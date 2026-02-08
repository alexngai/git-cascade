/**
 * Reconciliation logic for detecting and handling external git changes.
 *
 * When agents operate outside of git-cascade's control, the git state can
 * diverge from what's tracked in the database. This module provides APIs
 * to detect and reconcile such differences.
 */

import type Database from 'better-sqlite3';
import { getTables } from './db/tables.js';
import * as git from './git/index.js';
import * as streams from './streams.js';
import type { Stream } from './models/index.js';
import { DesyncError } from './errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Status of a single stream's synchronization.
 */
export interface StreamSyncStatus {
  /** Stream ID */
  streamId: string;
  /** Stream name */
  name: string;
  /** Whether the stream is in sync */
  inSync: boolean;
  /** Expected HEAD (from database baseCommit + operations) */
  expectedHead: string | null;
  /** Actual HEAD (from git branch) */
  actualHead: string | null;
  /** Description of the discrepancy (if any) */
  discrepancy?: string;
}

/**
 * Result of a reconciliation check.
 */
export interface ReconcileCheckResult {
  /** Whether all streams are in sync */
  allInSync: boolean;
  /** Status of each stream */
  streams: StreamSyncStatus[];
  /** Streams that are in sync */
  synced: string[];
  /** Streams that have diverged */
  diverged: string[];
  /** Streams where the branch doesn't exist */
  missing: string[];
}

/**
 * Options for reconciliation.
 */
export interface ReconcileOptions {
  /** Only check specific streams (default: all active streams) */
  streamIds?: string[];
  /** Update database to match git state (default: false, just report) */
  updateDatabase?: boolean;
  /** Create missing branches (default: false) */
  createMissingBranches?: boolean;
}

/**
 * Result of a reconciliation operation.
 */
export interface ReconcileResult {
  /** Streams that were updated in the database */
  updated: string[];
  /** Streams where branches were created */
  branchesCreated: string[];
  /** Streams that could not be reconciled */
  failed: Array<{ streamId: string; error: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a stream is in sync with its git branch.
 *
 * A stream is "in sync" if:
 * - The git branch exists
 * - The branch HEAD matches what's expected based on the stream's operations
 *
 * @param db - Database connection
 * @param repoPath - Path to the git repository
 * @param streamId - Stream to check
 * @returns Sync status for the stream
 */
export function checkStreamSync(
  db: Database.Database,
  repoPath: string,
  streamId: string
): StreamSyncStatus {
  const stream = streams.getStream(db, streamId);
  if (!stream) {
    return {
      streamId,
      name: 'unknown',
      inSync: false,
      expectedHead: null,
      actualHead: null,
      discrepancy: 'Stream not found in database',
    };
  }

  // Get the expected branch name
  const branchName = streams.getStreamBranchName(db, streamId);

  // Try to get actual HEAD from git
  let actualHead: string | null = null;
  let branchExists = true;
  try {
    actualHead = git.resolveRef(branchName, { cwd: repoPath });
  } catch {
    branchExists = false;
  }

  if (!branchExists) {
    return {
      streamId,
      name: stream.name,
      inSync: false,
      expectedHead: stream.baseCommit,
      actualHead: null,
      discrepancy: `Branch ${branchName} does not exist`,
    };
  }

  // For a basic check, we compare against the stream's baseCommit if no operations
  // In a more sophisticated check, we'd track the expected HEAD from operations
  // For now, we just verify the branch exists and report what we find
  const expectedHead = getExpectedHead(db, repoPath, stream);

  const inSync = actualHead === expectedHead;

  return {
    streamId,
    name: stream.name,
    inSync,
    expectedHead,
    actualHead,
    discrepancy: inSync ? undefined : `Expected ${expectedHead}, found ${actualHead}`,
  };
}

/**
 * Get the expected HEAD for a stream based on its operations.
 *
 * If the stream has operations, the expected HEAD is the afterState of the latest operation.
 * Otherwise, it's the baseCommit.
 */
function getExpectedHead(
  db: Database.Database,
  _repoPath: string,
  stream: Stream
): string {
  const t = getTables(db);

  // Get the latest operation's afterState
  const latestOp = db
    .prepare(
      `SELECT after_state FROM ${t.operations}
       WHERE stream_id = ?
       ORDER BY timestamp DESC
       LIMIT 1`
    )
    .get(stream.id) as { after_state: string } | undefined;

  return latestOp?.after_state ?? stream.baseCommit;
}

/**
 * Check all active streams for sync status.
 *
 * @param db - Database connection
 * @param repoPath - Path to the git repository
 * @param options - Optional filtering options
 * @returns Comprehensive sync status
 */
export function checkAllStreams(
  db: Database.Database,
  repoPath: string,
  options?: { streamIds?: string[] }
): ReconcileCheckResult {
  const streamList = options?.streamIds
    ? options.streamIds.map((id) => streams.getStream(db, id)).filter((s): s is Stream => s !== null)
    : streams.listStreams(db, { status: 'active' });

  const results: StreamSyncStatus[] = [];
  const synced: string[] = [];
  const diverged: string[] = [];
  const missing: string[] = [];

  for (const stream of streamList) {
    const status = checkStreamSync(db, repoPath, stream.id);
    results.push(status);

    if (status.actualHead === null) {
      missing.push(stream.id);
    } else if (status.inSync) {
      synced.push(stream.id);
    } else {
      diverged.push(stream.id);
    }
  }

  return {
    allInSync: diverged.length === 0 && missing.length === 0,
    streams: results,
    synced,
    diverged,
    missing,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconcile database state with git state.
 *
 * This can either:
 * 1. Update the database to match git (when git is source of truth)
 * 2. Create missing branches (when database is source of truth)
 *
 * @param db - Database connection
 * @param repoPath - Path to the git repository
 * @param options - Reconciliation options
 * @returns Result of reconciliation
 */
export function reconcile(
  db: Database.Database,
  repoPath: string,
  options: ReconcileOptions = {}
): ReconcileResult {
  const { updateDatabase = false, createMissingBranches = false, streamIds } = options;

  // First, check current state
  const checkResult = checkAllStreams(db, repoPath, { streamIds });

  const result: ReconcileResult = {
    updated: [],
    branchesCreated: [],
    failed: [],
  };

  // Handle diverged streams
  if (updateDatabase) {
    for (const streamId of checkResult.diverged) {
      try {
        updateStreamFromGit(db, repoPath, streamId);
        result.updated.push(streamId);
      } catch (error) {
        result.failed.push({
          streamId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Handle missing branches
  if (createMissingBranches) {
    for (const streamId of checkResult.missing) {
      try {
        createStreamBranch(db, repoPath, streamId);
        result.branchesCreated.push(streamId);
      } catch (error) {
        result.failed.push({
          streamId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return result;
}

/**
 * Update database state to match git state for a stream.
 *
 * Records a 'reconcile' operation to document the external changes.
 */
function updateStreamFromGit(
  db: Database.Database,
  repoPath: string,
  streamId: string
): void {
  const stream = streams.getStream(db, streamId);
  if (!stream) {
    throw new Error(`Stream ${streamId} not found`);
  }

  const branchName = streams.getStreamBranchName(db, streamId);
  const actualHead = git.resolveRef(branchName, { cwd: repoPath });
  const expectedHead = getExpectedHead(db, repoPath, stream);

  const t = getTables(db);

  // Record a reconcile operation
  const operationId = `op-reconcile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO ${t.operations} (
      id, stream_id, agent_id, op_type, before_state, after_state, timestamp, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operationId,
    streamId,
    'system',
    'reconcile',
    expectedHead,
    actualHead,
    Date.now(),
    JSON.stringify({ reason: 'external_changes_detected' })
  );

  // Update stream's updated_at
  db.prepare(`UPDATE ${t.streams} SET updated_at = ? WHERE id = ?`).run(Date.now(), streamId);
}

/**
 * Create a git branch for a stream that's missing its branch.
 */
function createStreamBranch(
  db: Database.Database,
  repoPath: string,
  streamId: string
): void {
  const stream = streams.getStream(db, streamId);
  if (!stream) {
    throw new Error(`Stream ${streamId} not found`);
  }

  // Don't create branches for local mode streams
  if (stream.isLocalMode) {
    throw new Error(`Stream ${streamId} is in local mode - cannot create branch`);
  }

  const branchName = `stream/${streamId}`;
  git.createBranch(branchName, stream.baseCommit, { cwd: repoPath });
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a stream is in sync before performing an operation.
 *
 * Use this before write operations to warn about potential conflicts.
 *
 * @param db - Database connection
 * @param repoPath - Path to the git repository
 * @param streamId - Stream to check
 * @throws DesyncError if stream is out of sync (unless force is true)
 */
export function ensureInSync(
  db: Database.Database,
  repoPath: string,
  streamId: string,
  options?: { force?: boolean }
): void {
  const status = checkStreamSync(db, repoPath, streamId);

  if (!status.inSync && !options?.force) {
    throw new DesyncError(
      streamId,
      status.expectedHead ?? 'unknown',
      status.actualHead ?? 'unknown'
    );
  }
}
