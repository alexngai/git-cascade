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

// Errors
export * from './errors.js';
