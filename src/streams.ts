/**
 * Stream CRUD operations.
 */

import type Database from 'better-sqlite3';
import * as crypto from 'crypto';
import { getTables } from './db/tables.js';
import type {
  Stream,
  StreamStatus,
  CreateStreamOptions,
  ForkStreamOptions,
  MergeStreamOptions,
  MergeResult,
} from './models/index.js';
import * as git from './git/index.js';
import { StreamNotFoundError, BranchNotFoundError } from './errors.js';

/**
 * Generate a unique stream ID.
 */
function generateStreamId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Convert database row to Stream object.
 */
function rowToStream(row: Record<string, unknown>): Stream {
  return {
    id: row.id as string,
    name: row.name as string,
    agentId: row.agent_id as string,
    baseCommit: row.base_commit as string,
    parentStream: row.parent_stream as string | null,
    status: row.status as StreamStatus,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    mergedInto: row.merged_into as string | null,
    enableStackedReview: Boolean(row.enable_stacked_review),
    metadata: JSON.parse((row.metadata as string) || '{}'),
  };
}

/**
 * Create a new stream.
 */
export function createStream(
  db: Database.Database,
  repoPath: string,
  options: CreateStreamOptions
): string {
  const streamId = generateStreamId();
  const now = Date.now();
  const base = options.base ?? 'main';
  const t = getTables(db);

  // Resolve base to commit hash
  const baseCommit = git.resolveRef(base, { cwd: repoPath });

  // Create git branch
  const branchName = `stream/${streamId}`;
  git.createBranch(branchName, baseCommit, { cwd: repoPath });

  // Insert into database
  db.prepare(`
    INSERT INTO ${t.streams} (
      id, name, agent_id, base_commit, parent_stream, status,
      created_at, updated_at, merged_into, enable_stacked_review, metadata
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)
  `).run(
    streamId,
    options.name,
    options.agentId,
    baseCommit,
    options.parentStream ?? null,
    now,
    now,
    options.enableStackedReview ? 1 : 0,
    JSON.stringify(options.metadata ?? {})
  );

  return streamId;
}

/**
 * Get a stream by ID.
 */
export function getStream(
  db: Database.Database,
  streamId: string
): Stream | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.streams} WHERE id = ?`)
    .get(streamId) as Record<string, unknown> | undefined;

  return row ? rowToStream(row) : null;
}

/**
 * Get a stream by ID, throwing if not found.
 */
export function getStreamOrThrow(
  db: Database.Database,
  streamId: string
): Stream {
  const stream = getStream(db, streamId);
  if (!stream) {
    throw new StreamNotFoundError(streamId);
  }
  return stream;
}

/**
 * List streams with optional filters.
 */
export function listStreams(
  db: Database.Database,
  options?: { agentId?: string; status?: StreamStatus }
): Stream[] {
  const t = getTables(db);
  let query = `SELECT * FROM ${t.streams} WHERE 1=1`;
  const params: unknown[] = [];

  if (options?.agentId) {
    query += ' AND agent_id = ?';
    params.push(options.agentId);
  }
  if (options?.status) {
    query += ' AND status = ?';
    params.push(options.status);
  }

  query += ' ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(rowToStream);
}

/**
 * Update stream properties.
 */
export function updateStream(
  db: Database.Database,
  streamId: string,
  updates: Partial<Pick<Stream, 'name' | 'status' | 'metadata'>>
): void {
  const stream = getStreamOrThrow(db, streamId);
  const now = Date.now();

  const setClauses: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];

  if (updates.name !== undefined) {
    setClauses.push('name = ?');
    params.push(updates.name);
  }
  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    params.push(updates.status);
  }
  if (updates.metadata !== undefined) {
    setClauses.push('metadata = ?');
    params.push(JSON.stringify({ ...stream.metadata, ...updates.metadata }));
  }

  params.push(streamId);

  const t = getTables(db);
  db.prepare(`UPDATE ${t.streams} SET ${setClauses.join(', ')} WHERE id = ?`).run(
    ...params
  );
}

/**
 * Abandon a stream.
 */
export function abandonStream(
  db: Database.Database,
  streamId: string,
  reason?: string
): void {
  const stream = getStreamOrThrow(db, streamId);
  const now = Date.now();

  const metadata = {
    ...stream.metadata,
    abandonedAt: now,
    abandonReason: reason,
  };

  const t = getTables(db);
  db.prepare(`
    UPDATE ${t.streams} SET status = 'abandoned', updated_at = ?, metadata = ?
    WHERE id = ?
  `).run(now, JSON.stringify(metadata), streamId);
}

/**
 * Fork a stream (create new stream from existing stream's head).
 */
export function forkStream(
  db: Database.Database,
  repoPath: string,
  options: ForkStreamOptions
): string {
  const parent = getStreamOrThrow(db, options.parentStreamId);

  // Get parent's current head
  const parentBranch = `stream/${parent.id}`;
  const baseCommit = git.resolveRef(parentBranch, { cwd: repoPath });

  // Create new stream with parent reference
  return createStream(db, repoPath, {
    name: options.name,
    agentId: options.agentId,
    base: baseCommit,
    parentStream: parent.id,
  });
}

/**
 * Merge a stream into another.
 */
export function mergeStream(
  db: Database.Database,
  _repoPath: string,
  options: MergeStreamOptions
): MergeResult {
  const t = getTables(db);
  const source = getStreamOrThrow(db, options.sourceStream);
  // Validate target exists
  getStreamOrThrow(db, options.targetStream);

  const sourceBranch = `stream/${source.id}`;
  const targetBranch = `stream/${options.targetStream}`;
  const strategy = options.strategy ?? 'merge-commit';

  const gitOpts = { cwd: options.worktree };

  // Checkout target branch
  git.checkout(targetBranch, gitOpts);

  try {
    if (strategy === 'merge-commit') {
      git.git(['merge', '--no-ff', sourceBranch, '-m', `Merge ${source.name}`], gitOpts);
    } else if (strategy === 'squash') {
      git.git(['merge', '--squash', sourceBranch], gitOpts);
      git.commit(`Merge ${source.name} (squashed)`, gitOpts);
    } else if (strategy === 'rebase') {
      // For rebase strategy, we rebase source onto target first
      git.checkout(sourceBranch, gitOpts);
      git.git(['rebase', targetBranch], gitOpts);
      git.checkout(targetBranch, gitOpts);
      git.git(['merge', '--ff-only', sourceBranch], gitOpts);
    }

    const newHead = git.getHead(gitOpts);

    // Update source stream status
    const now = Date.now();
    db.prepare(`
      UPDATE ${t.streams} SET status = 'merged', merged_into = ?, updated_at = ?
      WHERE id = ?
    `).run(options.targetStream, now, source.id);

    return { success: true, newHead };
  } catch (error) {
    // Check for conflicts
    const conflicts = git.getConflictedFiles(gitOpts);
    if (conflicts.length > 0) {
      git.mergeAbort(gitOpts);
      return { success: false, conflicts };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get the current head commit of a stream.
 */
export function getStreamHead(repoPath: string, streamId: string): string {
  const branchName = `stream/${streamId}`;
  try {
    return git.resolveRef(branchName, { cwd: repoPath });
  } catch {
    throw new BranchNotFoundError(branchName);
  }
}
