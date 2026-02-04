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
import * as recovery from './recovery.js';
import * as gc from './gc.js';
import * as reconcile from './reconcile.js';
import * as mergeQueue from './merge-queue.js';
import * as workerTasks from './worker-tasks.js';
import * as diffStacks from './diff-stacks.js';
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
  WorkerTask,
  CreateTaskOptions,
  StartTaskOptions,
  CompleteTaskOptions,
  ListTasksOptions,
  CleanupWorkerBranchesOptions,
  StartTaskResult,
  CompleteTaskResult,
  CleanupResult,
  Checkpoint,
  DiffStackWithCheckpoints,
} from './models/index.js';
import type {
  RollbackToOperationOptions,
  RollbackNOptions,
  RollbackToForkPointOptions,
} from './rollback.js';
import type {
  CreateCheckpointsFromStreamOptions,
  CreateStackFromStreamOptions,
  CherryPickStackResult,
} from './diff-stacks.js';
import { StreamConflictedError } from './errors.js';

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
  /** Skip startup recovery (default: false, respects runRecoveryOnStartup config) */
  skipRecovery?: boolean;
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

    // Run startup recovery if configured and not skipped
    // This cleans up incomplete operations, stale locks, and orphaned conflicts
    if (!options.skipRecovery) {
      const gcConfig = gc.getGCConfig(this.db);
      if (gcConfig.runRecoveryOnStartup) {
        recovery.startupRecovery(this.db, this.repoPath);
      }
    }
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

  abandonStream(streamId: string, options?: { reason?: string; cascade?: boolean }): void {
    streams.abandonStream(this.db, streamId, options);
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
    return streams.getStreamHead(this.db, this.repoPath, streamId);
  }

  getStreamBranchName(streamId: string): string {
    return streams.getStreamBranchName(this.db, streamId);
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

  /**
   * Async version of rebaseOntoStream that properly supports async conflict handlers.
   *
   * Use this when you need to provide an async conflictHandler that should be awaited.
   * The sync version (rebaseOntoStream) will return immediately with pendingAsyncResolution=true
   * when a conflictHandler is provided with onConflict='agent'.
   */
  async rebaseOntoStreamAsync(options: RebaseOntoStreamOptions): Promise<RebaseResult> {
    return streams.rebaseOntoStreamAsync(this.db, this.repoPath, options);
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

  /**
   * Get stream hierarchy as a tree structure with active tasks.
   *
   * @param rootStreamId - If provided, returns tree from this stream
   * @returns Single StreamNode if rootStreamId provided, otherwise array of root trees
   */
  getStreamHierarchy(rootStreamId?: string): StreamNode | StreamNode[] {
    return streams.getStreamHierarchy(this.db, rootStreamId);
  }

  /**
   * @deprecated Use getStreamHierarchy instead
   */
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
    // Block if stream is conflicted
    const stream = this.getStream(options.streamId);
    if (stream?.status === 'conflicted') {
      const conflictId = (stream.metadata as { conflictId?: string }).conflictId;
      throw new StreamConflictedError(options.streamId, conflictId);
    }

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
    // Handle the case where this is the first commit (HEAD~1 doesn't exist)
    let beforeState: string;
    try {
      beforeState = git.resolveRef('HEAD~1', gitOpts);
    } catch {
      // If HEAD~1 doesn't exist, use the empty tree hash or the commit itself
      // The empty tree is a well-known SHA in git representing no files
      beforeState = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    }

    this.recordOperation({
      streamId: options.streamId,
      agentId: options.agentId,
      opType: 'commit',
      beforeState,
      afterState: result.commit,
      metadata: { changeId: result.changeId },
    });

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Health Check
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check system health.
   *
   * Performs a comprehensive check of the system state including:
   * - Stream counts (active and archived)
   * - Active agents
   * - Stale locks
   * - Incomplete operations
   * - Orphaned conflicts
   * - Pending snapshots
   *
   * @returns Health check result
   */
  healthCheck(): recovery.HealthCheckResult {
    return recovery.healthCheck(this.db, this.repoPath);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Reconciliation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check if a stream is in sync with its git branch.
   */
  checkStreamSync(streamId: string): reconcile.StreamSyncStatus {
    return reconcile.checkStreamSync(this.db, this.repoPath, streamId);
  }

  /**
   * Check all active streams for sync status.
   */
  checkAllStreamsSync(options?: {
    streamIds?: string[];
  }): reconcile.ReconcileCheckResult {
    return reconcile.checkAllStreams(this.db, this.repoPath, options);
  }

  /**
   * Reconcile database state with git state.
   */
  reconcile(options?: reconcile.ReconcileOptions): reconcile.ReconcileResult {
    return reconcile.reconcile(this.db, this.repoPath, options);
  }

  /**
   * Ensure a stream is in sync before performing an operation.
   * @throws DesyncError if stream is out of sync (unless force is true)
   */
  ensureStreamInSync(streamId: string, options?: { force?: boolean }): void {
    reconcile.ensureInSync(this.db, this.repoPath, streamId, options);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Merge Queue
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Add a stream to the merge queue.
   */
  addToMergeQueue(options: mergeQueue.AddToQueueOptions): string {
    return mergeQueue.addToQueue(this.db, options);
  }

  /**
   * Get a merge queue entry by ID.
   */
  getMergeQueueEntry(entryId: string): mergeQueue.MergeQueueEntry | null {
    return mergeQueue.getQueueEntry(this.db, entryId);
  }

  /**
   * Get the merge queue for a target branch.
   */
  getMergeQueue(options?: {
    targetBranch?: string;
    status?: mergeQueue.MergeQueueStatus | mergeQueue.MergeQueueStatus[];
  }): mergeQueue.MergeQueueEntry[] {
    return mergeQueue.getQueue(this.db, options);
  }

  /**
   * Mark a queue entry as ready for merging.
   */
  markMergeQueueReady(entryId: string): void {
    mergeQueue.markReady(this.db, entryId);
  }

  /**
   * Cancel a merge queue entry.
   */
  cancelMergeQueueEntry(entryId: string): void {
    mergeQueue.cancelQueueEntry(this.db, entryId);
  }

  /**
   * Remove an entry from the merge queue.
   */
  removeFromMergeQueue(entryId: string): void {
    mergeQueue.removeFromQueue(this.db, entryId);
  }

  /**
   * Get the next entry to process from the queue.
   */
  getNextToMerge(targetBranch?: string): mergeQueue.MergeQueueEntry | null {
    return mergeQueue.getNextToMerge(this.db, targetBranch);
  }

  /**
   * Process the merge queue.
   */
  processMergeQueue(options: mergeQueue.ProcessQueueOptions): mergeQueue.ProcessQueueResult {
    return mergeQueue.processQueue(this.db, this.repoPath, options);
  }

  /**
   * Get queue position for a stream.
   */
  getMergeQueuePosition(streamId: string, targetBranch?: string): number | null {
    return mergeQueue.getQueuePosition(this.db, streamId, targetBranch);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Worker Tasks
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a worker task under a stream.
   *
   * @param options - Task creation options
   * @returns Task ID
   */
  createTask(options: CreateTaskOptions): string {
    return workerTasks.createTask(this.db, options);
  }

  /**
   * Get a worker task by ID.
   */
  getTask(taskId: string): WorkerTask | null {
    return workerTasks.getTask(this.db, taskId);
  }

  /**
   * List tasks for a stream with optional filters.
   */
  listTasks(streamId: string, options?: ListTasksOptions): WorkerTask[] {
    return workerTasks.listTasks(this.db, streamId, options);
  }

  /**
   * Start a task - assigns an agent and creates the worker branch.
   *
   * @param options - Start task options including taskId, agentId, and worktree
   * @returns Branch name and start commit
   */
  startTask(options: StartTaskOptions): StartTaskResult {
    return workerTasks.startTask(this.db, this.repoPath, options);
  }

  /**
   * Complete a task - merges the worker branch to the stream.
   *
   * Uses --no-ff to always create a merge commit, preserving full history.
   *
   * @param options - Complete task options
   * @returns Merge commit hash
   * @throws TaskConflictError if merge conflicts occur
   */
  completeTask(options: CompleteTaskOptions): CompleteTaskResult {
    return workerTasks.completeTask(this.db, this.repoPath, options);
  }

  /**
   * Abandon a task - marks it as abandoned and optionally deletes the branch.
   *
   * @param taskId - Task ID
   * @param options - Options (deleteBranch: whether to delete the git branch)
   */
  abandonTask(taskId: string, options?: { deleteBranch?: boolean }): void {
    workerTasks.abandonTask(this.db, this.repoPath, taskId, options);
  }

  /**
   * Release a task back to 'open' status.
   *
   * Used for recovery from conflicts or stuck tasks.
   */
  releaseTask(taskId: string): void {
    workerTasks.releaseTask(this.db, taskId);
  }

  /**
   * Clean up old worker branches.
   *
   * Deletes branches for completed/abandoned tasks older than threshold,
   * and optionally orphaned branches with no task record.
   *
   * @param options - Cleanup options
   * @returns List of deleted branches and any errors
   */
  cleanupWorkerBranches(options?: CleanupWorkerBranchesOptions): CleanupResult {
    return workerTasks.cleanupWorkerBranches(this.db, this.repoPath, options);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stream-based Diff Stacks
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create checkpoints from stream commits.
   *
   * Gets commits from the stream's baseCommit to current HEAD and creates
   * a checkpoint for each. Reuses existing checkpoints if already tracked.
   *
   * @param streamId - Stream to create checkpoints from
   * @param options - Optional commit range and creator
   * @returns Array of checkpoints in commit order
   */
  createCheckpointsFromStream(
    streamId: string,
    options?: CreateCheckpointsFromStreamOptions
  ): Checkpoint[] {
    return diffStacks.createCheckpointsFromStream(this.db, this.repoPath, streamId, options);
  }

  /**
   * Create a diff stack from stream commits.
   *
   * Creates checkpoints for commits in the specified range, then groups them
   * into a diff stack for review.
   *
   * @param options - Stack creation options including streamId
   * @returns DiffStackWithCheckpoints containing the stack and its checkpoints
   */
  createStackFromStream(options: CreateStackFromStreamOptions): DiffStackWithCheckpoints {
    return diffStacks.createStackFromStream(this.db, this.repoPath, options);
  }

  /**
   * Cherry-pick an approved stack's checkpoints to the target branch.
   *
   * Verifies the stack is approved, checks out the target branch, and
   * cherry-picks each checkpoint in order. Marks stack as merged on success.
   *
   * @param stackId - Stack to cherry-pick
   * @param worktree - Path to worktree for git operations
   * @returns Result including success status, cherry-picked commits, and new commits
   */
  cherryPickStackToTarget(stackId: string, worktree: string): CherryPickStackResult {
    return diffStacks.cherryPickStackToTarget(this.db, this.repoPath, stackId, worktree);
  }
}
