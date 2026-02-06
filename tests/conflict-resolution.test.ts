import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as conflicts from '../src/conflicts.js';
import * as streams from '../src/streams.js';
import * as git from '../src/git/index.js';
import * as fs from 'fs';
import * as path from 'path';

describe('Conflict Resolution', () => {
  let tracker: MultiAgentRepoTracker;
  let testRepo: ReturnType<typeof createTestRepo>;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  /**
   * Helper to create a conflict scenario.
   * Returns streams with conflicting changes.
   */
  function createConflictScenario(): {
    mainId: string;
    featureId: string;
    mainWorktree: string;
    featureWorktree: string;
  } {
    // Create main stream
    const mainId = tracker.createStream({
      name: 'main',
      agentId: 'agent-1',
    });

    // Get worktree for main and make initial commit
    const mainWorktreePath = path.join(testRepo.path, '.worktrees', 'main-wt');
    tracker.createWorktree({
      agentId: 'agent-1',
      path: mainWorktreePath,
      branch: `stream/${mainId}`,
    });

    fs.writeFileSync(path.join(mainWorktreePath, 'shared.txt'), 'initial content');
    git.stageAll({ cwd: mainWorktreePath });
    git.commit('initial commit', { cwd: mainWorktreePath });

    // Fork feature from main
    const featureId = tracker.forkStream({
      parentStreamId: mainId,
      name: 'feature',
      agentId: 'agent-2',
    });

    // Get worktree for feature
    const featureWorktreePath = path.join(testRepo.path, '.worktrees', 'feature-wt');
    tracker.createWorktree({
      agentId: 'agent-2',
      path: featureWorktreePath,
      branch: `stream/${featureId}`,
    });

    // Make conflicting change on main
    fs.writeFileSync(path.join(mainWorktreePath, 'shared.txt'), 'main change');
    git.stageAll({ cwd: mainWorktreePath });
    git.commit('main change', { cwd: mainWorktreePath });

    // Make conflicting change on feature
    fs.writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'feature change');
    git.stageAll({ cwd: featureWorktreePath });
    git.commit('feature change', { cwd: featureWorktreePath });

    return {
      mainId,
      featureId,
      mainWorktree: mainWorktreePath,
      featureWorktree: featureWorktreePath,
    };
  }

  describe('Rebase with Conflict Detection', () => {
    it('should detect conflict and set stream to conflicted status with abort strategy', () => {
      const { mainId, featureId, featureWorktree } = createConflictScenario();

      const result = streams.rebaseOntoStream(tracker.db, testRepo.path, {
        sourceStream: featureId,
        targetStream: mainId,
        agentId: 'agent-2',
        worktree: featureWorktree,
        onConflict: 'abort',
        cascade: false,
      });

      expect(result.success).toBe(false);
      expect(result.conflicts).toBeDefined();
      expect(result.conflicts!.length).toBeGreaterThan(0);
      expect(result.conflictId).toBeDefined();

      // Stream should be conflicted
      const stream = tracker.getStream(featureId);
      expect(stream!.status).toBe('conflicted');

      // Conflict record should exist
      const conflict = conflicts.getConflict(tracker.db, result.conflictId!);
      expect(conflict).not.toBeNull();
      expect(conflict!.status).toBe('pending');

      tracker.deallocateWorktree('agent-2');
    });

    it('should resolve conflict automatically with ours strategy', () => {
      const { mainId, featureId, featureWorktree } = createConflictScenario();

      const result = streams.rebaseOntoStream(tracker.db, testRepo.path, {
        sourceStream: featureId,
        targetStream: mainId,
        agentId: 'agent-2',
        worktree: featureWorktree,
        onConflict: 'ours',
        cascade: false,
      });

      expect(result.success).toBe(true);
      expect(result.newHead).toBeDefined();

      // Stream should still be active
      const stream = tracker.getStream(featureId);
      expect(stream!.status).toBe('active');

      // Content should be from source (feature)
      const content = fs.readFileSync(path.join(featureWorktree, 'shared.txt'), 'utf8');
      expect(content).toBe('feature change');

      tracker.deallocateWorktree('agent-2');
    });

    it('should resolve conflict automatically with theirs strategy', () => {
      const { mainId, featureId, featureWorktree } = createConflictScenario();

      const result = streams.rebaseOntoStream(tracker.db, testRepo.path, {
        sourceStream: featureId,
        targetStream: mainId,
        agentId: 'agent-2',
        worktree: featureWorktree,
        onConflict: 'theirs',
        cascade: false,
      });

      expect(result.success).toBe(true);
      expect(result.newHead).toBeDefined();

      // Content should be from target (main)
      const content = fs.readFileSync(path.join(featureWorktree, 'shared.txt'), 'utf8');
      expect(content).toBe('main change');

      tracker.deallocateWorktree('agent-2');
    });
  });

  describe('Agent Conflict Handler', () => {
    // Note: The agent handler uses a sync busy-wait pattern which has limitations
    // with async handlers. These tests verify the basic flow works.

    it('should set up conflict for agent resolution when handler times out', () => {
      const { mainId, featureId, featureWorktree } = createConflictScenario();

      // Use a handler that takes too long (simulate timeout)
      const handler = async () => {
        // The sync busy-wait can't properly await this
        return new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(true), 10000);
        });
      };

      // Use a very short timeout so it fails quickly
      const result = streams.rebaseOntoStream(tracker.db, testRepo.path, {
        sourceStream: featureId,
        targetStream: mainId,
        agentId: 'agent-2',
        worktree: featureWorktree,
        onConflict: 'agent',
        conflictHandler: handler,
        conflictTimeout: 50, // Very short timeout
        cascade: false,
      });

      expect(result.success).toBe(false);
      expect(result.conflictId).toBeDefined();

      // Sync version defers handler execution - conflict stays pending
      // Use rebaseOntoStreamAsync for actual async handler support with timeouts
      const conflict = conflicts.getConflict(tracker.db, result.conflictId!);
      expect(conflict!.status).toBe('pending');

      tracker.deallocateWorktree('agent-2');
    });

    it('should fall back to abort when no handler provided with agent strategy', () => {
      const { mainId, featureId, featureWorktree } = createConflictScenario();

      const result = streams.rebaseOntoStream(tracker.db, testRepo.path, {
        sourceStream: featureId,
        targetStream: mainId,
        agentId: 'agent-2',
        worktree: featureWorktree,
        onConflict: 'agent',
        // No handler provided
        cascade: false,
      });

      expect(result.success).toBe(false);
      expect(result.conflicts).toBeDefined();
      expect(result.conflictId).toBeDefined();

      // Stream should be conflicted (awaiting manual resolution)
      const stream = tracker.getStream(featureId);
      expect(stream!.status).toBe('conflicted');

      tracker.deallocateWorktree('agent-2');
    });
  });

  describe('Continue and Abort Resolution', () => {
    it('should abort conflicted rebase and reset stream', () => {
      const { mainId, featureId, featureWorktree } = createConflictScenario();

      // Create conflict
      const result = streams.rebaseOntoStream(tracker.db, testRepo.path, {
        sourceStream: featureId,
        targetStream: mainId,
        agentId: 'agent-2',
        worktree: featureWorktree,
        onConflict: 'abort',
        cascade: false,
      });

      expect(result.success).toBe(false);
      expect(tracker.getStream(featureId)!.status).toBe('conflicted');

      // Abort the rebase
      streams.abortConflictedRebase(tracker.db, featureId, featureWorktree);

      // Stream should be active
      expect(tracker.getStream(featureId)!.status).toBe('active');

      // Conflict should be abandoned
      const conflict = conflicts.getConflict(tracker.db, result.conflictId!);
      expect(conflict!.status).toBe('abandoned');

      tracker.deallocateWorktree('agent-2');
    });

    it('should clear conflict completely', () => {
      const { mainId, featureId, featureWorktree } = createConflictScenario();

      // Create conflict
      const result = streams.rebaseOntoStream(tracker.db, testRepo.path, {
        sourceStream: featureId,
        targetStream: mainId,
        agentId: 'agent-2',
        worktree: featureWorktree,
        onConflict: 'abort',
        cascade: false,
      });

      expect(result.success).toBe(false);

      // Clear the conflict
      streams.clearConflict(tracker.db, featureId, featureWorktree);

      // Stream should be active
      expect(tracker.getStream(featureId)!.status).toBe('active');

      // Conflict record should be deleted (not just abandoned)
      expect(conflicts.getConflict(tracker.db, result.conflictId!)).toBeNull();

      tracker.deallocateWorktree('agent-2');
    });
  });
});
