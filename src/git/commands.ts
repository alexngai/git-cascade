/**
 * Git command helpers.
 *
 * Provides a typed interface for common git operations.
 */

import { execSync, ExecSyncOptions } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
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
 * Cherry-pick a commit (stages changes but does not commit).
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
 * Check if a commit is a merge commit (has multiple parents).
 */
export function isMergeCommit(commit: string, options: GitOptions): boolean {
  // Get parent count - merge commits have 2+ parents
  const parents = git(['rev-parse', `${commit}^@`], options);
  const parentCount = parents.split('\n').filter(Boolean).length;
  return parentCount > 1;
}

/**
 * Cherry-pick a commit and create a new commit (preserves commit message).
 * For merge commits, uses -m 1 to follow the first parent (main line).
 * Skips empty cherry-picks (when changes already exist on target).
 */
export function cherryPickWithCommit(
  commit: string,
  options: GitOptions
): { success: boolean; newCommit?: string; conflicts: string[]; skipped?: boolean } {
  try {
    const args = ['cherry-pick'];

    // Handle merge commits with -m 1 (follow first parent)
    if (isMergeCommit(commit, options)) {
      args.push('-m', '1');
    }

    args.push(commit);

    const headBefore = getHead(options);
    try {
      git(args, options);
    } catch (error) {
      // Check if this is an empty cherry-pick (no changes to apply)
      const errorStr = String(error);
      if (errorStr.includes('cherry-pick is now empty') || errorStr.includes('nothing to commit')) {
        // Skip this empty cherry-pick
        try {
          git(['cherry-pick', '--skip'], options);
        } catch {
          // Ignore skip errors
        }
        return { success: true, newCommit: headBefore, conflicts: [], skipped: true };
      }
      throw error;
    }

    const newCommit = getHead(options);
    return { success: true, newCommit, conflicts: [] };
  } catch {
    const conflicts = getConflictedFiles(options);
    return { success: false, conflicts };
  }
}

/**
 * Abort a cherry-pick in progress.
 */
export function cherryPickAbort(options: GitOptions): void {
  git(['cherry-pick', '--abort'], options);
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

/**
 * Check if a rebase is in progress.
 */
export function isRebaseInProgress(options: GitOptions): boolean {
  const gitDir = git(['rev-parse', '--git-dir'], options).trim();
  const rebaseDir = `${options.cwd}/${gitDir}/rebase-merge`;
  const rebaseApplyDir = `${options.cwd}/${gitDir}/rebase-apply`;

  try {
    // Check for rebase-merge (interactive) or rebase-apply (standard)
    return fs.existsSync(rebaseDir) || fs.existsSync(rebaseApplyDir);
  } catch {
    return false;
  }
}

/**
 * Get rebase state information.
 */
export function getRebaseState(
  options: GitOptions
): { onto: string; head: string; step: number; total: number } | null {
  if (!isRebaseInProgress(options)) {
    return null;
  }

  const gitDir = git(['rev-parse', '--git-dir'], options).trim();

  // Try rebase-merge first (interactive rebase)
  const rebaseMergeDir = path.join(options.cwd, gitDir, 'rebase-merge');
  if (fs.existsSync(rebaseMergeDir)) {
    try {
      const onto = fs.readFileSync(path.join(rebaseMergeDir, 'onto'), 'utf8').trim();
      const head = fs.readFileSync(path.join(rebaseMergeDir, 'head-name'), 'utf8').trim();
      const msgnum = parseInt(fs.readFileSync(path.join(rebaseMergeDir, 'msgnum'), 'utf8').trim(), 10);
      const end = parseInt(fs.readFileSync(path.join(rebaseMergeDir, 'end'), 'utf8').trim(), 10);
      return { onto, head, step: msgnum, total: end };
    } catch {
      return null;
    }
  }

  // Try rebase-apply (standard rebase)
  const rebaseApplyDir = path.join(options.cwd, gitDir, 'rebase-apply');
  if (fs.existsSync(rebaseApplyDir)) {
    try {
      const onto = fs.readFileSync(path.join(rebaseApplyDir, 'onto'), 'utf8').trim();
      const head = fs.readFileSync(path.join(rebaseApplyDir, 'head-name'), 'utf8').trim();
      const next = parseInt(fs.readFileSync(path.join(rebaseApplyDir, 'next'), 'utf8').trim(), 10);
      const last = parseInt(fs.readFileSync(path.join(rebaseApplyDir, 'last'), 'utf8').trim(), 10);
      return { onto, head, step: next, total: last };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Continue a rebase after resolving conflicts.
 */
export function rebaseContinue(options: GitOptions): RebaseOntoResult {
  try {
    git(['rebase', '--continue'], options);
    return { success: true, newHead: getHead(options) };
  } catch (error) {
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
    // In git rebase, "ours" is the target we're rebasing onto, "theirs" is the commit being replayed
    // Our API: 'ours' = keep source stream's changes = git's "theirs" during rebase
    args.push('--strategy=recursive', '--strategy-option=theirs');
  } else if (strategy === 'theirs') {
    // Our API: 'theirs' = keep target stream's changes = git's "ours" during rebase
    args.push('--strategy=recursive', '--strategy-option=ours');
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
 * Skip the current commit during rebase.
 */
export function rebaseSkip(options: GitOptions): void {
  git(['rebase', '--skip'], options);
}

// ─────────────────────────────────────────────────────────────────────────────
// Change-Id Operations (Gerrit-style commit message trailers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a new Change-Id.
 *
 * Format: c-xxxxxxxx (8 hex characters from UUID)
 */
export function generateChangeId(): string {
  return `c-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Extract Change-Id from a commit message.
 *
 * Looks for a trailer line in the format: "Change-Id: c-xxxxxxxx"
 * Searches from the end of the message (trailers are at the bottom).
 *
 * @param commitMsg - The full commit message
 * @returns The Change-Id if found, null otherwise
 */
export function extractChangeId(commitMsg: string): string | null {
  const lines = commitMsg.trim().split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Change-Id: ')) {
      return trimmed.slice(11).trim(); // Remove "Change-Id: " prefix
    }
    // Allow blank lines between trailers
    if (trimmed === '') {
      continue;
    }
    // Stop searching when we hit a non-trailer line (doesn't look like "Key: value")
    if (!trimmed.includes(': ') && !trimmed.startsWith('Change-Id:')) {
      break;
    }
  }
  return null;
}

/**
 * Ensure a commit message has a Change-Id trailer.
 *
 * If the message already has a Change-Id, returns it unchanged.
 * Otherwise, appends a new Change-Id trailer.
 *
 * @param commitMsg - The commit message
 * @returns The commit message with a Change-Id trailer
 */
export function ensureChangeId(commitMsg: string): string {
  const existingId = extractChangeId(commitMsg);
  if (existingId) {
    return commitMsg;
  }

  const changeId = generateChangeId();
  const trimmed = commitMsg.trimEnd();

  // Check if message already ends with trailers (has a blank line followed by key: value lines)
  const lines = trimmed.split('\n');
  const lastNonEmptyIdx = lines.length - 1;

  // Find if there's already a trailer section
  let hasTrailerSection = false;
  for (let i = lastNonEmptyIdx; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const trimmedLine = line.trim();
    if (trimmedLine === '') {
      hasTrailerSection = true;
      break;
    }
    if (!trimmedLine.includes(': ')) {
      // Not a trailer line, so no trailer section yet
      break;
    }
    hasTrailerSection = true;
  }

  if (hasTrailerSection) {
    // Append to existing trailer section
    return `${trimmed}\nChange-Id: ${changeId}`;
  } else {
    // Add new trailer section with blank line
    return `${trimmed}\n\nChange-Id: ${changeId}`;
  }
}

/**
 * Get the Change-Id from a commit.
 *
 * Convenience function that fetches the commit message and extracts the Change-Id.
 *
 * @param commit - The commit hash
 * @param options - Git options
 * @returns The Change-Id if found, null otherwise
 */
export function getCommitChangeId(commit: string, options: GitOptions): string | null {
  const message = getCommitMessage(commit, options);
  return extractChangeId(message);
}

/**
 * Result of a commit with Change-Id.
 */
export interface CommitWithChangeIdResult {
  /** The commit hash */
  commit: string;
  /** The Change-Id (from trailer) */
  changeId: string;
}

/**
 * Create a commit with a Change-Id trailer.
 *
 * Ensures the commit message has a Change-Id trailer, creates the commit,
 * and returns both the commit hash and Change-Id.
 *
 * @param message - The commit message
 * @param options - Git options
 * @returns The commit hash and Change-Id
 */
export function commitWithChangeId(
  message: string,
  options: GitOptions
): CommitWithChangeIdResult {
  // Ensure message has Change-Id
  const messageWithId = ensureChangeId(message);
  const changeId = extractChangeId(messageWithId)!;

  // Create the commit
  git(['commit', '-m', messageWithId], options);
  const commitHash = getHead(options);

  return { commit: commitHash, changeId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stash Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Push changes to the stash with an optional message.
 *
 * Creates a new stash entry with all uncommitted changes (both staged
 * and unstaged), including untracked files. The working directory will
 * be clean after this operation.
 *
 * @param message - Optional descriptive message for the stash
 * @param options - Git options including cwd
 */
export function stashPush(message: string | undefined, options: GitOptions): void {
  // Use --include-untracked to capture new files
  if (message) {
    git(['stash', 'push', '--include-untracked', '-m', message], options);
  } else {
    git(['stash', 'push', '--include-untracked'], options);
  }
}

/**
 * Get the commit hash of the most recent stash entry.
 *
 * Uses `git stash list` format to get the stash ref, which is more
 * portable than parsing refs/stash directly.
 *
 * @param options - Git options including cwd
 * @returns The commit hash of the most recent stash entry
 * @throws GitOperationError if no stash entries exist
 */
export function getLatestStashRef(options: GitOptions): string {
  // Use stash list with format to get the commit hash
  // This is more reliable than rev-parse stash@{0} which can have shell escaping issues
  const output = git(['stash', 'list', '-1', '--format=%H'], options);
  if (!output) {
    throw new GitOperationError('No stash entries exist');
  }
  return output.trim();
}

/**
 * Apply a stash by its ref (commit hash).
 *
 * Applies the stash to the working directory without removing it from
 * the stash list. Use the commit hash rather than stash@{n} index for
 * reliable long-term references.
 *
 * @param stashRef - The commit hash of the stash to apply
 * @param options - Git options including cwd
 * @throws GitOperationError if the stash cannot be applied (e.g., conflicts)
 */
export function stashApply(stashRef: string, options: GitOptions): void {
  git(['stash', 'apply', stashRef], options);
}

/**
 * Drop a stash by its ref (commit hash).
 *
 * Removes the stash entry from the stash list. Note that this finds
 * the stash by its commit hash, which may not work if the stash has
 * already been dropped or expired.
 *
 * @param stashRef - The commit hash of the stash to drop
 * @param options - Git options including cwd
 */
export function stashDrop(stashRef: string, options: GitOptions): void {
  // Find the stash index that matches this ref
  // We need to iterate through stash list to find matching commit
  const list = stashList(options);
  const index = list.findIndex((entry) => entry.ref === stashRef);
  if (index >= 0) {
    git(['stash', 'drop', `stash@{${index}}`], options);
  }
}

/**
 * Stash list entry.
 */
export interface StashEntry {
  /** Index in the stash list (0 is most recent) */
  index: number;
  /** Commit hash of the stash */
  ref: string;
  /** Stash message */
  message: string;
}

/**
 * List all stash entries.
 *
 * @param options - Git options including cwd
 * @returns Array of stash entries, newest first
 */
export function stashList(options: GitOptions): StashEntry[] {
  try {
    // Format: commit hash, then message
    const output = git(['stash', 'list', '--format=%H %s'], options);
    if (!output) {
      return [];
    }

    return output.split('\n').filter(Boolean).map((line, index) => {
      const spaceIdx = line.indexOf(' ');
      const ref = line.slice(0, spaceIdx);
      const message = line.slice(spaceIdx + 1);
      return { index, ref, message };
    });
  } catch {
    // No stash entries
    return [];
  }
}
