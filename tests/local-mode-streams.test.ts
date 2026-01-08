/**
 * Tests for local mode streams (tracking existing branches).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTestRepo, commitFile } from './setup.js';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import * as git from '../src/git/index.js';

describe('Local Mode Streams', () => {
  let testRepo: ReturnType<typeof createTestRepo>;
  let tracker: MultiAgentRepoTracker;

  beforeEach(() => {
    testRepo = createTestRepo();
    tracker = new MultiAgentRepoTracker({ repoPath: testRepo.path });
  });

  afterEach(() => {
    tracker.close();
    testRepo.cleanup();
  });

  describe('Creating Local Mode Streams', () => {
    it('should create a stream tracking an existing branch', () => {
      // Create an existing branch
      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('feature/existing', head, { cwd: testRepo.path });

      // Make a commit on the branch
      git.checkout('feature/existing', { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'feature.txt'), 'feature content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('Add feature', { cwd: testRepo.path });
      const featureHead = git.getHead({ cwd: testRepo.path });
      git.checkout('main', { cwd: testRepo.path });

      // Create a local mode stream
      const streamId = tracker.createStream({
        name: 'track-existing',
        agentId: 'agent-1',
        existingBranch: 'feature/existing',
        createBranch: false,
      });

      // Verify stream was created
      const stream = tracker.getStream(streamId);
      expect(stream).toBeDefined();
      expect(stream!.isLocalMode).toBe(true);
      expect(stream!.existingBranch).toBe('feature/existing');
      expect(stream!.baseCommit).toBe(featureHead);
    });

    it('should not create a new git branch for local mode streams', () => {
      // Create an existing branch
      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('feature/no-new-branch', head, { cwd: testRepo.path });

      // Create local mode stream
      const streamId = tracker.createStream({
        name: 'local-stream',
        agentId: 'agent-1',
        existingBranch: 'feature/no-new-branch',
        createBranch: false,
      });

      // Verify no stream/<id> branch was created
      expect(() => {
        git.resolveRef(`stream/${streamId}`, { cwd: testRepo.path });
      }).toThrow();

      // Verify the existing branch still exists
      const branchHead = git.resolveRef('feature/no-new-branch', { cwd: testRepo.path });
      expect(branchHead).toBe(head);
    });

    it('should create normal stream when createBranch is not false', () => {
      const streamId = tracker.createStream({
        name: 'normal-stream',
        agentId: 'agent-1',
      });

      const stream = tracker.getStream(streamId);
      expect(stream!.isLocalMode).toBe(false);
      expect(stream!.existingBranch).toBeNull();

      // Verify stream/<id> branch was created
      const branchHead = git.resolveRef(`stream/${streamId}`, { cwd: testRepo.path });
      expect(branchHead).toBeDefined();
    });
  });

  describe('getStreamBranchName', () => {
    it('should return existing branch name for local mode streams', () => {
      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('feature/test-branch', head, { cwd: testRepo.path });

      const streamId = tracker.createStream({
        name: 'local-stream',
        agentId: 'agent-1',
        existingBranch: 'feature/test-branch',
        createBranch: false,
      });

      const branchName = tracker.getStreamBranchName(streamId);
      expect(branchName).toBe('feature/test-branch');
    });

    it('should return stream/<id> for normal streams', () => {
      const streamId = tracker.createStream({
        name: 'normal-stream',
        agentId: 'agent-1',
      });

      const branchName = tracker.getStreamBranchName(streamId);
      expect(branchName).toBe(`stream/${streamId}`);
    });
  });

  describe('getStreamHead', () => {
    it('should return HEAD of existing branch for local mode streams', () => {
      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('feature/head-test', head, { cwd: testRepo.path });

      // Make a commit on the feature branch
      git.checkout('feature/head-test', { cwd: testRepo.path });
      fs.writeFileSync(path.join(testRepo.path, 'new-file.txt'), 'content');
      git.stageAll({ cwd: testRepo.path });
      git.commit('New commit', { cwd: testRepo.path });
      const featureHead = git.getHead({ cwd: testRepo.path });
      git.checkout('main', { cwd: testRepo.path });

      const streamId = tracker.createStream({
        name: 'local-stream',
        agentId: 'agent-1',
        existingBranch: 'feature/head-test',
        createBranch: false,
      });

      const streamHead = tracker.getStreamHead(streamId);
      expect(streamHead).toBe(featureHead);
    });
  });

  describe('Worktree with Local Mode Streams', () => {
    it('should checkout existing branch when updating worktree to local mode stream', () => {
      // Create existing branch with a commit
      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('feature/worktree-test', head, { cwd: testRepo.path });

      // Create local mode stream
      const streamId = tracker.createStream({
        name: 'local-stream',
        agentId: 'agent-1',
        existingBranch: 'feature/worktree-test',
        createBranch: false,
      });

      // Create worktree
      const wtPath = path.join(testRepo.path, '.worktrees', 'agent-1');
      fs.mkdirSync(path.dirname(wtPath), { recursive: true });
      tracker.createWorktree({ agentId: 'agent-1', path: wtPath });

      // Update worktree to use the local mode stream
      tracker.updateWorktreeStream('agent-1', streamId);

      // Verify worktree is on the existing branch
      const currentBranch = git.git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wtPath }).trim();
      expect(currentBranch).toBe('feature/worktree-test');
    });
  });

  describe('Archiving Local Mode Streams', () => {
    it('should preserve isLocalMode and existingBranch when archiving', async () => {
      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('feature/archive-test', head, { cwd: testRepo.path });

      const streamId = tracker.createStream({
        name: 'local-stream',
        agentId: 'agent-1',
        existingBranch: 'feature/archive-test',
        createBranch: false,
      });

      // Abandon the stream (which triggers archiving if configured)
      tracker.abandonStream(streamId, 'Test abandonment');

      // Check the stream status
      const stream = tracker.getStream(streamId);
      expect(stream!.status).toBe('abandoned');
      expect(stream!.isLocalMode).toBe(true);
      expect(stream!.existingBranch).toBe('feature/archive-test');
    });
  });

  describe('Stream Properties', () => {
    it('should include isLocalMode and existingBranch in stream object', () => {
      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('feature/props-test', head, { cwd: testRepo.path });

      const streamId = tracker.createStream({
        name: 'local-stream',
        agentId: 'agent-1',
        existingBranch: 'feature/props-test',
        createBranch: false,
      });

      const stream = tracker.getStream(streamId);
      expect(stream).toHaveProperty('isLocalMode');
      expect(stream).toHaveProperty('existingBranch');
      expect(stream!.isLocalMode).toBe(true);
      expect(stream!.existingBranch).toBe('feature/props-test');
    });

    it('should list local mode streams correctly', () => {
      const head = git.getHead({ cwd: testRepo.path });
      git.createBranch('feature/list-test', head, { cwd: testRepo.path });

      // Create normal stream
      tracker.createStream({ name: 'normal', agentId: 'agent-1' });

      // Create local mode stream
      tracker.createStream({
        name: 'local',
        agentId: 'agent-1',
        existingBranch: 'feature/list-test',
        createBranch: false,
      });

      const streams = tracker.listStreams();
      expect(streams).toHaveLength(2);

      const localStream = streams.find((s) => s.name === 'local');
      const normalStream = streams.find((s) => s.name === 'normal');

      expect(localStream!.isLocalMode).toBe(true);
      expect(normalStream!.isLocalMode).toBe(false);
    });
  });
});
