/**
 * Checkpoint operations for git-cascade.
 *
 * Checkpoints are snapshots of individual commits with minimal state.
 * Part of the unified checkpoint/diff stack architecture (s-366r).
 */

import type Database from 'better-sqlite3';
import crypto from 'crypto';
import { getTables } from './db/tables.js';
import type {
  Checkpoint,
  CreateCheckpointOptions,
  ListCheckpointsOptions,
} from './models/checkpoint.js';

// ─────────────────────────────────────────────────────────────────────────────
// Row Conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a database row to a Checkpoint object.
 */
function rowToCheckpoint(row: Record<string, unknown>): Checkpoint {
  return {
    id: row.id as string,
    streamId: row.stream_id as string,
    commitSha: row.commit_sha as string,
    parentCommit: (row.parent_commit as string) || null,
    originalCommit: (row.original_commit as string) || null,
    changeId: (row.change_id as string) || null,
    message: (row.message as string) || null,
    createdAt: row.created_at as number,
    createdBy: (row.created_by as string) || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Create Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new checkpoint.
 *
 * @throws Error if checkpoint already exists for this stream/commit combination
 */
export function createCheckpoint(
  db: Database.Database,
  options: CreateCheckpointOptions
): Checkpoint {
  const t = getTables(db);
  const id = `cp-${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO ${t.checkpoints} (
      id, stream_id, commit_sha, parent_commit, original_commit,
      change_id, message, created_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    options.streamId,
    options.commitSha,
    options.parentCommit ?? null,
    options.originalCommit ?? null,
    options.changeId ?? null,
    options.message ?? null,
    now,
    options.createdBy ?? null
  );

  return {
    id,
    streamId: options.streamId,
    commitSha: options.commitSha,
    parentCommit: options.parentCommit ?? null,
    originalCommit: options.originalCommit ?? null,
    changeId: options.changeId ?? null,
    message: options.message ?? null,
    createdAt: now,
    createdBy: options.createdBy ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a checkpoint by ID.
 */
export function getCheckpoint(
  db: Database.Database,
  id: string
): Checkpoint | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.checkpoints} WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;

  return row ? rowToCheckpoint(row) : null;
}

/**
 * Get a checkpoint by commit SHA within a stream.
 */
export function getCheckpointByCommit(
  db: Database.Database,
  streamId: string,
  commitSha: string
): Checkpoint | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.checkpoints} WHERE stream_id = ? AND commit_sha = ?`)
    .get(streamId, commitSha) as Record<string, unknown> | undefined;

  return row ? rowToCheckpoint(row) : null;
}

/**
 * Get all checkpoints for a stream, ordered by creation time.
 */
export function getCheckpointsForStream(
  db: Database.Database,
  streamId: string
): Checkpoint[] {
  const t = getTables(db);
  const rows = db
    .prepare(`SELECT * FROM ${t.checkpoints} WHERE stream_id = ? ORDER BY created_at ASC`)
    .all(streamId) as Array<Record<string, unknown>>;

  return rows.map(rowToCheckpoint);
}

/**
 * Get checkpoints by change_id (stable identity across rebases).
 */
export function getCheckpointsByChangeId(
  db: Database.Database,
  changeId: string
): Checkpoint[] {
  const t = getTables(db);
  const rows = db
    .prepare(`SELECT * FROM ${t.checkpoints} WHERE change_id = ? ORDER BY created_at ASC`)
    .all(changeId) as Array<Record<string, unknown>>;

  return rows.map(rowToCheckpoint);
}

/**
 * Get checkpoints not in any stack.
 *
 * @param streamId - Optional filter by stream
 */
export function getUnstackedCheckpoints(
  db: Database.Database,
  streamId?: string
): Checkpoint[] {
  const t = getTables(db);

  let query = `
    SELECT c.* FROM ${t.checkpoints} c
    LEFT JOIN ${t.diff_stack_entries} e ON c.id = e.checkpoint_id
    WHERE e.id IS NULL
  `;

  if (streamId) {
    query += ` AND c.stream_id = ?`;
  }

  query += ` ORDER BY c.created_at ASC`;

  const stmt = db.prepare(query);
  const rows = (streamId ? stmt.all(streamId) : stmt.all()) as Array<
    Record<string, unknown>
  >;

  return rows.map(rowToCheckpoint);
}

/**
 * List checkpoints with optional filters.
 */
export function listCheckpoints(
  db: Database.Database,
  options: ListCheckpointsOptions = {}
): Checkpoint[] {
  const t = getTables(db);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.streamId) {
    conditions.push('c.stream_id = ?');
    params.push(options.streamId);
  }

  if (options.changeId) {
    conditions.push('c.change_id = ?');
    params.push(options.changeId);
  }

  let query = `SELECT c.* FROM ${t.checkpoints} c`;

  if (options.unstackedOnly) {
    query += ` LEFT JOIN ${t.diff_stack_entries} e ON c.id = e.checkpoint_id`;
    conditions.push('e.id IS NULL');
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  query += ` ORDER BY c.created_at ASC`;

  const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToCheckpoint);
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete a checkpoint by ID.
 *
 * Note: This will cascade delete any stack entries referencing this checkpoint.
 */
export function deleteCheckpoint(db: Database.Database, id: string): boolean {
  const t = getTables(db);
  const result = db.prepare(`DELETE FROM ${t.checkpoints} WHERE id = ?`).run(id);
  return result.changes > 0;
}

/**
 * Delete all checkpoints for a stream.
 */
export function deleteCheckpointsForStream(
  db: Database.Database,
  streamId: string
): number {
  const t = getTables(db);
  const result = db
    .prepare(`DELETE FROM ${t.checkpoints} WHERE stream_id = ?`)
    .run(streamId);
  return result.changes;
}
