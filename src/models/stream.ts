/**
 * Stream data model and types.
 *
 * A Stream is a logical unit of work that maps 1:1 to a git branch.
 */

export type StreamStatus = 'active' | 'paused' | 'merged' | 'abandoned';

export interface Stream {
  /** Unique identifier (e.g., "abc12345") */
  id: string;
  /** Human-readable name (e.g., "feature-auth") */
  name: string;
  /** Owning agent identifier */
  agentId: string;
  /** Commit hash where stream branched from */
  baseCommit: string;
  /** ID of parent stream if forked */
  parentStream: string | null;
  /** Current status */
  status: StreamStatus;
  /** Unix timestamp (ms) when created */
  createdAt: number;
  /** Unix timestamp (ms) when last updated */
  updatedAt: number;
  /** Target stream ID if merged */
  mergedInto: string | null;
  /** Opt-in: track commits as reviewable stack entries */
  enableStackedReview: boolean;
  /** Extensible metadata */
  metadata: Record<string, unknown>;
}

export interface CreateStreamOptions {
  name: string;
  agentId: string;
  /** Branch or commit to base from (default: "main") */
  base?: string;
  /** Parent stream ID if forking */
  parentStream?: string;
  /** Enable stacked review workflow */
  enableStackedReview?: boolean;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface ForkStreamOptions {
  parentStreamId: string;
  name: string;
  agentId: string;
}

export type MergeStrategy = 'merge-commit' | 'squash' | 'rebase';

export interface MergeStreamOptions {
  sourceStream: string;
  targetStream: string;
  agentId: string;
  worktree: string;
  strategy?: MergeStrategy;
}

export interface MergeResult {
  success: boolean;
  newHead?: string;
  conflicts?: string[];
  error?: string;
}
