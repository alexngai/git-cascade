/**
 * Operation checkpoint management for crash recovery.
 *
 * Tracks multi-step operations (like cascade rebase) so they can be
 * recovered if a crash occurs mid-operation.
 */

import type Database from 'better-sqlite3';
import { getTables } from './db/tables.js';
import { resetHard } from './git/commands.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface OperationCheckpoint {
  operationId: string;
  streamId: string;
  opType: string;
  step: number;
  totalSteps: number;
  beforeState: string;
  currentState: string;
  startedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert database row to OperationCheckpoint.
 */
function rowToCheckpoint(row: Record<string, unknown>): OperationCheckpoint {
  return {
    operationId: row.operation_id as string,
    streamId: row.stream_id as string,
    opType: row.op_type as string,
    step: row.step as number,
    totalSteps: row.total_steps as number,
    beforeState: row.before_state as string,
    currentState: row.current_state as string,
    startedAt: row.started_at as number,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkpoint Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create or update an operation checkpoint.
 *
 * Records the current state during a multi-step operation for crash recovery.
 * Uses INSERT OR REPLACE for upsert behavior.
 *
 * @param db - Database connection
 * @param data - Checkpoint data
 */
export function checkpoint(db: Database.Database, data: OperationCheckpoint): void {
  const t = getTables(db);

  db.prepare(`
    INSERT OR REPLACE INTO ${t.operation_checkpoints} (
      operation_id, stream_id, op_type, step, total_steps,
      before_state, current_state, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.operationId,
    data.streamId,
    data.opType,
    data.step,
    data.totalSteps,
    data.beforeState,
    data.currentState,
    data.startedAt
  );
}

/**
 * Complete (remove) a checkpoint after successful operation.
 *
 * Call this when a multi-step operation completes successfully
 * to clean up the checkpoint record.
 *
 * @param db - Database connection
 * @param operationId - The operation ID to remove
 */
export function completeCheckpoint(db: Database.Database, operationId: string): void {
  const t = getTables(db);
  db.prepare(`DELETE FROM ${t.operation_checkpoints} WHERE operation_id = ?`).run(operationId);
}

/**
 * Get a checkpoint by operation ID.
 *
 * @param db - Database connection
 * @param operationId - The operation ID to look up
 * @returns The checkpoint if found, null otherwise
 */
export function getCheckpoint(
  db: Database.Database,
  operationId: string
): OperationCheckpoint | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.operation_checkpoints} WHERE operation_id = ?`)
    .get(operationId) as Record<string, unknown> | undefined;

  return row ? rowToCheckpoint(row) : null;
}

/**
 * Get all incomplete operation checkpoints.
 *
 * Returns checkpoints where step < totalSteps, indicating operations
 * that did not complete (likely due to crash).
 *
 * @param db - Database connection
 * @returns Array of incomplete checkpoints
 */
export function getIncompleteCheckpoints(db: Database.Database): OperationCheckpoint[] {
  const t = getTables(db);
  const rows = db
    .prepare(`
      SELECT * FROM ${t.operation_checkpoints}
      WHERE step < total_steps
      ORDER BY started_at ASC
    `)
    .all() as Record<string, unknown>[];

  return rows.map(rowToCheckpoint);
}

/**
 * Get all checkpoints (including complete ones).
 *
 * @param db - Database connection
 * @returns Array of all checkpoints
 */
export function getAllCheckpoints(db: Database.Database): OperationCheckpoint[] {
  const t = getTables(db);
  const rows = db
    .prepare(`SELECT * FROM ${t.operation_checkpoints} ORDER BY started_at ASC`)
    .all() as Record<string, unknown>[];

  return rows.map(rowToCheckpoint);
}

/**
 * Recover from a crashed operation by resetting to before_state.
 *
 * Performs a hard reset on the worktree to the state before the
 * operation started. After reset, removes the checkpoint record.
 *
 * @param db - Database connection
 * @param repoPath - Path to the git repository
 * @param checkpoint - The checkpoint to recover from
 * @param worktree - Path to the worktree to reset
 */
export function recoverCheckpoint(
  db: Database.Database,
  _repoPath: string,
  checkpointData: OperationCheckpoint,
  worktree: string
): void {
  // Reset the worktree to the before state
  resetHard(checkpointData.beforeState, { cwd: worktree });

  // Remove the checkpoint after successful recovery
  completeCheckpoint(db, checkpointData.operationId);
}

/**
 * Get checkpoints for a specific stream.
 *
 * @param db - Database connection
 * @param streamId - The stream ID to filter by
 * @returns Array of checkpoints for the stream
 */
export function getCheckpointsForStream(
  db: Database.Database,
  streamId: string
): OperationCheckpoint[] {
  const t = getTables(db);
  const rows = db
    .prepare(`
      SELECT * FROM ${t.operation_checkpoints}
      WHERE stream_id = ?
      ORDER BY started_at ASC
    `)
    .all(streamId) as Record<string, unknown>[];

  return rows.map(rowToCheckpoint);
}

/**
 * Delete all checkpoints for a stream.
 *
 * Useful during stream cleanup/archival.
 *
 * @param db - Database connection
 * @param streamId - The stream ID to clean up
 */
export function deleteCheckpointsForStream(
  db: Database.Database,
  streamId: string
): void {
  const t = getTables(db);
  db.prepare(`DELETE FROM ${t.operation_checkpoints} WHERE stream_id = ?`).run(streamId);
}
