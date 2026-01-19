/**
 * Database migration utilities for dataplane.
 *
 * Follows the same pattern as sudocode's migration system for consistency.
 * Migrations are tracked separately with prefix support.
 */

import type Database from "better-sqlite3";

export interface DataplaneMigration {
  version: number;
  name: string;
  up: (db: Database.Database, prefix: string) => void;
  down?: (db: Database.Database, prefix: string) => void;
}

/**
 * All dataplane migrations in order.
 *
 * Note: The base schema is created by initializeSchema() in database.ts.
 * These migrations handle schema changes after initial setup.
 */
const MIGRATIONS: DataplaneMigration[] = [
  {
    version: 1,
    name: "add-branch-point-commit",
    up: (db: Database.Database, prefix: string) => {
      // Check if branch_point_commit column exists
      const columns = db.pragma(`table_info(${prefix}streams)`) as Array<{
        name: string;
      }>;
      const hasBranchPointCommit = columns.some(
        (col) => col.name === "branch_point_commit"
      );

      if (hasBranchPointCommit) {
        // Already migrated
        return;
      }

      // Check if streams table exists
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='${prefix}streams'`
        )
        .all() as Array<{ name: string }>;

      if (tables.length === 0) {
        // Table doesn't exist yet, will be created with new schema
        return;
      }

      // Add branch_point_commit column for DAG tracking
      db.exec(
        `ALTER TABLE ${prefix}streams ADD COLUMN branch_point_commit TEXT`
      );

      console.log(
        `  ✓ Added branch_point_commit column to ${prefix}streams table`
      );
    },
    down: (_db: Database.Database, _prefix: string) => {
      // SQLite doesn't support DROP COLUMN directly in older versions
      console.log(
        `  Note: branch_point_commit column cannot be removed (SQLite limitation)`
      );
    },
  },
  {
    version: 2,
    name: "add-stream-merges-table",
    up: (db: Database.Database, prefix: string) => {
      // Check if stream_merges table already exists
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='${prefix}stream_merges'`
        )
        .all() as Array<{ name: string }>;

      if (tables.length > 0) {
        // Already migrated
        return;
      }

      // Create stream_merges table for DAG merge event tracking
      db.exec(`
        CREATE TABLE ${prefix}stream_merges (
          id TEXT PRIMARY KEY,
          source_stream_id TEXT NOT NULL,
          source_commit TEXT NOT NULL,
          target_stream_id TEXT NOT NULL,
          merge_commit TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (source_stream_id) REFERENCES ${prefix}streams(id),
          FOREIGN KEY (target_stream_id) REFERENCES ${prefix}streams(id)
        );
      `);

      // Create indexes for efficient queries
      db.exec(`
        CREATE INDEX IF NOT EXISTS ${prefix}idx_stream_merges_source ON ${prefix}stream_merges(source_stream_id);
        CREATE INDEX IF NOT EXISTS ${prefix}idx_stream_merges_target ON ${prefix}stream_merges(target_stream_id);
      `);

      console.log(
        `  ✓ Created ${prefix}stream_merges table for DAG merge tracking`
      );
    },
    down: (db: Database.Database, prefix: string) => {
      db.exec(`DROP TABLE IF EXISTS ${prefix}stream_merges;`);
      console.log(`  ✓ Dropped ${prefix}stream_merges table`);
    },
  },
  {
    version: 3,
    name: "add-checkpoints-and-diff-stacks",
    up: (db: Database.Database, prefix: string) => {
      // Check if checkpoints table already exists
      const checkpointsTables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='${prefix}checkpoints'`
        )
        .all() as Array<{ name: string }>;

      if (checkpointsTables.length === 0) {
        // Create checkpoints table - raw commit snapshots with minimal state
        db.exec(`
          CREATE TABLE ${prefix}checkpoints (
            id TEXT PRIMARY KEY,
            stream_id TEXT NOT NULL,
            commit_sha TEXT NOT NULL,
            parent_commit TEXT,
            original_commit TEXT,
            change_id TEXT,
            message TEXT,
            created_at INTEGER NOT NULL,
            created_by TEXT,
            FOREIGN KEY (stream_id) REFERENCES ${prefix}streams(id),
            UNIQUE(stream_id, commit_sha)
          );
        `);

        // Create indexes for checkpoints
        db.exec(`
          CREATE INDEX IF NOT EXISTS ${prefix}idx_checkpoints_stream ON ${prefix}checkpoints(stream_id);
          CREATE INDEX IF NOT EXISTS ${prefix}idx_checkpoints_change_id ON ${prefix}checkpoints(change_id);
        `);

        console.log(`  ✓ Created ${prefix}checkpoints table`);
      }

      // Check if diff_stacks table already exists
      const diffStacksTables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='${prefix}diff_stacks'`
        )
        .all() as Array<{ name: string }>;

      if (diffStacksTables.length === 0) {
        // Create diff_stacks table - reviewable/mergeable units
        db.exec(`
          CREATE TABLE ${prefix}diff_stacks (
            id TEXT PRIMARY KEY,
            name TEXT,
            description TEXT,
            target_branch TEXT NOT NULL DEFAULT 'main',
            review_status TEXT NOT NULL DEFAULT 'pending',
            reviewed_by TEXT,
            reviewed_at INTEGER,
            review_notes TEXT,
            queue_position INTEGER,
            created_at INTEGER NOT NULL,
            created_by TEXT
          );
        `);

        // Create indexes for diff_stacks
        db.exec(`
          CREATE INDEX IF NOT EXISTS ${prefix}idx_diff_stacks_status ON ${prefix}diff_stacks(review_status);
          CREATE INDEX IF NOT EXISTS ${prefix}idx_diff_stacks_queue ON ${prefix}diff_stacks(target_branch, queue_position)
            WHERE queue_position IS NOT NULL;
        `);

        console.log(`  ✓ Created ${prefix}diff_stacks table`);
      }

      // Check if diff_stack_entries table already exists
      const entriesTables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='${prefix}diff_stack_entries'`
        )
        .all() as Array<{ name: string }>;

      if (entriesTables.length === 0) {
        // Create diff_stack_entries table - checkpoint grouping (many-to-many)
        db.exec(`
          CREATE TABLE ${prefix}diff_stack_entries (
            id TEXT PRIMARY KEY,
            stack_id TEXT NOT NULL,
            checkpoint_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            FOREIGN KEY (stack_id) REFERENCES ${prefix}diff_stacks(id) ON DELETE CASCADE,
            FOREIGN KEY (checkpoint_id) REFERENCES ${prefix}checkpoints(id),
            UNIQUE(stack_id, checkpoint_id)
          );
        `);

        // Create indexes for diff_stack_entries
        db.exec(`
          CREATE INDEX IF NOT EXISTS ${prefix}idx_stack_entries_stack_id ON ${prefix}diff_stack_entries(stack_id);
          CREATE INDEX IF NOT EXISTS ${prefix}idx_stack_entries_checkpoint_id ON ${prefix}diff_stack_entries(checkpoint_id);
        `);

        console.log(`  ✓ Created ${prefix}diff_stack_entries table`);
      }

      console.log(`  ✓ Completed checkpoint and diff stack schema migration`);
    },
    down: (db: Database.Database, prefix: string) => {
      db.exec(`DROP TABLE IF EXISTS ${prefix}diff_stack_entries;`);
      db.exec(`DROP TABLE IF EXISTS ${prefix}diff_stacks;`);
      db.exec(`DROP TABLE IF EXISTS ${prefix}checkpoints;`);
      console.log(
        `  ✓ Dropped checkpoints, diff_stacks, and diff_stack_entries tables`
      );
    },
  },
];

/**
 * Get migration table name with prefix.
 */
function getMigrationTableName(prefix: string): string {
  return `${prefix}dataplane_migrations`;
}

/**
 * Get the current migration version from the database.
 */
export function getCurrentDataplaneMigrationVersion(
  db: Database.Database,
  prefix: string = ""
): number {
  const tableName = getMigrationTableName(prefix);

  // Create migrations table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const stmt = db.prepare(`SELECT MAX(version) as version FROM ${tableName}`);
  const result = stmt.get() as { version: number | null };
  return result.version ?? 0;
}

/**
 * Record a migration as applied.
 */
export function recordDataplaneMigration(
  db: Database.Database,
  migration: DataplaneMigration,
  prefix: string = ""
): void {
  const tableName = getMigrationTableName(prefix);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ${tableName} (version, name, applied_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(migration.version, migration.name, Date.now());
}

/**
 * Run all pending dataplane migrations.
 *
 * @param db - Database connection
 * @param prefix - Table name prefix (e.g., 'dp_' when sharing sudocode's database)
 * @returns Number of migrations applied
 */
export function runDataplaneMigrations(
  db: Database.Database,
  prefix: string = ""
): number {
  const currentVersion = getCurrentDataplaneMigrationVersion(db, prefix);

  const pendingMigrations = MIGRATIONS.filter(
    (m) => m.version > currentVersion
  );

  if (pendingMigrations.length === 0) {
    return 0;
  }

  console.log(
    `Running ${pendingMigrations.length} pending dataplane migration(s)...`
  );

  for (const migration of pendingMigrations) {
    console.log(
      `  Applying dataplane migration ${migration.version}: ${migration.name}`
    );
    try {
      migration.up(db, prefix);
      recordDataplaneMigration(db, migration, prefix);
      console.log(
        `  ✓ Dataplane migration ${migration.version} applied successfully`
      );
    } catch (error) {
      console.error(
        `  ✗ Dataplane migration ${migration.version} failed:`,
        error
      );
      throw error;
    }
  }

  return pendingMigrations.length;
}

/**
 * Rollback the last migration.
 *
 * @param db - Database connection
 * @param prefix - Table name prefix
 * @returns true if a migration was rolled back, false if none to rollback
 */
export function rollbackDataplaneMigration(
  db: Database.Database,
  prefix: string = ""
): boolean {
  const currentVersion = getCurrentDataplaneMigrationVersion(db, prefix);

  if (currentVersion === 0) {
    console.log("No migrations to rollback");
    return false;
  }

  const migration = MIGRATIONS.find((m) => m.version === currentVersion);
  if (!migration) {
    console.error(`Migration version ${currentVersion} not found`);
    return false;
  }

  if (!migration.down) {
    console.error(`Migration ${migration.name} does not have a down function`);
    return false;
  }

  console.log(
    `Rolling back dataplane migration ${migration.version}: ${migration.name}`
  );

  try {
    migration.down(db, prefix);

    const tableName = getMigrationTableName(prefix);
    db.prepare(`DELETE FROM ${tableName} WHERE version = ?`).run(
      migration.version
    );

    console.log(
      `  ✓ Dataplane migration ${migration.version} rolled back successfully`
    );
    return true;
  } catch (error) {
    console.error(
      `  ✗ Rollback of dataplane migration ${migration.version} failed:`,
      error
    );
    throw error;
  }
}

/**
 * Get all available migrations.
 */
export function getDataplaneMigrations(): readonly DataplaneMigration[] {
  return MIGRATIONS;
}

/**
 * Get the latest migration version available.
 */
export function getLatestDataplaneMigrationVersion(): number {
  return MIGRATIONS.length > 0
    ? Math.max(...MIGRATIONS.map((m) => m.version))
    : 0;
}
