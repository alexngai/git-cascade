/**
 * Stream CRUD operations.
 */

import type Database from 'better-sqlite3';
import * as crypto from 'crypto';
import { getTables } from './db/tables.js';
import type {
  Stream,
  StreamStatus,
  CreateStreamOptions,
  ForkStreamOptions,
  MergeStreamOptions,
  MergeResult,
  RebaseOntoStreamOptions,
  RebaseResult,
  ConflictInfo,
  StreamNode,
} from './models/index.js';
import * as git from './git/index.js';
import * as stacks from './stacks.js';
import * as deps from './dependencies.js';
import * as changes from './changes.js';
import { StreamNotFoundError, BranchNotFoundError } from './errors.js';

/**
 * Generate a unique stream ID.
 */
function generateStreamId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Convert database row to Stream object.
 */
function rowToStream(row: Record<string, unknown>): Stream {
  return {
    id: row.id as string,
    name: row.name as string,
    agentId: row.agent_id as string,
    baseCommit: row.base_commit as string,
    parentStream: row.parent_stream as string | null,
    status: row.status as StreamStatus,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    mergedInto: row.merged_into as string | null,
    enableStackedReview: Boolean(row.enable_stacked_review),
    metadata: JSON.parse((row.metadata as string) || '{}'),
  };
}

/**
 * Create a new stream.
 */
export function createStream(
  db: Database.Database,
  repoPath: string,
  options: CreateStreamOptions
): string {
  const streamId = generateStreamId();
  const now = Date.now();
  const base = options.base ?? 'main';
  const t = getTables(db);

  // Resolve base to commit hash
  const baseCommit = git.resolveRef(base, { cwd: repoPath });

  // Create git branch
  const branchName = `stream/${streamId}`;
  git.createBranch(branchName, baseCommit, { cwd: repoPath });

  // Insert into database
  db.prepare(`
    INSERT INTO ${t.streams} (
      id, name, agent_id, base_commit, parent_stream, status,
      created_at, updated_at, merged_into, enable_stacked_review, metadata
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)
  `).run(
    streamId,
    options.name,
    options.agentId,
    baseCommit,
    options.parentStream ?? null,
    now,
    now,
    options.enableStackedReview ? 1 : 0,
    JSON.stringify(options.metadata ?? {})
  );

  return streamId;
}

/**
 * Get a stream by ID.
 */
export function getStream(
  db: Database.Database,
  streamId: string
): Stream | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.streams} WHERE id = ?`)
    .get(streamId) as Record<string, unknown> | undefined;

  return row ? rowToStream(row) : null;
}

/**
 * Get a stream by ID, throwing if not found.
 */
export function getStreamOrThrow(
  db: Database.Database,
  streamId: string
): Stream {
  const stream = getStream(db, streamId);
  if (!stream) {
    throw new StreamNotFoundError(streamId);
  }
  return stream;
}

/**
 * List streams with optional filters.
 */
export function listStreams(
  db: Database.Database,
  options?: { agentId?: string; status?: StreamStatus }
): Stream[] {
  const t = getTables(db);
  let query = `SELECT * FROM ${t.streams} WHERE 1=1`;
  const params: unknown[] = [];

  if (options?.agentId) {
    query += ' AND agent_id = ?';
    params.push(options.agentId);
  }
  if (options?.status) {
    query += ' AND status = ?';
    params.push(options.status);
  }

  query += ' ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(rowToStream);
}

/**
 * Update stream properties.
 */
export function updateStream(
  db: Database.Database,
  streamId: string,
  updates: Partial<Pick<Stream, 'name' | 'status' | 'metadata'>>
): void {
  const stream = getStreamOrThrow(db, streamId);
  const now = Date.now();

  const setClauses: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];

  if (updates.name !== undefined) {
    setClauses.push('name = ?');
    params.push(updates.name);
  }
  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    params.push(updates.status);
  }
  if (updates.metadata !== undefined) {
    setClauses.push('metadata = ?');
    params.push(JSON.stringify({ ...stream.metadata, ...updates.metadata }));
  }

  params.push(streamId);

  const t = getTables(db);
  db.prepare(`UPDATE ${t.streams} SET ${setClauses.join(', ')} WHERE id = ?`).run(
    ...params
  );
}

/**
 * Abandon a stream.
 */
export function abandonStream(
  db: Database.Database,
  streamId: string,
  reason?: string
): void {
  const stream = getStreamOrThrow(db, streamId);
  const now = Date.now();

  const metadata = {
    ...stream.metadata,
    abandonedAt: now,
    abandonReason: reason,
  };

  const t = getTables(db);
  db.prepare(`
    UPDATE ${t.streams} SET status = 'abandoned', updated_at = ?, metadata = ?
    WHERE id = ?
  `).run(now, JSON.stringify(metadata), streamId);
}

/**
 * Fork a stream (create new stream from existing stream's head).
 */
export function forkStream(
  db: Database.Database,
  repoPath: string,
  options: ForkStreamOptions
): string {
  const parent = getStreamOrThrow(db, options.parentStreamId);

  // Get parent's current head
  const parentBranch = `stream/${parent.id}`;
  const baseCommit = git.resolveRef(parentBranch, { cwd: repoPath });

  // Create new stream with parent reference
  return createStream(db, repoPath, {
    name: options.name,
    agentId: options.agentId,
    base: baseCommit,
    parentStream: parent.id,
  });
}

/**
 * Merge a stream into another.
 */
export function mergeStream(
  db: Database.Database,
  _repoPath: string,
  options: MergeStreamOptions
): MergeResult {
  const t = getTables(db);
  const source = getStreamOrThrow(db, options.sourceStream);
  // Validate target exists
  getStreamOrThrow(db, options.targetStream);

  const sourceBranch = `stream/${source.id}`;
  const targetBranch = `stream/${options.targetStream}`;
  const strategy = options.strategy ?? 'merge-commit';

  const gitOpts = { cwd: options.worktree };

  // Checkout target branch
  git.checkout(targetBranch, gitOpts);

  try {
    if (strategy === 'merge-commit') {
      git.git(['merge', '--no-ff', sourceBranch, '-m', `Merge ${source.name}`], gitOpts);
    } else if (strategy === 'squash') {
      git.git(['merge', '--squash', sourceBranch], gitOpts);
      git.commit(`Merge ${source.name} (squashed)`, gitOpts);
    } else if (strategy === 'rebase') {
      // For rebase strategy, we rebase source onto target first
      git.checkout(sourceBranch, gitOpts);
      git.git(['rebase', targetBranch], gitOpts);
      git.checkout(targetBranch, gitOpts);
      git.git(['merge', '--ff-only', sourceBranch], gitOpts);
    }

    const newHead = git.getHead(gitOpts);

    // Update source stream status
    const now = Date.now();
    db.prepare(`
      UPDATE ${t.streams} SET status = 'merged', merged_into = ?, updated_at = ?
      WHERE id = ?
    `).run(options.targetStream, now, source.id);

    // Mark all changes in source stream as merged
    const sourceChanges = changes.getChangesForStream(db, source.id, { status: 'active' });
    if (sourceChanges.length > 0) {
      changes.markMerged(db, sourceChanges.map((c) => c.id));
    }

    return { success: true, newHead };
  } catch (error) {
    // Check for conflicts
    const conflicts = git.getConflictedFiles(gitOpts);
    if (conflicts.length > 0) {
      git.mergeAbort(gitOpts);
      return { success: false, conflicts };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get the current head commit of a stream.
 */
export function getStreamHead(repoPath: string, streamId: string): string {
  const branchName = `stream/${streamId}`;
  try {
    return git.resolveRef(branchName, { cwd: repoPath });
  } catch {
    throw new BranchNotFoundError(branchName);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rebase Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebase a stream onto another stream's head.
 *
 * This operation:
 * 1. Rebases source stream's commits onto target stream's head
 * 2. Updates source stream's baseCommit to target's head
 * 3. If enableStackedReview=true, rebuilds the stack
 */
export function rebaseOntoStream(
  db: Database.Database,
  _repoPath: string,
  options: RebaseOntoStreamOptions
): RebaseResult {
  const { sourceStream, targetStream, worktree } = options;
  const onConflict = options.onConflict ?? 'abort';

  // Validate streams exist
  const source = getStreamOrThrow(db, sourceStream);
  getStreamOrThrow(db, targetStream); // Validate target exists

  const sourceBranch = `stream/${sourceStream}`;
  const targetBranch = `stream/${targetStream}`;
  const gitOpts = { cwd: worktree };

  // Get target's current head (this will be the new base)
  const targetHead = git.resolveRef(targetBranch, gitOpts);

  // Check if source has any commits beyond its base
  const commits = git.getCommitRange(source.baseCommit, sourceBranch, gitOpts);
  if (commits.length === 0) {
    // No commits to rebase, just update baseCommit
    updateBaseCommit(db, sourceStream, targetHead);
    git.checkout(sourceBranch, gitOpts);
    git.resetHard(targetHead, gitOpts);
    return {
      success: true,
      newHead: targetHead,
      newBaseCommit: targetHead,
    };
  }

  // Handle manual strategy - just fail if conflicts might occur
  if (onConflict === 'manual') {
    // Try the rebase without any conflict resolution
    const result = git.rebaseOnto(targetHead, source.baseCommit, sourceBranch, gitOpts);
    if (!result.success) {
      // Abort and let user handle it
      try {
        git.rebaseAbort(gitOpts);
      } catch {
        // Ignore
      }
      const conflicts: ConflictInfo[] = (result.conflicts ?? []).map((f) => ({ file: f }));
      return {
        success: false,
        conflicts,
        error: 'Rebase has conflicts - manual resolution required',
      };
    }
    // Success - update baseCommit and rebuild stack
    updateBaseCommit(db, sourceStream, targetHead);
    if (source.enableStackedReview) {
      stacks.rebuildStack(db, worktree, sourceStream);
    }
    // Rebuild change tracking
    const newCommits = git.getCommitRange(targetHead, sourceBranch, gitOpts);
    const commitMapping = changes.buildRebaseCommitMapping(worktree, commits, newCommits);
    changes.rebuildChangesAfterRebase(db, sourceStream, commitMapping);
    return {
      success: true,
      newHead: result.newHead,
      newBaseCommit: targetHead,
    };
  }

  // Handle agent strategy (deferred to Phase 6)
  if (onConflict === 'agent') {
    return {
      success: false,
      error: 'Agent conflict resolution not yet implemented (Phase 6)',
    };
  }

  // Map our strategy to git strategy
  const gitStrategy: git.RebaseConflictStrategy =
    onConflict === 'ours' ? 'ours' : onConflict === 'theirs' ? 'theirs' : 'abort';

  // Perform the rebase
  const result = git.rebaseOntoWithStrategy(
    targetHead,
    source.baseCommit,
    sourceBranch,
    gitStrategy,
    gitOpts
  );

  if (!result.success) {
    const conflicts: ConflictInfo[] = (result.conflicts ?? []).map((f) => ({ file: f }));
    return {
      success: false,
      conflicts,
      error: result.error ?? 'Rebase failed due to conflicts',
    };
  }

  // Update source stream's baseCommit
  updateBaseCommit(db, sourceStream, targetHead);

  // Rebuild stack if enabled
  if (source.enableStackedReview) {
    stacks.rebuildStack(db, worktree, sourceStream);
  }

  // Rebuild change tracking
  const newCommits = git.getCommitRange(targetHead, sourceBranch, gitOpts);
  const commitMapping = changes.buildRebaseCommitMapping(worktree, commits, newCommits);
  changes.rebuildChangesAfterRebase(db, sourceStream, commitMapping);

  return {
    success: true,
    newHead: result.newHead,
    newBaseCommit: targetHead,
  };
}

/**
 * Sync a stream with its parent (convenience wrapper).
 */
export function syncWithParent(
  db: Database.Database,
  _repoPath: string,
  streamId: string,
  agentId: string,
  worktree: string,
  onConflict?: RebaseOntoStreamOptions['onConflict']
): RebaseResult {
  const stream = getStreamOrThrow(db, streamId);

  if (!stream.parentStream) {
    throw new Error(`Stream ${streamId} has no parent stream`);
  }

  return rebaseOntoStream(db, _repoPath, {
    sourceStream: streamId,
    targetStream: stream.parentStream,
    agentId,
    worktree,
    onConflict,
  });
}

/**
 * Update a stream's baseCommit.
 */
function updateBaseCommit(
  db: Database.Database,
  streamId: string,
  newBaseCommit: string
): void {
  const t = getTables(db);
  const now = Date.now();

  db.prepare(`
    UPDATE ${t.streams} SET base_commit = ?, updated_at = ?
    WHERE id = ?
  `).run(newBaseCommit, now, streamId);
}

/**
 * Get child streams (streams forked from this stream).
 */
export function getChildStreams(
  db: Database.Database,
  streamId: string
): Stream[] {
  const t = getTables(db);

  const rows = db.prepare(`
    SELECT * FROM ${t.streams}
    WHERE parent_stream = ?
    ORDER BY created_at ASC
  `).all(streamId) as Record<string, unknown>[];

  return rows.map(rowToStream);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream Graph Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the common ancestor commit between two streams.
 */
export function findCommonAncestor(
  repoPath: string,
  streamIdA: string,
  streamIdB: string
): string {
  const branchA = `stream/${streamIdA}`;
  const branchB = `stream/${streamIdB}`;
  const gitOpts = { cwd: repoPath };

  return git.getMergeBase(branchA, branchB, gitOpts);
}

/**
 * Get root streams (streams with no parent).
 */
export function getRootStreams(db: Database.Database): Stream[] {
  const t = getTables(db);

  const rows = db.prepare(`
    SELECT * FROM ${t.streams}
    WHERE parent_stream IS NULL AND status != 'abandoned'
    ORDER BY created_at ASC
  `).all() as Record<string, unknown>[];

  return rows.map(rowToStream);
}

/**
 * Build a stream node recursively.
 */
function buildStreamNode(db: Database.Database, stream: Stream): StreamNode {
  const children = getChildStreams(db, stream.id);
  const dependencies = deps.getDependencies(db, stream.id);

  return {
    stream,
    children: children.map((child) => buildStreamNode(db, child)),
    dependencies,
  };
}

/**
 * Get stream graph as a tree structure.
 *
 * @param rootStreamId - If provided, returns tree from this stream
 * @returns Single StreamNode if rootStreamId provided, otherwise array of root trees
 */
export function getStreamGraph(
  db: Database.Database,
  rootStreamId?: string
): StreamNode | StreamNode[] {
  if (rootStreamId) {
    const stream = getStreamOrThrow(db, rootStreamId);
    return buildStreamNode(db, stream);
  }

  // Return forest of all root streams
  const roots = getRootStreams(db);
  return roots.map((stream) => buildStreamNode(db, stream));
}
