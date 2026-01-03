import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiAgentRepoTracker } from '../src/tracker.js';
import { createTestRepo } from './setup.js';
import * as gc from '../src/gc.js';

describe('GC Configuration', () => {
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

  describe('getGCConfig', () => {
    it('should return default config when no values are set', () => {
      const config = gc.getGCConfig(tracker.db);

      expect(config.autoArchiveOnMerge).toBe(true);
      expect(config.autoArchiveOnAbandon).toBe(true);
      expect(config.archiveRetentionDays).toBe(30);
      expect(config.deleteGitBranches).toBe(true);
      expect(config.deleteWorktrees).toBe(true);
      expect(config.runRecoveryOnStartup).toBe(true);
    });

    it('should return stored values merged with defaults', () => {
      // Set some values
      gc.setGCConfig(tracker.db, {
        autoArchiveOnMerge: false,
        archiveRetentionDays: 60,
      });

      const config = gc.getGCConfig(tracker.db);

      // Custom values
      expect(config.autoArchiveOnMerge).toBe(false);
      expect(config.archiveRetentionDays).toBe(60);

      // Default values for unset keys
      expect(config.autoArchiveOnAbandon).toBe(true);
      expect(config.deleteGitBranches).toBe(true);
      expect(config.deleteWorktrees).toBe(true);
      expect(config.runRecoveryOnStartup).toBe(true);
    });
  });

  describe('setGCConfig', () => {
    it('should update a single boolean value', () => {
      gc.setGCConfig(tracker.db, { autoArchiveOnMerge: false });

      const config = gc.getGCConfig(tracker.db);
      expect(config.autoArchiveOnMerge).toBe(false);
    });

    it('should update a single numeric value', () => {
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 90 });

      const config = gc.getGCConfig(tracker.db);
      expect(config.archiveRetentionDays).toBe(90);
    });

    it('should update multiple values at once', () => {
      gc.setGCConfig(tracker.db, {
        autoArchiveOnMerge: false,
        autoArchiveOnAbandon: false,
        archiveRetentionDays: 7,
        deleteGitBranches: false,
        deleteWorktrees: false,
        runRecoveryOnStartup: false,
      });

      const config = gc.getGCConfig(tracker.db);
      expect(config.autoArchiveOnMerge).toBe(false);
      expect(config.autoArchiveOnAbandon).toBe(false);
      expect(config.archiveRetentionDays).toBe(7);
      expect(config.deleteGitBranches).toBe(false);
      expect(config.deleteWorktrees).toBe(false);
      expect(config.runRecoveryOnStartup).toBe(false);
    });

    it('should overwrite previously set values', () => {
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 30 });
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 60 });
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 90 });

      const config = gc.getGCConfig(tracker.db);
      expect(config.archiveRetentionDays).toBe(90);
    });

    it('should not affect other values when updating specific keys', () => {
      // Set all values to non-default
      gc.setGCConfig(tracker.db, {
        autoArchiveOnMerge: false,
        autoArchiveOnAbandon: false,
        archiveRetentionDays: 60,
        deleteGitBranches: false,
        deleteWorktrees: false,
        runRecoveryOnStartup: false,
      });

      // Update only one value
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 90 });

      const config = gc.getGCConfig(tracker.db);
      expect(config.autoArchiveOnMerge).toBe(false);
      expect(config.autoArchiveOnAbandon).toBe(false);
      expect(config.archiveRetentionDays).toBe(90);
      expect(config.deleteGitBranches).toBe(false);
      expect(config.deleteWorktrees).toBe(false);
      expect(config.runRecoveryOnStartup).toBe(false);
    });

    it('should handle empty partial config gracefully', () => {
      gc.setGCConfig(tracker.db, {});

      const config = gc.getGCConfig(tracker.db);
      // All defaults should still be in place
      expect(config.autoArchiveOnMerge).toBe(true);
      expect(config.archiveRetentionDays).toBe(30);
    });

    it('should ignore undefined values in partial config', () => {
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 60 });

      // Pass object with undefined value
      gc.setGCConfig(tracker.db, {
        autoArchiveOnMerge: undefined,
        archiveRetentionDays: 90,
      } as Partial<gc.GCConfig>);

      const config = gc.getGCConfig(tracker.db);
      expect(config.autoArchiveOnMerge).toBe(true); // Still default
      expect(config.archiveRetentionDays).toBe(90);
    });
  });

  describe('persistence', () => {
    it('should persist config across tracker instances', () => {
      // Set config on first tracker
      gc.setGCConfig(tracker.db, {
        autoArchiveOnMerge: false,
        archiveRetentionDays: 45,
      });

      tracker.close();

      // Create new tracker for same repo
      const tracker2 = new MultiAgentRepoTracker({ repoPath: testRepo.path });

      try {
        const config = gc.getGCConfig(tracker2.db);
        expect(config.autoArchiveOnMerge).toBe(false);
        expect(config.archiveRetentionDays).toBe(45);
      } finally {
        tracker2.close();
      }
    });
  });

  describe('edge cases', () => {
    it('should handle zero retention days', () => {
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 0 });

      const config = gc.getGCConfig(tracker.db);
      expect(config.archiveRetentionDays).toBe(0);
    });

    it('should handle large retention days value', () => {
      gc.setGCConfig(tracker.db, { archiveRetentionDays: 365 });

      const config = gc.getGCConfig(tracker.db);
      expect(config.archiveRetentionDays).toBe(365);
    });

    it('should toggle boolean values correctly', () => {
      // Start with default (true)
      expect(gc.getGCConfig(tracker.db).deleteGitBranches).toBe(true);

      // Set to false
      gc.setGCConfig(tracker.db, { deleteGitBranches: false });
      expect(gc.getGCConfig(tracker.db).deleteGitBranches).toBe(false);

      // Set back to true
      gc.setGCConfig(tracker.db, { deleteGitBranches: true });
      expect(gc.getGCConfig(tracker.db).deleteGitBranches).toBe(true);
    });
  });
});
