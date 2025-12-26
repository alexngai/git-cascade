/**
 * Stack and Review Block operations.
 *
 * Review Blocks are the core reviewable unit - each block contains
 * one or more commits and has its own review status. Stacks are
 * ordered collections of Review Blocks within a stream.
 */

import type Database from 'better-sqlite3';
import * as crypto from 'crypto';
import { getTables } from './db/tables.js';
import { getStreamOrThrow } from './streams.js';
import * as git from './git/index.js';
import type {
  ReviewBlock,
  StackEntry,
  StackConfig,
  ReviewStatus,
  CreateReviewBlockOptions,
  SetReviewStatusOptions,
} from './models/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// ID Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate unique review block ID.
 */
function generateReviewBlockId(): string {
  return `rb-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Generate unique stack entry ID.
 */
function generateStackEntryId(): string {
  return `stack-${crypto.randomUUID().slice(0, 8)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row Converters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert database row to ReviewBlock object (without commits).
 */
function rowToReviewBlock(row: Record<string, unknown>): Omit<ReviewBlock, 'commits'> {
  return {
    id: row.id as string,
    streamId: row.stream_id as string,
    stackName: row.stack_name as string,
    position: row.position as number,
    title: row.title as string,
    description: row.description as string | null,
    reviewStatus: row.review_status as ReviewStatus,
    reviewedBy: row.reviewed_by as string | null,
    reviewedAt: row.reviewed_at as number | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

/**
 * Convert database row to StackEntry object.
 */
function rowToStackEntry(row: Record<string, unknown>): StackEntry {
  return {
    id: row.id as string,
    reviewBlockId: row.review_block_id as string,
    commitHash: row.commit_hash as string,
    commitPosition: row.commit_position as number,
    originalCommit: row.original_commit as string,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Review Block CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a review block with one or more commits.
 */
export function createReviewBlock(
  db: Database.Database,
  options: CreateReviewBlockOptions
): string {
  const { streamId, commits, title, description } = options;
  const stackName = options.stackName ?? 'default';

  // Validate stream exists and has stacked review enabled
  const stream = getStreamOrThrow(db, streamId);
  if (!stream.enableStackedReview) {
    throw new Error(`Stream ${streamId} does not have stacked review enabled`);
  }

  if (commits.length === 0) {
    throw new Error('At least one commit is required');
  }

  const t = getTables(db);
  const now = Date.now();
  const blockId = generateReviewBlockId();

  // Get next position
  const maxPosRow = db.prepare(`
    SELECT MAX(position) as max_pos FROM ${t.review_blocks}
    WHERE stream_id = ? AND stack_name = ?
  `).get(streamId, stackName) as { max_pos: number | null } | undefined;
  const position = (maxPosRow?.max_pos ?? -1) + 1;

  db.transaction(() => {
    // Insert review block
    db.prepare(`
      INSERT INTO ${t.review_blocks} (
        id, stream_id, stack_name, position, title, description,
        review_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).run(blockId, streamId, stackName, position, title, description ?? null, now, now);

    // Insert stack entries for each commit
    for (let i = 0; i < commits.length; i++) {
      const entryId = generateStackEntryId();
      db.prepare(`
        INSERT INTO ${t.stack_entries} (
          id, review_block_id, commit_hash, commit_position, original_commit
        ) VALUES (?, ?, ?, ?, ?)
      `).run(entryId, blockId, commits[i], i, commits[i]);
    }
  })();

  return blockId;
}

/**
 * Get a review block by ID, including its commits.
 */
export function getReviewBlock(
  db: Database.Database,
  reviewBlockId: string
): ReviewBlock | null {
  const t = getTables(db);

  const row = db.prepare(`
    SELECT * FROM ${t.review_blocks} WHERE id = ?
  `).get(reviewBlockId) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  const block = rowToReviewBlock(row);

  // Get commits for this block
  const entryRows = db.prepare(`
    SELECT * FROM ${t.stack_entries}
    WHERE review_block_id = ?
    ORDER BY commit_position ASC
  `).all(reviewBlockId) as Record<string, unknown>[];

  const commits = entryRows.map(rowToStackEntry);

  return { ...block, commits };
}

/**
 * Get a review block or throw if not found.
 */
export function getReviewBlockOrThrow(
  db: Database.Database,
  reviewBlockId: string
): ReviewBlock {
  const block = getReviewBlock(db, reviewBlockId);
  if (!block) {
    throw new Error(`Review block not found: ${reviewBlockId}`);
  }
  return block;
}

/**
 * Get ordered review blocks for a stream's stack.
 */
export function getStack(
  db: Database.Database,
  streamId: string,
  stackName = 'default'
): ReviewBlock[] {
  const t = getTables(db);

  const blockRows = db.prepare(`
    SELECT * FROM ${t.review_blocks}
    WHERE stream_id = ? AND stack_name = ?
    ORDER BY position ASC
  `).all(streamId, stackName) as Record<string, unknown>[];

  return blockRows.map((row) => {
    const block = rowToReviewBlock(row);

    // Get commits for this block
    const entryRows = db.prepare(`
      SELECT * FROM ${t.stack_entries}
      WHERE review_block_id = ?
      ORDER BY commit_position ASC
    `).all(block.id) as Record<string, unknown>[];

    const commits = entryRows.map(rowToStackEntry);

    return { ...block, commits };
  });
}

/**
 * Set review status for a review block.
 */
export function setReviewStatus(
  db: Database.Database,
  options: SetReviewStatusOptions
): void {
  const { reviewBlockId, status, reviewer } = options;

  const block = getReviewBlockOrThrow(db, reviewBlockId);

  // Cannot change status once merged
  if (block.reviewStatus === 'merged') {
    throw new Error(`Cannot change status of merged review block: ${reviewBlockId}`);
  }

  const t = getTables(db);
  const now = Date.now();

  db.prepare(`
    UPDATE ${t.review_blocks}
    SET review_status = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(status, reviewer ?? null, now, now, reviewBlockId);
}

/**
 * Delete a review block (cascade deletes entries).
 */
export function deleteReviewBlock(
  db: Database.Database,
  reviewBlockId: string
): void {
  const t = getTables(db);

  // CASCADE delete handles stack_entries
  db.prepare(`DELETE FROM ${t.review_blocks} WHERE id = ?`).run(reviewBlockId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stack Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default stack configuration.
 */
const DEFAULT_STACK_CONFIG: StackConfig = {
  autoPopulate: true,
  groupingStrategy: 'per-commit',
  rebuildBehavior: {
    matchStrategy: 'patch-id',
    deleteOrphaned: true,
  },
};

/**
 * Get stack configuration, returning defaults if not set.
 */
export function getStackConfig(
  db: Database.Database,
  streamId: string,
  stackName = 'default'
): StackConfig {
  const t = getTables(db);

  const row = db.prepare(`
    SELECT config_json FROM ${t.stack_configs}
    WHERE stream_id = ? AND stack_name = ?
  `).get(streamId, stackName) as { config_json: string } | undefined;

  if (row) {
    return { ...DEFAULT_STACK_CONFIG, ...JSON.parse(row.config_json) };
  }

  return DEFAULT_STACK_CONFIG;
}

/**
 * Set stack configuration (merges with existing).
 */
export function setStackConfig(
  db: Database.Database,
  streamId: string,
  stackName: string,
  config: Partial<StackConfig>
): void {
  const existing = getStackConfig(db, streamId, stackName);
  const merged = { ...existing, ...config };

  const t = getTables(db);

  db.prepare(`
    INSERT INTO ${t.stack_configs} (stream_id, stack_name, config_json)
    VALUES (?, ?, ?)
    ON CONFLICT (stream_id, stack_name) DO UPDATE SET config_json = ?
  `).run(streamId, stackName, JSON.stringify(merged), JSON.stringify(merged));
}

/**
 * List all stack names for a stream.
 */
export function listStacks(
  db: Database.Database,
  streamId: string
): string[] {
  const t = getTables(db);

  const rows = db.prepare(`
    SELECT DISTINCT stack_name FROM ${t.review_blocks}
    WHERE stream_id = ?
    ORDER BY stack_name ASC
  `).all(streamId) as { stack_name: string }[];

  const stackNames = rows.map((r) => r.stack_name);

  // Always include 'default' if there are any blocks
  if (stackNames.length > 0 && !stackNames.includes('default')) {
    return ['default', ...stackNames];
  }

  return stackNames.length > 0 ? stackNames : ['default'];
}

// ─────────────────────────────────────────────────────────────────────────────
// Stack Entry Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get stack entries for a review block.
 */
export function getStackEntriesForBlock(
  db: Database.Database,
  reviewBlockId: string
): StackEntry[] {
  const t = getTables(db);

  const rows = db.prepare(`
    SELECT * FROM ${t.stack_entries}
    WHERE review_block_id = ?
    ORDER BY commit_position ASC
  `).all(reviewBlockId) as Record<string, unknown>[];

  return rows.map(rowToStackEntry);
}

/**
 * Update a stack entry's commit hash.
 */
export function updateStackEntryCommit(
  db: Database.Database,
  entryId: string,
  newCommitHash: string
): void {
  const t = getTables(db);

  db.prepare(`
    UPDATE ${t.stack_entries}
    SET commit_hash = ?
    WHERE id = ?
  `).run(newCommitHash, entryId);
}

/**
 * Delete a stack entry.
 */
export function deleteStackEntry(
  db: Database.Database,
  entryId: string
): void {
  const t = getTables(db);
  db.prepare(`DELETE FROM ${t.stack_entries} WHERE id = ?`).run(entryId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stack Rebuilding (After Rebase)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild stack after a rebase operation.
 *
 * When a stream is rebased, commit hashes change. This function:
 * 1. Uses patch-id to match old commits to new commits
 * 2. Updates commitHash in stack entries
 * 3. Deletes entries for squashed/dropped commits
 * 4. Deletes empty review blocks
 * 5. Auto-populates untracked commits if config allows
 */
export function rebuildStack(
  db: Database.Database,
  repoPath: string,
  streamId: string,
  stackName = 'default'
): void {
  const stream = getStreamOrThrow(db, streamId);

  if (!stream.enableStackedReview) {
    return; // Nothing to do
  }

  const t = getTables(db);
  const gitOptions = { cwd: repoPath };

  // Get all review blocks for this stack
  const blocks = getStack(db, streamId, stackName);

  if (blocks.length === 0) {
    // No blocks to rebuild, but may need to auto-populate
    const config = getStackConfig(db, streamId, stackName);
    if (config.autoPopulate) {
      autoPopulateStack(db, repoPath, streamId, stackName);
    }
    return;
  }

  // Get current commits in stream
  const streamBranch = `stream/${streamId}`;
  const currentCommits = git.getCommitRange(
    stream.baseCommit,
    streamBranch,
    gitOptions
  );

  // Build patch-id map for current commits
  const patchIdToCommit = git.buildPatchIdMap(currentCommits, gitOptions);

  db.transaction(() => {
    for (const block of blocks) {
      let remainingEntries = 0;

      for (const entry of block.commits) {
        try {
          // Get patch-id of original commit
          const originalPatchId = git.getPatchId(entry.originalCommit, gitOptions);

          // Find matching current commit
          const newCommit = patchIdToCommit.get(originalPatchId);

          if (newCommit) {
            // Update commit hash
            db.prepare(`
              UPDATE ${t.stack_entries}
              SET commit_hash = ?
              WHERE id = ?
            `).run(newCommit, entry.id);
            remainingEntries++;
          } else {
            // Commit was squashed/dropped - delete entry
            db.prepare(`DELETE FROM ${t.stack_entries} WHERE id = ?`).run(entry.id);
          }
        } catch {
          // If we can't get patch-id (e.g., commit doesn't exist), delete entry
          db.prepare(`DELETE FROM ${t.stack_entries} WHERE id = ?`).run(entry.id);
        }
      }

      // If block has no commits left, delete it
      if (remainingEntries === 0) {
        db.prepare(`DELETE FROM ${t.review_blocks} WHERE id = ?`).run(block.id);
      }
    }

    // Auto-populate untracked commits if enabled
    const config = getStackConfig(db, streamId, stackName);
    if (config.autoPopulate) {
      autoPopulateUntrackedInTransaction(db, repoPath, streamId, stackName, currentCommits);
    }
  })();
}

/**
 * Auto-populate stack with untracked commits.
 * Creates a review block for each commit not already in the stack.
 */
export function autoPopulateStack(
  db: Database.Database,
  repoPath: string,
  streamId: string,
  stackName = 'default'
): void {
  const stream = getStreamOrThrow(db, streamId);

  if (!stream.enableStackedReview) {
    return;
  }

  const gitOptions = { cwd: repoPath };
  const streamBranch = `stream/${streamId}`;

  // Get current commits in stream
  const currentCommits = git.getCommitRange(
    stream.baseCommit,
    streamBranch,
    gitOptions
  );

  db.transaction(() => {
    autoPopulateUntrackedInTransaction(db, repoPath, streamId, stackName, currentCommits);
  })();
}

/**
 * Internal helper for auto-populating untracked commits.
 * Must be called within a transaction.
 */
function autoPopulateUntrackedInTransaction(
  db: Database.Database,
  repoPath: string,
  streamId: string,
  stackName: string,
  currentCommits: string[]
): void {
  const t = getTables(db);
  const gitOptions = { cwd: repoPath };

  // Get all tracked commits in this stack
  const blocks = getStack(db, streamId, stackName);
  const trackedCommits = new Set(
    blocks.flatMap((b) => b.commits.map((c) => c.commitHash))
  );

  // Get max position
  const maxPosRow = db.prepare(`
    SELECT MAX(position) as max_pos FROM ${t.review_blocks}
    WHERE stream_id = ? AND stack_name = ?
  `).get(streamId, stackName) as { max_pos: number | null } | undefined;
  let nextPosition = (maxPosRow?.max_pos ?? -1) + 1;

  const now = Date.now();

  // Create review block for each untracked commit
  for (const commit of currentCommits) {
    if (!trackedCommits.has(commit)) {
      const message = git.getCommitMessage(commit, gitOptions);
      const title = message.split('\n')[0] || 'Untitled commit';

      const blockId = generateReviewBlockId();

      db.prepare(`
        INSERT INTO ${t.review_blocks} (
          id, stream_id, stack_name, position, title, description,
          review_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'draft', ?, ?)
      `).run(blockId, streamId, stackName, nextPosition, title, now, now);

      const entryId = generateStackEntryId();
      db.prepare(`
        INSERT INTO ${t.stack_entries} (
          id, review_block_id, commit_hash, commit_position, original_commit
        ) VALUES (?, ?, ?, 0, ?)
      `).run(entryId, blockId, commit, commit);

      nextPosition++;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Review Block Manipulation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add commits to an existing review block.
 */
export function addCommitsToBlock(
  db: Database.Database,
  reviewBlockId: string,
  commits: string[]
): void {
  if (commits.length === 0) {
    return;
  }

  const block = getReviewBlockOrThrow(db, reviewBlockId);

  // Cannot modify merged blocks
  if (block.reviewStatus === 'merged') {
    throw new Error(`Cannot modify merged review block: ${reviewBlockId}`);
  }

  const t = getTables(db);
  const now = Date.now();

  // Get current max position within block
  const maxPosRow = db.prepare(`
    SELECT MAX(commit_position) as max_pos FROM ${t.stack_entries}
    WHERE review_block_id = ?
  `).get(reviewBlockId) as { max_pos: number | null } | undefined;
  let nextPosition = (maxPosRow?.max_pos ?? -1) + 1;

  db.transaction(() => {
    for (const commit of commits) {
      const entryId = generateStackEntryId();
      db.prepare(`
        INSERT INTO ${t.stack_entries} (
          id, review_block_id, commit_hash, commit_position, original_commit
        ) VALUES (?, ?, ?, ?, ?)
      `).run(entryId, reviewBlockId, commit, nextPosition, commit);
      nextPosition++;
    }

    // Update block timestamp
    db.prepare(`
      UPDATE ${t.review_blocks} SET updated_at = ? WHERE id = ?
    `).run(now, reviewBlockId);
  })();
}

/**
 * Remove commits from a review block.
 * If all commits are removed, the block is deleted.
 */
export function removeCommitsFromBlock(
  db: Database.Database,
  reviewBlockId: string,
  commits: string[]
): void {
  if (commits.length === 0) {
    return;
  }

  const block = getReviewBlockOrThrow(db, reviewBlockId);

  // Cannot modify merged blocks
  if (block.reviewStatus === 'merged') {
    throw new Error(`Cannot modify merged review block: ${reviewBlockId}`);
  }

  const t = getTables(db);
  const now = Date.now();
  const commitSet = new Set(commits);

  db.transaction(() => {
    // Delete entries for specified commits
    for (const entry of block.commits) {
      if (commitSet.has(entry.commitHash)) {
        db.prepare(`DELETE FROM ${t.stack_entries} WHERE id = ?`).run(entry.id);
      }
    }

    // Check if block has any remaining commits
    const remaining = db.prepare(`
      SELECT COUNT(*) as cnt FROM ${t.stack_entries}
      WHERE review_block_id = ?
    `).get(reviewBlockId) as { cnt: number };

    if (remaining.cnt === 0) {
      // Delete empty block
      db.prepare(`DELETE FROM ${t.review_blocks} WHERE id = ?`).run(reviewBlockId);
    } else {
      // Renumber remaining commits
      const entries = db.prepare(`
        SELECT id FROM ${t.stack_entries}
        WHERE review_block_id = ?
        ORDER BY commit_position ASC
      `).all(reviewBlockId) as { id: string }[];

      for (let i = 0; i < entries.length; i++) {
        db.prepare(`
          UPDATE ${t.stack_entries} SET commit_position = ? WHERE id = ?
        `).run(i, entries[i]!.id);
      }

      // Update block timestamp
      db.prepare(`
        UPDATE ${t.review_blocks} SET updated_at = ? WHERE id = ?
      `).run(now, reviewBlockId);
    }
  })();
}

/**
 * Split a review block at a specified position.
 * Commits at positions <= splitAfterPosition stay in original block.
 * Commits at positions > splitAfterPosition go to new block.
 *
 * @param splitAfterPosition - Position after which to split (0-indexed)
 * @param newTitle - Title for the new block
 * @returns ID of the new review block
 */
export function splitReviewBlock(
  db: Database.Database,
  reviewBlockId: string,
  splitAfterPosition: number,
  newTitle: string
): string {
  const block = getReviewBlockOrThrow(db, reviewBlockId);

  // Cannot modify merged blocks
  if (block.reviewStatus === 'merged') {
    throw new Error(`Cannot modify merged review block: ${reviewBlockId}`);
  }

  if (splitAfterPosition < 0 || splitAfterPosition >= block.commits.length - 1) {
    throw new Error(
      `Invalid split position: ${splitAfterPosition}. ` +
      `Must be between 0 and ${block.commits.length - 2}`
    );
  }

  const t = getTables(db);
  const now = Date.now();
  const newBlockId = generateReviewBlockId();

  db.transaction(() => {
    // Insert new block at next position
    db.prepare(`
      INSERT INTO ${t.review_blocks} (
        id, stream_id, stack_name, position, title, description,
        review_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'draft', ?, ?)
    `).run(
      newBlockId,
      block.streamId,
      block.stackName,
      block.position + 1,
      newTitle,
      now,
      now
    );

    // Shift positions of subsequent blocks
    db.prepare(`
      UPDATE ${t.review_blocks}
      SET position = position + 1
      WHERE stream_id = ? AND stack_name = ? AND position > ? AND id != ?
    `).run(block.streamId, block.stackName, block.position, newBlockId);

    // Move commits after split point to new block
    const commitsToMove = block.commits.filter(
      (c) => c.commitPosition > splitAfterPosition
    );

    for (let i = 0; i < commitsToMove.length; i++) {
      db.prepare(`
        UPDATE ${t.stack_entries}
        SET review_block_id = ?, commit_position = ?
        WHERE id = ?
      `).run(newBlockId, i, commitsToMove[i]!.id);
    }

    // Update original block timestamp
    db.prepare(`
      UPDATE ${t.review_blocks} SET updated_at = ? WHERE id = ?
    `).run(now, reviewBlockId);
  })();

  return newBlockId;
}

/**
 * Merge multiple review blocks into one.
 * Blocks must be from the same stream/stack and will be merged in position order.
 *
 * @param reviewBlockIds - IDs of blocks to merge (must be 2+)
 * @param title - Title for the merged block
 * @param description - Optional description
 * @returns ID of the merged review block (uses first block's ID)
 */
export function mergeReviewBlocks(
  db: Database.Database,
  reviewBlockIds: string[],
  title: string,
  description?: string
): string {
  if (reviewBlockIds.length < 2) {
    throw new Error('At least two review blocks are required for merge');
  }

  // Get all blocks and validate
  const blocks = reviewBlockIds.map((id) => getReviewBlockOrThrow(db, id));

  // Verify all blocks are from same stream/stack
  const firstBlock = blocks[0]!;
  const streamId = firstBlock.streamId;
  const stackName = firstBlock.stackName;
  for (const block of blocks) {
    if (block.streamId !== streamId || block.stackName !== stackName) {
      throw new Error('All blocks must be from the same stream and stack');
    }
    if (block.reviewStatus === 'merged') {
      throw new Error(`Cannot modify merged review block: ${block.id}`);
    }
  }

  // Sort blocks by position to merge in order
  blocks.sort((a, b) => a.position - b.position);

  const t = getTables(db);
  const now = Date.now();
  // Use the block with lowest position as the target
  const targetBlock = blocks[0]!;
  const targetBlockId = targetBlock.id;

  db.transaction(() => {
    // Move all commits from other blocks to the target block
    let nextPosition = targetBlock.commits.length;

    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i]!;
      for (const entry of block.commits) {
        db.prepare(`
          UPDATE ${t.stack_entries}
          SET review_block_id = ?, commit_position = ?
          WHERE id = ?
        `).run(targetBlockId, nextPosition, entry.id);
        nextPosition++;
      }

      // Delete the now-empty block
      db.prepare(`DELETE FROM ${t.review_blocks} WHERE id = ?`).run(block.id);
    }

    // Update target block with new title/description
    db.prepare(`
      UPDATE ${t.review_blocks}
      SET title = ?, description = ?, updated_at = ?
      WHERE id = ?
    `).run(title, description ?? null, now, targetBlockId);

    // Renumber positions for remaining blocks in stack
    const remainingBlocks = db.prepare(`
      SELECT id FROM ${t.review_blocks}
      WHERE stream_id = ? AND stack_name = ?
      ORDER BY position ASC
    `).all(streamId, stackName) as { id: string }[];

    for (let i = 0; i < remainingBlocks.length; i++) {
      db.prepare(`
        UPDATE ${t.review_blocks} SET position = ? WHERE id = ?
      `).run(i, remainingBlocks[i]!.id);
    }
  })();

  return targetBlockId;
}
