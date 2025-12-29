/**
 * Conflict model types.
 *
 * Types for conflict tracking and resolution.
 */

/**
 * Status of a conflict record.
 */
export type ConflictStatus = 'pending' | 'in_progress' | 'resolved' | 'abandoned';

/**
 * How a conflict was resolved.
 */
export interface ConflictResolution {
  /** Resolution method */
  method: 'ours' | 'theirs' | 'manual' | 'agent';
  /** Who resolved it (agentId or 'human') */
  resolvedBy: string;
  /** Optional details about the resolution */
  details?: string;
}

/**
 * A conflict record.
 */
export interface ConflictRecord {
  /** Unique identifier (cf-xxxxxxxx) */
  id: string;
  /** Stream that has the conflict */
  streamId: string;
  /** Operation that caused the conflict (if any) */
  operationId: string | null;
  /** Commit being rebased/merged */
  conflictingCommit: string;
  /** Commit being rebased/merged onto */
  targetCommit: string;
  /** List of files with conflicts */
  conflictedFiles: string[];
  /** Current status */
  status: ConflictStatus;
  /** When the conflict was created */
  createdAt: number;
  /** When the conflict was resolved (if resolved) */
  resolvedAt: number | null;
  /** Resolution details (if resolved) */
  resolution: ConflictResolution | null;
}

/**
 * Options for creating a conflict record.
 */
export interface CreateConflictOptions {
  streamId: string;
  operationId?: string;
  conflictingCommit: string;
  targetCommit: string;
  conflictedFiles: string[];
}

/**
 * Options for listing conflicts.
 */
export interface ListConflictsOptions {
  streamId?: string;
  status?: ConflictStatus;
  limit?: number;
}
