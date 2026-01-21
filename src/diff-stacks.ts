/**
 * Diff Stack operations for the dataplane.
 *
 * Diff Stacks are reviewable/mergeable units that group one or more checkpoints.
 * Part of the unified checkpoint/diff stack architecture (s-366r).
 */

import type Database from 'better-sqlite3';
import crypto from 'crypto';
import { getTables } from './db/tables.js';
import type {
  Checkpoint,
  CheckpointInStack,
  DiffStack,
  DiffStackEntry,
  DiffStackReviewStatus,
  DiffStackWithCheckpoints,
  CreateDiffStackOptions,
  AddCheckpointToStackOptions,
  SetStackReviewStatusOptions,
  ListDiffStacksOptions,
} from './models/checkpoint.js';
import * as git from './git/index.js';
import * as checkpoints from './checkpoints.js';
import * as streams from './streams.js';

// ─────────────────────────────────────────────────────────────────────────────
// Stream-based Options Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for creating checkpoints from stream commits.
 */
export interface CreateCheckpointsFromStreamOptions {
  /** Start commit (exclusive). Defaults to stream's baseCommit. */
  from?: string;
  /** End commit (inclusive). Defaults to stream's current HEAD. */
  to?: string;
  /** Creator identifier for the checkpoints. */
  createdBy?: string;
}

/**
 * Options for creating a diff stack from stream commits.
 */
export interface CreateStackFromStreamOptions {
  /** Stream ID to create stack from. */
  streamId: string;
  /** Optional human-readable name for the stack. */
  name?: string;
  /** Optional description. */
  description?: string;
  /** Target branch for merge (default: 'main'). */
  targetBranch?: string;
  /** Commit range (defaults to stream's baseCommit to HEAD). */
  commitRange?: {
    from: string;
    to: string;
  };
  /** Creator identifier. */
  createdBy?: string;
}

/**
 * Result of cherry-picking a stack to target.
 */
export interface CherryPickStackResult {
  /** Whether the operation succeeded. */
  success: boolean;
  /** Original commits that were cherry-picked. */
  cherryPickedCommits: string[];
  /** New commits created on target branch. */
  newCommits: string[];
  /** Error message if operation failed. */
  error?: string;
  /** Conflicting files if operation failed due to conflicts. */
  conflicts?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Row Conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a database row to a DiffStack object.
 */
function rowToDiffStack(row: Record<string, unknown>): DiffStack {
  return {
    id: row.id as string,
    name: (row.name as string) || null,
    description: (row.description as string) || null,
    targetBranch: row.target_branch as string,
    reviewStatus: row.review_status as DiffStackReviewStatus,
    reviewedBy: (row.reviewed_by as string) || null,
    reviewedAt: (row.reviewed_at as number) || null,
    reviewNotes: (row.review_notes as string) || null,
    queuePosition: (row.queue_position as number) ?? null,
    createdAt: row.created_at as number,
    createdBy: (row.created_by as string) || null,
  };
}

/**
 * Convert a database row to a Checkpoint object.
 */
function rowToCheckpoint(row: Record<string, unknown>): Checkpoint {
  return {
    id: row.id as string,
    streamId: row.stream_id as string,
    commitSha: row.commit_sha as string,
    parentCommit: (row.parent_commit as string) || null,
    originalCommit: (row.original_commit as string) || null,
    changeId: (row.change_id as string) || null,
    message: (row.message as string) || null,
    createdAt: row.created_at as number,
    createdBy: (row.created_by as string) || null,
  };
}

/**
 * Convert a database row to a CheckpointInStack object.
 */
function rowToCheckpointInStack(row: Record<string, unknown>): CheckpointInStack {
  return {
    ...rowToCheckpoint(row),
    position: row.position as number,
  };
}

/**
 * Convert a database row to a DiffStackEntry object.
 */
function rowToDiffStackEntry(row: Record<string, unknown>): DiffStackEntry {
  return {
    id: row.id as string,
    stackId: row.stack_id as string,
    checkpointId: row.checkpoint_id as string,
    position: row.position as number,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Create Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new diff stack.
 *
 * @param db Database instance
 * @param options Stack creation options
 * @returns The created DiffStack
 */
export function createDiffStack(
  db: Database.Database,
  options: CreateDiffStackOptions = {}
): DiffStack {
  const t = getTables(db);
  const id = `ds-${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO ${t.diff_stacks} (
      id, name, description, target_branch, review_status,
      reviewed_by, reviewed_at, review_notes, queue_position,
      created_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    options.name ?? null,
    options.description ?? null,
    options.targetBranch ?? 'main',
    'pending',
    null,
    null,
    null,
    null,
    now,
    options.createdBy ?? null
  );

  // Add initial checkpoints if provided
  if (options.checkpointIds && options.checkpointIds.length > 0) {
    for (const [i, checkpointId] of options.checkpointIds.entries()) {
      addCheckpointToStack(db, {
        stackId: id,
        checkpointId,
        position: i,
      });
    }
  }

  return {
    id,
    name: options.name ?? null,
    description: options.description ?? null,
    targetBranch: options.targetBranch ?? 'main',
    reviewStatus: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
    queuePosition: null,
    createdAt: now,
    createdBy: options.createdBy ?? null,
  };
}

/**
 * Add a checkpoint to a stack.
 *
 * @param db Database instance
 * @param options Add options including stackId, checkpointId, and optional position
 * @returns The created DiffStackEntry
 * @throws Error if checkpoint doesn't exist or is already in the stack
 */
export function addCheckpointToStack(
  db: Database.Database,
  options: AddCheckpointToStackOptions
): DiffStackEntry {
  const t = getTables(db);
  const id = `dse-${crypto.randomUUID().slice(0, 8)}`;

  // Verify checkpoint exists
  const checkpointExists = db
    .prepare(`SELECT 1 FROM ${t.checkpoints} WHERE id = ?`)
    .get(options.checkpointId);
  if (!checkpointExists) {
    throw new Error(`Checkpoint not found: ${options.checkpointId}`);
  }

  // Verify stack exists
  const stackExists = db
    .prepare(`SELECT 1 FROM ${t.diff_stacks} WHERE id = ?`)
    .get(options.stackId);
  if (!stackExists) {
    throw new Error(`Stack not found: ${options.stackId}`);
  }

  // Determine position (append to end if not specified)
  let position = options.position;
  if (position === undefined) {
    const maxPos = db
      .prepare(
        `SELECT MAX(position) as max_pos FROM ${t.diff_stack_entries} WHERE stack_id = ?`
      )
      .get(options.stackId) as { max_pos: number | null } | undefined;
    position = (maxPos?.max_pos ?? -1) + 1;
  } else {
    // Shift existing entries at or after this position
    db.prepare(
      `UPDATE ${t.diff_stack_entries} SET position = position + 1 WHERE stack_id = ? AND position >= ?`
    ).run(options.stackId, position);
  }

  const stmt = db.prepare(`
    INSERT INTO ${t.diff_stack_entries} (id, stack_id, checkpoint_id, position)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(id, options.stackId, options.checkpointId, position);

  return {
    id,
    stackId: options.stackId,
    checkpointId: options.checkpointId,
    position,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a diff stack by ID.
 */
export function getDiffStack(
  db: Database.Database,
  id: string
): DiffStack | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.diff_stacks} WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;

  return row ? rowToDiffStack(row) : null;
}

/**
 * Get a diff stack with its checkpoints included.
 */
export function getDiffStackWithCheckpoints(
  db: Database.Database,
  id: string
): DiffStackWithCheckpoints | null {
  const stack = getDiffStack(db, id);
  if (!stack) return null;

  const checkpoints = getCheckpointsInStack(db, id);
  return {
    ...stack,
    checkpoints,
  };
}

/**
 * Get all checkpoints in a stack, ordered by position.
 */
export function getCheckpointsInStack(
  db: Database.Database,
  stackId: string
): CheckpointInStack[] {
  const t = getTables(db);
  const rows = db
    .prepare(
      `
    SELECT c.*, e.position
    FROM ${t.checkpoints} c
    JOIN ${t.diff_stack_entries} e ON c.id = e.checkpoint_id
    WHERE e.stack_id = ?
    ORDER BY e.position ASC
  `
    )
    .all(stackId) as Array<Record<string, unknown>>;

  return rows.map(rowToCheckpointInStack);
}

/**
 * Get all stacks containing a checkpoint.
 */
export function getStacksForCheckpoint(
  db: Database.Database,
  checkpointId: string
): DiffStack[] {
  const t = getTables(db);
  const rows = db
    .prepare(
      `
    SELECT s.*
    FROM ${t.diff_stacks} s
    JOIN ${t.diff_stack_entries} e ON s.id = e.stack_id
    WHERE e.checkpoint_id = ?
    ORDER BY s.created_at ASC
  `
    )
    .all(checkpointId) as Array<Record<string, unknown>>;

  return rows.map(rowToDiffStack);
}

/**
 * Get stack entries for a stack.
 */
export function getStackEntries(
  db: Database.Database,
  stackId: string
): DiffStackEntry[] {
  const t = getTables(db);
  const rows = db
    .prepare(
      `SELECT * FROM ${t.diff_stack_entries} WHERE stack_id = ? ORDER BY position ASC`
    )
    .all(stackId) as Array<Record<string, unknown>>;

  return rows.map(rowToDiffStackEntry);
}

/**
 * List diff stacks with optional filters.
 */
export function listDiffStacks(
  db: Database.Database,
  options: ListDiffStacksOptions = {}
): DiffStack[] {
  const t = getTables(db);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.reviewStatus) {
    conditions.push('review_status = ?');
    params.push(options.reviewStatus);
  }

  if (options.targetBranch) {
    conditions.push('target_branch = ?');
    params.push(options.targetBranch);
  }

  if (options.queuedOnly) {
    conditions.push('queue_position IS NOT NULL');
  }

  let query = `SELECT * FROM ${t.diff_stacks}`;
  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }
  query += ` ORDER BY created_at ASC`;

  const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToDiffStack);
}

/**
 * Get stacks in the merge queue for a target branch, ordered by position.
 */
export function getQueuedStacks(
  db: Database.Database,
  targetBranch: string = 'main'
): DiffStack[] {
  const t = getTables(db);
  const rows = db
    .prepare(
      `
    SELECT * FROM ${t.diff_stacks}
    WHERE target_branch = ? AND queue_position IS NOT NULL
    ORDER BY queue_position ASC
  `
    )
    .all(targetBranch) as Array<Record<string, unknown>>;

  return rows.map(rowToDiffStack);
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Transition Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Valid status transitions for diff stacks.
 * Key = current status, Value = array of valid target statuses
 */
const VALID_STATUS_TRANSITIONS: Record<DiffStackReviewStatus, DiffStackReviewStatus[]> = {
  pending: ['approved', 'rejected', 'abandoned'],
  approved: ['merged', 'rejected', 'pending', 'abandoned'],
  rejected: ['pending', 'abandoned'],
  merged: [], // Terminal state - no transitions allowed
  abandoned: ['pending'], // Can be reopened
};

/**
 * Check if a status transition is valid.
 */
export function isValidStatusTransition(
  from: DiffStackReviewStatus,
  to: DiffStackReviewStatus
): boolean {
  if (from === to) return true; // Same status is always valid
  return VALID_STATUS_TRANSITIONS[from].includes(to);
}

// ─────────────────────────────────────────────────────────────────────────────
// Update Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update the review status of a stack.
 *
 * @throws Error if status transition is invalid (e.g., can't change merged stack)
 */
export function setStackReviewStatus(
  db: Database.Database,
  options: SetStackReviewStatusOptions
): DiffStack | null {
  const t = getTables(db);
  const now = Date.now();

  // Get current stack to validate transition
  const currentStack = getDiffStack(db, options.stackId);
  if (!currentStack) {
    return null;
  }

  // Validate status transition
  if (!isValidStatusTransition(currentStack.reviewStatus, options.status)) {
    throw new Error(
      `Invalid status transition: cannot change from '${currentStack.reviewStatus}' to '${options.status}'`
    );
  }

  // Preserve existing notes if not provided
  const newNotes = options.notes !== undefined ? options.notes : currentStack.reviewNotes;

  const result = db
    .prepare(
      `
    UPDATE ${t.diff_stacks}
    SET review_status = ?, reviewed_by = ?, reviewed_at = ?, review_notes = ?
    WHERE id = ?
  `
    )
    .run(
      options.status,
      options.reviewedBy ?? null,
      now,
      newNotes,
      options.stackId
    );

  if (result.changes === 0) {
    return null;
  }

  return getDiffStack(db, options.stackId);
}

/**
 * Add or update review notes on a stack.
 * This does not change the review status or reviewer.
 */
export function addStackReviewNotes(
  db: Database.Database,
  stackId: string,
  notes: string
): DiffStack | null {
  const t = getTables(db);

  const result = db
    .prepare(`UPDATE ${t.diff_stacks} SET review_notes = ? WHERE id = ?`)
    .run(notes, stackId);

  if (result.changes === 0) {
    return null;
  }

  return getDiffStack(db, stackId);
}

/**
 * Set the queue position of a stack.
 * If position is null, removes from queue.
 */
export function setStackQueuePosition(
  db: Database.Database,
  stackId: string,
  position: number | null
): DiffStack | null {
  const t = getTables(db);

  if (position !== null) {
    // Get the stack to know its target branch
    const stack = getDiffStack(db, stackId);
    if (!stack) return null;

    // Shift existing items at or after this position
    db.prepare(
      `
      UPDATE ${t.diff_stacks}
      SET queue_position = queue_position + 1
      WHERE target_branch = ? AND queue_position IS NOT NULL AND queue_position >= ?
    `
    ).run(stack.targetBranch, position);
  }

  const result = db
    .prepare(`UPDATE ${t.diff_stacks} SET queue_position = ? WHERE id = ?`)
    .run(position, stackId);

  if (result.changes === 0) {
    return null;
  }

  return getDiffStack(db, stackId);
}

/**
 * Add a stack to the end of the merge queue.
 *
 * @throws Error if stack is not approved
 */
export function enqueueStack(
  db: Database.Database,
  stackId: string
): DiffStack | null {
  const t = getTables(db);
  const stack = getDiffStack(db, stackId);
  if (!stack) return null;

  // Only approved stacks can be queued
  if (stack.reviewStatus !== 'approved') {
    throw new Error(
      `Cannot queue stack with status '${stack.reviewStatus}'. Only approved stacks can be queued.`
    );
  }

  // Get the max position for this target branch
  const maxPos = db
    .prepare(
      `
    SELECT MAX(queue_position) as max_pos
    FROM ${t.diff_stacks}
    WHERE target_branch = ? AND queue_position IS NOT NULL
  `
    )
    .get(stack.targetBranch) as { max_pos: number | null } | undefined;

  const newPosition = (maxPos?.max_pos ?? -1) + 1;
  return setStackQueuePosition(db, stackId, newPosition);
}

/**
 * Remove a stack from the merge queue and compact positions.
 */
export function dequeueStack(
  db: Database.Database,
  stackId: string
): DiffStack | null {
  const t = getTables(db);
  const stack = getDiffStack(db, stackId);
  if (!stack || stack.queuePosition === null) return stack;

  // Remove from queue
  db.prepare(`UPDATE ${t.diff_stacks} SET queue_position = NULL WHERE id = ?`).run(
    stackId
  );

  // Compact remaining positions
  db.prepare(
    `
    UPDATE ${t.diff_stacks}
    SET queue_position = queue_position - 1
    WHERE target_branch = ? AND queue_position > ?
  `
  ).run(stack.targetBranch, stack.queuePosition);

  return getDiffStack(db, stackId);
}

/**
 * Reorder the entire merge queue for a target branch.
 *
 * @param db Database instance
 * @param targetBranch Target branch to reorder queue for
 * @param stackIds New order of stack IDs (index = position)
 * @returns Updated stacks in new order
 * @throws Error if stackIds doesn't match current queued stacks
 */
export function reorderQueue(
  db: Database.Database,
  targetBranch: string,
  stackIds: string[]
): DiffStack[] {
  const t = getTables(db);

  // Get current queued stacks
  const currentQueue = getQueuedStacks(db, targetBranch);
  const currentIds = new Set(currentQueue.map((s) => s.id));
  const newIds = new Set(stackIds);

  // Verify all stacks are accounted for
  if (currentIds.size !== newIds.size) {
    throw new Error('New queue order must include all currently queued stacks');
  }
  for (const id of currentIds) {
    if (!newIds.has(id)) {
      throw new Error(`Missing stack in new queue order: ${id}`);
    }
  }
  for (const id of newIds) {
    if (!currentIds.has(id)) {
      throw new Error(`Stack ${id} is not in the current queue`);
    }
  }

  // Update positions
  const updateStmt = db.prepare(
    `UPDATE ${t.diff_stacks} SET queue_position = ? WHERE id = ?`
  );

  for (const [i, stackId] of stackIds.entries()) {
    updateStmt.run(i, stackId);
  }

  // Return updated stacks in new order
  return stackIds.map((id) => getDiffStack(db, id)!);
}

/**
 * Remove a checkpoint from a stack.
 */
export function removeCheckpointFromStack(
  db: Database.Database,
  stackId: string,
  checkpointId: string
): boolean {
  const t = getTables(db);

  // Get the entry to know its position
  const entry = db
    .prepare(
      `SELECT * FROM ${t.diff_stack_entries} WHERE stack_id = ? AND checkpoint_id = ?`
    )
    .get(stackId, checkpointId) as Record<string, unknown> | undefined;

  if (!entry) return false;

  const position = entry.position as number;

  // Delete the entry
  const result = db
    .prepare(
      `DELETE FROM ${t.diff_stack_entries} WHERE stack_id = ? AND checkpoint_id = ?`
    )
    .run(stackId, checkpointId);

  // Compact remaining positions
  db.prepare(
    `
    UPDATE ${t.diff_stack_entries}
    SET position = position - 1
    WHERE stack_id = ? AND position > ?
  `
  ).run(stackId, position);

  return result.changes > 0;
}

/**
 * Reorder checkpoints within a stack.
 *
 * @param db Database instance
 * @param stackId Stack ID
 * @param checkpointIds New order of checkpoint IDs (must include all existing checkpoints)
 * @throws Error if checkpointIds doesn't match existing checkpoints
 */
export function reorderStackCheckpoints(
  db: Database.Database,
  stackId: string,
  checkpointIds: string[]
): void {
  const t = getTables(db);

  // Get current entries
  const currentEntries = getStackEntries(db, stackId);
  const currentIds = new Set(currentEntries.map((e) => e.checkpointId));
  const newIds = new Set(checkpointIds);

  // Verify all checkpoints are accounted for
  if (currentIds.size !== newIds.size) {
    throw new Error('New checkpoint order must include all existing checkpoints');
  }
  for (const id of currentIds) {
    if (!newIds.has(id)) {
      throw new Error(`Missing checkpoint in new order: ${id}`);
    }
  }

  // Update positions
  const updateStmt = db.prepare(
    `UPDATE ${t.diff_stack_entries} SET position = ? WHERE stack_id = ? AND checkpoint_id = ?`
  );

  for (let i = 0; i < checkpointIds.length; i++) {
    updateStmt.run(i, stackId, checkpointIds[i]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete a diff stack by ID.
 * Stack entries are cascade-deleted via foreign key constraint.
 */
export function deleteDiffStack(db: Database.Database, id: string): boolean {
  const t = getTables(db);
  const result = db.prepare(`DELETE FROM ${t.diff_stacks} WHERE id = ?`).run(id);
  return result.changes > 0;
}

/**
 * Delete all stacks with a given review status.
 */
export function deleteStacksByStatus(
  db: Database.Database,
  status: DiffStackReviewStatus
): number {
  const t = getTables(db);
  const result = db
    .prepare(`DELETE FROM ${t.diff_stacks} WHERE review_status = ?`)
    .run(status);
  return result.changes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream-based Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create checkpoints from stream commits.
 *
 * Gets commits from the stream's baseCommit (or specified `from`) to current HEAD
 * (or specified `to`), and creates a checkpoint for each commit. Reuses existing
 * checkpoints if the (streamId, commitSha) pair already exists.
 *
 * @param db Database instance
 * @param repoPath Path to the git repository
 * @param streamId Stream to create checkpoints from
 * @param options Optional commit range and creator
 * @returns Array of checkpoints in commit order
 * @throws Error if stream not found
 */
export function createCheckpointsFromStream(
  db: Database.Database,
  repoPath: string,
  streamId: string,
  options: CreateCheckpointsFromStreamOptions = {}
): Checkpoint[] {
  const gitOpts = { cwd: repoPath };

  // Get stream to determine base commit
  const stream = streams.getStream(db, streamId);
  if (!stream) {
    throw new Error(`Stream not found: ${streamId}`);
  }

  // Determine branch name for this stream
  const branchName = stream.existingBranch ?? `stream/${streamId}`;

  // Determine commit range
  const fromCommit = options.from ?? stream.baseCommit;
  const toCommit = options.to ?? git.resolveRef(branchName, gitOpts);

  // Get commits in range (from is exclusive, to is inclusive)
  const commits = git.getCommitRange(fromCommit, toCommit, gitOpts);

  if (commits.length === 0) {
    return [];
  }

  const result: Checkpoint[] = [];

  for (const commitSha of commits) {
    // Check if checkpoint already exists for this stream/commit pair
    const existing = checkpoints.getCheckpointByCommit(db, streamId, commitSha);
    if (existing) {
      result.push(existing);
      continue;
    }

    // Get commit details
    const message = git.getCommitMessage(commitSha, gitOpts);
    const changeId = git.getCommitChangeId(commitSha, gitOpts);

    // Get parent commit
    let parentCommit: string | null = null;
    try {
      parentCommit = git.git(['rev-parse', `${commitSha}^`], gitOpts);
    } catch {
      // First commit has no parent
    }

    // Create checkpoint
    const checkpoint = checkpoints.createCheckpoint(db, {
      streamId,
      commitSha,
      parentCommit: parentCommit ?? undefined,
      originalCommit: commitSha,
      changeId: changeId ?? undefined,
      message,
      createdBy: options.createdBy,
    });

    result.push(checkpoint);
  }

  return result;
}

/**
 * Create a diff stack from stream commits.
 *
 * Creates checkpoints for commits in the specified range (or all commits since
 * stream's baseCommit), then groups them into a diff stack for review.
 *
 * @param db Database instance
 * @param repoPath Path to the git repository
 * @param options Stack creation options including streamId and optional range
 * @returns DiffStackWithCheckpoints containing the stack and its checkpoints
 * @throws Error if stream not found
 */
export function createStackFromStream(
  db: Database.Database,
  repoPath: string,
  options: CreateStackFromStreamOptions
): DiffStackWithCheckpoints {
  // Create checkpoints from stream commits
  const streamCheckpoints = createCheckpointsFromStream(db, repoPath, options.streamId, {
    from: options.commitRange?.from,
    to: options.commitRange?.to,
    createdBy: options.createdBy,
  });

  // Create the diff stack with checkpoints
  const stack = createDiffStack(db, {
    name: options.name,
    description: options.description,
    targetBranch: options.targetBranch ?? 'main',
    checkpointIds: streamCheckpoints.map((cp) => cp.id),
    createdBy: options.createdBy,
  });

  // Return stack with checkpoints
  return {
    ...stack,
    checkpoints: streamCheckpoints.map((cp, index) => ({
      ...cp,
      position: index,
    })),
  };
}

/**
 * Cherry-pick an approved stack's checkpoints to the target branch.
 *
 * Verifies the stack is approved, checks out the target branch in the provided
 * worktree, and cherry-picks each checkpoint's commit in order. If all succeed,
 * marks the stack as merged.
 *
 * @param db Database instance
 * @param repoPath Path to the git repository
 * @param stackId Stack to cherry-pick
 * @param worktree Path to worktree for git operations
 * @returns Result including cherry-picked and new commits
 * @throws Error if stack not found or not approved
 */
export function cherryPickStackToTarget(
  db: Database.Database,
  _repoPath: string,
  stackId: string,
  worktree: string
): CherryPickStackResult {
  const gitOpts = { cwd: worktree };

  // Get stack with checkpoints
  const stack = getDiffStackWithCheckpoints(db, stackId);
  if (!stack) {
    return {
      success: false,
      cherryPickedCommits: [],
      newCommits: [],
      error: `Stack not found: ${stackId}`,
    };
  }

  // Verify stack is approved
  if (stack.reviewStatus !== 'approved') {
    return {
      success: false,
      cherryPickedCommits: [],
      newCommits: [],
      error: `Stack is not approved. Current status: ${stack.reviewStatus}`,
    };
  }

  // Verify there are checkpoints to cherry-pick
  if (stack.checkpoints.length === 0) {
    // Empty stack - mark as merged and return success
    setStackReviewStatus(db, {
      stackId,
      status: 'merged',
    });
    return {
      success: true,
      cherryPickedCommits: [],
      newCommits: [],
    };
  }

  // Checkout target branch
  try {
    git.checkout(stack.targetBranch, gitOpts);
  } catch (err) {
    return {
      success: false,
      cherryPickedCommits: [],
      newCommits: [],
      error: `Failed to checkout target branch '${stack.targetBranch}': ${err}`,
    };
  }

  const cherryPickedCommits: string[] = [];
  const newCommits: string[] = [];

  // Cherry-pick each checkpoint in order
  for (const checkpoint of stack.checkpoints) {
    const result = git.cherryPickWithCommit(checkpoint.commitSha, gitOpts);

    if (!result.success) {
      // Abort cherry-pick and return error
      try {
        git.cherryPickAbort(gitOpts);
      } catch {
        // Ignore abort errors
      }

      return {
        success: false,
        cherryPickedCommits,
        newCommits,
        error: `Conflict while cherry-picking commit ${checkpoint.commitSha}`,
        conflicts: result.conflicts,
      };
    }

    cherryPickedCommits.push(checkpoint.commitSha);
    if (result.newCommit) {
      newCommits.push(result.newCommit);
    }
  }

  // All cherry-picks succeeded - mark stack as merged
  setStackReviewStatus(db, {
    stackId,
    status: 'merged',
  });

  return {
    success: true,
    cherryPickedCommits,
    newCommits,
  };
}
