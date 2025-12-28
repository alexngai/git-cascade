/**
 * Git command helpers.
 *
 * Provides a typed interface for common git operations.
 */

import { execSync, ExecSyncOptions } from 'child_process';
import { GitOperationError, BranchNotFoundError } from '../errors.js';

export interface GitOptions {
  /** Working directory for git commands */
  cwd: string;
  /** Environment variables */
  env?: Record<string, string>;
}

/**
 * Quote a shell argument if it contains spaces or special characters.
 */
function quoteArg(arg: string): string {
  // If arg contains spaces, quotes, or other special chars, quote it
  if (/[\s"'$`\\!*?#&;()[\]{}|<>]/.test(arg)) {
    // Escape any single quotes and wrap in single quotes
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
  return arg;
}

/**
 * Execute a git command and return stdout.
 */
export function git(args: string[], options: GitOptions): string {
  const execOptions: ExecSyncOptions = {
    cwd: options.cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...options.env },
    maxBuffer: 50 * 1024 * 1024, // 50MB
  };

  try {
    // Properly quote arguments that need it
    const quotedArgs = args.map(quoteArg).join(' ');
    const result = execSync(`git ${quotedArgs}`, execOptions);
    return (result as string).trim();
  } catch (error) {
    const err = error as { status?: number; stderr?: Buffer | string };
    const stderr = err.stderr?.toString() ?? '';
    throw new GitOperationError(`git ${args[0]} failed: ${stderr}`);
  }
}

/**
 * Get the current HEAD commit hash.
 */
export function getHead(options: GitOptions): string {
  return git(['rev-parse', 'HEAD'], options);
}

/**
 * Resolve a ref (branch, tag, commit) to a commit hash.
 */
export function resolveRef(ref: string, options: GitOptions): string {
  try {
    return git(['rev-parse', ref], options);
  } catch {
    throw new BranchNotFoundError(ref);
  }
}

/**
 * Check if a ref exists.
 */
export function refExists(ref: string, options: GitOptions): boolean {
  try {
    git(['rev-parse', '--verify', ref], options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the commit message for a commit.
 */
export function getCommitMessage(commit: string, options: GitOptions): string {
  return git(['log', '-1', '--format=%B', commit], options);
}

/**
 * Create a new branch at a specific commit.
 */
export function createBranch(
  branchName: string,
  commit: string,
  options: GitOptions
): void {
  git(['branch', branchName, commit], options);
}

/**
 * Delete a branch.
 */
export function deleteBranch(
  branchName: string,
  force: boolean,
  options: GitOptions
): void {
  const flag = force ? '-D' : '-d';
  git(['branch', flag, branchName], options);
}

/**
 * Update a branch to point to a specific commit.
 */
export function updateBranch(
  branchName: string,
  commit: string,
  options: GitOptions
): void {
  git(['branch', '-f', branchName, commit], options);
}

/**
 * Get list of commits between two refs.
 */
export function getCommitRange(
  from: string,
  to: string,
  options: GitOptions
): string[] {
  const output = git(['rev-list', '--reverse', `${from}..${to}`], options);
  return output ? output.split('\n').filter(Boolean) : [];
}

/**
 * Get the merge base of two commits.
 */
export function getMergeBase(
  commit1: string,
  commit2: string,
  options: GitOptions
): string {
  return git(['merge-base', commit1, commit2], options);
}

/**
 * Check if working directory is clean.
 */
export function isClean(options: GitOptions): boolean {
  const status = git(['status', '--porcelain'], options);
  return status === '';
}

/**
 * Get list of changed files (staged and unstaged).
 */
export function getChangedFiles(options: GitOptions): string[] {
  const status = git(['status', '--porcelain'], options);
  if (!status) return [];
  return status
    .split('\n')
    .map((line) => line.slice(3))
    .filter(Boolean);
}

/**
 * Stage all changes.
 */
export function stageAll(options: GitOptions): void {
  git(['add', '--all'], options);
}

/**
 * Create a commit with the given message.
 */
export function commit(message: string, options: GitOptions): string {
  git(['commit', '-m', message], options);
  return getHead(options);
}

/**
 * Amend the last commit.
 */
export function amendCommit(
  message: string | undefined,
  options: GitOptions
): string {
  const args = message
    ? ['commit', '--amend', '-m', message]
    : ['commit', '--amend', '--no-edit'];
  git(args, options);
  return getHead(options);
}

/**
 * Checkout a branch or commit.
 */
export function checkout(ref: string, options: GitOptions): void {
  git(['checkout', ref], options);
}

/**
 * Hard reset to a specific commit.
 */
export function resetHard(commit: string, options: GitOptions): void {
  git(['reset', '--hard', commit], options);
}

/**
 * Cherry-pick a commit.
 */
export function cherryPick(
  commit: string,
  options: GitOptions
): { success: boolean; conflicts: string[] } {
  try {
    git(['cherry-pick', '--no-commit', commit], options);
    return { success: true, conflicts: [] };
  } catch {
    const conflicts = getConflictedFiles(options);
    return { success: false, conflicts };
  }
}

/**
 * Get list of conflicted files.
 */
export function getConflictedFiles(options: GitOptions): string[] {
  const output = git(['diff', '--name-only', '--diff-filter=U'], options);
  return output ? output.split('\n').filter(Boolean) : [];
}

/**
 * Abort a rebase in progress.
 */
export function rebaseAbort(options: GitOptions): void {
  git(['rebase', '--abort'], options);
}

/**
 * Abort a merge in progress.
 */
export function mergeAbort(options: GitOptions): void {
  git(['merge', '--abort'], options);
}

// ─────────────────────────────────────────────────────────────────────────────
// Worktree Operations
// ─────────────────────────────────────────────────────────────────────────────

export interface WorktreeListEntry {
  path: string;
  commit: string;
  branch: string | null;
  bare: boolean;
}

/**
 * Add a new worktree.
 */
export function addWorktree(
  path: string,
  branch: string,
  options: GitOptions
): void {
  git(['worktree', 'add', path, branch], options);
}

/**
 * Add a new worktree with a detached HEAD at a specific commit.
 */
export function addWorktreeDetached(
  path: string,
  commit: string,
  options: GitOptions
): void {
  git(['worktree', 'add', '--detach', path, commit], options);
}

/**
 * Remove a worktree.
 */
export function removeWorktree(
  path: string,
  force: boolean,
  options: GitOptions
): void {
  const args = force
    ? ['worktree', 'remove', '--force', path]
    : ['worktree', 'remove', path];
  git(args, options);
}

/**
 * List all worktrees.
 */
export function listWorktrees(options: GitOptions): WorktreeListEntry[] {
  const output = git(['worktree', 'list', '--porcelain'], options);
  if (!output) return [];

  const entries: WorktreeListEntry[] = [];
  let current: Partial<WorktreeListEntry> = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) {
        entries.push(current as WorktreeListEntry);
      }
      current = { path: line.slice(9), branch: null, bare: false };
    } else if (line.startsWith('HEAD ')) {
      current.commit = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7);
    } else if (line === 'bare') {
      current.bare = true;
    }
  }

  if (current.path) {
    entries.push(current as WorktreeListEntry);
  }

  return entries;
}

/**
 * Prune stale worktree references.
 */
export function pruneWorktrees(options: GitOptions): void {
  git(['worktree', 'prune'], options);
}

// ─────────────────────────────────────────────────────────────────────────────
// Patch-ID Operations (for tracking commits across rebases)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get git patch-id for a commit.
 *
 * Patch-id is a stable hash of the diff content, surviving rebases
 * and commit message changes. This is useful for tracking the "same"
 * logical change across rebases where commit hashes change.
 *
 * @param commit - The commit hash to get patch-id for
 * @param options - Git options including cwd
 * @returns The patch-id hash
 */
export function getPatchId(commit: string, options: GitOptions): string {
  const execOptions = {
    cwd: options.cwd,
    encoding: 'utf-8' as const,
    env: { ...process.env, ...options.env },
    maxBuffer: 50 * 1024 * 1024,
  };

  try {
    // git show <commit> | git patch-id --stable
    const result = execSync(
      `git show ${quoteArg(commit)} | git patch-id --stable`,
      execOptions
    );
    const output = (result as string).trim();
    // Output format: "<patch-id> <commit>"
    const patchId = output.split(' ')[0];
    if (!patchId) {
      throw new GitOperationError(`Failed to get patch-id for ${commit}: empty output`);
    }
    return patchId;
  } catch (error) {
    const err = error as { status?: number; stderr?: Buffer | string };
    const stderr = err.stderr?.toString() ?? '';
    throw new GitOperationError(`Failed to get patch-id for ${commit}: ${stderr}`);
  }
}

/**
 * Build a map of patch-ids to commit hashes for a range of commits.
 *
 * Useful for rebuilding stacks after rebase - find which new commit
 * corresponds to which old commit by matching patch-ids.
 *
 * @param commits - Array of commit hashes
 * @param options - Git options including cwd
 * @returns Map from patch-id to commit hash
 */
export function buildPatchIdMap(
  commits: string[],
  options: GitOptions
): Map<string, string> {
  const map = new Map<string, string>();
  for (const commit of commits) {
    try {
      const patchId = getPatchId(commit, options);
      map.set(patchId, commit);
    } catch {
      // Skip commits that fail (e.g., merge commits have no patch-id)
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rebase Operations
// ─────────────────────────────────────────────────────────────────────────────

export type RebaseConflictStrategy = 'abort' | 'ours' | 'theirs';

export interface RebaseOntoResult {
  success: boolean;
  newHead?: string;
  conflicts?: string[];
  error?: string;
}

/**
 * Rebase commits onto a new base.
 *
 * git rebase --onto <newbase> <upstream> [branch]
 *
 * This rebases commits from upstream..branch onto newbase.
 *
 * @param newBase - The commit to rebase onto
 * @param upstream - The upstream commit (exclusive - commits after this are rebased)
 * @param branch - The branch to rebase (optional, uses current if not specified)
 * @param options - Git options including cwd
 */
export function rebaseOnto(
  newBase: string,
  upstream: string,
  branch: string | undefined,
  options: GitOptions
): RebaseOntoResult {
  try {
    const args = ['rebase', '--onto', newBase, upstream];
    if (branch) {
      args.push(branch);
    }
    git(args, options);
    return { success: true, newHead: getHead(options) };
  } catch (error) {
    // Check if there are conflicts
    const conflicts = getConflictedFiles(options);
    if (conflicts.length > 0) {
      return { success: false, conflicts };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Rebase with a specific conflict resolution strategy.
 *
 * @param newBase - The commit to rebase onto
 * @param upstream - The upstream commit (exclusive)
 * @param branch - The branch to rebase
 * @param strategy - How to handle conflicts
 * @param options - Git options including cwd
 */
export function rebaseOntoWithStrategy(
  newBase: string,
  upstream: string,
  branch: string,
  strategy: RebaseConflictStrategy,
  options: GitOptions
): RebaseOntoResult {
  // First checkout the branch
  checkout(branch, options);

  // Try rebase with strategy-specific options
  const args = ['rebase', '--onto', newBase, upstream];

  if (strategy === 'ours') {
    // Note: In git rebase, --ours means keep the changes from the branch being rebased
    // This is counterintuitive but correct
    args.push('--strategy=recursive', '--strategy-option=ours');
  } else if (strategy === 'theirs') {
    args.push('--strategy=recursive', '--strategy-option=theirs');
  }

  try {
    git(args, options);
    return { success: true, newHead: getHead(options) };
  } catch (error) {
    const conflicts = getConflictedFiles(options);
    if (conflicts.length > 0) {
      if (strategy === 'abort') {
        // Abort the rebase and return conflict info
        try {
          rebaseAbort(options);
        } catch {
          // Ignore abort errors
        }
        return { success: false, conflicts };
      }
      // For ours/theirs, we shouldn't normally get here, but handle it
      return { success: false, conflicts };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Continue a rebase after resolving conflicts.
 */
export function rebaseContinue(options: GitOptions): void {
  git(['rebase', '--continue'], options);
}

/**
 * Skip the current commit during rebase.
 */
export function rebaseSkip(options: GitOptions): void {
  git(['rebase', '--skip'], options);
}

/**
 * Check if a rebase is in progress.
 */
export function isRebaseInProgress(options: GitOptions): boolean {
  try {
    // Check for .git/rebase-merge or .git/rebase-apply directories
    const gitDir = git(['rev-parse', '--git-dir'], options);
    const fs = require('fs');
    const path = require('path');
    const rebaseMerge = path.join(options.cwd, gitDir, 'rebase-merge');
    const rebaseApply = path.join(options.cwd, gitDir, 'rebase-apply');
    return fs.existsSync(rebaseMerge) || fs.existsSync(rebaseApply);
  } catch {
    return false;
  }
}
