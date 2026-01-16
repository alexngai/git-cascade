/**
 * Dataplane migration system tests.
 *
 * Tests for the versioned migration system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  runDataplaneMigrations,
  getCurrentDataplaneMigrationVersion,
  getDataplaneMigrations,
  getLatestDataplaneMigrationVersion,
  rollbackDataplaneMigration,
} from '../src/db/migrations.js';

describe('Dataplane Migrations', () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    // Create a temporary database
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataplane-migration-test-'));
    dbPath = path.join(tempDir, 'test.db');
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
    // Clean up temp files
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    const tempDir = path.dirname(dbPath);
    if (fs.existsSync(tempDir)) {
      fs.rmdirSync(tempDir, { recursive: true });
    }
  });

  describe('getCurrentDataplaneMigrationVersion', () => {
    it('should return 0 for a fresh database', () => {
      const version = getCurrentDataplaneMigrationVersion(db);
      expect(version).toBe(0);
    });

    it('should create the migrations table if it does not exist', () => {
      getCurrentDataplaneMigrationVersion(db);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dataplane_migrations'")
        .all() as Array<{ name: string }>;

      expect(tables.length).toBe(1);
    });

    it('should support table prefixes', () => {
      const version = getCurrentDataplaneMigrationVersion(db, 'dp_');
      expect(version).toBe(0);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dp_dataplane_migrations'")
        .all() as Array<{ name: string }>;

      expect(tables.length).toBe(1);
    });
  });

  describe('getDataplaneMigrations', () => {
    it('should return all available migrations', () => {
      const migrations = getDataplaneMigrations();
      expect(migrations.length).toBeGreaterThanOrEqual(2);
      expect(migrations[0].version).toBe(1);
      expect(migrations[0].name).toBe('add-branch-point-commit');
      expect(migrations[1].version).toBe(2);
      expect(migrations[1].name).toBe('add-stream-merges-table');
    });

    it('should return migrations in order', () => {
      const migrations = getDataplaneMigrations();
      for (let i = 1; i < migrations.length; i++) {
        expect(migrations[i].version).toBeGreaterThan(migrations[i - 1].version);
      }
    });
  });

  describe('getLatestDataplaneMigrationVersion', () => {
    it('should return the highest version number', () => {
      const migrations = getDataplaneMigrations();
      const latest = getLatestDataplaneMigrationVersion();
      expect(latest).toBe(Math.max(...migrations.map((m) => m.version)));
    });
  });

  describe('runDataplaneMigrations', () => {
    beforeEach(() => {
      // Create the base streams table that migrations depend on
      db.exec(`
        CREATE TABLE streams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          parent_stream TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          merged_into TEXT,
          enable_stacked_review INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          existing_branch TEXT,
          is_local_mode INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (parent_stream) REFERENCES streams(id)
        );
      `);
    });

    it('should run all pending migrations on a fresh database', () => {
      const applied = runDataplaneMigrations(db);
      expect(applied).toBeGreaterThanOrEqual(2);

      const version = getCurrentDataplaneMigrationVersion(db);
      expect(version).toBe(getLatestDataplaneMigrationVersion());
    });

    it('should add branch_point_commit column via migration 1', () => {
      runDataplaneMigrations(db);

      const columns = db.pragma('table_info(streams)') as Array<{ name: string }>;
      const hasBranchPointCommit = columns.some((col) => col.name === 'branch_point_commit');
      expect(hasBranchPointCommit).toBe(true);
    });

    it('should create stream_merges table via migration 2', () => {
      runDataplaneMigrations(db);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stream_merges'")
        .all() as Array<{ name: string }>;

      expect(tables.length).toBe(1);
    });

    it('should create indexes for stream_merges table', () => {
      runDataplaneMigrations(db);

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%stream_merges%'")
        .all() as Array<{ name: string }>;

      expect(indexes.length).toBeGreaterThanOrEqual(2);
    });

    it('should be idempotent', () => {
      // Run migrations twice
      const first = runDataplaneMigrations(db);
      const second = runDataplaneMigrations(db);

      expect(first).toBeGreaterThanOrEqual(2);
      expect(second).toBe(0); // No new migrations
    });

    it('should work with table prefix', () => {
      // Create prefixed streams table
      db.exec(`
        CREATE TABLE dp_streams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          parent_stream TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          merged_into TEXT,
          enable_stacked_review INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          existing_branch TEXT,
          is_local_mode INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (parent_stream) REFERENCES dp_streams(id)
        );
      `);

      const applied = runDataplaneMigrations(db, 'dp_');
      expect(applied).toBeGreaterThanOrEqual(2);

      // Check prefixed tables and columns
      const columns = db.pragma('table_info(dp_streams)') as Array<{ name: string }>;
      const hasBranchPointCommit = columns.some((col) => col.name === 'branch_point_commit');
      expect(hasBranchPointCommit).toBe(true);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dp_stream_merges'")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(1);

      // Check version is tracked in prefixed table
      const version = getCurrentDataplaneMigrationVersion(db, 'dp_');
      expect(version).toBe(getLatestDataplaneMigrationVersion());
    });

    it('should record each migration in the migrations table', () => {
      runDataplaneMigrations(db);

      const migrations = db
        .prepare('SELECT * FROM dataplane_migrations ORDER BY version')
        .all() as Array<{ version: number; name: string; applied_at: number }>;

      expect(migrations.length).toBeGreaterThanOrEqual(2);
      expect(migrations[0].version).toBe(1);
      expect(migrations[0].name).toBe('add-branch-point-commit');
      expect(migrations[1].version).toBe(2);
      expect(migrations[1].name).toBe('add-stream-merges-table');

      // Check that applied_at is a valid timestamp
      for (const m of migrations) {
        expect(m.applied_at).toBeGreaterThan(0);
      }
    });

    it('should skip migrations that have already been applied', () => {
      // Manually record migration 1 as applied
      getCurrentDataplaneMigrationVersion(db); // Creates table
      db.prepare('INSERT INTO dataplane_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(1, 'add-branch-point-commit', Date.now());

      const applied = runDataplaneMigrations(db);

      // Should only apply migration 2+
      expect(applied).toBe(getLatestDataplaneMigrationVersion() - 1);

      // Verify migration 2 was applied
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stream_merges'")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(1);
    });
  });

  describe('rollbackDataplaneMigration', () => {
    beforeEach(() => {
      // Create base streams table
      db.exec(`
        CREATE TABLE streams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          parent_stream TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          merged_into TEXT,
          enable_stacked_review INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          existing_branch TEXT,
          is_local_mode INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (parent_stream) REFERENCES streams(id)
        );
      `);
    });

    it('should return false when no migrations to rollback', () => {
      const result = rollbackDataplaneMigration(db);
      expect(result).toBe(false);
    });

    it('should rollback the last migration', () => {
      // Apply all migrations
      runDataplaneMigrations(db);
      const versionBefore = getCurrentDataplaneMigrationVersion(db);

      // Rollback
      const result = rollbackDataplaneMigration(db);
      expect(result).toBe(true);

      const versionAfter = getCurrentDataplaneMigrationVersion(db);
      expect(versionAfter).toBe(versionBefore - 1);
    });

    it('should remove stream_merges table when rolling back migration 2', () => {
      runDataplaneMigrations(db);

      // Verify table exists
      let tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stream_merges'")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(1);

      // Rollback migration 2
      rollbackDataplaneMigration(db);

      // Verify table is dropped
      tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stream_merges'")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(0);
    });
  });

  describe('migration 1: add-branch-point-commit', () => {
    it('should not fail if column already exists', () => {
      // Create streams table with branch_point_commit already
      db.exec(`
        CREATE TABLE streams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          parent_stream TEXT,
          branch_point_commit TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          merged_into TEXT,
          enable_stacked_review INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          existing_branch TEXT,
          is_local_mode INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (parent_stream) REFERENCES streams(id)
        );
      `);

      // Migration should be idempotent
      expect(() => runDataplaneMigrations(db)).not.toThrow();
    });

    it('should not fail if streams table does not exist', () => {
      // Don't create streams table
      expect(() => runDataplaneMigrations(db)).not.toThrow();
    });
  });

  describe('migration 2: add-stream-merges-table', () => {
    beforeEach(() => {
      db.exec(`
        CREATE TABLE streams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          parent_stream TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          merged_into TEXT,
          enable_stacked_review INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          existing_branch TEXT,
          is_local_mode INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (parent_stream) REFERENCES streams(id)
        );
      `);
    });

    it('should not fail if stream_merges table already exists', () => {
      // Create stream_merges table manually
      db.exec(`
        CREATE TABLE stream_merges (
          id TEXT PRIMARY KEY,
          source_stream_id TEXT NOT NULL,
          source_commit TEXT NOT NULL,
          target_stream_id TEXT NOT NULL,
          merge_commit TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}'
        );
      `);

      // Migration should be idempotent
      expect(() => runDataplaneMigrations(db)).not.toThrow();
    });

    it('should create correct schema for stream_merges', () => {
      runDataplaneMigrations(db);

      const columns = db.pragma('table_info(stream_merges)') as Array<{ name: string; type: string; notnull: number }>;
      const columnMap = new Map(columns.map((c) => [c.name, c]));

      expect(columnMap.has('id')).toBe(true);
      expect(columnMap.has('source_stream_id')).toBe(true);
      expect(columnMap.has('source_commit')).toBe(true);
      expect(columnMap.has('target_stream_id')).toBe(true);
      expect(columnMap.has('merge_commit')).toBe(true);
      expect(columnMap.has('created_at')).toBe(true);
      expect(columnMap.has('metadata')).toBe(true);

      // Check NOT NULL constraints
      expect(columnMap.get('source_stream_id')?.notnull).toBe(1);
      expect(columnMap.get('target_stream_id')?.notnull).toBe(1);
    });
  });
});
