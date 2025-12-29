/**
 * Custom error classes for the dataplane.
 */

/**
 * Base class for git operation failures.
 */
export class GitOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitOperationError';
  }
}

/**
 * Merge/rebase conflict occurred.
 */
export class ConflictError extends GitOperationError {
  conflictedFiles: string[];
  operation: 'rebase' | 'merge' | 'cherry_pick';

  constructor(
    conflictedFiles: string[],
    operation: 'rebase' | 'merge' | 'cherry_pick'
  ) {
    super(`Conflict in ${operation}: ${conflictedFiles.join(', ')}`);
    this.name = 'ConflictError';
    this.conflictedFiles = conflictedFiles;
    this.operation = operation;
  }
}

/**
 * Referenced branch does not exist.
 */
export class BranchNotFoundError extends GitOperationError {
  branch: string;

  constructor(branch: string) {
    super(`Branch not found: ${branch}`);
    this.name = 'BranchNotFoundError';
    this.branch = branch;
  }
}

/**
 * Worktree operation failed.
 */
export class WorktreeError extends GitOperationError {
  worktree?: string;

  constructor(message: string, worktree?: string) {
    super(message);
    this.name = 'WorktreeError';
    this.worktree = worktree;
  }
}

/**
 * Stream not found in database.
 */
export class StreamNotFoundError extends Error {
  streamId: string;

  constructor(streamId: string) {
    super(`Stream not found: ${streamId}`);
    this.name = 'StreamNotFoundError';
    this.streamId = streamId;
  }
}

/**
 * Stream has unresolved conflicts that block an operation.
 */
export class UnresolvedConflictsError extends Error {
  streamId?: string;
  conflictCount?: number;

  constructor(messageOrStreamId: string, conflictCount?: number) {
    // If conflictCount is provided, this is the old format with streamId
    if (conflictCount !== undefined) {
      super(`Stream ${messageOrStreamId} has ${conflictCount} unresolved conflicts`);
      this.streamId = messageOrStreamId;
      this.conflictCount = conflictCount;
    } else {
      // Otherwise, it's just a custom message
      super(messageOrStreamId);
    }
    this.name = 'UnresolvedConflictsError';
  }
}

/**
 * Dependency graph has cycles.
 */
export class CyclicDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CyclicDependencyError';
  }
}

/**
 * Stream has diamond dependency (multiple parents).
 * Thrown during cascade rebase when merge-based streams are detected.
 */
export class DiamondDependencyError extends Error {
  streamId: string;
  parents: string[];
  parentHeads: string[];

  constructor(streamId: string, parents: string[], parentHeads: string[]) {
    super(
      `Stream ${streamId} has diamond dependency on [${parents.join(', ')}] - requires manual resolution`
    );
    this.name = 'DiamondDependencyError';
    this.streamId = streamId;
    this.parents = parents;
    this.parentHeads = parentHeads;
  }
}

/**
 * Database and git state are out of sync.
 */
export class DesyncError extends Error {
  streamId: string;
  dbState: string;
  gitState: string;

  constructor(streamId: string, dbState: string, gitState: string) {
    super(`Stream ${streamId} desync: DB=${dbState}, Git=${gitState}`);
    this.name = 'DesyncError';
    this.streamId = streamId;
    this.dbState = dbState;
    this.gitState = gitState;
  }
}

/**
 * Stream lock could not be acquired.
 */
export class LockError extends Error {
  streamId: string;
  heldBy: string;

  constructor(streamId: string, heldBy: string) {
    super(`Stream ${streamId} is locked by ${heldBy}`);
    this.name = 'LockError';
    this.streamId = streamId;
    this.heldBy = heldBy;
  }
}

/**
 * Stream is in conflicted state and operation is blocked.
 */
export class StreamConflictedError extends Error {
  streamId: string;
  conflictId?: string;

  constructor(streamId: string, conflictId?: string) {
    super(
      `Stream ${streamId} is in conflicted state - resolve conflict before proceeding`
    );
    this.name = 'StreamConflictedError';
    this.streamId = streamId;
    this.conflictId = conflictId;
  }
}

/**
 * Conflict resolution failed.
 */
export class ConflictResolutionError extends Error {
  conflictId: string;
  reason: 'timeout' | 'handler_failed' | 'verification_failed' | 'partial_resolution';

  constructor(
    conflictId: string,
    reason: 'timeout' | 'handler_failed' | 'verification_failed' | 'partial_resolution'
  ) {
    const messages = {
      timeout: 'Conflict resolution timed out',
      handler_failed: 'Conflict handler returned failure',
      verification_failed: 'Conflict resolution verification failed',
      partial_resolution: 'Only partial conflict resolution - some files remain conflicted',
    };
    super(`${messages[reason]} for conflict ${conflictId}`);
    this.name = 'ConflictResolutionError';
    this.conflictId = conflictId;
    this.reason = reason;
  }
}
