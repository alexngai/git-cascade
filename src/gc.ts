/**
 * Garbage collection configuration and stream archiving.
 *
 * Provides persistent configuration for GC behavior including
 * auto-archiving, retention periods, and cleanup options.
 * Also provides functions to archive streams for later pruning.
 */

import type Database from 'better-sqlite3';
import { getTables } from './db/tables.js';
import { clearGuard } from './guards.js';
import type { StreamStatus } from './models/index.js';

/**
 * GC configuration options.
 */
export interface GCConfig {
  /** Archive streams automatically when merged (default: true) */
  autoArchiveOnMerge: boolean;
  /** Archive streams automatically when abandoned (default: true) */
  autoArchiveOnAbandon: boolean;
  /** Days to retain archived streams before pruning (default: 30) */
  archiveRetentionDays: number;
  /** Delete git branches during prune (default: true) */
  deleteGitBranches: boolean;
  /** Delete worktrees during prune (default: true) */
  deleteWorktrees: boolean;
  /** Run recovery on startup (default: true) */
  runRecoveryOnStartup: boolean;
}

/**
 * Result of archiving a stream.
 */
export interface ArchiveResult {
  streamId: string;
  archivedAt: number;
}

/**
 * Archived stream record.
 */
export interface ArchivedStream {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Owning agent identifier */
  agentId: string;
  /** Commit hash where stream branched from */
  baseCommit: string;
  /** ID of parent stream if forked */
  parentStream: string | null;
  /** Status when archived */
  status: StreamStatus;
  /** Unix timestamp (ms) when created */
  createdAt: number;
  /** Unix timestamp (ms) when last updated */
  updatedAt: number;
  /** Unix timestamp (ms) when archived */
  archivedAt: number;
  /** Target stream ID if merged */
  mergedInto: string | null;
  /** Whether stacked review was enabled */
  enableStackedReview: boolean;
  /** Extensible metadata */
  metadata: Record<string, unknown>;
}

/**
 * Default GC configuration values.
 */
const DEFAULT_CONFIG: GCConfig = {
  autoArchiveOnMerge: true,
  autoArchiveOnAbandon: true,
  archiveRetentionDays: 30,
  deleteGitBranches: true,
  deleteWorktrees: true,
  runRecoveryOnStartup: true,
};

/**
 * Config key to type mapping for serialization.
 */
type ConfigKey = keyof GCConfig;

/**
 * Serialize a config value to string for database storage.
 */
function serializeValue(key: ConfigKey, value: GCConfig[ConfigKey]): string {
  if (key === 'archiveRetentionDays') {
    return String(value);
  }
  // Boolean values
  return value ? 'true' : 'false';
}

/**
 * Deserialize a config value from database storage.
 */
function deserializeValue(key: ConfigKey, value: string): GCConfig[ConfigKey] {
  if (key === 'archiveRetentionDays') {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? DEFAULT_CONFIG[key] : parsed;
  }
  // Boolean values
  return value === 'true';
}

/**
 * Get the current GC configuration.
 *
 * Returns the stored configuration merged with defaults for any
 * keys that are not set in the database.
 *
 * @param db - Database connection
 * @returns The complete GC configuration
 */
export function getGCConfig(db: Database.Database): GCConfig {
  const t = getTables(db);

  // Start with defaults
  const config: GCConfig = { ...DEFAULT_CONFIG };

  // Query all config values from database
  const rows = db
    .prepare(`SELECT key, value FROM ${t.gc_config}`)
    .all() as Array<{ key: string; value: string }>;

  // Override defaults with stored values
  for (const row of rows) {
    const key = row.key as ConfigKey;
    if (key in DEFAULT_CONFIG) {
      // Type-safe assignment using key mapping
      switch (key) {
        case 'autoArchiveOnMerge':
          config.autoArchiveOnMerge = deserializeValue(key, row.value) as boolean;
          break;
        case 'autoArchiveOnAbandon':
          config.autoArchiveOnAbandon = deserializeValue(key, row.value) as boolean;
          break;
        case 'archiveRetentionDays':
          config.archiveRetentionDays = deserializeValue(key, row.value) as number;
          break;
        case 'deleteGitBranches':
          config.deleteGitBranches = deserializeValue(key, row.value) as boolean;
          break;
        case 'deleteWorktrees':
          config.deleteWorktrees = deserializeValue(key, row.value) as boolean;
          break;
        case 'runRecoveryOnStartup':
          config.runRecoveryOnStartup = deserializeValue(key, row.value) as boolean;
          break;
      }
    }
  }

  return config;
}

/**
 * Update GC configuration.
 *
 * Only updates the keys provided in the partial config. Other keys
 * retain their current values.
 *
 * @param db - Database connection
 * @param config - Partial configuration to update
 */
export function setGCConfig(
  db: Database.Database,
  config: Partial<GCConfig>
): void {
  const t = getTables(db);

  const upsert = db.prepare(`
    INSERT INTO ${t.gc_config} (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  // Update each provided key
  for (const [key, value] of Object.entries(config)) {
    if (key in DEFAULT_CONFIG && value !== undefined) {
      const serialized = serializeValue(
        key as ConfigKey,
        value as GCConfig[ConfigKey]
      );
      upsert.run(key, serialized);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream Archiving
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert database row to ArchivedStream object.
 */
function rowToArchivedStream(row: Record<string, unknown>): ArchivedStream {
  return {
    id: row.id as string,
    name: row.name as string,
    agentId: row.agent_id as string,
    baseCommit: row.base_commit as string,
    parentStream: row.parent_stream as string | null,
    status: row.status as StreamStatus,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    archivedAt: row.archived_at as number,
    mergedInto: row.merged_into as string | null,
    enableStackedReview: Boolean(row.enable_stacked_review),
    metadata: JSON.parse((row.metadata as string) || '{}'),
  };
}

/**
 * Archive a stream.
 *
 * Moves the stream from the streams table to the archived_streams table.
 * The git branch is preserved (deletion happens during prune).
 * The stream guard is cleared since the stream is no longer active.
 *
 * @param db - Database connection
 * @param _repoPath - Repository path (reserved for future use)
 * @param streamId - ID of the stream to archive
 * @returns Archive result with stream ID and timestamp
 * @throws Error if stream does not exist
 */
export function archiveStream(
  db: Database.Database,
  _repoPath: string,
  streamId: string
): ArchiveResult {
  const t = getTables(db);
  const now = Date.now();

  // Get the stream from streams table
  const row = db
    .prepare(`SELECT * FROM ${t.streams} WHERE id = ?`)
    .get(streamId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error(`Stream not found: ${streamId}`);
  }

  // Clear the stream guard first (before deleting from streams due to FK constraint)
  clearGuard(db, streamId);

  // Insert into archived_streams
  db.prepare(`
    INSERT INTO ${t.archived_streams} (
      id, name, agent_id, base_commit, parent_stream, status,
      created_at, updated_at, archived_at, merged_into, enable_stacked_review, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.name,
    row.agent_id,
    row.base_commit,
    row.parent_stream,
    row.status,
    row.created_at,
    row.updated_at,
    now,
    row.merged_into,
    row.enable_stacked_review,
    row.metadata
  );

  // Delete from streams table
  db.prepare(`DELETE FROM ${t.streams} WHERE id = ?`).run(streamId);

  return {
    streamId,
    archivedAt: now,
  };
}

/**
 * Check if a stream is archived.
 *
 * @param db - Database connection
 * @param streamId - ID of the stream to check
 * @returns true if the stream exists in archived_streams
 */
export function isArchived(db: Database.Database, streamId: string): boolean {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT 1 FROM ${t.archived_streams} WHERE id = ?`)
    .get(streamId);

  return row !== undefined;
}

/**
 * Get an archived stream by ID.
 *
 * @param db - Database connection
 * @param streamId - ID of the archived stream
 * @returns The archived stream or null if not found
 */
export function getArchivedStream(
  db: Database.Database,
  streamId: string
): ArchivedStream | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.archived_streams} WHERE id = ?`)
    .get(streamId) as Record<string, unknown> | undefined;

  return row ? rowToArchivedStream(row) : null;
}

/**
 * Options for listing archived streams.
 */
export interface ListArchivedStreamsOptions {
  /** Only return streams archived more than this many days ago */
  olderThanDays?: number;
}

/**
 * List archived streams.
 *
 * @param db - Database connection
 * @param options - Optional filtering options
 * @returns Array of archived streams
 */
export function listArchivedStreams(
  db: Database.Database,
  options?: ListArchivedStreamsOptions
): ArchivedStream[] {
  const t = getTables(db);

  let query = `SELECT * FROM ${t.archived_streams}`;
  const params: unknown[] = [];

  if (options?.olderThanDays !== undefined) {
    const cutoffMs = Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000;
    query += ` WHERE archived_at < ?`;
    params.push(cutoffMs);
  }

  query += ` ORDER BY archived_at DESC`;

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(rowToArchivedStream);
}
