/**
 * Cascade rebase logic.
 *
 * When a stream is rebased, all dependent streams need to be rebased too.
 * This module handles the cascade propagation.
 */

import type Database from 'better-sqlite3';
import * as deps from './dependencies.js';
import * as streams from './streams.js';
import * as git from './git/index.js';
import { createWorktreeProvider } from './worktrees.js';
import { DiamondDependencyError } from './errors.js';
import type {
  CascadeResult,
  CascadeStrategy,
  WorktreeProviderOptions,
  RebaseResult,
} from './models/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Cascade Rebase Options
// ─────────────────────────────────────────────────────────────────────────────

export interface CascadeRebaseOptions {
  /** Root stream that was rebased */
  rootStream: string;
  /** Agent performing the cascade */
  agentId: string;
  /** Worktree provider options */
  worktree: WorktreeProviderOptions;
  /** Strategy for handling conflicts (default: 'stop_on_conflict') */
  strategy?: CascadeStrategy;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cascade Rebase Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cascade rebase to all dependents of a root stream.
 *
 * Algorithm:
 * 1. Get all dependents of root stream
 * 2. Sort topologically (dependencies come before dependents)
 * 3. For each stream in order:
 *    - Check if any dependency failed → skip
 *    - Check for diamond dependency → throw error
 *    - Perform rebase
 *    - Handle result based on strategy
 */
export function cascadeRebase(
  db: Database.Database,
  repoPath: string,
  options: CascadeRebaseOptions
): CascadeResult {
  const { rootStream, agentId, worktree: worktreeOptions } = options;
  const strategy = options.strategy ?? 'stop_on_conflict';

  // Get all dependents of root stream
  const dependents = deps.getAllDependents(db, rootStream);

  if (dependents.length === 0) {
    return {
      success: true,
      updated: [],
      failed: [],
      skipped: [],
      results: {},
    };
  }

  // Sort topologically
  const ordered = deps.topologicalSort(db, dependents);

  // Create worktree provider
  const provider = createWorktreeProvider(repoPath, worktreeOptions);

  const results: Record<string, RebaseResult> = {};
  const failed: string[] = [];
  const skipped: string[] = [];
  const updated: string[] = [];

  try {
    for (const streamId of ordered) {
      // Check if any dependency failed
      const streamDeps = deps.getDependencies(db, streamId);
      const failedDeps = streamDeps.filter((d) => failed.includes(d));

      if (failedDeps.length > 0) {
        results[streamId] = {
          success: false,
          error: `Skipped: dependencies failed: ${failedDeps.join(', ')}`,
        };
        skipped.push(streamId);
        continue;
      }

      // Check for diamond dependency
      if (deps.isDiamondDependency(db, streamId)) {
        const depType = deps.getDependencyType(db, streamId);
        const parentHeads = streamDeps.map((parentId) => {
          try {
            return git.resolveRef(`stream/${parentId}`, { cwd: repoPath });
          } catch {
            return 'unknown';
          }
        });

        // Throw for diamond dependencies - requires manual resolution
        if (depType === 'merge' || streamDeps.length > 1) {
          provider.cleanup();
          throw new DiamondDependencyError(streamId, streamDeps, parentHeads);
        }
      }

      // Get worktree for this stream
      let worktreePath: string;
      try {
        worktreePath = provider.getWorktree(streamId);
      } catch (error) {
        results[streamId] = {
          success: false,
          error: `Failed to get worktree: ${error instanceof Error ? error.message : String(error)}`,
        };
        failed.push(streamId);

        if (strategy === 'stop_on_conflict') {
          break;
        }
        continue;
      }

      // Determine rebase target (first dependency that's still in our set or root)
      const rebaseTarget = streamDeps.find(
        (d) => d === rootStream || dependents.includes(d)
      ) ?? rootStream;

      // Perform the rebase (without cascade - we're already cascading)
      const result = streams.rebaseOntoStream(db, repoPath, {
        sourceStream: streamId,
        targetStream: rebaseTarget,
        agentId,
        worktree: worktreePath,
        onConflict: 'abort', // For now, abort on conflict
        cascade: false, // Disable nested cascade
      });

      results[streamId] = result;

      if (result.success) {
        updated.push(streamId);
      } else {
        failed.push(streamId);

        if (strategy === 'stop_on_conflict') {
          break;
        }
        // For skip_conflicting, continue to next stream
      }
    }
  } finally {
    // Always cleanup the provider
    provider.cleanup();
  }

  return {
    success: failed.length === 0 && skipped.length === 0,
    updated,
    failed,
    skipped,
    results,
  };
}
