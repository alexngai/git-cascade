/**
 * Operation checkpoint management and recovery.
 *
 * Provides:
 * - Checkpoint tracking for multi-step operations (crash recovery)
 * - Health check to assess system state
 * - Startup recovery to clean up after crashes
 */

import type Database from 'better-sqlite3';
import { getTables } from './db/tables.js';
import { resetHard } from './git/commands.js';
import * as guards from './guards.js';
import * as snapshots from './snapshots.js';
import * as conflicts from './conflicts.js';
import * as gc from './gc.js';
import * as streams from './streams.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of a health check on the system.
 */
export interface HealthCheckResult {
  /** Whether the system is healthy (no issues found) */
  healthy: boolean;
  /** List of issues found during health check */
  issues: string[];
  /** Number of active streams */
  streamCount: number;
  /** Number of archived streams */
  archivedCount: number;
  /** Number of active agents (guards touched within last 60 seconds) */
  activeAgents: number;
  /** Number of stale locks (older than 5 minutes) */
  staleLocks: number;
  /** Number of incomplete operations (checkpoints) */
  incompleteOps: number;
  /** Number of orphaned conflicts (in_progress without active rebase) */
  orphanedConflicts: number;
  /** Number of pending snapshots */
  pendingSnapshots: number;
}

/** Stale lock threshold: 5 minutes */
const STALE_LOCK_THRESHOLD_MS = 5 * 60 * 1000;

/** Active agent threshold: 60 seconds */
const ACTIVE_AGENT_THRESHOLD_S = 60;

/**
 * Check system health.
 *
 * Performs a comprehensive check of the system state including:
 * - Stream counts (active and archived)
 * - Active agents (guards within last 60s)
 * - Stale locks (older than 5 minutes)
 * - Incomplete operations (checkpoints)
 * - Orphaned conflicts (in_progress status without active resolution)
 * - Pending snapshots
 *
 * @param db - Database connection
 * @param _repoPath - Repository path (reserved for future use)
 * @returns Health check result with counts and issues
 */
export function healthCheck(
  db: Database.Database,
  _repoPath: string
): HealthCheckResult {
  const t = getTables(db);
  const issues: string[] = [];

  // Count streams
  const streamCount = (
    db.prepare(`SELECT COUNT(*) as count FROM ${t.streams}`).get() as { count: number }
  ).count;

  // Count archived streams
  const archivedCount = gc.listArchivedStreams(db).length;

  // Count active agents (guards within last 60 seconds)
  const activeGuards = guards.listActiveGuards(db, ACTIVE_AGENT_THRESHOLD_S);
  const activeAgents = activeGuards.length;

  // Find stale locks (older than 5 minutes)
  const staleLockThreshold = Date.now() - STALE_LOCK_THRESHOLD_MS;
  const staleLocks = (
    db.prepare(`SELECT COUNT(*) as count FROM ${t.stream_locks} WHERE acquired_at < ?`)
      .get(staleLockThreshold) as { count: number }
  ).count;

  if (staleLocks > 0) {
    issues.push(`${staleLocks} stale lock(s) found (older than 5 minutes)`);
  }

  // Find incomplete operations
  const incompleteCheckpoints = getIncompleteCheckpoints(db);
  const incompleteOps = incompleteCheckpoints.length;

  if (incompleteOps > 0) {
    issues.push(`${incompleteOps} incomplete operation(s) found`);
  }

  // Find orphaned conflicts (in_progress status)
  // These are conflicts that were being resolved but the process crashed
  const staleConflicts = conflicts.getStaleConflicts(db, 0);
  const orphanedConflicts = staleConflicts.length;

  if (orphanedConflicts > 0) {
    issues.push(`${orphanedConflicts} orphaned conflict(s) found (in_progress status)`);
  }

  // Count pending snapshots
  const pendingSnapshots = snapshots.listSnapshots(db).length;

  return {
    healthy: issues.length === 0,
    issues,
    streamCount,
    archivedCount,
    activeAgents,
    staleLocks,
    incompleteOps,
    orphanedConflicts,
    pendingSnapshots,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup Recovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of startup recovery operations.
 */
export interface StartupRecoveryResult {
  /** Number of incomplete operations recovered */
  recoveredOperations: number;
  /** Number of stale locks released */
  releasedLocks: number;
  /** Number of orphaned conflicts recovered */
  recoveredConflicts: number;
  /** Number of streams cleaned from conflicted status */
  cleanedStreams: number;
  /** Log of actions taken */
  log: string[];
}

/**
 * Run startup recovery to clean up after crashes.
 *
 * Performs the following recovery actions:
 * 1. Recover incomplete operations (clear checkpoints without git reset since we don't have worktree info)
 * 2. Release stale locks (older than 5 minutes)
 * 3. Recover orphaned conflicts (in_progress without active rebase)
 *
 * Each action is logged for transparency.
 *
 * @param db - Database connection
 * @param _repoPath - Repository path (reserved for future use)
 * @returns Recovery result with counts and log
 */
export function startupRecovery(
  db: Database.Database,
  _repoPath: string
): StartupRecoveryResult {
  const t = getTables(db);
  const log: string[] = [];
  let recoveredOperations = 0;
  let releasedLocks = 0;
  let recoveredConflicts = 0;
  let cleanedStreams = 0;

  // ─────────────────────────────────────────────────────────────────────────
  // Step 1: Recover incomplete operations
  // ─────────────────────────────────────────────────────────────────────────
  const incompleteCheckpoints = getIncompleteCheckpoints(db);
  for (const checkpoint of incompleteCheckpoints) {
    // We can't do git reset without worktree info, so just clear the checkpoint
    // The git state may be inconsistent, but at least we won't block future operations
    completeCheckpoint(db, checkpoint.operationId);
    log.push(
      `Cleared incomplete checkpoint: ${checkpoint.operationId} ` +
      `(stream: ${checkpoint.streamId}, op: ${checkpoint.opType}, step: ${checkpoint.step}/${checkpoint.totalSteps})`
    );
    recoveredOperations++;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2: Release stale locks
  // ─────────────────────────────────────────────────────────────────────────
  const staleLockThreshold = Date.now() - STALE_LOCK_THRESHOLD_MS;
  const staleLocksResult = db
    .prepare(`DELETE FROM ${t.stream_locks} WHERE acquired_at < ?`)
    .run(staleLockThreshold);

  releasedLocks = staleLocksResult.changes;
  if (releasedLocks > 0) {
    log.push(`Released ${releasedLocks} stale lock(s) (older than 5 minutes)`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3: Recover orphaned conflicts
  // ─────────────────────────────────────────────────────────────────────────
  // Use 1 hour threshold as per the existing recoverOrphanedConflicts implementation
  const orphanedResult = streams.recoverOrphanedConflicts(db, 60 * 60 * 1000);

  recoveredConflicts = orphanedResult.recovered.length;
  cleanedStreams = orphanedResult.streamsCleaned.length;

  for (const conflictId of orphanedResult.recovered) {
    log.push(`Recovered orphaned conflict: ${conflictId}`);
  }

  for (const streamId of orphanedResult.streamsCleaned) {
    log.push(`Cleaned conflicted status from stream: ${streamId}`);
  }

  return {
    recoveredOperations,
    releasedLocks,
    recoveredConflicts,
    cleanedStreams,
    log,
  };
}
