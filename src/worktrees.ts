/**
 * Worktree management for agent isolation.
 *
 * Each agent gets a dedicated git worktree for filesystem isolation.
 */

import type Database from 'better-sqlite3';
import { getTables } from './db/tables.js';
import type { AgentWorktree, CreateWorktreeOptions } from './models/index.js';
import * as git from './git/index.js';
import { WorktreeError } from './errors.js';

/**
 * Convert database row to AgentWorktree object.
 */
function rowToWorktree(row: Record<string, unknown>): AgentWorktree {
  return {
    agentId: row.agent_id as string,
    path: row.path as string,
    currentStream: row.current_stream as string | null,
    createdAt: row.created_at as number,
    lastActive: row.last_active as number,
  };
}

/**
 * Create a new worktree for an agent.
 */
export function createWorktree(
  db: Database.Database,
  repoPath: string,
  options: CreateWorktreeOptions
): AgentWorktree {
  const now = Date.now();
  const t = getTables(db);

  // Check if agent already has a worktree
  const existing = getWorktree(db, options.agentId);
  if (existing) {
    throw new WorktreeError(
      `Agent ${options.agentId} already has a worktree at ${existing.path}`
    );
  }

  // Determine current stream from branch name
  let currentStream: string | null = null;

  // Create git worktree
  try {
    if (options.branch) {
      // If a specific branch is requested (e.g., stream branch), check it out
      git.addWorktree(options.path, options.branch, { cwd: repoPath });
      if (options.branch.startsWith('stream/')) {
        currentStream = options.branch.slice(7); // Remove 'stream/' prefix
      }
    } else {
      // Default: create worktree with detached HEAD at current HEAD
      // This avoids "branch already checked out" errors
      const head = git.getHead({ cwd: repoPath });
      git.addWorktreeDetached(options.path, head, { cwd: repoPath });
    }
  } catch (error) {
    throw new WorktreeError(
      `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Record in database
  db.prepare(`
    INSERT INTO ${t.agent_worktrees} (agent_id, path, current_stream, created_at, last_active)
    VALUES (?, ?, ?, ?, ?)
  `).run(options.agentId, options.path, currentStream, now, now);

  return {
    agentId: options.agentId,
    path: options.path,
    currentStream,
    createdAt: now,
    lastActive: now,
  };
}

/**
 * Get a worktree by agent ID.
 */
export function getWorktree(
  db: Database.Database,
  agentId: string
): AgentWorktree | null {
  const t = getTables(db);
  const row = db
    .prepare(`SELECT * FROM ${t.agent_worktrees} WHERE agent_id = ?`)
    .get(agentId) as Record<string, unknown> | undefined;

  return row ? rowToWorktree(row) : null;
}

/**
 * Update the stream checked out in an agent's worktree.
 */
export function updateWorktreeStream(
  db: Database.Database,
  _repoPath: string,
  agentId: string,
  streamId: string | null
): void {
  const worktree = getWorktree(db, agentId);
  if (!worktree) {
    throw new WorktreeError(`No worktree found for agent ${agentId}`);
  }

  const now = Date.now();

  if (streamId) {
    // Checkout the stream branch in the worktree
    const branchName = `stream/${streamId}`;
    try {
      git.checkout(branchName, { cwd: worktree.path });
    } catch (error) {
      throw new WorktreeError(
        `Failed to checkout stream ${streamId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    // Checkout main/default branch
    try {
      git.checkout('main', { cwd: worktree.path });
    } catch {
      // Try master if main doesn't exist
      git.checkout('master', { cwd: worktree.path });
    }
  }

  // Update database
  const t = getTables(db);
  db.prepare(`
    UPDATE ${t.agent_worktrees}
    SET current_stream = ?, last_active = ?
    WHERE agent_id = ?
  `).run(streamId, now, agentId);
}

/**
 * Deallocate (remove) a worktree.
 */
export function deallocateWorktree(
  db: Database.Database,
  repoPath: string,
  agentId: string
): void {
  const worktree = getWorktree(db, agentId);
  if (!worktree) {
    // Already deallocated, nothing to do
    return;
  }

  // Remove git worktree
  try {
    git.removeWorktree(worktree.path, true, { cwd: repoPath });
  } catch (error) {
    // Log but don't fail - the worktree might already be gone
    console.warn(
      `Warning: Failed to remove worktree ${worktree.path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Remove from database
  const t = getTables(db);
  db.prepare(`DELETE FROM ${t.agent_worktrees} WHERE agent_id = ?`).run(agentId);

  // Prune stale worktree references
  try {
    git.pruneWorktrees({ cwd: repoPath });
  } catch {
    // Ignore prune errors
  }
}

/**
 * List all registered worktrees.
 */
export function listWorktrees(db: Database.Database): AgentWorktree[] {
  const t = getTables(db);
  const rows = db
    .prepare(`SELECT * FROM ${t.agent_worktrees} ORDER BY created_at DESC`)
    .all() as Record<string, unknown>[];

  return rows.map(rowToWorktree);
}

/**
 * Update last active timestamp for a worktree.
 */
export function touchWorktree(db: Database.Database, agentId: string): void {
  const now = Date.now();
  const t = getTables(db);
  db.prepare(`UPDATE ${t.agent_worktrees} SET last_active = ? WHERE agent_id = ?`).run(
    now,
    agentId
  );
}

/**
 * Find stale worktrees (not active for a given threshold).
 */
export function findStaleWorktrees(
  db: Database.Database,
  thresholdMs: number
): AgentWorktree[] {
  const cutoff = Date.now() - thresholdMs;
  const t = getTables(db);
  const rows = db
    .prepare(`SELECT * FROM ${t.agent_worktrees} WHERE last_active < ?`)
    .all(cutoff) as Record<string, unknown>[];

  return rows.map(rowToWorktree);
}
