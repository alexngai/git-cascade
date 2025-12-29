/**
 * Change identity models.
 *
 * Changes provide stable identity tracking across git rebases.
 * Each change has a unique ID (Change-Id) that survives commit rewrites.
 */

/**
 * Status of a change in its lifecycle.
 */
export type ChangeStatus = 'active' | 'squashed' | 'dropped' | 'merged';

/**
 * Record of a commit hash associated with a change.
 */
export interface CommitRecord {
  /** The commit hash */
  commit: string;
  /** When this commit was recorded */
  recordedAt: number;
  /** Why this commit was recorded */
  reason: 'initial' | 'rebase' | 'amend' | 'squash_target';
}

/**
 * A logical change that survives rebases.
 *
 * Changes are identified by a stable ID (matching the Change-Id trailer
 * in commit messages) and track their commit history across rewrites.
 */
export interface Change {
  /** Stable change ID (matches Change-Id trailer, format: c-xxxxxxxx) */
  id: string;
  /** Stream this change belongs to */
  streamId: string;
  /** Description of the change (usually first line of commit message) */
  description: string;
  /** History of commits for this change (newest first) */
  commitHistory: CommitRecord[];
  /** Current commit hash (null if squashed/dropped) */
  currentCommit: string | null;
  /** Current status */
  status: ChangeStatus;
  /** If squashed, the change ID it was squashed into */
  squashedInto?: string;
  /** If split from another change, the original change ID */
  splitFrom?: string;
}

/**
 * Options for creating a change.
 */
export interface CreateChangeOptions {
  /** Stream the change belongs to */
  streamId: string;
  /** Initial commit hash */
  commit: string;
  /** Description (usually first line of commit message) */
  description: string;
  /** Optional explicit change ID (auto-generated if not provided) */
  changeId?: string;
}
