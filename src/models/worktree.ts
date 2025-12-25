/**
 * Agent Worktree data model and types.
 *
 * Git worktrees provide filesystem isolation for each agent.
 */

export interface AgentWorktree {
  /** Agent identifier */
  agentId: string;
  /** Filesystem path to worktree */
  path: string;
  /** Stream currently checked out */
  currentStream: string | null;
  /** Unix timestamp (ms) when created */
  createdAt: number;
  /** Unix timestamp (ms) of last operation */
  lastActive: number;
}

export interface CreateWorktreeOptions {
  agentId: string;
  /** Path where worktree should be created */
  path: string;
  /** Initial branch/stream to checkout (default: main) */
  branch?: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  locked: boolean;
}
