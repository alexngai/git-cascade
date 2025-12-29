/**
 * Dependency and cascade rebase types.
 */

import type { RebaseResult } from './stream.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependency Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type of dependency relationship between streams.
 */
export type DependencyType = 'fork' | 'merge' | 'rebase_onto';

/**
 * Stream dependency record.
 */
export interface StreamDependency {
  streamId: string;
  dependsOn: string[];
  dependencyType: DependencyType;
}

// ─────────────────────────────────────────────────────────────────────────────
// Worktree Provider Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mode for providing worktrees during cascade rebase.
 */
export type WorktreeMode = 'callback' | 'temporary' | 'sequential';

/**
 * Options for worktree provider.
 */
export interface WorktreeProviderOptions {
  /** Mode for worktree management */
  mode: WorktreeMode;
  /** For 'callback' mode - function to get worktree path */
  provider?: (streamId: string) => string;
  /** For 'sequential' mode - path to reuse */
  worktreePath?: string;
  /** For 'temporary' mode - base directory for temp worktrees */
  tempDir?: string;
}

/**
 * Worktree provider instance.
 */
export interface WorktreeProvider {
  /** Get worktree path for a stream */
  getWorktree(streamId: string): string;
  /** Cleanup any temporary resources */
  cleanup(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cascade Rebase Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strategy for handling conflicts during cascade rebase.
 */
export type CascadeStrategy =
  | 'stop_on_conflict'   // Stop entire cascade at first conflict
  | 'skip_conflicting';  // Skip streams that would conflict, continue others
  // Future (Phase 6):
  // | 'defer_conflicts'    // Continue with conflict markers
  // | 'interactive';       // Call handler for each conflict

/**
 * Options for cascade rebase.
 */
export interface CascadeOptions {
  /** Strategy for handling conflicts */
  strategy?: CascadeStrategy;
  /** Worktree provider options */
  worktree?: WorktreeProviderOptions;
}

/**
 * Result of a cascade rebase operation.
 */
export interface CascadeResult {
  /** Whether all streams were successfully rebased */
  success: boolean;
  /** Streams that were successfully rebased */
  updated: string[];
  /** Streams that failed to rebase */
  failed: string[];
  /** Streams skipped due to failed dependencies */
  skipped: string[];
  /** Per-stream rebase results */
  results: Record<string, RebaseResult>;
}
