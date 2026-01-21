/**
 * Worker Task data model and types.
 *
 * A WorkerTask is a short-lived, ephemeral unit of work that maps to a
 * temporary git branch. Tasks are created under a stream (integration branch)
 * and merged back with a merge commit to preserve history.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Task Types
// ─────────────────────────────────────────────────────────────────────────────

export type WorkerTaskStatus = 'open' | 'in_progress' | 'completed' | 'abandoned';

export interface WorkerTask {
  /** Unique identifier (e.g., "wt-abc123") */
  id: string;
  /** Task description/title */
  title: string;
  /** Parent stream (integration branch) */
  streamId: string;
  /** Assigned agent (null = unassigned) */
  agentId: string | null;
  /** Ephemeral branch name (null until task is started) */
  branchName: string | null;
  /** Current status */
  status: WorkerTaskStatus;
  /** Commit SHA of stream HEAD when task started */
  startCommit: string | null;
  /** Merge commit SHA when task completed */
  mergeCommit: string | null;
  /** Unix timestamp (ms) when created */
  createdAt: number;
  /** Unix timestamp (ms) when task was started */
  startedAt: number | null;
  /** Unix timestamp (ms) when task was completed */
  completedAt: number | null;
  /** Priority (lower = higher priority, default: 100) */
  priority: number;
  /** Extensible metadata */
  metadata: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task Merge Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record of a task merge event.
 * Created when a worker task is completed and merged to its parent stream.
 */
export interface TaskMerge {
  /** Unique identifier for this merge event */
  id: string;
  /** Task that was merged */
  taskId: string;
  /** Worker branch that was merged */
  sourceBranch: string;
  /** Commit SHA in the worker branch that was merged */
  sourceCommit: string;
  /** Stream that was merged into */
  targetStreamId: string;
  /** Resulting merge commit SHA */
  mergeCommit: string;
  /** Unix timestamp (ms) when merge was recorded */
  createdAt: number;
  /** Agent that performed the merge */
  createdBy: string | null;
  /** Extensible metadata */
  metadata: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task Options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for creating a new worker task.
 */
export interface CreateTaskOptions {
  /** Task description/title */
  title: string;
  /** Parent stream ID */
  streamId: string;
  /** Priority (default: 100, lower = higher priority) */
  priority?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for starting a task.
 * Assigns an agent and creates the ephemeral worker branch.
 */
export interface StartTaskOptions {
  /** Task ID to start */
  taskId: string;
  /** Agent to assign */
  agentId: string;
  /** Worktree path for git operations */
  worktree: string;
}

/**
 * Options for completing a task.
 * Merges the worker branch to the parent stream with --no-ff.
 */
export interface CompleteTaskOptions {
  /** Task ID to complete */
  taskId: string;
  /** Worktree path for git operations */
  worktree: string;
  /** Optional merge commit message (default: "Merge task: <title>") */
  message?: string;
}

/**
 * Options for listing tasks.
 */
export interface ListTasksOptions {
  /** Filter by status */
  status?: WorkerTaskStatus;
  /** Filter by assigned agent */
  agentId?: string;
}

/**
 * Options for cleaning up worker branches.
 */
export interface CleanupWorkerBranchesOptions {
  /** Delete completed task branches older than this (default: 24h) */
  olderThanMs?: number;
  /** Only delete orphaned branches (no task record) */
  orphanedOnly?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task Results
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of starting a task.
 */
export interface StartTaskResult {
  /** Created worker branch name */
  branchName: string;
  /** Commit SHA of stream HEAD when task started */
  startCommit: string;
}

/**
 * Result of completing a task.
 */
export interface CompleteTaskResult {
  /** Merge commit SHA */
  mergeCommit: string;
}

/**
 * Result of cleaning up worker branches.
 */
export interface CleanupResult {
  /** Branches that were deleted */
  deleted: string[];
  /** Errors encountered during cleanup */
  errors: string[];
}

/**
 * Result of recovering stale tasks.
 */
export interface RecoverTasksResult {
  /** Task IDs that were released */
  released: string[];
}
