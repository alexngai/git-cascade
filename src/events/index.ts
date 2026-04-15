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
  STREAM_CONFLICT_RESOLVED: 'stream.conflict_resolved',
  STREAM_ABANDONED: 'stream.abandoned',
  STREAM_PUSHED: 'stream.pushed',
  CASCADE_REBASED: 'cascade.rebased',
  CASCADE_COMPLETED: 'cascade.completed',
  QUEUE_ADDED: 'queue.added',
  QUEUE_READY: 'queue.ready',
  QUEUE_CANCELLED: 'queue.cancelled',
  QUEUE_REMOVED: 'queue.removed',
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
  STREAM_CONFLICT_RESOLVED: `${DEFAULT_CASCADE_PREFIX}/${CASCADE_METHOD_SUFFIXES.STREAM_CONFLICT_RESOLVED}`,
  STREAM_ABANDONED: `${DEFAULT_CASCADE_PREFIX}/${CASCADE_METHOD_SUFFIXES.STREAM_ABANDONED}`,
  STREAM_PUSHED: `${DEFAULT_CASCADE_PREFIX}/${CASCADE_METHOD_SUFFIXES.STREAM_PUSHED}`,
  CASCADE_REBASED: `${DEFAULT_CASCADE_PREFIX}/${CASCADE_METHOD_SUFFIXES.CASCADE_REBASED}`,
  CASCADE_COMPLETED: `${DEFAULT_CASCADE_PREFIX}/${CASCADE_METHOD_SUFFIXES.CASCADE_COMPLETED}`,
  QUEUE_ADDED: `${DEFAULT_CASCADE_PREFIX}/${CASCADE_METHOD_SUFFIXES.QUEUE_ADDED}`,
  QUEUE_READY: `${DEFAULT_CASCADE_PREFIX}/${CASCADE_METHOD_SUFFIXES.QUEUE_READY}`,
  QUEUE_CANCELLED: `${DEFAULT_CASCADE_PREFIX}/${CASCADE_METHOD_SUFFIXES.QUEUE_CANCELLED}`,
  QUEUE_REMOVED: `${DEFAULT_CASCADE_PREFIX}/${CASCADE_METHOD_SUFFIXES.QUEUE_REMOVED}`,
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
  STREAM_CONFLICT_RESOLVED: string;
  STREAM_ABANDONED: string;
  STREAM_PUSHED: string;
  CASCADE_REBASED: string;
  CASCADE_COMPLETED: string;
  QUEUE_ADDED: string;
  QUEUE_READY: string;
  QUEUE_CANCELLED: string;
  QUEUE_REMOVED: string;
} {
  return {
    STREAM_OPENED: `${prefix}/${CASCADE_METHOD_SUFFIXES.STREAM_OPENED}`,
    STREAM_COMMITTED: `${prefix}/${CASCADE_METHOD_SUFFIXES.STREAM_COMMITTED}`,
    STREAM_MERGED: `${prefix}/${CASCADE_METHOD_SUFFIXES.STREAM_MERGED}`,
    STREAM_CONFLICTED: `${prefix}/${CASCADE_METHOD_SUFFIXES.STREAM_CONFLICTED}`,
    STREAM_CONFLICT_RESOLVED: `${prefix}/${CASCADE_METHOD_SUFFIXES.STREAM_CONFLICT_RESOLVED}`,
    STREAM_ABANDONED: `${prefix}/${CASCADE_METHOD_SUFFIXES.STREAM_ABANDONED}`,
    STREAM_PUSHED: `${prefix}/${CASCADE_METHOD_SUFFIXES.STREAM_PUSHED}`,
    CASCADE_REBASED: `${prefix}/${CASCADE_METHOD_SUFFIXES.CASCADE_REBASED}`,
    CASCADE_COMPLETED: `${prefix}/${CASCADE_METHOD_SUFFIXES.CASCADE_COMPLETED}`,
    QUEUE_ADDED: `${prefix}/${CASCADE_METHOD_SUFFIXES.QUEUE_ADDED}`,
    QUEUE_READY: `${prefix}/${CASCADE_METHOD_SUFFIXES.QUEUE_READY}`,
    QUEUE_CANCELLED: `${prefix}/${CASCADE_METHOD_SUFFIXES.QUEUE_CANCELLED}`,
    QUEUE_REMOVED: `${prefix}/${CASCADE_METHOD_SUFFIXES.QUEUE_REMOVED}`,
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

/**
 * Fired when a stream's commits are pushed to a remote (trunk-style flows
 * via `direct-push` / `optimistic-push` landing strategies). Distinct from
 * `stream.merged` because the target isn't a tracked stream.
 */
export interface StreamPushedParams {
  /** Stream whose head was pushed */
  stream_id: string;
  /** Agent that did the push */
  agent_id: string;
  /** Commit hash at the head when push completed */
  pushed_commit: string;
  /** Remote name (typically 'origin') */
  remote: string;
  /** Remote ref pushed to (e.g., 'main', 'refs/heads/feature-x') */
  remote_ref: string;
  /** Strategy that drove the push ('direct-push' | 'optimistic-push' | etc.) */
  strategy?: string;
  /** Caller metadata */
  metadata?: EventMetadata;
}

export interface QueueEntryBase {
  /** Merge queue entry id */
  entry_id: string;
  /** Stream queued for merge */
  stream_id: string;
  /** Target branch for the merge (e.g., 'main') */
  target_branch: string;
  /** Caller metadata */
  metadata?: EventMetadata;
}

/** Fired when a stream is added to the merge queue. */
export type QueueAddedParams = QueueEntryBase;
/** Fired when a queued entry is marked ready to merge. */
export type QueueReadyParams = QueueEntryBase;
/** Fired when a queued entry is cancelled (operator decision). */
export type QueueCancelledParams = QueueEntryBase & { reason?: string };
/** Fired when a queued entry is removed (after merge or cleanup). */
export type QueueRemovedParams = QueueEntryBase & { outcome?: string };

export interface StreamConflictResolvedParams {
  /** Stream whose conflict was resolved */
  stream_id: string;
  /** Conflict record id that was resolved */
  conflict_id: string;
  /** How the conflict was resolved (ours/theirs/manual/agent/abandoned/auto-resolve/spawn-resolver) */
  resolution_method: string;
  /** Agent or human that performed the resolution */
  resolved_by?: string;
  /** Optional human-readable summary of what was resolved */
  resolution_summary?: string;
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

/**
 * A single commit produced by a cascade rebase operation. Shape is a subset
 * of StreamCommittedParams — the hub can record these via the same code path.
 */
export interface CascadeRebasedCommit {
  commit_hash: string;
  /** Change-Id trailer, if the commit carries one */
  change_id?: string;
  /** Parent commit */
  parent_commit: string;
  /** First line of commit message */
  message_summary: string;
  /** Files modified by this commit */
  files_touched: string[];
}

/**
 * Fired once per dependent stream successfully rebased by `cascadeRebase`.
 *
 * Replaces the Phase 0 gap where rebased commits weren't emitted as
 * stream.committed — cascade.rebased carries the new commits in a richer
 * shape with explicit "triggered_by" attribution, so consumers can
 * distinguish original commits from rebase-derived ones.
 */
export interface CascadeRebasedParams {
  /** Stream that was rebased */
  stream_id: string;
  /** Agent performing the cascade */
  agent_id: string;
  /** Root stream whose rebase triggered this cascade */
  triggered_by_stream_id: string;
  /** Agent who triggered the root rebase, if different from `agent_id` */
  triggered_by_agent_id?: string;
  /** New base commit after rebase */
  new_base_commit: string;
  /** New head commit after rebase */
  new_head: string;
  /** Commits produced by the rebase, in order */
  new_commits: CascadeRebasedCommit[];
  /** Caller metadata (threaded through CascadeRebaseOptions.metadata) */
  metadata?: EventMetadata;
}

/**
 * Fired once per `cascadeRebase` invocation, summarizing the outcome.
 *
 * Useful for hub-level observability (how many streams were updated, which
 * failed) and UI dashboards. Individual `cascade.rebased` events provide
 * the per-stream detail.
 */
export interface CascadeCompletedParams {
  /** Root stream whose rebase triggered the cascade */
  root_stream_id: string;
  /** Agent that triggered the cascade */
  agent_id: string;
  /** Strategy applied */
  strategy: 'stop_on_conflict' | 'skip_conflicting' | 'defer_conflicts';
  /** Streams rebased successfully */
  updated_streams: string[];
  /** Streams that failed (non-conflict errors) */
  failed_streams: Array<{ stream_id: string; reason: string }>;
  /** Streams skipped because an upstream dependency failed */
  skipped_streams: string[];
  /** Streams with deferred conflicts (defer_conflicts strategy) */
  deferred_streams?: string[];
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
  'stream.conflict_resolved': StreamConflictResolvedParams;
  'stream.abandoned': StreamAbandonedParams;
  'stream.pushed': StreamPushedParams;
  'cascade.rebased': CascadeRebasedParams;
  'cascade.completed': CascadeCompletedParams;
  'queue.added': QueueAddedParams;
  'queue.ready': QueueReadyParams;
  'queue.cancelled': QueueCancelledParams;
  'queue.removed': QueueRemovedParams;
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
  'x-cascade/stream.conflict_resolved': StreamConflictResolvedParams;
  'x-cascade/stream.abandoned': StreamAbandonedParams;
  'x-cascade/stream.pushed': StreamPushedParams;
  'x-cascade/cascade.rebased': CascadeRebasedParams;
  'x-cascade/cascade.completed': CascadeCompletedParams;
  'x-cascade/queue.added': QueueAddedParams;
  'x-cascade/queue.ready': QueueReadyParams;
  'x-cascade/queue.cancelled': QueueCancelledParams;
  'x-cascade/queue.removed': QueueRemovedParams;
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
