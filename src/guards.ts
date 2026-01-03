/**
 * Stream guard operations for optimistic concurrency control.
 *
 * Guards track "who wrote last" to detect concurrent modifications
 * without blocking. They enable optimistic concurrency - operations
 * proceed without locking, but validate before committing that no
 * other agent has written since the operation started.
 */

import type Database from 'better-sqlite3';
import { getTables } from './db/tables.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamGuard {
  streamId: string;
  agentId: string;
  lastWrite: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert database row to StreamGuard.
 */
function rowToStreamGuard(row: Record<string, unknown>): StreamGuard {
  return {
    streamId: row.stream_id as string,
    agentId: row.agent_id as string,
    lastWrite: row.last_write as number,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Touch guard after successful write.
 *
 * Updates the guard record to indicate that the specified agent has just
 * written to the stream. Uses INSERT OR REPLACE for upsert behavior.
 *
 * @param db - Database connection
 * @param streamId - The stream that was written to
 * @param agentId - The agent that performed the write
 */
export function touchGuard(
  db: Database.Database,
  streamId: string,
  agentId: string
): void {
  const t = getTables(db);
  const now = Date.now();

  db.prepare(`
    INSERT OR REPLACE INTO ${t.stream_guards} (stream_id, agent_id, last_write)
    VALUES (?, ?, ?)
  `).run(streamId, agentId, now);
}

/**
 * Validate no one else wrote since timestamp.
 *
 * Returns true if either:
 * - No guard exists (no one has written yet)
 * - The same agent was the last writer
 * - The last write was before the given timestamp
 *
 * Returns false if another agent wrote after the timestamp.
 *
 * @param db - Database connection
 * @param streamId - The stream to validate
 * @param agentId - The agent performing the validation
 * @param sinceTimestamp - The timestamp to check against (when the agent last read)
 * @returns true if validation passes, false if concurrent modification detected
 */
export function validateGuard(
  db: Database.Database,
  streamId: string,
  agentId: string,
  sinceTimestamp: number
): boolean {
  const guard = getGuard(db, streamId);

  // No guard exists - no one has written yet, safe to proceed
  if (!guard) {
    return true;
  }

  // Same agent was last writer - safe to proceed
  if (guard.agentId === agentId) {
    return true;
  }

  // Another agent wrote, but before our read timestamp - safe to proceed
  if (guard.lastWrite <= sinceTimestamp) {
    return true;
  }

  // Another agent wrote after our read timestamp - concurrent modification!
  return false;
}

/**
 * Clear guard (on stream delete/archive).
 *
 * Removes the guard record for a stream, typically called when
 * the stream is deleted or archived.
 *
 * @param db - Database connection
 * @param streamId - The stream to clear the guard for
 */
export function clearGuard(db: Database.Database, streamId: string): void {
  const t = getTables(db);
  db.prepare(`DELETE FROM ${t.stream_guards} WHERE stream_id = ?`).run(streamId);
}

/**
 * Get current guard state.
 *
 * @param db - Database connection
 * @param streamId - The stream to get the guard for
 * @returns The guard record if it exists, null otherwise
 */
export function getGuard(
  db: Database.Database,
  streamId: string
): StreamGuard | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.stream_guards} WHERE stream_id = ?`)
    .get(streamId) as Record<string, unknown> | undefined;

  return row ? rowToStreamGuard(row) : null;
}

/**
 * List all guards with recent activity (for health check).
 *
 * Returns guards where the last write was within the specified
 * number of seconds. Useful for monitoring active streams and
 * detecting stale or orphaned guards.
 *
 * @param db - Database connection
 * @param withinSeconds - Time window in seconds
 * @returns Array of active guards
 */
export function listActiveGuards(
  db: Database.Database,
  withinSeconds: number
): StreamGuard[] {
  const t = getTables(db);
  const cutoff = Date.now() - withinSeconds * 1000;

  const rows = db
    .prepare(`
      SELECT * FROM ${t.stream_guards}
      WHERE last_write >= ?
      ORDER BY last_write DESC
    `)
    .all(cutoff) as Record<string, unknown>[];

  return rows.map(rowToStreamGuard);
}
