/**
 * Event hooks for git-cascade operations.
 *
 * git-cascade can optionally emit structured events when streams are opened,
 * commits are recorded, merges complete, conflicts are detected, or streams
 * are abandoned. Pass an `emit` callback to the tracker constructor to
 * receive them.
 *
 * ## Transport-agnostic
 *
 * git-cascade has no transport dependency. The `emit` callback is a plain
 * function — the caller decides how to forward events: log them, push them
 * to an event bus, forward them as JSON-RPC notifications, etc.
 *
 * ## MAP-compatible by design
 *
 * The default method names follow the MAP (Multi-Agent Protocol) vendor
 * extension convention: `x-cascade/stream.opened`, `x-cascade/stream.committed`,
 * and so on. Runtimes that embed git-cascade alongside a MAP connection can
 * forward emitted events verbatim as MAP notifications — no translation
 * needed. Hubs registering handlers under the same names consume them directly.
 *
 * The `x-` prefix signals "third-party vendor extension, not core MAP
 * protocol," which is the appropriate classification for a standalone
 * library defining its own schema.
 *
 * ## Configurable prefix
 *
 * The prefix defaults to `x-cascade` but can be overridden via
 * `TrackerOptions.eventPrefix`. This is useful for:
 *
 *   - Branded deployments (`x-mycompany-cascade/stream.opened`)
 *   - Isolating event namespaces in testing / debugging
 *   - Environments that disallow the `x-` prefix or require a different one
 *
 * The suffix portion (`stream.opened`, `stream.committed`, ...) is fixed —
 * only the prefix varies. Consumers narrowing on event type should match on
 * the suffix, not the full method string.
 *
 * ## Event ordering and delivery
 *
 * Events fire synchronously after the corresponding database write, before
 * the tracker method returns. They fire in operation order. Exceptions
 * thrown by the callback are caught and discarded — a misbehaving observer
 * cannot break cascade operations.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Prefix
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default prefix applied to every emitted method name.
 *
 * Follows the MAP vendor-extension convention (`x-<vendor>/<method>`).
 * Override via `TrackerOptions.eventPrefix`.
 */
export const DEFAULT_CASCADE_PREFIX = 'x-cascade';

// ─────────────────────────────────────────────────────────────────────────────
// Method suffixes (prefix-free, canonical)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical method suffixes. These never change — the prefix varies.
 *
 * Consumers narrowing on event type should match on the suffix via
 * `String.endsWith('stream.opened')` rather than the full method string.
 */
export const CASCADE_METHOD_SUFFIXES = {
  STREAM_OPENED: 'stream.opened',
  STREAM_COMMITTED: 'stream.committed',
  STREAM_MERGED: 'stream.merged',
  STREAM_CONFLICTED: 'stream.conflicted',
  STREAM_ABANDONED: 'stream.abandoned',
} as const;

export type CascadeMethodSuffix =
  (typeof CASCADE_METHOD_SUFFIXES)[keyof typeof CASCADE_METHOD_SUFFIXES];

export const CASCADE_METHOD_SUFFIX_SET: ReadonlySet<string> = new Set(
  Object.values(CASCADE_METHOD_SUFFIXES)
);

// ─────────────────────────────────────────────────────────────────────────────
// Full method names (with default prefix applied)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full method names with the default `x-cascade` prefix applied. Use these
 * when registering handlers or matching events from a tracker that uses the
 * default prefix. For custom prefixes, call `buildCascadeMethods(prefix)`.
 */
export const CASCADE_METHODS = {
  STREAM_OPENED: `${DEFAULT_CASCADE_PREFIX}/${CASCADE_METHOD_SUFFIXES.STREAM_OPENED}`,
  STREAM_COMMITTED: `${DEFAULT_CASCADE_PREFIX}/${CASCADE_METHOD_SUFFIXES.STREAM_COMMITTED}`,
  STREAM_MERGED: `${DEFAULT_CASCADE_PREFIX}/${CASCADE_METHOD_SUFFIXES.STREAM_MERGED}`,
  STREAM_CONFLICTED: `${DEFAULT_CASCADE_PREFIX}/${CASCADE_METHOD_SUFFIXES.STREAM_CONFLICTED}`,
  STREAM_ABANDONED: `${DEFAULT_CASCADE_PREFIX}/${CASCADE_METHOD_SUFFIXES.STREAM_ABANDONED}`,
} as const;

export type CascadeMethod = (typeof CASCADE_METHODS)[keyof typeof CASCADE_METHODS];

export const CASCADE_METHOD_SET: ReadonlySet<string> = new Set(
  Object.values(CASCADE_METHODS)
);

/**
 * Build a method-name map for a custom prefix.
 *
 * Returns the same shape as `CASCADE_METHODS` but with the given prefix.
 * Useful for hubs/runtimes that need to register handlers matching a
 * tracker configured with a non-default prefix.
 *
 * @example
 *   const methods = buildCascadeMethods('x-acme-cascade');
 *   // methods.STREAM_OPENED === 'x-acme-cascade/stream.opened'
 */
export function buildCascadeMethods(prefix: string): {
  STREAM_OPENED: string;
  STREAM_COMMITTED: string;
  STREAM_MERGED: string;
  STREAM_CONFLICTED: string;
  STREAM_ABANDONED: string;
} {
  return {
    STREAM_OPENED: `${prefix}/${CASCADE_METHOD_SUFFIXES.STREAM_OPENED}`,
    STREAM_COMMITTED: `${prefix}/${CASCADE_METHOD_SUFFIXES.STREAM_COMMITTED}`,
    STREAM_MERGED: `${prefix}/${CASCADE_METHOD_SUFFIXES.STREAM_MERGED}`,
    STREAM_CONFLICTED: `${prefix}/${CASCADE_METHOD_SUFFIXES.STREAM_CONFLICTED}`,
    STREAM_ABANDONED: `${prefix}/${CASCADE_METHOD_SUFFIXES.STREAM_ABANDONED}`,
  };
}

/**
 * Extract the suffix portion of a method string, or `null` if it doesn't
 * match any known cascade suffix.
 *
 * Useful for consumers that want to handle events regardless of the prefix
 * a tracker was configured with.
 *
 * @example
 *   matchCascadeSuffix('x-cascade/stream.opened') // 'stream.opened'
 *   matchCascadeSuffix('x-acme/stream.opened')    // 'stream.opened'
 *   matchCascadeSuffix('map/agents/register')     // null
 */
export function matchCascadeSuffix(method: string): CascadeMethodSuffix | null {
  for (const suffix of Object.values(CASCADE_METHOD_SUFFIXES)) {
    if (method.endsWith(`/${suffix}`) || method === suffix) {
      return suffix;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optional reference to an external task (e.g., an OpenTasks node) that this
 * stream/commit is doing work for. git-cascade does not interpret these
 * fields — they pass through to event consumers verbatim.
 */
export interface TaskRef {
  /** Identifier of the task resource (e.g., OpenTasks resource ID) */
  resource_id: string;
  /** Identifier of the task node within the resource */
  node_id: string;
}

/**
 * Free-form metadata attached to events. Supplied by the caller via
 * CreateStreamOptions.metadata or CommitChangesOptions.metadata. Common
 * conventions:
 *
 *   { task_ref?: TaskRef, trigger?: string, ... }
 */
export type EventMetadata = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Event payloads
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamOpenedParams {
  /** git-cascade stream id */
  stream_id: string;
  /** Human-readable stream name */
  name: string;
  /** Owning agent */
  agent_id: string;
  /** Commit the stream was based from */
  base_commit: string;
  /** Parent stream id, if forked */
  parent_stream?: string;
  /** Branch the stream maps to (stream/<id> or an existing tracked branch) */
  branch_name?: string;
  /** Whether the stream tracks an existing branch (local mode) */
  is_local_mode?: boolean;
  /** Caller metadata (e.g., { task_ref }) */
  metadata?: EventMetadata;
}

export interface StreamCommittedParams {
  /** Stream that received the commit */
  stream_id: string;
  /** Commit hash */
  commit_hash: string;
  /** Stable Change-Id (Gerrit-style trailer) for this logical change */
  change_id: string;
  /** Agent that authored the commit */
  agent_id: string;
  /** First line of commit message */
  message_summary: string;
  /** Files modified by this commit (git diff-tree --name-only) */
  files_touched: string[];
  /** Parent commit hash (best-effort; '4b825dc...' empty-tree for initial commit) */
  parent_commit: string;
  /** Caller metadata threaded through from CommitChangesOptions.metadata */
  metadata?: EventMetadata;
}

export interface StreamMergedParams {
  /** Stream that was merged from */
  source_stream_id: string;
  /** Stream that was merged into (or branch name when merging to a non-stream target) */
  target_stream_id: string;
  /** Resulting merge commit */
  merge_commit: string;
  /** Agent that performed the merge */
  agent_id: string;
  /** Strategy used (merge-commit, squash, rebase, task-merge) */
  strategy?: string;
  /** Source commit at the moment of merge (head of source stream / worker branch) */
  source_commit?: string;
  /** Caller metadata */
  metadata?: EventMetadata;
}

export interface StreamConflictedParams {
  /** Stream that became conflicted */
  stream_id: string;
  /** Conflict record id (cf-xxxxxxxx) when one was persisted */
  conflict_id?: string;
  /** Files in conflict */
  conflicted_files: string[];
  /** Agent that triggered the operation that produced the conflict */
  agent_id?: string;
  /** Commit being applied when the conflict occurred */
  conflicting_commit?: string;
  /** Commit being applied onto */
  target_commit?: string;
  /** Operation that caused the conflict (rebase, merge, sync, task-complete) */
  source?: string;
  /** Caller metadata */
  metadata?: EventMetadata;
}

export interface StreamAbandonedParams {
  /** Stream that was abandoned */
  stream_id: string;
  /** Reason supplied by the caller, if any */
  reason?: string;
  /** Whether the abandon cascaded to child streams */
  cascade?: boolean;
  /** Caller metadata */
  metadata?: EventMetadata;
}

// ─────────────────────────────────────────────────────────────────────────────
// Method → payload mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps canonical suffixes to their payload types. This is the prefix-free
 * type map — use it for narrowing regardless of what prefix a tracker was
 * configured with.
 */
export interface CascadeSuffixMap {
  'stream.opened': StreamOpenedParams;
  'stream.committed': StreamCommittedParams;
  'stream.merged': StreamMergedParams;
  'stream.conflicted': StreamConflictedParams;
  'stream.abandoned': StreamAbandonedParams;
}

/**
 * Maps default-prefixed method names to their payload types. Kept for
 * convenience when working with the default prefix; for custom prefixes,
 * use `CascadeSuffixMap` after calling `matchCascadeSuffix`.
 */
export interface CascadeMethodMap {
  'x-cascade/stream.opened': StreamOpenedParams;
  'x-cascade/stream.committed': StreamCommittedParams;
  'x-cascade/stream.merged': StreamMergedParams;
  'x-cascade/stream.conflicted': StreamConflictedParams;
  'x-cascade/stream.abandoned': StreamAbandonedParams;
}

// ─────────────────────────────────────────────────────────────────────────────
// Emitter callback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Callback invoked synchronously after a successful operation.
 *
 * The `method` string is the full prefixed method name as configured on the
 * tracker (default `x-cascade/*`). To narrow the params type, match on the
 * suffix via `matchCascadeSuffix(method)` and consult `CascadeSuffixMap`.
 *
 * Implementations should be fire-and-forget: never throw (the tracker
 * catches and discards exceptions), never block. Expensive synchronous
 * work in the callback will slow cascade operations.
 */
export type CascadeEmitter = (method: string, params: unknown) => void;
