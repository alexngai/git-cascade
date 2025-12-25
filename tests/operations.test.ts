/**
 * Operation logging tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/index.js';
import { createTestRepo, commitFile, getHead, type TestRepo } from './setup.js';

describe('Operation Logging', () => {
  let testRepo: TestRepo;
  let tracker: MultiAgentRepoTracker;
  let streamId: string;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });
    streamId = tracker.createStream({ name: 'test-stream', agentId: 'agent-1' });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  describe('recordOperation', () => {
    it('should record an operation', () => {
      const beforeState = getHead(testRepo.path);
      const afterState = commitFile(
        testRepo.path,
        'test.txt',
        'content',
        'Test commit'
      );

      const opId = tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState,
        afterState,
      });

      expect(opId).toMatch(/^op-[a-f0-9]{8}$/);
    });

    it('should store operation metadata', () => {
      const opId = tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: 'abc123',
        afterState: 'def456',
        metadata: { message: 'Test commit' },
      });

      const op = tracker.getOperation(opId);
      expect(op!.metadata.message).toBe('Test commit');
    });
  });

  describe('getOperation', () => {
    it('should retrieve operation by ID', () => {
      const opId = tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: 'abc123',
        afterState: 'def456',
      });

      const op = tracker.getOperation(opId);
      expect(op).not.toBeNull();
      expect(op!.id).toBe(opId);
      expect(op!.streamId).toBe(streamId);
      expect(op!.opType).toBe('commit');
    });

    it('should return null for unknown ID', () => {
      const op = tracker.getOperation('op-unknown');
      expect(op).toBeNull();
    });
  });

  describe('getOperations', () => {
    it('should list all operations', () => {
      tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: 'a',
        afterState: 'b',
      });
      tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'amend',
        beforeState: 'b',
        afterState: 'c',
      });

      const ops = tracker.getOperations();
      expect(ops).toHaveLength(2);
    });

    it('should filter by streamId', () => {
      const stream2 = tracker.createStream({
        name: 'stream-2',
        agentId: 'agent-1',
      });

      tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: 'a',
        afterState: 'b',
      });
      tracker.recordOperation({
        streamId: stream2,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: 'x',
        afterState: 'y',
      });

      const ops = tracker.getOperations({ streamId });
      expect(ops).toHaveLength(1);
      expect(ops[0]!.streamId).toBe(streamId);
    });

    it('should filter by agentId', () => {
      tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: 'a',
        afterState: 'b',
      });
      tracker.recordOperation({
        streamId,
        agentId: 'agent-2',
        opType: 'commit',
        beforeState: 'b',
        afterState: 'c',
      });

      const ops = tracker.getOperations({ agentId: 'agent-2' });
      expect(ops).toHaveLength(1);
      expect(ops[0]!.agentId).toBe('agent-2');
    });
  });

  describe('getLatestOperation', () => {
    it('should return most recent operation', async () => {
      tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: 'a',
        afterState: 'b',
      });

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'amend',
        beforeState: 'b',
        afterState: 'c',
      });

      const latest = tracker.getLatestOperation(streamId);
      expect(latest).not.toBeNull();
      expect(latest!.opType).toBe('amend');
      expect(latest!.afterState).toBe('c');
    });

    it('should return null for stream with no operations', () => {
      const latest = tracker.getLatestOperation(streamId);
      expect(latest).toBeNull();
    });
  });

  describe('getOperationChain', () => {
    it('should return operation chain from oldest to newest', () => {
      const op1 = tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: 'a',
        afterState: 'b',
      });

      const op2 = tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'commit',
        beforeState: 'b',
        afterState: 'c',
        parentOps: [op1],
      });

      const op3 = tracker.recordOperation({
        streamId,
        agentId: 'agent-1',
        opType: 'amend',
        beforeState: 'c',
        afterState: 'd',
        parentOps: [op2],
      });

      const chain = tracker.getOperationChain(op3);
      expect(chain).toHaveLength(3);
      expect(chain[0]!.id).toBe(op1);
      expect(chain[1]!.id).toBe(op2);
      expect(chain[2]!.id).toBe(op3);
    });
  });
});
