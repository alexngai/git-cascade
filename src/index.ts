/**
 * Dataplane - Multi-agent git tracking system.
 *
 * Coordination layer for multiple AI agents working concurrently
 * on a shared codebase.
 */

// Main tracker
export { MultiAgentRepoTracker, type TrackerOptions } from './tracker.js';

// Models
export * from './models/index.js';

// Database
export { createDatabase, closeDatabase } from './db/index.js';

// Git helpers
export * from './git/index.js';

// Stack operations (low-level API)
export * as stacks from './stacks.js';

// Dependency operations (low-level API)
export * as dependencies from './dependencies.js';

// Stream operations (low-level API)
export * as streams from './streams.js';

// Change tracking (low-level API)
export * as changes from './changes.js';

// Conflict tracking (low-level API)
export * as conflicts from './conflicts.js';

// Errors
export * from './errors.js';
