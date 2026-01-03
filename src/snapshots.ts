/**
 * Working copy snapshot operations.
 *
 * Provides CRUD operations for working copy snapshots using git stash.
 * Snapshots protect uncommitted work during risky operations like rebase.
 *
 * **Important limitation:** Git stash refs expire with the reflog, which
 * defaults to 90 days. Snapshots older than 90 days may become unrestorable
 * if the underlying stash ref has been garbage collected by git.
 */

import type Database from 'better-sqlite3';
import * as crypto from 'crypto';
import { getTables } from './db/tables.js';
import * as git from './git/index.js';

/**
 * Represents a working copy snapshot record.
 */
export interface Snapshot {
  /** Unique snapshot identifier */
  id: string;
  /** Path to the worktree where the snapshot was taken */
  worktree: string;
  /** Agent that created the snapshot */
  agentId: string;
  /** Reason for creating the snapshot (e.g., "pre-rebase", "manual") */
  reason: string;
  /** Git stash ref (commit hash of the stash) */
  stashRef: string;
  /** HEAD commit at the time of snapshot */
  headAtSnapshot: string;
  /** Timestamp when the snapshot was created */
  createdAt: number;
}

/**
 * Options for listing snapshots.
 */
export interface ListSnapshotsOptions {
  /** Filter by worktree path */
  worktree?: string;
  /** Filter by agent ID */
  agentId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ID Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate unique snapshot ID.
 */
function generateSnapshotId(): string {
  return `snap-${crypto.randomUUID().slice(0, 8)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row Converter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert database row to Snapshot object.
 */
function rowToSnapshot(row: Record<string, unknown>): Snapshot {
  return {
    id: row.id as string,
    worktree: row.worktree as string,
    agentId: row.agent_id as string,
    reason: row.reason as string,
    stashRef: row.stash_ref as string,
    headAtSnapshot: row.head_at_snapshot as string,
    createdAt: row.created_at as number,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a snapshot of uncommitted work in a worktree.
 *
 * Uses `git stash push` to save uncommitted changes and records the
 * stash ref in the database for later restoration.
 *
 * **Note:** Git stash refs expire with the reflog (default 90 days).
 * Snapshots older than 90 days may become unrestorable.
 *
 * @param db - Database connection
 * @param worktree - Path to the worktree to snapshot
 * @param agentId - ID of the agent creating the snapshot
 * @param reason - Reason for creating the snapshot
 * @returns The snapshot ID, or null if there was nothing to snapshot
 */
export function snapshot(
  db: Database.Database,
  worktree: string,
  agentId: string,
  reason: string
): string | null {
  const gitOptions = { cwd: worktree };

  // Check if there's anything to snapshot
  if (git.isClean(gitOptions)) {
    return null;
  }

  // Get current HEAD before stashing
  const headAtSnapshot = git.getHead(gitOptions);

  // Create stash with a descriptive message
  const stashMessage = `snapshot:${agentId}:${reason}`;
  git.stashPush(stashMessage, gitOptions);

  // Get the stash ref (commit hash of the stash)
  const stashRef = git.getLatestStashRef(gitOptions);

  // Record in database
  const t = getTables(db);
  const id = generateSnapshotId();
  const now = Date.now();

  db.prepare(`
    INSERT INTO ${t.wc_snapshots} (
      id, worktree, agent_id, reason, stash_ref, head_at_snapshot, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, worktree, agentId, reason, stashRef, headAtSnapshot, now);

  return id;
}

/**
 * Restore a snapshot to a worktree.
 *
 * Uses `git stash apply` to restore the saved changes. The snapshot
 * record is kept in the database (use deleteSnapshot to remove it).
 *
 * **Note:** The stash ref may have expired if the snapshot is older
 * than 90 days (git's default reflog expiration).
 *
 * @param db - Database connection
 * @param snapshotId - ID of the snapshot to restore
 * @param worktree - Path to the worktree to restore to
 * @returns true if restoration succeeded, false otherwise
 */
export function restore(
  db: Database.Database,
  snapshotId: string,
  worktree: string
): boolean {
  const snap = getSnapshot(db, snapshotId);
  if (!snap) {
    return false;
  }

  const gitOptions = { cwd: worktree };

  try {
    git.stashApply(snap.stashRef, gitOptions);
    return true;
  } catch {
    // Stash apply failed (e.g., stash expired, conflicts)
    return false;
  }
}

/**
 * List snapshots with optional filters.
 *
 * @param db - Database connection
 * @param options - Optional filters for worktree and/or agentId
 * @returns Array of matching snapshots, ordered by creation time (newest first)
 */
export function listSnapshots(
  db: Database.Database,
  options?: ListSnapshotsOptions
): Snapshot[] {
  const t = getTables(db);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.worktree) {
    conditions.push('worktree = ?');
    params.push(options.worktree);
  }

  if (options?.agentId) {
    conditions.push('agent_id = ?');
    params.push(options.agentId);
  }

  let query = `SELECT * FROM ${t.wc_snapshots}`;
  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }
  query += ' ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(rowToSnapshot);
}

/**
 * Get a single snapshot by ID.
 *
 * @param db - Database connection
 * @param snapshotId - ID of the snapshot to retrieve
 * @returns The snapshot, or null if not found
 */
export function getSnapshot(
  db: Database.Database,
  snapshotId: string
): Snapshot | null {
  const t = getTables(db);

  const row = db.prepare(`
    SELECT * FROM ${t.wc_snapshots} WHERE id = ?
  `).get(snapshotId) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  return rowToSnapshot(row);
}

/**
 * Delete a snapshot record from the database.
 *
 * This only removes the database record; it does not drop the underlying
 * git stash. The stash will be cleaned up naturally by git's reflog
 * expiration (default 90 days).
 *
 * @param db - Database connection
 * @param snapshotId - ID of the snapshot to delete
 */
export function deleteSnapshot(
  db: Database.Database,
  snapshotId: string
): void {
  const t = getTables(db);
  db.prepare(`DELETE FROM ${t.wc_snapshots} WHERE id = ?`).run(snapshotId);
}

/**
 * Prune old snapshots from the database.
 *
 * Removes snapshot records older than the specified number of days.
 * This is useful for cleaning up the database, especially since stash
 * refs expire after 90 days by default anyway.
 *
 * @param db - Database connection
 * @param olderThanDays - Delete snapshots older than this many days
 * @returns The number of snapshots deleted
 */
export function pruneSnapshots(
  db: Database.Database,
  olderThanDays: number
): number {
  const t = getTables(db);
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

  const result = db.prepare(`
    DELETE FROM ${t.wc_snapshots} WHERE created_at < ?
  `).run(cutoffMs);

  return result.changes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe Operation Wrappers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of a safe operation wrapper.
 */
export interface SafeOperationResult<T> {
  /** Whether the operation completed successfully */
  success: boolean;
  /** The result of the operation (only present if success is true) */
  result?: T;
  /** The error that occurred (only present if success is false) */
  error?: Error;
  /** Snapshot ID for recovery if the operation failed (only present if uncommitted changes existed) */
  snapshotId?: string;
}

/**
 * Execute an operation with automatic snapshot protection.
 *
 * Creates a snapshot of uncommitted work before executing a risky operation.
 * If the operation fails, the snapshot ID is returned for recovery.
 *
 * @example
 * ```typescript
 * // Protect a rebase operation
 * const result = safeOperation(
 *   db,
 *   '/path/to/worktree',
 *   'agent-1',
 *   'rebase',
 *   () => git.rebase('main', { cwd: '/path/to/worktree' })
 * );
 *
 * if (!result.success) {
 *   console.error('Rebase failed:', result.error?.message);
 *   if (result.snapshotId) {
 *     // Restore uncommitted changes
 *     restore(db, result.snapshotId, '/path/to/worktree');
 *   }
 * }
 * ```
 *
 * @param db - Database connection
 * @param worktree - Path to the worktree to protect
 * @param agentId - ID of the agent performing the operation
 * @param operation - Description of the operation (used as snapshot reason)
 * @param func - The function to execute
 * @returns Result containing success status, result/error, and snapshot ID
 */
export function safeOperation<T>(
  db: Database.Database,
  worktree: string,
  agentId: string,
  operation: string,
  func: () => T
): SafeOperationResult<T> {
  // Create snapshot before operation (if uncommitted changes exist)
  const snapshotId = snapshot(db, worktree, agentId, `pre-${operation}`) ?? undefined;

  try {
    const result = func();
    return {
      success: true,
      result,
      snapshotId,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err : new Error(String(err)),
      snapshotId,
    };
  }
}

/**
 * Execute an async operation with automatic snapshot protection.
 *
 * Creates a snapshot of uncommitted work before executing a risky async operation.
 * If the operation fails, the snapshot ID is returned for recovery.
 *
 * @example
 * ```typescript
 * // Protect an async merge operation
 * const result = await safeOperationAsync(
 *   db,
 *   '/path/to/worktree',
 *   'agent-1',
 *   'merge',
 *   async () => {
 *     await git.fetchAsync({ cwd: '/path/to/worktree' });
 *     return git.merge('origin/main', { cwd: '/path/to/worktree' });
 *   }
 * );
 *
 * if (!result.success) {
 *   console.error('Merge failed:', result.error?.message);
 *   if (result.snapshotId) {
 *     // Restore uncommitted changes
 *     restore(db, result.snapshotId, '/path/to/worktree');
 *   }
 * }
 * ```
 *
 * @param db - Database connection
 * @param worktree - Path to the worktree to protect
 * @param agentId - ID of the agent performing the operation
 * @param operation - Description of the operation (used as snapshot reason)
 * @param func - The async function to execute
 * @returns Promise resolving to result containing success status, result/error, and snapshot ID
 */
export async function safeOperationAsync<T>(
  db: Database.Database,
  worktree: string,
  agentId: string,
  operation: string,
  func: () => Promise<T>
): Promise<SafeOperationResult<T>> {
  // Create snapshot before operation (if uncommitted changes exist)
  const snapshotId = snapshot(db, worktree, agentId, `pre-${operation}`) ?? undefined;

  try {
    const result = await func();
    return {
      success: true,
      result,
      snapshotId,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err : new Error(String(err)),
      snapshotId,
    };
  }
}
