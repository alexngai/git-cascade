/**
 * Rollback operations for stream state restoration.
 *
 * Enables reverting stream state using the operation log.
 */

import type Database from 'better-sqlite3';
import type { Operation } from './models/index.js';
import * as git from './git/index.js';
import * as streams from './streams.js';
import * as operations from './operations.js';
import { StreamNotFoundError, UnresolvedConflictsError } from './errors.js';

export interface RollbackToOperationOptions {
  /** Stream to rollback */
  streamId: string;
  /** Operation ID to rollback to */
  operationId: string;
  /** Path to worktree */
  worktreePath: string;
}

export interface RollbackNOptions {
  /** Stream to rollback */
  streamId: string;
  /** Number of operations to rollback */
  n: number;
  /** Path to worktree */
  worktreePath: string;
}

export interface RollbackToForkPointOptions {
  /** Stream to rollback */
  streamId: string;
  /** Path to worktree */
  worktreePath: string;
}

/**
 * Rollback a stream to a specific operation's state.
 */
export function rollbackToOperation(
  db: Database.Database,
  _repoPath: string,
  options: RollbackToOperationOptions
): void {
  const { streamId, operationId, worktreePath } = options;

  // Verify stream exists
  const stream = streams.getStreamOrThrow(db, streamId);

  // Check for uncommitted changes
  if (!git.isClean({ cwd: worktreePath })) {
    throw new UnresolvedConflictsError(
      'Cannot rollback with uncommitted changes. Commit or stash changes first.'
    );
  }

  // Warn if stream is already merged
  if (stream.status === 'merged') {
    console.warn(`Warning: Rolling back merged stream ${streamId}`);
  }

  // Find the operation
  const operation = operations.getOperation(db, operationId);
  if (!operation) {
    throw new Error(`Operation not found: ${operationId}`);
  }

  // Verify operation belongs to this stream
  if (operation.streamId !== streamId) {
    throw new Error(
      `Operation ${operationId} belongs to stream ${operation.streamId}, not ${streamId}`
    );
  }

  // Get the target commit (afterState of the operation)
  const targetCommit = operation.afterState;
  if (!targetCommit) {
    throw new Error(
      `Operation ${operationId} has no afterState commit - cannot rollback`
    );
  }

  // Reset worktree to target commit
  // This automatically updates the branch pointer since we're on the branch
  git.resetHard(targetCommit, { cwd: worktreePath });

  // Record rollback operation
  operations.recordOperation(db, {
    streamId,
    agentId: stream.agentId,
    opType: 'rollback',
    beforeState: stream.baseCommit,
    afterState: targetCommit,
    metadata: {
      targetOperationId: operationId,
    },
  });
}

/**
 * Rollback a stream by N operations.
 */
export function rollbackN(
  db: Database.Database,
  repoPath: string,
  options: RollbackNOptions
): void {
  const { streamId, n, worktreePath } = options;

  if (n <= 0) {
    throw new Error('Rollback count must be positive');
  }

  // Get latest operation
  const latest = operations.getLatestOperation(db, streamId);
  if (!latest) {
    throw new Error(`No operations found for stream ${streamId}`);
  }

  // Walk back n operations
  let current: Operation | null = latest;
  for (let i = 0; i < n; i++) {
    // Check if we can go back further
    if (!current.parentOps || current.parentOps.length === 0 || !current.parentOps[0]) {
      // We found i operations before running out (we have current, plus i-1 previous)
      const found = i + 1;
      throw new Error(
        `Cannot rollback ${n} operations - only ${found} operations in history`
      );
    }
    const parentOpId = current.parentOps[0]!;
    const prev = operations.getOperation(db, parentOpId);
    if (!prev) {
      throw new Error(`Operation chain broken at ${parentOpId}`);
    }
    current = prev;
  }

  // Rollback to the target operation
  rollbackToOperation(db, repoPath, {
    streamId,
    operationId: current.id,
    worktreePath,
  });
}

/**
 * Rollback a stream to its fork point (baseCommit).
 *
 * This is a nuclear option that clears all work on the stream.
 */
export function rollbackToForkPoint(
  db: Database.Database,
  _repoPath: string,
  options: RollbackToForkPointOptions
): void {
  const { streamId, worktreePath } = options;

  // Verify stream exists
  const stream = streams.getStream(db, streamId);
  if (!stream) {
    throw new StreamNotFoundError(streamId);
  }

  // Check for uncommitted changes
  if (!git.isClean({ cwd: worktreePath })) {
    throw new UnresolvedConflictsError(
      'Cannot rollback with uncommitted changes. Commit or stash changes first.'
    );
  }

  // Warn if stream is already merged
  if (stream.status === 'merged') {
    console.warn(`Warning: Rolling back merged stream ${streamId}`);
  }

  // Reset to baseCommit
  const targetCommit = stream.baseCommit;
  // This automatically updates the branch pointer since we're on the branch
  git.resetHard(targetCommit, { cwd: worktreePath });

  // Record rollback operation
  operations.recordOperation(db, {
    streamId,
    agentId: stream.agentId,
    opType: 'rollback',
    beforeState: stream.baseCommit,
    afterState: targetCommit,
    metadata: {
      resetToForkPoint: true,
    },
  });
}
