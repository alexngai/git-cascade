/**
 * Stack entry data model and types.
 *
 * A Stack is an ordered list of commits within a stream,
 * intended for incremental review (opt-in feature).
 */

export type ReviewStatus = 'draft' | 'review' | 'approved' | 'merged';

export interface StackEntry {
  /** Unique identifier */
  id: string;
  /** Parent stream ID */
  streamId: string;
  /** Current commit hash (changes on rebase) */
  commitHash: string;
  /** Order in stack (0 = bottom/oldest) */
  position: number;
  /** Commit message or custom description */
  description: string;
  /** Review status */
  reviewStatus: ReviewStatus;
  /** Reviewer identifier */
  reviewedBy: string | null;
  /** Review timestamp (ms) */
  reviewedAt: number | null;
  /** Original commit hash (stable across rebases) */
  originalCommit: string;
}

export interface AddToStackOptions {
  streamId: string;
  commit: string;
  description?: string;
}

export interface SetReviewStatusOptions {
  stackEntryId: string;
  status: ReviewStatus;
  reviewer?: string;
}
