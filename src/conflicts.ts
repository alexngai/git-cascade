/**
 * Conflict record management.
 *
 * Tracks conflicts that occur during rebase/merge operations,
 * enabling deferred resolution and crash recovery.
 */

import type Database from 'better-sqlite3';
import * as crypto from 'crypto';
import { getTables } from './db/tables.js';
import type {
  ConflictRecord,
  ConflictStatus,
  ConflictResolution,
  CreateConflictOptions,
  ListConflictsOptions,
} from './models/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a unique conflict ID.
 */
function generateConflictId(): string {
  return `cf-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Convert database row to ConflictRecord.
 */
function rowToConflictRecord(row: Record<string, unknown>): ConflictRecord {
  return {
    id: row.id as string,
    streamId: row.stream_id as string,
    operationId: row.operation_id as string | null,
    conflictingCommit: row.conflicting_commit as string,
    targetCommit: row.target_commit as string,
    conflictedFiles: JSON.parse((row.conflicted_files as string) || '[]'),
    status: row.status as ConflictStatus,
    createdAt: row.created_at as number,
    resolvedAt: row.resolved_at as number | null,
    resolution: row.resolution ? JSON.parse(row.resolution as string) : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new conflict record.
 *
 * @returns The conflict ID
 */
export function createConflict(
  db: Database.Database,
  options: CreateConflictOptions
): string {
  const t = getTables(db);
  const conflictId = generateConflictId();
  const now = Date.now();

  db.prepare(`
    INSERT INTO ${t.conflicts} (
      id, stream_id, operation_id, conflicting_commit, target_commit,
      conflicted_files, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    conflictId,
    options.streamId,
    options.operationId ?? null,
    options.conflictingCommit,
    options.targetCommit,
    JSON.stringify(options.conflictedFiles),
    now
  );

  return conflictId;
}

/**
 * Get a conflict by ID.
 */
export function getConflict(
  db: Database.Database,
  conflictId: string
): ConflictRecord | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.conflicts} WHERE id = ?`)
    .get(conflictId) as Record<string, unknown> | undefined;

  return row ? rowToConflictRecord(row) : null;
}

/**
 * Get the active (pending or in_progress) conflict for a stream.
 */
export function getConflictForStream(
  db: Database.Database,
  streamId: string
): ConflictRecord | null {
  const t = getTables(db);
  const row = db
    .prepare(`
      SELECT * FROM ${t.conflicts}
      WHERE stream_id = ? AND status IN ('pending', 'in_progress')
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get(streamId) as Record<string, unknown> | undefined;

  return row ? rowToConflictRecord(row) : null;
}

/**
 * Check if a stream has an unresolved conflict.
 */
export function hasUnresolvedConflict(
  db: Database.Database,
  streamId: string
): boolean {
  return getConflictForStream(db, streamId) !== null;
}

/**
 * Update a conflict's status.
 */
export function updateConflictStatus(
  db: Database.Database,
  conflictId: string,
  status: ConflictStatus
): void {
  const t = getTables(db);
  db.prepare(`UPDATE ${t.conflicts} SET status = ? WHERE id = ?`).run(
    status,
    conflictId
  );
}

/**
 * Start conflict resolution (sets status to in_progress).
 */
export function startConflictResolution(
  db: Database.Database,
  conflictId: string,
  _agentId: string
): void {
  updateConflictStatus(db, conflictId, 'in_progress');
}

/**
 * Mark a conflict as resolved.
 */
export function resolveConflict(
  db: Database.Database,
  conflictId: string,
  resolution: ConflictResolution
): void {
  const t = getTables(db);
  const now = Date.now();

  db.prepare(`
    UPDATE ${t.conflicts}
    SET status = 'resolved', resolved_at = ?, resolution = ?
    WHERE id = ?
  `).run(now, JSON.stringify(resolution), conflictId);
}

/**
 * Abandon a conflict (resolution failed or rolled back).
 */
export function abandonConflict(
  db: Database.Database,
  conflictId: string
): void {
  updateConflictStatus(db, conflictId, 'abandoned');
}

/**
 * Delete a conflict record.
 */
export function deleteConflict(
  db: Database.Database,
  conflictId: string
): void {
  const t = getTables(db);
  db.prepare(`DELETE FROM ${t.conflicts} WHERE id = ?`).run(conflictId);
}

/**
 * List conflicts with optional filtering.
 */
export function listConflicts(
  db: Database.Database,
  options?: ListConflictsOptions
): ConflictRecord[] {
  const t = getTables(db);

  let query = `SELECT * FROM ${t.conflicts} WHERE 1=1`;
  const params: unknown[] = [];

  if (options?.streamId) {
    query += ' AND stream_id = ?';
    params.push(options.streamId);
  }

  if (options?.status) {
    query += ' AND status = ?';
    params.push(options.status);
  }

  query += ' ORDER BY created_at DESC';

  if (options?.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(rowToConflictRecord);
}

/**
 * Get stale conflicts (in_progress for longer than threshold).
 * Used for crash recovery.
 */
export function getStaleConflicts(
  db: Database.Database,
  thresholdMs: number
): ConflictRecord[] {
  const t = getTables(db);
  const cutoff = Date.now() - thresholdMs;

  const rows = db
    .prepare(`
      SELECT * FROM ${t.conflicts}
      WHERE status = 'in_progress' AND created_at <= ?
      ORDER BY created_at ASC
    `)
    .all(cutoff) as Record<string, unknown>[];

  return rows.map(rowToConflictRecord);
}

/**
 * Get all pending conflicts (awaiting resolution).
 */
export function getPendingConflicts(
  db: Database.Database
): ConflictRecord[] {
  return listConflicts(db, { status: 'pending' });
}

/**
 * Count conflicts by status.
 */
export function countConflictsByStatus(
  db: Database.Database
): Record<ConflictStatus, number> {
  const t = getTables(db);

  const rows = db
    .prepare(`
      SELECT status, COUNT(*) as count
      FROM ${t.conflicts}
      GROUP BY status
    `)
    .all() as { status: ConflictStatus; count: number }[];

  const result: Record<ConflictStatus, number> = {
    pending: 0,
    in_progress: 0,
    resolved: 0,
    abandoned: 0,
  };

  for (const row of rows) {
    result[row.status] = row.count;
  }

  return result;
}
