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
import * as git from './git/index.js';
import * as snapshots from './snapshots.js';
import * as recovery from './recovery.js';
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

  // Wrap all archive operations in a transaction to ensure atomicity
  db.transaction(() => {
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
  })();

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

// ─────────────────────────────────────────────────────────────────────────────
// Prune and GC Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of pruning archived streams.
 */
export interface PruneResult {
  /** Number of streams pruned */
  prunedStreams: number;
  /** List of git branches deleted */
  deletedBranches: string[];
  /** Any errors encountered during pruning */
  errors: string[];
}

/**
 * Result of a full garbage collection.
 */
export interface GCResult {
  /** Number of streams archived in this run */
  archivedStreams: number;
  /** Number of archived streams pruned */
  prunedStreams: number;
  /** Number of old snapshots pruned */
  prunedSnapshots: number;
  /** Number of orphaned worktrees cleaned */
  cleanedWorktrees: number;
  /** Number of incomplete operations recovered */
  recoveredOperations: number;
  /** Number of stale locks released */
  releasedLocks: number;
  /** Any errors encountered during GC */
  errors: string[];
}

/**
 * Prune archived streams past their retention period.
 *
 * Deletes archived streams older than the specified threshold, including:
 * - The archived_streams record
 * - Associated git branch (stream/{id}) if deleteGitBranches config is true
 * - Related operations, dependencies, and conflicts
 *
 * @param db - Database connection
 * @param repoPath - Path to the git repository
 * @param olderThanDays - Days threshold (defaults to archiveRetentionDays from config)
 * @returns Prune result with counts and any errors
 */
export function prune(
  db: Database.Database,
  repoPath: string,
  olderThanDays?: number
): PruneResult {
  const config = getGCConfig(db);
  const t = getTables(db);

  const threshold = olderThanDays ?? config.archiveRetentionDays;
  // When threshold is 0, we want to prune all archived streams including those just archived
  // Add 1ms to include streams archived at the same millisecond
  const cutoffMs = Date.now() - threshold * 24 * 60 * 60 * 1000 + (threshold === 0 ? 1 : 0);

  const result: PruneResult = {
    prunedStreams: 0,
    deletedBranches: [],
    errors: [],
  };

  // Get all archived streams older than (or equal to for threshold=0) the threshold
  const oldStreams = db
    .prepare(`SELECT id FROM ${t.archived_streams} WHERE archived_at < ?`)
    .all(cutoffMs) as Array<{ id: string }>;

  for (const { id } of oldStreams) {
    try {
      // Delete git branch if configured
      if (config.deleteGitBranches) {
        const branchName = `stream/${id}`;
        try {
          git.deleteBranch(branchName, true, { cwd: repoPath });
          result.deletedBranches.push(branchName);
        } catch (error) {
          // Branch might not exist (already deleted or never pushed)
          // Log but continue - this is not a fatal error
          const errMsg = error instanceof Error ? error.message : String(error);
          if (!errMsg.includes('not found')) {
            result.errors.push(`Failed to delete branch ${branchName}: ${errMsg}`);
          }
        }
      }

      // Delete related records in a transaction
      db.transaction(() => {
        // Delete operations for this stream (FK constraint - operations reference streams)
        db.prepare(`DELETE FROM ${t.operations} WHERE stream_id = ?`).run(id);

        // Delete dependencies for this stream
        db.prepare(`DELETE FROM ${t.dependencies} WHERE stream_id = ?`).run(id);

        // Delete conflicts for this stream
        db.prepare(`DELETE FROM ${t.conflicts} WHERE stream_id = ?`).run(id);

        // Delete changes for this stream
        db.prepare(`DELETE FROM ${t.changes} WHERE stream_id = ?`).run(id);

        // Delete operation checkpoints for this stream
        db.prepare(`DELETE FROM ${t.operation_checkpoints} WHERE stream_id = ?`).run(id);

        // Delete review blocks and stack entries for this stream
        // Stack entries cascade delete from review_blocks
        db.prepare(`DELETE FROM ${t.review_blocks} WHERE stream_id = ?`).run(id);

        // Delete stack configs for this stream
        db.prepare(`DELETE FROM ${t.stack_configs} WHERE stream_id = ?`).run(id);

        // Finally, delete the archived stream record
        db.prepare(`DELETE FROM ${t.archived_streams} WHERE id = ?`).run(id);
      })();

      result.prunedStreams++;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(`Failed to prune stream ${id}: ${errMsg}`);
    }
  }

  return result;
}

/**
 * Run full garbage collection pipeline.
 *
 * Performs the following cleanup steps:
 * 1. Archive merged/abandoned streams (if auto-archive is enabled)
 * 2. Prune archived streams past retention period
 * 3. Clean up orphaned worktrees (if deleteWorktrees is enabled)
 * 4. Prune old snapshots (7 days default)
 * 5. Recover incomplete operations (clear stale checkpoints)
 * 6. Release stale locks
 *
 * @param db - Database connection
 * @param repoPath - Path to the git repository
 * @returns GC result with summary of all actions taken
 */
export function gc(
  db: Database.Database,
  repoPath: string
): GCResult {
  const config = getGCConfig(db);
  const t = getTables(db);

  const result: GCResult = {
    archivedStreams: 0,
    prunedStreams: 0,
    prunedSnapshots: 0,
    cleanedWorktrees: 0,
    recoveredOperations: 0,
    releasedLocks: 0,
    errors: [],
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Step 1: Archive merged/abandoned streams (if auto-archive enabled)
  // ─────────────────────────────────────────────────────────────────────────
  try {
    // Find streams that should be archived
    const streamsToArchive: Array<{ id: string; status: string }> = [];

    if (config.autoArchiveOnMerge) {
      const merged = db
        .prepare(`SELECT id, status FROM ${t.streams} WHERE status = 'merged'`)
        .all() as Array<{ id: string; status: string }>;
      streamsToArchive.push(...merged);
    }

    if (config.autoArchiveOnAbandon) {
      const abandoned = db
        .prepare(`SELECT id, status FROM ${t.streams} WHERE status = 'abandoned'`)
        .all() as Array<{ id: string; status: string }>;
      streamsToArchive.push(...abandoned);
    }

    for (const stream of streamsToArchive) {
      try {
        archiveStream(db, repoPath, stream.id);
        result.archivedStreams++;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to archive stream ${stream.id}: ${errMsg}`);
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Archive phase failed: ${errMsg}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2: Prune archived streams past retention period
  // ─────────────────────────────────────────────────────────────────────────
  try {
    const pruneResult = prune(db, repoPath);
    result.prunedStreams = pruneResult.prunedStreams;
    result.errors.push(...pruneResult.errors);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Prune phase failed: ${errMsg}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3: Clean up orphaned worktrees
  // ─────────────────────────────────────────────────────────────────────────
  if (config.deleteWorktrees) {
    try {
      // Prune stale worktree references using git worktree prune
      git.pruneWorktrees({ cwd: repoPath });
      result.cleanedWorktrees = 1; // Mark as cleaned (git doesn't report count)
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(`Worktree cleanup failed: ${errMsg}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 4: Prune old snapshots (7 days default)
  // ─────────────────────────────────────────────────────────────────────────
  try {
    const snapshotRetentionDays = 7;
    result.prunedSnapshots = snapshots.pruneSnapshots(db, snapshotRetentionDays);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Snapshot cleanup failed: ${errMsg}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 5: Recover incomplete operations
  // ─────────────────────────────────────────────────────────────────────────
  try {
    // Get all incomplete checkpoints
    const incompleteCheckpoints = recovery.getIncompleteCheckpoints(db);
    for (const checkpoint of incompleteCheckpoints) {
      try {
        // Complete (remove) the checkpoint without recovery since we don't have worktree info
        // In a full recovery, we would need the worktree path to reset git state
        recovery.completeCheckpoint(db, checkpoint.operationId);
        result.recoveredOperations++;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(
          `Failed to clean checkpoint ${checkpoint.operationId}: ${errMsg}`
        );
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Operation recovery failed: ${errMsg}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 6: Release stale locks
  // ─────────────────────────────────────────────────────────────────────────
  try {
    // Release locks older than 1 hour (likely from crashed processes)
    const staleLockThreshold = Date.now() - 60 * 60 * 1000;

    const staleLocksResult = db
      .prepare(`DELETE FROM ${t.stream_locks} WHERE acquired_at < ?`)
      .run(staleLockThreshold);

    result.releasedLocks = staleLocksResult.changes;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Lock cleanup failed: ${errMsg}`);
  }

  return result;
}
