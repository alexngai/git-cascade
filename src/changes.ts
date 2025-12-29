/**
 * Change identity tracking.
 *
 * Provides stable identity for commits that survives rebases.
 * Each change has a unique ID (Change-Id) stored in commit message trailers.
 */

import type Database from 'better-sqlite3';
import { getTables } from './db/tables.js';
import type {
  Change,
  ChangeStatus,
  CommitRecord,
  CreateChangeOptions,
} from './models/index.js';
import * as git from './git/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Database Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert database row to Change object.
 */
function rowToChange(row: Record<string, unknown>): Change {
  const change: Change = {
    id: row.id as string,
    streamId: row.stream_id as string,
    description: row.description as string,
    commitHistory: JSON.parse((row.commit_history as string) || '[]'),
    currentCommit: row.current_commit as string | null,
    status: row.status as ChangeStatus,
  };

  if (row.squashed_into) {
    change.squashedInto = row.squashed_into as string;
  }
  if (row.split_from) {
    change.splitFrom = row.split_from as string;
  }

  return change;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core CRUD Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new change.
 *
 * @param db - Database connection
 * @param options - Change creation options
 * @returns The change ID
 */
export function createChange(
  db: Database.Database,
  options: CreateChangeOptions
): string {
  const t = getTables(db);
  const changeId = options.changeId ?? git.generateChangeId();
  const now = Date.now();

  const initialRecord: CommitRecord = {
    commit: options.commit,
    recordedAt: now,
    reason: 'initial',
  };

  db.prepare(`
    INSERT INTO ${t.changes} (
      id, stream_id, description, commit_history, current_commit, status
    ) VALUES (?, ?, ?, ?, ?, 'active')
  `).run(
    changeId,
    options.streamId,
    options.description,
    JSON.stringify([initialRecord]),
    options.commit
  );

  return changeId;
}

/**
 * Get a change by ID.
 */
export function getChange(
  db: Database.Database,
  changeId: string
): Change | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.changes} WHERE id = ?`)
    .get(changeId) as Record<string, unknown> | undefined;

  return row ? rowToChange(row) : null;
}

/**
 * Get a change by its current commit.
 */
export function getChangeByCommit(
  db: Database.Database,
  commit: string
): Change | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.changes} WHERE current_commit = ?`)
    .get(commit) as Record<string, unknown> | undefined;

  return row ? rowToChange(row) : null;
}

/**
 * Get a change by any historical commit.
 *
 * Searches through commit_history JSON to find changes that
 * previously had this commit hash.
 */
export function getChangeByHistoricalCommit(
  db: Database.Database,
  commit: string
): Change | null {
  const t = getTables(db);

  // First check current_commit (faster)
  const current = getChangeByCommit(db, commit);
  if (current) {
    return current;
  }

  // Search through commit_history JSON
  // SQLite JSON functions: json_each to iterate array
  const row = db
    .prepare(`
      SELECT c.* FROM ${t.changes} c, json_each(c.commit_history) as h
      WHERE json_extract(h.value, '$.commit') = ?
      LIMIT 1
    `)
    .get(commit) as Record<string, unknown> | undefined;

  return row ? rowToChange(row) : null;
}

/**
 * Get all changes for a stream.
 */
export function getChangesForStream(
  db: Database.Database,
  streamId: string,
  options?: { status?: ChangeStatus }
): Change[] {
  const t = getTables(db);

  let query = `SELECT * FROM ${t.changes} WHERE stream_id = ?`;
  const params: unknown[] = [streamId];

  if (options?.status) {
    query += ' AND status = ?';
    params.push(options.status);
  }

  query += ' ORDER BY rowid DESC';

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(rowToChange);
}

/**
 * Record a commit rewrite (after rebase, amend, etc).
 *
 * Updates the current_commit and prepends to commit_history.
 */
export function recordRewrite(
  db: Database.Database,
  changeId: string,
  newCommit: string,
  reason: CommitRecord['reason']
): void {
  const t = getTables(db);
  const change = getChange(db, changeId);

  if (!change) {
    throw new Error(`Change not found: ${changeId}`);
  }

  const now = Date.now();
  const newRecord: CommitRecord = {
    commit: newCommit,
    recordedAt: now,
    reason,
  };

  // Prepend to history (newest first)
  const newHistory = [newRecord, ...change.commitHistory];

  db.prepare(`
    UPDATE ${t.changes}
    SET current_commit = ?, commit_history = ?
    WHERE id = ?
  `).run(newCommit, JSON.stringify(newHistory), changeId);
}

/**
 * Update a change's status.
 */
export function updateChangeStatus(
  db: Database.Database,
  changeId: string,
  status: ChangeStatus,
  squashedInto?: string
): void {
  const t = getTables(db);

  if (squashedInto) {
    db.prepare(`
      UPDATE ${t.changes}
      SET status = ?, squashed_into = ?, current_commit = NULL
      WHERE id = ?
    `).run(status, squashedInto, changeId);
  } else if (status === 'dropped') {
    db.prepare(`
      UPDATE ${t.changes}
      SET status = ?, current_commit = NULL
      WHERE id = ?
    `).run(status, changeId);
  } else {
    db.prepare(`
      UPDATE ${t.changes}
      SET status = ?
      WHERE id = ?
    `).run(status, changeId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a squash operation.
 *
 * Multiple changes are absorbed into a target change.
 */
export function recordSquash(
  db: Database.Database,
  absorbedIds: string[],
  targetId: string,
  resultCommit: string
): void {
  // Update absorbed changes
  for (const absorbedId of absorbedIds) {
    updateChangeStatus(db, absorbedId, 'squashed', targetId);
  }

  // Update target with new commit
  recordRewrite(db, targetId, resultCommit, 'squash_target');
}

/**
 * Record a split operation.
 *
 * One change becomes multiple changes.
 *
 * @returns Array of new change IDs
 */
export function recordSplit(
  db: Database.Database,
  originalId: string,
  streamId: string,
  newCommits: Array<{ commit: string; description: string }>
): string[] {
  const t = getTables(db);

  // Mark original as dropped
  updateChangeStatus(db, originalId, 'dropped');

  // Create new changes
  const newIds: string[] = [];
  for (const { commit, description } of newCommits) {
    const changeId = git.generateChangeId();
    const now = Date.now();

    const initialRecord: CommitRecord = {
      commit,
      recordedAt: now,
      reason: 'initial',
    };

    db.prepare(`
      INSERT INTO ${t.changes} (
        id, stream_id, description, commit_history, current_commit, status, split_from
      ) VALUES (?, ?, ?, ?, ?, 'active', ?)
    `).run(
      changeId,
      streamId,
      description,
      JSON.stringify([initialRecord]),
      commit,
      originalId
    );

    newIds.push(changeId);
  }

  return newIds;
}

/**
 * Mark changes as merged.
 */
export function markMerged(db: Database.Database, changeIds: string[]): void {
  for (const changeId of changeIds) {
    updateChangeStatus(db, changeId, 'merged');
  }
}

/**
 * Mark a change as dropped.
 */
export function markDropped(db: Database.Database, changeId: string): void {
  updateChangeStatus(db, changeId, 'dropped');
}

// ─────────────────────────────────────────────────────────────────────────────
// Rebase Integration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build commit mapping from old commits to new commits using patch-id.
 */
export function buildRebaseCommitMapping(
  worktree: string,
  oldCommits: string[],
  newCommits: string[]
): Map<string, string> {
  const gitOpts = { cwd: worktree };

  const oldPatchIds = git.buildPatchIdMap(oldCommits, gitOpts);
  const newPatchIds = git.buildPatchIdMap(newCommits, gitOpts);

  // Invert newPatchIds: patchId -> newCommit
  const patchIdToNew = new Map<string, string>();
  for (const [patchId, commit] of newPatchIds) {
    patchIdToNew.set(patchId, commit);
  }

  // Map old commits to new commits via patch-id
  const mapping = new Map<string, string>();
  for (const [patchId, oldCommit] of oldPatchIds) {
    const newCommit = patchIdToNew.get(patchId);
    if (newCommit) {
      mapping.set(oldCommit, newCommit);
    }
  }

  return mapping;
}

/**
 * Rebuild change tracking after a rebase.
 *
 * Uses commit mapping to update current_commit and history for affected changes.
 */
export function rebuildChangesAfterRebase(
  db: Database.Database,
  streamId: string,
  commitMapping: Map<string, string>
): void {
  // Get all active changes for this stream
  const changes = getChangesForStream(db, streamId, { status: 'active' });

  for (const change of changes) {
    if (!change.currentCommit) continue;

    const newCommit = commitMapping.get(change.currentCommit);
    if (newCommit && newCommit !== change.currentCommit) {
      recordRewrite(db, change.id, newCommit, 'rebase');
    }
  }
}

/**
 * Get all changes for a stream that are active.
 */
export function getActiveChanges(
  db: Database.Database,
  streamId: string
): Change[] {
  return getChangesForStream(db, streamId, { status: 'active' });
}
