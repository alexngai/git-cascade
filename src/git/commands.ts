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
