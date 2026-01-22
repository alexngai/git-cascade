/**
 * Worker Tasks management.
 *
 * Provides lifecycle management for ephemeral worker branches that
 * merge into streams (integration branches).
 */

import type Database from 'better-sqlite3';
import { getTables } from './db/tables.js';
import * as git from './git/commands.js';
import * as streams from './streams.js';
import type {
  WorkerTask,
  WorkerTaskStatus,
  TaskMerge,
  CreateTaskOptions,
  StartTaskOptions,
  CompleteTaskOptions,
  ListTasksOptions,
  CleanupWorkerBranchesOptions,
  StartTaskResult,
  CompleteTaskResult,
  CleanupResult,
  RecoverTasksResult,
} from './models/task.js';

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} not found`);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskStateError';
  }
}

export class TaskConflictError extends Error {
  public readonly conflicts: string[];
  public readonly taskId: string;

  constructor(taskId: string, conflicts: string[]) {
    super(`Merge conflict while completing task ${taskId}: ${conflicts.join(', ')}`);
    this.name = 'TaskConflictError';
    this.taskId = taskId;
    this.conflicts = conflicts;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ID Generation
// ─────────────────────────────────────────────────────────────────────────────

function generateTaskId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `wt-${timestamp}-${random}`;
}

function generateMergeId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `tm-${timestamp}-${random}`;
}

/**
 * Generate a worker branch name.
 * Format: worker/<agentId>/<taskId>@<timestamp>
 */
export function generateWorkerBranchName(agentId: string, taskId: string): string {
  const timestamp = Date.now().toString(36);
  return `worker/${agentId}/${taskId}@${timestamp}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row Conversion
// ─────────────────────────────────────────────────────────────────────────────

function rowToTask(row: Record<string, unknown>): WorkerTask {
  return {
    id: row.id as string,
    title: row.title as string,
    streamId: row.stream_id as string,
    agentId: row.agent_id as string | null,
    branchName: row.branch_name as string | null,
    status: row.status as WorkerTaskStatus,
    startCommit: row.start_commit as string | null,
    mergeCommit: row.merge_commit as string | null,
    createdAt: row.created_at as number,
    startedAt: row.started_at as number | null,
    completedAt: row.completed_at as number | null,
    priority: row.priority as number,
    metadata: JSON.parse((row.metadata as string) || '{}'),
  };
}

function rowToTaskMerge(row: Record<string, unknown>): TaskMerge {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    sourceBranch: row.source_branch as string,
    sourceCommit: row.source_commit as string,
    targetStreamId: row.target_stream_id as string,
    mergeCommit: row.merge_commit as string,
    createdAt: row.created_at as number,
    createdBy: row.created_by as string | null,
    metadata: JSON.parse((row.metadata as string) || '{}'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new worker task under a stream.
 *
 * @param db - Database connection
 * @param options - Task creation options
 * @returns Task ID
 */
export function createTask(
  db: Database.Database,
  options: CreateTaskOptions
): string {
  const t = getTables(db);
  const now = Date.now();
  const id = generateTaskId();

  // Verify stream exists and is active
  const stream = streams.getStreamOrThrow(db, options.streamId);
  if (stream.status !== 'active') {
    throw new TaskStateError(
      `Cannot create task on stream ${options.streamId} with status '${stream.status}' (must be 'active')`
    );
  }

  db.prepare(`
    INSERT INTO ${t.worker_tasks} (
      id, title, stream_id, status, priority, created_at, metadata
    ) VALUES (?, ?, ?, 'open', ?, ?, ?)
  `).run(
    id,
    options.title,
    options.streamId,
    options.priority ?? 100,
    now,
    JSON.stringify(options.metadata ?? {})
  );

  return id;
}

/**
 * Get a task by ID.
 */
export function getTask(
  db: Database.Database,
  taskId: string
): WorkerTask | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.worker_tasks} WHERE id = ?`)
    .get(taskId) as Record<string, unknown> | undefined;

  return row ? rowToTask(row) : null;
}

/**
 * Get a task by ID, throwing if not found.
 */
export function getTaskOrThrow(
  db: Database.Database,
  taskId: string
): WorkerTask {
  const task = getTask(db, taskId);
  if (!task) {
    throw new TaskNotFoundError(taskId);
  }
  return task;
}

/**
 * List tasks for a stream with optional filters.
 */
export function listTasks(
  db: Database.Database,
  streamId: string,
  options?: ListTasksOptions
): WorkerTask[] {
  const t = getTables(db);
  let query = `SELECT * FROM ${t.worker_tasks} WHERE stream_id = ?`;
  const params: unknown[] = [streamId];

  if (options?.status) {
    query += ` AND status = ?`;
    params.push(options.status);
  }

  if (options?.agentId) {
    query += ` AND agent_id = ?`;
    params.push(options.agentId);
  }

  query += ` ORDER BY priority ASC, created_at ASC`;

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

/**
 * Update a task's fields.
 */
export function updateTask(
  db: Database.Database,
  taskId: string,
  updates: Partial<Omit<WorkerTask, 'id' | 'createdAt'>>
): void {
  const t = getTables(db);
  getTaskOrThrow(db, taskId); // Verify task exists

  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.title !== undefined) {
    setClauses.push('title = ?');
    params.push(updates.title);
  }
  if (updates.agentId !== undefined) {
    setClauses.push('agent_id = ?');
    params.push(updates.agentId);
  }
  if (updates.branchName !== undefined) {
    setClauses.push('branch_name = ?');
    params.push(updates.branchName);
  }
  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    params.push(updates.status);
  }
  if (updates.startCommit !== undefined) {
    setClauses.push('start_commit = ?');
    params.push(updates.startCommit);
  }
  if (updates.mergeCommit !== undefined) {
    setClauses.push('merge_commit = ?');
    params.push(updates.mergeCommit);
  }
  if (updates.startedAt !== undefined) {
    setClauses.push('started_at = ?');
    params.push(updates.startedAt);
  }
  if (updates.completedAt !== undefined) {
    setClauses.push('completed_at = ?');
    params.push(updates.completedAt);
  }
  if (updates.priority !== undefined) {
    setClauses.push('priority = ?');
    params.push(updates.priority);
  }
  if (updates.metadata !== undefined) {
    setClauses.push('metadata = ?');
    params.push(JSON.stringify(updates.metadata));
  }

  if (setClauses.length === 0) {
    return;
  }

  params.push(taskId);

  db.prepare(`UPDATE ${t.worker_tasks} SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start a task - assigns an agent and creates the worker branch.
 *
 * Creates a new branch from the stream's current HEAD and checks it out
 * in the provided worktree.
 *
 * @param db - Database connection
 * @param repoPath - Path to the git repository
 * @param options - Start task options
 * @returns Branch name and start commit
 */
export function startTask(
  db: Database.Database,
  _repoPath: string,
  options: StartTaskOptions
): StartTaskResult {
  const task = getTaskOrThrow(db, options.taskId);

  // Validate task state
  if (task.status !== 'open') {
    throw new TaskStateError(
      `Cannot start task ${task.id} with status '${task.status}' (must be 'open')`
    );
  }

  // Verify stream is still active
  const stream = streams.getStreamOrThrow(db, task.streamId);
  if (stream.status !== 'active') {
    throw new TaskStateError(
      `Cannot start task on stream ${task.streamId} with status '${stream.status}'`
    );
  }

  // Get stream's current HEAD
  const streamBranch = streams.getStreamBranchName(db, task.streamId);
  const gitOpts = { cwd: options.worktree };
  const startCommit = git.resolveRef(streamBranch, gitOpts);

  // Generate branch name
  const branchName = generateWorkerBranchName(options.agentId, task.id);

  // Create and checkout the worker branch
  git.createBranch(branchName, startCommit, gitOpts);
  git.checkout(branchName, gitOpts);

  // Update task
  const now = Date.now();
  updateTask(db, task.id, {
    agentId: options.agentId,
    branchName,
    status: 'in_progress',
    startCommit,
    startedAt: now,
  });

  return { branchName, startCommit };
}

/**
 * Complete a task - merges the worker branch to the stream.
 *
 * Uses --no-ff to always create a merge commit, preserving full history.
 * If there are conflicts, releases the task back to 'open' status.
 *
 * @param db - Database connection
 * @param repoPath - Path to the git repository
 * @param options - Complete task options
 * @returns Merge commit hash, or throws TaskConflictError on conflicts
 */
export function completeTask(
  db: Database.Database,
  _repoPath: string,
  options: CompleteTaskOptions
): CompleteTaskResult {
  const task = getTaskOrThrow(db, options.taskId);

  // Validate task state
  if (task.status !== 'in_progress') {
    throw new TaskStateError(
      `Cannot complete task ${task.id} with status '${task.status}' (must be 'in_progress')`
    );
  }

  if (!task.branchName) {
    throw new TaskStateError(`Task ${task.id} has no branch name`);
  }

  // Verify stream is still active
  const stream = streams.getStreamOrThrow(db, task.streamId);
  if (stream.status !== 'active') {
    throw new TaskStateError(
      `Cannot complete task on stream ${task.streamId} with status '${stream.status}'`
    );
  }

  const streamBranch = streams.getStreamBranchName(db, task.streamId);
  const gitOpts = { cwd: options.worktree };

  // Get current commit on worker branch (for merge record)
  const sourceCommit = git.resolveRef(task.branchName, gitOpts);

  // Checkout the stream branch
  git.checkout(streamBranch, gitOpts);

  // Attempt merge with --no-ff
  const message = options.message ?? `Merge task: ${task.title}`;

  try {
    git.git(['merge', '--no-ff', task.branchName, '-m', message], gitOpts);
  } catch (error) {
    // Check for conflicts
    const conflicts = git.getConflictedFiles(gitOpts);
    if (conflicts.length > 0) {
      // Abort the merge
      git.mergeAbort(gitOpts);

      // Release task back to open
      releaseTask(db, task.id);

      throw new TaskConflictError(task.id, conflicts);
    }

    // Re-throw non-conflict errors
    throw error;
  }

  const mergeCommit = git.getHead(gitOpts);
  const now = Date.now();

  // Record the merge
  recordTaskMerge(db, {
    taskId: task.id,
    sourceBranch: task.branchName,
    sourceCommit,
    targetStreamId: task.streamId,
    mergeCommit,
    createdBy: task.agentId,
  });

  // Update task status
  updateTask(db, task.id, {
    status: 'completed',
    mergeCommit,
    completedAt: now,
  });

  return { mergeCommit };
}

/**
 * Abandon a task - marks it as abandoned and optionally deletes the branch.
 *
 * @param db - Database connection
 * @param repoPath - Path to the git repository
 * @param taskId - Task ID
 * @param options - Options (deleteBranch: whether to delete the git branch)
 */
export function abandonTask(
  db: Database.Database,
  repoPath: string,
  taskId: string,
  options?: { deleteBranch?: boolean }
): void {
  const task = getTaskOrThrow(db, taskId);

  if (task.status === 'completed') {
    throw new TaskStateError(`Cannot abandon completed task ${taskId}`);
  }

  // Delete the branch if requested and it exists
  if (options?.deleteBranch !== false && task.branchName) {
    try {
      git.deleteBranch(task.branchName, true, { cwd: repoPath });
    } catch {
      // Ignore errors - branch may not exist
    }
  }

  updateTask(db, taskId, {
    status: 'abandoned',
  });
}

/**
 * Release a task back to 'open' status.
 *
 * Used for recovery from conflicts or stuck tasks.
 * Keeps the branch name so work isn't lost.
 *
 * @param db - Database connection
 * @param taskId - Task ID
 */
export function releaseTask(db: Database.Database, taskId: string): void {
  const task = getTaskOrThrow(db, taskId);

  if (task.status === 'completed') {
    throw new TaskStateError(`Cannot release completed task ${taskId}`);
  }

  if (task.status === 'abandoned') {
    throw new TaskStateError(`Cannot release abandoned task ${taskId}`);
  }

  updateTask(db, taskId, {
    status: 'open',
    agentId: null,
    // Keep branchName so work isn't lost
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Task Merge Records
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a task merge event.
 */
export function recordTaskMerge(
  db: Database.Database,
  options: {
    taskId: string;
    sourceBranch: string;
    sourceCommit: string;
    targetStreamId: string;
    mergeCommit: string;
    createdBy?: string | null;
    metadata?: Record<string, unknown>;
  }
): string {
  const t = getTables(db);
  const id = generateMergeId();
  const now = Date.now();

  db.prepare(`
    INSERT INTO ${t.task_merges} (
      id, task_id, source_branch, source_commit, target_stream_id,
      merge_commit, created_at, created_by, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    options.taskId,
    options.sourceBranch,
    options.sourceCommit,
    options.targetStreamId,
    options.mergeCommit,
    now,
    options.createdBy ?? null,
    JSON.stringify(options.metadata ?? {})
  );

  return id;
}

/**
 * Get task merge records for a task.
 */
export function getTaskMerges(
  db: Database.Database,
  taskId: string
): TaskMerge[] {
  const t = getTables(db);
  const rows = db
    .prepare(`SELECT * FROM ${t.task_merges} WHERE task_id = ? ORDER BY created_at ASC`)
    .all(taskId) as Record<string, unknown>[];

  return rows.map(rowToTaskMerge);
}

/**
 * Get task merge records for a stream.
 */
export function getStreamTaskMerges(
  db: Database.Database,
  streamId: string
): TaskMerge[] {
  const t = getTables(db);
  const rows = db
    .prepare(`SELECT * FROM ${t.task_merges} WHERE target_stream_id = ? ORDER BY created_at ASC`)
    .all(streamId) as Record<string, unknown>[];

  return rows.map(rowToTaskMerge);
}

// ─────────────────────────────────────────────────────────────────────────────
// Conflict Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if completing a task would result in merge conflicts.
 *
 * Performs a dry-run merge to detect conflicts without modifying the repository.
 *
 * @param db - Database connection
 * @param repoPath - Path to the git repository
 * @param taskId - Task ID
 * @param worktree - Worktree path for git operations
 * @returns List of conflicting files, or empty array if no conflicts
 */
export function detectTaskConflicts(
  db: Database.Database,
  _repoPath: string,
  taskId: string,
  worktree: string
): string[] {
  const task = getTaskOrThrow(db, taskId);

  if (!task.branchName) {
    return [];
  }

  const streamBranch = streams.getStreamBranchName(db, task.streamId);
  const gitOpts = { cwd: worktree };

  // Save current branch
  const currentBranch = git.git(['rev-parse', '--abbrev-ref', 'HEAD'], gitOpts);

  try {
    // Checkout stream branch
    git.checkout(streamBranch, gitOpts);

    // Try merge with --no-commit --no-ff
    try {
      git.git(['merge', '--no-commit', '--no-ff', task.branchName], gitOpts);
      // No conflicts - abort the merge
      git.git(['merge', '--abort'], gitOpts);
      return [];
    } catch {
      const conflicts = git.getConflictedFiles(gitOpts);
      // Abort the merge
      try {
        git.git(['merge', '--abort'], gitOpts);
      } catch {
        // May fail if merge wasn't started
      }
      return conflicts;
    }
  } finally {
    // Restore original branch
    try {
      git.checkout(currentBranch, gitOpts);
    } catch {
      // Ignore errors restoring branch
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Maintenance Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clean up old worker branches.
 *
 * Deletes branches for:
 * - Completed tasks older than threshold
 * - Abandoned tasks
 * - Orphaned branches (no task record)
 *
 * @param db - Database connection
 * @param repoPath - Path to the git repository
 * @param options - Cleanup options
 * @returns Deleted branches and any errors
 */
export function cleanupWorkerBranches(
  db: Database.Database,
  repoPath: string,
  options?: CleanupWorkerBranchesOptions
): CleanupResult {
  const t = getTables(db);
  const threshold = options?.olderThanMs ?? 24 * 60 * 60 * 1000; // 24 hours default
  const cutoff = Date.now() - threshold;
  const gitOpts = { cwd: repoPath };

  const deleted: string[] = [];
  const errors: string[] = [];

  // Get all worker branches from git
  let branches: string[];
  try {
    const output = git.git(['branch', '--list', 'worker/*'], gitOpts);
    branches = output
      .split('\n')
      .map((b) => b.trim().replace(/^\* /, ''))
      .filter(Boolean);
  } catch {
    return { deleted, errors: ['Failed to list branches'] };
  }

  for (const branchName of branches) {
    // Check if this branch has a task record
    const task = db
      .prepare(`SELECT * FROM ${t.worker_tasks} WHERE branch_name = ?`)
      .get(branchName) as Record<string, unknown> | undefined;

    if (!task) {
      // Orphaned branch - no task record
      if (!options?.orphanedOnly || options.orphanedOnly) {
        try {
          git.deleteBranch(branchName, true, gitOpts);
          deleted.push(branchName);
        } catch (err) {
          errors.push(`Failed to delete orphaned branch ${branchName}: ${err}`);
        }
      }
      continue;
    }

    if (options?.orphanedOnly) {
      continue;
    }

    const taskObj = rowToTask(task);

    // Delete completed tasks older than threshold
    if (taskObj.status === 'completed' && taskObj.completedAt && taskObj.completedAt <= cutoff) {
      try {
        git.deleteBranch(branchName, true, gitOpts);
        // Clear branch name from task record
        updateTask(db, taskObj.id, { branchName: null });
        deleted.push(branchName);
      } catch (err) {
        errors.push(`Failed to delete completed branch ${branchName}: ${err}`);
      }
      continue;
    }

    // Delete abandoned task branches
    if (taskObj.status === 'abandoned') {
      try {
        git.deleteBranch(branchName, true, gitOpts);
        updateTask(db, taskObj.id, { branchName: null });
        deleted.push(branchName);
      } catch (err) {
        errors.push(`Failed to delete abandoned branch ${branchName}: ${err}`);
      }
    }
  }

  return { deleted, errors };
}

/**
 * Recover tasks stuck in 'in_progress' status.
 *
 * Releases tasks that have been in_progress for longer than the threshold,
 * indicating the agent may have crashed.
 *
 * @param db - Database connection
 * @param thresholdMs - Time in ms after which tasks are considered stuck (default: 1 hour)
 * @returns Released task IDs
 */
export function recoverStaleTasks(
  db: Database.Database,
  thresholdMs: number = 60 * 60 * 1000
): RecoverTasksResult {
  const t = getTables(db);
  const cutoff = Date.now() - thresholdMs;

  // Find tasks that have been in_progress for too long
  const staleTasks = db
    .prepare(
      `SELECT * FROM ${t.worker_tasks}
       WHERE status = 'in_progress' AND started_at < ?`
    )
    .all(cutoff) as Record<string, unknown>[];

  const released: string[] = [];

  for (const row of staleTasks) {
    const task = rowToTask(row);
    // Release the task back to 'open' state
    updateTask(db, task.id, {
      status: 'open',
      agentId: null,
      // Keep branchName so work isn't lost
    });
    released.push(task.id);
  }

  return { released };
}

// ─────────────────────────────────────────────────────────────────────────────
// Query Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get count of tasks by status for a stream.
 */
export function getTaskCounts(
  db: Database.Database,
  streamId: string
): Record<WorkerTaskStatus, number> {
  const t = getTables(db);
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) as count FROM ${t.worker_tasks}
       WHERE stream_id = ? GROUP BY status`
    )
    .all(streamId) as Array<{ status: string; count: number }>;

  const counts: Record<WorkerTaskStatus, number> = {
    open: 0,
    in_progress: 0,
    completed: 0,
    abandoned: 0,
  };

  for (const row of rows) {
    counts[row.status as WorkerTaskStatus] = row.count;
  }

  return counts;
}

/**
 * Get the next available task for a stream (highest priority, oldest).
 */
export function getNextTask(
  db: Database.Database,
  streamId: string
): WorkerTask | null {
  const t = getTables(db);
  const row = db
    .prepare(
      `SELECT * FROM ${t.worker_tasks}
       WHERE stream_id = ? AND status = 'open'
       ORDER BY priority ASC, created_at ASC
       LIMIT 1`
    )
    .get(streamId) as Record<string, unknown> | undefined;

  return row ? rowToTask(row) : null;
}
