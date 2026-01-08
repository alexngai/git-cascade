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
  ConflictHandler,
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
  /** Per-stream conflict handlers (for defer_conflicts with optional agent resolution) */
  conflictHandlers?: Map<string, ConflictHandler>;
  /** Timeout for conflict handlers in ms (default: 300000 = 5 min) */
  conflictTimeout?: number;
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
  const conflictHandlers = options.conflictHandlers;
  const conflictTimeout = options.conflictTimeout ?? 300000;

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
  const provider = createWorktreeProvider(db, repoPath, worktreeOptions);

  const results: Record<string, RebaseResult> = {};
  const failed: string[] = [];
  const skipped: string[] = [];
  const updated: string[] = [];
  const deferred: string[] = [];
  const conflictRecords: Record<string, string> = {};

  try {
    for (const streamId of ordered) {
      // Check if any dependency failed or is deferred (conflicted)
      const streamDeps = deps.getDependencies(db, streamId);
      const failedDeps = streamDeps.filter((d) => failed.includes(d));
      const deferredDeps = streamDeps.filter((d) => deferred.includes(d));

      if (failedDeps.length > 0) {
        results[streamId] = {
          success: false,
          error: `Skipped: dependencies failed: ${failedDeps.join(', ')}`,
        };
        skipped.push(streamId);
        continue;
      }

      // For defer_conflicts, skip streams whose dependencies are conflicted
      if (deferredDeps.length > 0) {
        results[streamId] = {
          success: false,
          error: `Skipped: dependencies have unresolved conflicts: ${deferredDeps.join(', ')}`,
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

      // Get conflict handler for this stream (if using defer_conflicts with handlers)
      const streamHandler = conflictHandlers?.get(streamId);

      // Perform the rebase (without cascade - we're already cascading)
      const result = streams.rebaseOntoStream(db, repoPath, {
        sourceStream: streamId,
        targetStream: rebaseTarget,
        agentId,
        worktree: worktreePath,
        // For defer_conflicts with handler, use 'agent'; otherwise 'abort'
        onConflict: strategy === 'defer_conflicts' && streamHandler ? 'agent' : 'abort',
        conflictHandler: streamHandler,
        conflictTimeout,
        cascade: false, // Disable nested cascade
      });

      results[streamId] = result;

      if (result.success) {
        updated.push(streamId);
      } else if (result.conflicts && result.conflicts.length > 0) {
        // Handle conflict based on strategy
        if (strategy === 'defer_conflicts') {
          // Record the conflict and mark stream as deferred
          deferred.push(streamId);
          if (result.conflictId) {
            conflictRecords[streamId] = result.conflictId;
          }
          // Continue processing other streams
        } else if (strategy === 'skip_conflicting') {
          failed.push(streamId);
          // Continue processing other streams
        } else {
          // stop_on_conflict
          failed.push(streamId);
          break;
        }
      } else {
        // Non-conflict failure
        failed.push(streamId);

        if (strategy === 'stop_on_conflict') {
          break;
        }
      }
    }
  } finally {
    // Always cleanup the provider
    provider.cleanup();
  }

  return {
    success: failed.length === 0 && skipped.length === 0 && deferred.length === 0,
    updated,
    failed,
    skipped,
    results,
    deferred: deferred.length > 0 ? deferred : undefined,
    conflictRecords: Object.keys(conflictRecords).length > 0 ? conflictRecords : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resume Cascade After Conflict Resolution
// ─────────────────────────────────────────────────────────────────────────────

export interface ResumeCascadeOptions {
  /** Stream IDs that were previously deferred due to conflicts */
  deferredStreams: string[];
  /** Agent performing the cascade */
  agentId: string;
  /** Worktree provider options */
  worktree: WorktreeProviderOptions;
  /** Strategy for handling new conflicts (default: 'defer_conflicts') */
  strategy?: CascadeStrategy;
  /** Per-stream conflict handlers */
  conflictHandlers?: Map<string, ConflictHandler>;
  /** Timeout for conflict handlers in ms */
  conflictTimeout?: number;
}

/**
 * Resume cascade rebase after deferred conflicts have been resolved.
 *
 * Checks which previously deferred streams are now resolved (no longer conflicted)
 * and continues the cascade for their dependents.
 */
export function resumeCascade(
  db: Database.Database,
  repoPath: string,
  options: ResumeCascadeOptions
): CascadeResult {
  const { deferredStreams, agentId, worktree: worktreeOptions } = options;
  const strategy = options.strategy ?? 'defer_conflicts';
  const conflictHandlers = options.conflictHandlers;
  const conflictTimeout = options.conflictTimeout ?? 300000;

  const results: Record<string, RebaseResult> = {};
  const failed: string[] = [];
  const skipped: string[] = [];
  const updated: string[] = [];
  const deferred: string[] = [];
  const conflictRecords: Record<string, string> = {};

  // Check which deferred streams are now resolved
  const resolvedStreams: string[] = [];
  const stillConflicted: string[] = [];

  for (const streamId of deferredStreams) {
    const stream = streams.getStream(db, streamId);
    if (!stream) {
      results[streamId] = {
        success: false,
        error: `Stream ${streamId} not found`,
      };
      failed.push(streamId);
      continue;
    }

    if (stream.status === 'conflicted') {
      stillConflicted.push(streamId);
      results[streamId] = {
        success: false,
        error: 'Stream still has unresolved conflict',
      };
    } else {
      resolvedStreams.push(streamId);
      updated.push(streamId); // Already successfully rebased (conflict was resolved)
    }
  }

  if (resolvedStreams.length === 0) {
    // No streams were resolved, nothing to cascade
    return {
      success: stillConflicted.length === 0,
      updated,
      failed,
      skipped,
      results,
      deferred: stillConflicted.length > 0 ? stillConflicted : undefined,
    };
  }

  // Get all dependents of resolved streams
  const allDependents = new Set<string>();
  for (const streamId of resolvedStreams) {
    const streamDependents = deps.getAllDependents(db, streamId);
    for (const dep of streamDependents) {
      // Don't include streams that are still conflicted
      if (!stillConflicted.includes(dep)) {
        allDependents.add(dep);
      }
    }
  }

  // Remove streams that were already processed in the original cascade
  // (they should not be re-processed)
  for (const streamId of resolvedStreams) {
    allDependents.delete(streamId);
  }

  if (allDependents.size === 0) {
    return {
      success: stillConflicted.length === 0,
      updated,
      failed,
      skipped,
      results,
      deferred: stillConflicted.length > 0 ? stillConflicted : undefined,
    };
  }

  // Sort topologically
  const ordered = deps.topologicalSort(db, Array.from(allDependents));

  // Create worktree provider
  const provider = createWorktreeProvider(db, repoPath, worktreeOptions);

  try {
    for (const streamId of ordered) {
      // Check if any dependency failed or is still deferred
      const streamDeps = deps.getDependencies(db, streamId);
      const failedDeps = streamDeps.filter((d) => failed.includes(d));
      const conflictedDeps = streamDeps.filter((d) =>
        stillConflicted.includes(d) || deferred.includes(d)
      );

      if (failedDeps.length > 0) {
        results[streamId] = {
          success: false,
          error: `Skipped: dependencies failed: ${failedDeps.join(', ')}`,
        };
        skipped.push(streamId);
        continue;
      }

      if (conflictedDeps.length > 0) {
        results[streamId] = {
          success: false,
          error: `Skipped: dependencies have unresolved conflicts: ${conflictedDeps.join(', ')}`,
        };
        skipped.push(streamId);
        continue;
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

      // Determine rebase target (first resolved dependency or first available)
      const rebaseTarget = streamDeps.find((d) =>
        resolvedStreams.includes(d) || updated.includes(d)
      ) ?? streamDeps[0];

      if (!rebaseTarget) {
        results[streamId] = {
          success: false,
          error: 'No valid rebase target found',
        };
        failed.push(streamId);
        continue;
      }

      // Get conflict handler for this stream
      const streamHandler = conflictHandlers?.get(streamId);

      // Perform the rebase
      const result = streams.rebaseOntoStream(db, repoPath, {
        sourceStream: streamId,
        targetStream: rebaseTarget,
        agentId,
        worktree: worktreePath,
        onConflict: strategy === 'defer_conflicts' && streamHandler ? 'agent' : 'abort',
        conflictHandler: streamHandler,
        conflictTimeout,
        cascade: false,
      });

      results[streamId] = result;

      if (result.success) {
        updated.push(streamId);
      } else if (result.conflicts && result.conflicts.length > 0) {
        if (strategy === 'defer_conflicts') {
          deferred.push(streamId);
          if (result.conflictId) {
            conflictRecords[streamId] = result.conflictId;
          }
        } else if (strategy === 'skip_conflicting') {
          failed.push(streamId);
        } else {
          failed.push(streamId);
          break;
        }
      } else {
        failed.push(streamId);
        if (strategy === 'stop_on_conflict') {
          break;
        }
      }
    }
  } finally {
    provider.cleanup();
  }

  // Combine still-conflicted with newly deferred
  const allDeferred = [...stillConflicted, ...deferred];

  return {
    success: failed.length === 0 && skipped.length === 0 && allDeferred.length === 0,
    updated,
    failed,
    skipped,
    results,
    deferred: allDeferred.length > 0 ? allDeferred : undefined,
    conflictRecords: Object.keys(conflictRecords).length > 0 ? conflictRecords : undefined,
  };
}
