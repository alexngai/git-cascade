/**
 * Garbage collection configuration.
 *
 * Provides persistent configuration for GC behavior including
 * auto-archiving, retention periods, and cleanup options.
 */

import type Database from 'better-sqlite3';
import { getTables } from './db/tables.js';

/**
 * GC configuration options.
 */
export interface GCConfig {
  /** Archive streams automatically when merged (default: true) */
  autoArchiveOnMerge: boolean;
  /** Archive streams automatically when abandoned (default: true) */
  autoArchiveOnAbandon: boolean;
  /** Days to retain archived streams before pruning (default: 30) */
  archiveRetentionDays: number;
  /** Delete git branches during prune (default: true) */
  deleteGitBranches: boolean;
  /** Delete worktrees during prune (default: true) */
  deleteWorktrees: boolean;
  /** Run recovery on startup (default: true) */
  runRecoveryOnStartup: boolean;
}

/**
 * Default GC configuration values.
 */
const DEFAULT_CONFIG: GCConfig = {
  autoArchiveOnMerge: true,
  autoArchiveOnAbandon: true,
  archiveRetentionDays: 30,
  deleteGitBranches: true,
  deleteWorktrees: true,
  runRecoveryOnStartup: true,
};

/**
 * Config key to type mapping for serialization.
 */
type ConfigKey = keyof GCConfig;

/**
 * Serialize a config value to string for database storage.
 */
function serializeValue(key: ConfigKey, value: GCConfig[ConfigKey]): string {
  if (key === 'archiveRetentionDays') {
    return String(value);
  }
  // Boolean values
  return value ? 'true' : 'false';
}

/**
 * Deserialize a config value from database storage.
 */
function deserializeValue(key: ConfigKey, value: string): GCConfig[ConfigKey] {
  if (key === 'archiveRetentionDays') {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? DEFAULT_CONFIG[key] : parsed;
  }
  // Boolean values
  return value === 'true';
}

/**
 * Get the current GC configuration.
 *
 * Returns the stored configuration merged with defaults for any
 * keys that are not set in the database.
 *
 * @param db - Database connection
 * @returns The complete GC configuration
 */
export function getGCConfig(db: Database.Database): GCConfig {
  const t = getTables(db);

  // Start with defaults
  const config: GCConfig = { ...DEFAULT_CONFIG };

  // Query all config values from database
  const rows = db
    .prepare(`SELECT key, value FROM ${t.gc_config}`)
    .all() as Array<{ key: string; value: string }>;

  // Override defaults with stored values
  for (const row of rows) {
    const key = row.key as ConfigKey;
    if (key in DEFAULT_CONFIG) {
      // Type-safe assignment using key mapping
      switch (key) {
        case 'autoArchiveOnMerge':
          config.autoArchiveOnMerge = deserializeValue(key, row.value) as boolean;
          break;
        case 'autoArchiveOnAbandon':
          config.autoArchiveOnAbandon = deserializeValue(key, row.value) as boolean;
          break;
        case 'archiveRetentionDays':
          config.archiveRetentionDays = deserializeValue(key, row.value) as number;
          break;
        case 'deleteGitBranches':
          config.deleteGitBranches = deserializeValue(key, row.value) as boolean;
          break;
        case 'deleteWorktrees':
          config.deleteWorktrees = deserializeValue(key, row.value) as boolean;
          break;
        case 'runRecoveryOnStartup':
          config.runRecoveryOnStartup = deserializeValue(key, row.value) as boolean;
          break;
      }
    }
  }

  return config;
}

/**
 * Update GC configuration.
 *
 * Only updates the keys provided in the partial config. Other keys
 * retain their current values.
 *
 * @param db - Database connection
 * @param config - Partial configuration to update
 */
export function setGCConfig(
  db: Database.Database,
  config: Partial<GCConfig>
): void {
  const t = getTables(db);

  const upsert = db.prepare(`
    INSERT INTO ${t.gc_config} (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  // Update each provided key
  for (const [key, value] of Object.entries(config)) {
    if (key in DEFAULT_CONFIG && value !== undefined) {
      const serialized = serializeValue(
        key as ConfigKey,
        value as GCConfig[ConfigKey]
      );
      upsert.run(key, serialized);
    }
  }
}
