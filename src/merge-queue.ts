/**
 * Merge Queue management.
 *
 * Tracks streams that are ready to be merged to a target branch.
 * Maintains ordering (priority + timestamp) and supports automatic
 * progression based on review status.
 */

import type Database from 'better-sqlite3';
import { getTables } from './db/tables.js';
import * as streams from './streams.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Status of a merge queue entry.
 */
export type MergeQueueStatus = 'pending' | 'ready' | 'merging' | 'merged' | 'failed' | 'cancelled';

/**
 * A stream in the merge queue.
 */
export interface MergeQueueEntry {
  /** Unique ID for this queue entry */
  id: string;
  /** Stream ID to be merged */
  streamId: string;
  /** Target branch to merge into (e.g., 'main') */
  targetBranch: string;
  /** Priority (lower = higher priority, default: 100) */
  priority: number;
  /** Current status */
  status: MergeQueueStatus;
  /** Agent that added this to the queue */
  addedBy: string;
  /** Unix timestamp (ms) when added */
  addedAt: number;
  /** Unix timestamp (ms) when status last changed */
  updatedAt: number;
  /** Position in queue (computed) */
  position?: number;
  /** Error message if failed */
  error?: string;
  /** Merge commit hash if merged */
  mergeCommit?: string;
  /** Metadata */
  metadata: Record<string, unknown>;
}

/**
 * Options for adding a stream to the merge queue.
 */
export interface AddToQueueOptions {
  /** Stream to add */
  streamId: string;
  /** Target branch to merge into (default: 'main') */
  targetBranch?: string;
  /** Priority (default: 100, lower = higher priority) */
  priority?: number;
  /** Agent adding to queue */
  agentId: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for processing the merge queue.
 */
export interface ProcessQueueOptions {
  /** Target branch to process (default: all) */
  targetBranch?: string;
  /** Maximum entries to process (default: 1) */
  limit?: number;
  /** Agent performing the merge */
  agentId: string;
  /** Worktree path for git operations */
  worktree: string;
  /** Merge strategy */
  strategy?: 'merge-commit' | 'squash' | 'rebase';
}

/**
 * Result of processing the merge queue.
 */
export interface ProcessQueueResult {
  /** Entries that were successfully merged */
  merged: Array<{ entryId: string; streamId: string; mergeCommit: string }>;
  /** Entries that failed to merge */
  failed: Array<{ entryId: string; streamId: string; error: string }>;
  /** Entries that were skipped (not ready) */
  skipped: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a stream to the merge queue.
 *
 * @param db - Database connection
 * @param options - Queue entry options
 * @returns ID of the queue entry
 */
export function addToQueue(
  db: Database.Database,
  options: AddToQueueOptions
): string {
  const {
    streamId,
    targetBranch = 'main',
    priority = 100,
    agentId,
    metadata = {},
  } = options;

  const t = getTables(db);
  const now = Date.now();
  const id = `mq-${now}-${Math.random().toString(36).slice(2, 8)}`;

  // Verify stream exists
  const stream = streams.getStream(db, streamId);
  if (!stream) {
    throw new Error(`Stream ${streamId} not found`);
  }

  // Check if stream is already in queue for this target
  const existing = db
    .prepare(
      `SELECT id FROM ${t.merge_queue}
       WHERE stream_id = ? AND target_branch = ? AND status IN ('pending', 'ready', 'merging')`
    )
    .get(streamId, targetBranch) as { id: string } | undefined;

  if (existing) {
    throw new Error(`Stream ${streamId} is already in merge queue (entry ${existing.id})`);
  }

  db.prepare(`
    INSERT INTO ${t.merge_queue} (
      id, stream_id, target_branch, priority, status, added_by,
      added_at, updated_at, metadata
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(id, streamId, targetBranch, priority, agentId, now, now, JSON.stringify(metadata));

  return id;
}

/**
 * Get a merge queue entry by ID.
 */
export function getQueueEntry(
  db: Database.Database,
  entryId: string
): MergeQueueEntry | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.merge_queue} WHERE id = ?`)
    .get(entryId) as Record<string, unknown> | undefined;

  return row ? rowToEntry(row) : null;
}

/**
 * Get the merge queue for a target branch.
 *
 * Returns entries ordered by priority (ascending) then added_at (ascending).
 */
export function getQueue(
  db: Database.Database,
  options?: { targetBranch?: string; status?: MergeQueueStatus | MergeQueueStatus[] }
): MergeQueueEntry[] {
  const t = getTables(db);
  let query = `SELECT * FROM ${t.merge_queue}`;
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (options?.targetBranch) {
    conditions.push('target_branch = ?');
    params.push(options.targetBranch);
  }

  if (options?.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  query += ` ORDER BY priority ASC, added_at ASC`;

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];

  return rows.map((row, index) => ({
    ...rowToEntry(row),
    position: index + 1,
  }));
}

/**
 * Update queue entry status.
 */
export function updateQueueEntry(
  db: Database.Database,
  entryId: string,
  updates: Partial<Pick<MergeQueueEntry, 'status' | 'priority' | 'error' | 'mergeCommit' | 'metadata'>>
): void {
  const t = getTables(db);
  const entry = getQueueEntry(db, entryId);
  if (!entry) {
    throw new Error(`Queue entry ${entryId} not found`);
  }

  const now = Date.now();
  const setClauses: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    params.push(updates.status);
  }
  if (updates.priority !== undefined) {
    setClauses.push('priority = ?');
    params.push(updates.priority);
  }
  if (updates.error !== undefined) {
    setClauses.push('error = ?');
    params.push(updates.error);
  }
  if (updates.mergeCommit !== undefined) {
    setClauses.push('merge_commit = ?');
    params.push(updates.mergeCommit);
  }
  if (updates.metadata !== undefined) {
    setClauses.push('metadata = ?');
    params.push(JSON.stringify(updates.metadata));
  }

  params.push(entryId);

  db.prepare(`UPDATE ${t.merge_queue} SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
}

/**
 * Mark a queue entry as ready for merging.
 */
export function markReady(db: Database.Database, entryId: string): void {
  updateQueueEntry(db, entryId, { status: 'ready' });
}

/**
 * Cancel a queue entry.
 */
export function cancelQueueEntry(db: Database.Database, entryId: string): void {
  updateQueueEntry(db, entryId, { status: 'cancelled' });
}

/**
 * Remove a queue entry.
 */
export function removeFromQueue(db: Database.Database, entryId: string): void {
  const t = getTables(db);
  db.prepare(`DELETE FROM ${t.merge_queue} WHERE id = ?`).run(entryId);
}

/**
 * Get the next entry to process from the queue.
 *
 * Returns the highest priority (lowest number) entry with 'ready' status.
 */
export function getNextToMerge(
  db: Database.Database,
  targetBranch: string = 'main'
): MergeQueueEntry | null {
  const t = getTables(db);
  const row = db
    .prepare(
      `SELECT * FROM ${t.merge_queue}
       WHERE target_branch = ? AND status = 'ready'
       ORDER BY priority ASC, added_at ASC
       LIMIT 1`
    )
    .get(targetBranch) as Record<string, unknown> | undefined;

  return row ? rowToEntry(row) : null;
}

/**
 * Process the merge queue.
 *
 * Attempts to merge ready entries in priority order.
 */
export function processQueue(
  db: Database.Database,
  repoPath: string,
  options: ProcessQueueOptions
): ProcessQueueResult {
  const {
    targetBranch = 'main',
    limit = 1,
    agentId,
    worktree,
    strategy = 'merge-commit',
  } = options;

  const result: ProcessQueueResult = {
    merged: [],
    failed: [],
    skipped: [],
  };

  // Get ready entries
  const entries = getQueue(db, { targetBranch, status: 'ready' });

  let processed = 0;
  for (const entry of entries) {
    if (processed >= limit) break;

    // Mark as merging
    updateQueueEntry(db, entry.id, { status: 'merging' });

    try {
      // Perform the merge
      const mergeResult = streams.mergeStream(db, repoPath, {
        sourceStream: entry.streamId,
        targetStream: targetBranch,
        agentId,
        worktree,
        strategy,
      });

      if (mergeResult.success && mergeResult.newHead) {
        // Success
        updateQueueEntry(db, entry.id, {
          status: 'merged',
          mergeCommit: mergeResult.newHead,
        });
        result.merged.push({
          entryId: entry.id,
          streamId: entry.streamId,
          mergeCommit: mergeResult.newHead,
        });
      } else {
        // Merge failed (conflicts, etc.)
        const errorMsg = mergeResult.error ?? mergeResult.conflicts?.join(', ') ?? 'Unknown error';
        updateQueueEntry(db, entry.id, {
          status: 'failed',
          error: errorMsg,
        });
        result.failed.push({
          entryId: entry.id,
          streamId: entry.streamId,
          error: errorMsg,
        });
      }

      processed++;
    } catch (error) {
      // Unexpected error
      const errorMsg = error instanceof Error ? error.message : String(error);
      updateQueueEntry(db, entry.id, {
        status: 'failed',
        error: errorMsg,
      });
      result.failed.push({
        entryId: entry.id,
        streamId: entry.streamId,
        error: errorMsg,
      });
      processed++;
    }
  }

  return result;
}

/**
 * Get queue position for a stream.
 *
 * Returns null if stream is not in queue.
 */
export function getQueuePosition(
  db: Database.Database,
  streamId: string,
  targetBranch: string = 'main'
): number | null {
  const queue = getQueue(db, { targetBranch, status: ['pending', 'ready', 'merging'] });
  const index = queue.findIndex((e) => e.streamId === streamId);
  return index === -1 ? null : index + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function rowToEntry(row: Record<string, unknown>): MergeQueueEntry {
  return {
    id: row.id as string,
    streamId: row.stream_id as string,
    targetBranch: row.target_branch as string,
    priority: row.priority as number,
    status: row.status as MergeQueueStatus,
    addedBy: row.added_by as string,
    addedAt: row.added_at as number,
    updatedAt: row.updated_at as number,
    error: row.error as string | undefined,
    mergeCommit: row.merge_commit as string | undefined,
    metadata: JSON.parse((row.metadata as string) || '{}'),
  };
}
