/**
 * Operation data model and types.
 *
 * An Operation represents a single mutation to repository state.
 * Operations form a DAG for audit trail and rollback.
 */

export type OperationType =
  | 'commit'        // New commit added
  | 'amend'         // Existing commit modified
  | 'rebase'        // Stream rebased onto new base
  | 'merge'         // Another stream merged in
  | 'cherry_pick'   // Specific commit(s) copied
  | 'rollback'      // State rolled back
  | 'reset'         // Hard reset to specific commit
  | 'stack_reorder'; // Stack entries reordered

export interface Operation {
  /** Unique identifier */
  id: string;
  /** Stream this operation belongs to */
  streamId: string;
  /** Agent that performed the operation */
  agentId: string;
  /** Type of operation */
  opType: OperationType;
  /** Commit hash before operation */
  beforeState: string;
  /** Commit hash after operation */
  afterState: string;
  /** Parent operation IDs (usually 1, can be 2 for merges) */
  parentOps: string[];
  /** Unix timestamp (ms) */
  timestamp: number;
  /** Operation-specific data */
  metadata: Record<string, unknown>;
}

export interface RecordOperationOptions {
  streamId: string;
  agentId: string;
  opType: OperationType;
  beforeState: string;
  afterState: string;
  parentOps?: string[];
  metadata?: Record<string, unknown>;
}
