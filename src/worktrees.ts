/**
 * Worktree management for agent isolation.
 *
 * Each agent gets a dedicated git worktree for filesystem isolation.
 */

import type Database from 'better-sqlite3';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { getTables } from './db/tables.js';
import type {
  AgentWorktree,
  CreateWorktreeOptions,
  WorktreeProvider,
  WorktreeProviderOptions,
} from './models/index.js';
import * as git from './git/index.js';
import * as streams from './streams.js';
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
 *
 * For normal streams, checks out `stream/{id}`.
 * For local mode streams, checks out the existing branch name.
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

  // Validate worktree path exists before attempting git operations
  if (!fs.existsSync(worktree.path)) {
    throw new WorktreeError(
      `Worktree path does not exist: ${worktree.path}`,
      worktree.path
    );
  }

  if (streamId) {
    // Get the branch name from the stream (handles local mode)
    const branchName = streams.getStreamBranchName(db, streamId);
    try {
      git.checkout(branchName, { cwd: worktree.path });
    } catch (error) {
      throw new WorktreeError(
        `Failed to checkout stream ${streamId}: ${error instanceof Error ? error.message : String(error)}`,
        worktree.path
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

// ─────────────────────────────────────────────────────────────────────────────
// Worktree Provider for Cascade Rebase
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a worktree provider for cascade rebase operations.
 *
 * @param db - Database connection for stream lookups
 * @param repoPath - Path to the main repository
 * @param options - Provider configuration
 */
export function createWorktreeProvider(
  db: Database.Database,
  repoPath: string,
  options: WorktreeProviderOptions
): WorktreeProvider {
  switch (options.mode) {
    case 'callback':
      return createCallbackProvider(options);
    case 'temporary':
      return createTemporaryProvider(db, repoPath, options);
    case 'sequential':
      return createSequentialProvider(db, repoPath, options);
    default:
      throw new WorktreeError(`Unknown worktree mode: ${options.mode}`);
  }
}

/**
 * Create a callback-based worktree provider.
 * The caller provides a function to get the worktree path for each stream.
 */
function createCallbackProvider(options: WorktreeProviderOptions): WorktreeProvider {
  if (!options.provider) {
    throw new WorktreeError('Callback mode requires a provider function');
  }

  const providerFn = options.provider;

  return {
    getWorktree(streamId: string): string {
      return providerFn(streamId);
    },
    cleanup(): void {
      // Nothing to clean up - caller manages worktrees
    },
  };
}

/**
 * Create a temporary worktree provider.
 * Creates a new temporary worktree for each stream, cleans up when done.
 */
function createTemporaryProvider(
  db: Database.Database,
  repoPath: string,
  options: WorktreeProviderOptions
): WorktreeProvider {
  const tempDir = options.tempDir ?? os.tmpdir();
  const createdWorktrees: string[] = [];

  return {
    getWorktree(streamId: string): string {
      // Get the branch name from the stream (handles local mode)
      const branchName = streams.getStreamBranchName(db, streamId);
      const worktreePath = path.join(tempDir, `cascade-wt-${streamId}-${Date.now()}`);

      // Create the temporary worktree
      git.addWorktree(worktreePath, branchName, { cwd: repoPath });
      createdWorktrees.push(worktreePath);

      return worktreePath;
    },
    cleanup(): void {
      // Remove all created worktrees
      for (const wt of createdWorktrees) {
        try {
          git.removeWorktree(wt, true, { cwd: repoPath });
        } catch {
          // Best effort - worktree might already be gone
        }
        // Also try to remove the directory if it still exists
        try {
          if (fs.existsSync(wt)) {
            fs.rmSync(wt, { recursive: true, force: true });
          }
        } catch {
          // Ignore cleanup errors
        }
      }
      createdWorktrees.length = 0;

      // Prune stale worktree references
      try {
        git.pruneWorktrees({ cwd: repoPath });
      } catch {
        // Ignore prune errors
      }
    },
  };
}

/**
 * Create a sequential worktree provider.
 * Reuses a single worktree, checking out each stream in turn.
 */
function createSequentialProvider(
  db: Database.Database,
  _repoPath: string,
  options: WorktreeProviderOptions
): WorktreeProvider {
  const worktreePath = options.worktreePath;
  if (!worktreePath) {
    throw new WorktreeError('Sequential mode requires a worktreePath');
  }

  // Validate worktree path exists upfront
  if (!fs.existsSync(worktreePath)) {
    throw new WorktreeError(
      `Worktree path does not exist: ${worktreePath}`,
      worktreePath
    );
  }

  return {
    getWorktree(streamId: string): string {
      // Get the branch name from the stream (handles local mode)
      const branchName = streams.getStreamBranchName(db, streamId);

      // Checkout the stream branch in the existing worktree
      git.checkout(branchName, { cwd: worktreePath });

      return worktreePath;
    },
    cleanup(): void {
      // Nothing to clean up - worktree is managed by caller
    },
  };
}
