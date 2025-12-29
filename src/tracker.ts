/**
 * MultiAgentRepoTracker - Main entry point for the dataplane.
 *
 * Coordinates multiple AI agents working on a shared git repository.
 */

import Database from 'better-sqlite3';
import { createDatabase, closeDatabase } from './db/index.js';
import { getTableNames, registerTables, type TableNames } from './db/tables.js';
import * as streams from './streams.js';
import * as operations from './operations.js';
import * as worktrees from './worktrees.js';
import * as rollback from './rollback.js';
import * as stacks from './stacks.js';
import * as deps from './dependencies.js';
import * as changes from './changes.js';
import * as git from './git/index.js';
import type {
  Stream,
  StreamStatus,
  CreateStreamOptions,
  ForkStreamOptions,
  MergeStreamOptions,
  MergeResult,
  Operation,
  RecordOperationOptions,
  AgentWorktree,
  CreateWorktreeOptions,
  ReviewBlock,
  StackConfig,
  CreateReviewBlockOptions,
  SetReviewStatusOptions,
  RebaseOntoStreamOptions,
  RebaseResult,
  ConflictStrategy,
  StreamNode,
  Change,
  ChangeStatus,
  CreateChangeOptions,
} from './models/index.js';
import type {
  RollbackToOperationOptions,
  RollbackNOptions,
  RollbackToForkPointOptions,
} from './rollback.js';

export interface TrackerOptions {
  /** Path to the git repository */
  repoPath: string;
  /** Path to the SQLite database file (ignored if db is provided) */
  dbPath?: string;
  /** Existing database connection (optional) */
  db?: Database.Database;
  /** Table name prefix (default: no prefix) */
  tablePrefix?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Main tracker class for multi-agent git coordination.
 */
export class MultiAgentRepoTracker {
  readonly repoPath: string;
  readonly db: Database.Database;
  readonly tables: TableNames;
  private readonly ownsDb: boolean;

  constructor(options: TrackerOptions) {
    this.repoPath = options.repoPath;
    const prefix = options.tablePrefix ?? '';
    this.tables = getTableNames(prefix);

    if (options.db) {
      // Use existing database
      this.db = options.db;
      this.ownsDb = false;
      // Initialize schema in existing DB with prefix
      createDatabase({ db: options.db, tablePrefix: prefix });
    } else {
      // Create new database
      const dbPath = options.dbPath ?? `${options.repoPath}/.dataplane/tracker.db`;
      this.db = createDatabase({ path: dbPath, tablePrefix: prefix, verbose: options.verbose });
      this.ownsDb = true;
    }

    // Register table names for this database instance
    registerTables(this.db, this.tables);
  }

  /**
   * Close the tracker and release resources.
   * Only closes the database if we created it (not if using existing DB).
   */
  close(): void {
    if (this.ownsDb) {
      closeDatabase(this.db);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stream Operations
  // ─────────────────────────────────────────────────────────────────────────────

  createStream(options: CreateStreamOptions): string {
    return streams.createStream(this.db, this.repoPath, options);
  }

  getStream(streamId: string): Stream | null {
    return streams.getStream(this.db, streamId);
  }

  updateStream(
    streamId: string,
    updates: Partial<Pick<Stream, 'name' | 'status' | 'metadata'>>
  ): void {
    streams.updateStream(this.db, streamId, updates);
  }

  abandonStream(streamId: string, reason?: string): void {
    streams.abandonStream(this.db, streamId, reason);
  }

  forkStream(options: ForkStreamOptions): string {
    return streams.forkStream(this.db, this.repoPath, options);
  }

  mergeStream(options: MergeStreamOptions): MergeResult {
    return streams.mergeStream(this.db, this.repoPath, options);
  }

  listStreams(options?: {
    agentId?: string;
    status?: StreamStatus;
  }): Stream[] {
    return streams.listStreams(this.db, options);
  }

  getStreamHead(streamId: string): string {
    return streams.getStreamHead(this.repoPath, streamId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Operation Logging
  // ─────────────────────────────────────────────────────────────────────────────

  recordOperation(options: RecordOperationOptions): string {
    return operations.recordOperation(this.db, options);
  }

  getOperation(operationId: string): Operation | null {
    return operations.getOperation(this.db, operationId);
  }

  getOperations(options?: {
    streamId?: string;
    agentId?: string;
    since?: number;
  }): Operation[] {
    return operations.getOperations(this.db, options);
  }

  getLatestOperation(streamId: string): Operation | null {
    return operations.getLatestOperation(this.db, streamId);
  }

  getOperationChain(operationId: string): Operation[] {
    return operations.getOperationChain(this.db, operationId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Worktree Management
  // ─────────────────────────────────────────────────────────────────────────────

  createWorktree(options: CreateWorktreeOptions): AgentWorktree {
    return worktrees.createWorktree(this.db, this.repoPath, options);
  }

  getWorktree(agentId: string): AgentWorktree | null {
    return worktrees.getWorktree(this.db, agentId);
  }

  updateWorktreeStream(agentId: string, streamId: string | null): void {
    worktrees.updateWorktreeStream(this.db, this.repoPath, agentId, streamId);
  }

  deallocateWorktree(agentId: string): void {
    worktrees.deallocateWorktree(this.db, this.repoPath, agentId);
  }

  listWorktrees(): AgentWorktree[] {
    return worktrees.listWorktrees(this.db);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Rollback Operations
  // ─────────────────────────────────────────────────────────────────────────────

  rollbackToOperation(options: RollbackToOperationOptions): void {
    rollback.rollbackToOperation(this.db, this.repoPath, options);
  }

  rollbackN(options: RollbackNOptions): void {
    rollback.rollbackN(this.db, this.repoPath, options);
  }

  rollbackToForkPoint(options: RollbackToForkPointOptions): void {
    rollback.rollbackToForkPoint(this.db, this.repoPath, options);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stack & Review Block Operations
  // ─────────────────────────────────────────────────────────────────────────────

  createReviewBlock(options: CreateReviewBlockOptions): string {
    return stacks.createReviewBlock(this.db, options);
  }

  getReviewBlock(reviewBlockId: string): ReviewBlock | null {
    return stacks.getReviewBlock(this.db, reviewBlockId);
  }

  getStack(streamId: string, stackName?: string): ReviewBlock[] {
    return stacks.getStack(this.db, streamId, stackName);
  }

  setReviewStatus(options: SetReviewStatusOptions): void {
    stacks.setReviewStatus(this.db, options);
  }

  deleteReviewBlock(reviewBlockId: string): void {
    stacks.deleteReviewBlock(this.db, reviewBlockId);
  }

  addCommitsToBlock(reviewBlockId: string, commits: string[]): void {
    stacks.addCommitsToBlock(this.db, reviewBlockId, commits);
  }

  removeCommitsFromBlock(reviewBlockId: string, commits: string[]): void {
    stacks.removeCommitsFromBlock(this.db, reviewBlockId, commits);
  }

  splitReviewBlock(
    reviewBlockId: string,
    splitAfterPosition: number,
    newTitle: string
  ): string {
    return stacks.splitReviewBlock(this.db, reviewBlockId, splitAfterPosition, newTitle);
  }

  mergeReviewBlocks(
    reviewBlockIds: string[],
    title: string,
    description?: string
  ): string {
    return stacks.mergeReviewBlocks(this.db, reviewBlockIds, title, description);
  }

  rebuildStack(streamId: string, stackName?: string): void {
    stacks.rebuildStack(this.db, this.repoPath, streamId, stackName);
  }

  autoPopulateStack(streamId: string, stackName?: string): void {
    stacks.autoPopulateStack(this.db, this.repoPath, streamId, stackName);
  }

  getStackConfig(streamId: string, stackName?: string): StackConfig {
    return stacks.getStackConfig(this.db, streamId, stackName);
  }

  setStackConfig(
    streamId: string,
    stackName: string,
    config: Partial<StackConfig>
  ): void {
    stacks.setStackConfig(this.db, streamId, stackName, config);
  }

  listStacks(streamId: string): string[] {
    return stacks.listStacks(this.db, streamId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Rebase Operations
  // ─────────────────────────────────────────────────────────────────────────────

  rebaseOntoStream(options: RebaseOntoStreamOptions): RebaseResult {
    return streams.rebaseOntoStream(this.db, this.repoPath, options);
  }

  syncWithParent(
    streamId: string,
    agentId: string,
    worktree: string,
    onConflict?: ConflictStrategy
  ): RebaseResult {
    return streams.syncWithParent(
      this.db,
      this.repoPath,
      streamId,
      agentId,
      worktree,
      onConflict
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Dependency Operations
  // ─────────────────────────────────────────────────────────────────────────────

  addDependency(streamId: string, dependsOnId: string): void {
    deps.addDependency(this.db, streamId, dependsOnId);
  }

  removeDependency(streamId: string, dependsOnId: string): void {
    deps.removeDependency(this.db, streamId, dependsOnId);
  }

  getDependencies(streamId: string): string[] {
    return deps.getDependencies(this.db, streamId);
  }

  getDependents(streamId: string): string[] {
    return deps.getDependents(this.db, streamId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stream Graph Queries
  // ─────────────────────────────────────────────────────────────────────────────

  getChildStreams(streamId: string): Stream[] {
    return streams.getChildStreams(this.db, streamId);
  }

  findCommonAncestor(streamIdA: string, streamIdB: string): string {
    return streams.findCommonAncestor(this.repoPath, streamIdA, streamIdB);
  }

  getStreamGraph(rootStreamId?: string): StreamNode | StreamNode[] {
    return streams.getStreamGraph(this.db, rootStreamId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Change Tracking
  // ─────────────────────────────────────────────────────────────────────────────

  createChange(options: CreateChangeOptions): string {
    return changes.createChange(this.db, options);
  }

  getChange(changeId: string): Change | null {
    return changes.getChange(this.db, changeId);
  }

  getChangeByCommit(commit: string): Change | null {
    return changes.getChangeByCommit(this.db, commit);
  }

  getChangeByHistoricalCommit(commit: string): Change | null {
    return changes.getChangeByHistoricalCommit(this.db, commit);
  }

  getChangesForStream(
    streamId: string,
    options?: { status?: ChangeStatus }
  ): Change[] {
    return changes.getChangesForStream(this.db, streamId, options);
  }

  recordSquash(
    absorbedIds: string[],
    targetId: string,
    resultCommit: string
  ): void {
    changes.recordSquash(this.db, absorbedIds, targetId, resultCommit);
  }

  recordSplit(
    originalId: string,
    streamId: string,
    newCommits: Array<{ commit: string; description: string }>
  ): string[] {
    return changes.recordSplit(this.db, originalId, streamId, newCommits);
  }

  markChangesMerged(changeIds: string[]): void {
    changes.markMerged(this.db, changeIds);
  }

  markChangeDropped(changeId: string): void {
    changes.markDropped(this.db, changeId);
  }

  /**
   * Commit changes in a worktree with automatic Change tracking.
   *
   * This method:
   * 1. Stages all changes
   * 2. Creates a commit with a Change-Id trailer
   * 3. Creates a Change entry in the database
   * 4. Records the operation
   *
   * @returns The commit hash and change ID
   */
  commitChanges(options: {
    streamId: string;
    agentId: string;
    worktree: string;
    message: string;
  }): { commit: string; changeId: string } {
    const gitOpts = { cwd: options.worktree };

    // Stage all changes
    git.stageAll(gitOpts);

    // Commit with Change-Id
    const result = git.commitWithChangeId(options.message, gitOpts);

    // Extract description (first line of message)
    const description = options.message.split('\n')[0] || options.message;

    // Create Change entry
    changes.createChange(this.db, {
      streamId: options.streamId,
      commit: result.commit,
      description,
      changeId: result.changeId,
    });

    // Record operation
    this.recordOperation({
      streamId: options.streamId,
      agentId: options.agentId,
      opType: 'commit',
      beforeState: git.resolveRef('HEAD~1', gitOpts),
      afterState: result.commit,
      metadata: { changeId: result.changeId },
    });

    return result;
  }
}
