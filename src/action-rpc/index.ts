/**
 * Action RPC schema for the cascade protocol — hub → sidecar command channel.
 *
 * The complement to the `x-cascade/stream.*` event vocabulary in `events/`:
 * where events flow runtime → hub ("here is what happened"), action requests
 * flow hub → runtime ("please do this"). The runtime executes the
 * corresponding git-cascade operation and a resulting `x-cascade/stream.*`
 * event flows back through the normal projection pipeline.
 *
 * Passive types only — no transport coupling, no runtime logic. Hubs and
 * sidecars both consume these types so the source-of-truth must be the
 * published package.
 *
 * ## Wire shape
 *
 * Each action is a JSON-RPC notification under the `x-cascade/request.`
 * prefix, sharing the `x-` vendor-extension convention with the event
 * vocabulary. The hub sends; the runtime executes; observability is
 * achieved by the resulting `x-cascade/stream.*` event, not by a response
 * to the request. This is a fire-and-forget intent channel, not an RPC.
 *
 * ## Why this lives in git-cascade
 *
 * Same reason as the events module and the diff RPC module: git-cascade
 * owns the entire `x-cascade` / `cascade/*` protocol schema namespace.
 * Hubs and sidecars share these shapes — they must come from the published
 * package, not either side of the conversation.
 *
 * ## Capability gating
 *
 * Participants advertise `cascade.canAct` (see `events/index.ts` ::
 * `CascadeCapability`) to indicate that they can receive and execute
 * actions. A hub should suppress action requests to participants that
 * declare `canAct: false` — otherwise the request silently no-ops.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Action names + method names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical action names. Each maps 1:1 to a method under the
 * `x-cascade/request.` prefix.
 */
export type CascadeAction =
  | 'merge'
  | 'abandon'
  | 'pause'
  | 'resume'
  | 'resolve'
  | 'push'
  | 'commit';

/**
 * Full method names for the cascade action RPC family. These are stable
 * wire constants — register handlers and match incoming methods against
 * these. Like the event methods they use the `x-cascade` vendor-extension
 * prefix.
 */
export const CASCADE_ACTION_METHODS: Record<CascadeAction, string> = {
  merge: 'x-cascade/request.merge',
  abandon: 'x-cascade/request.abandon',
  pause: 'x-cascade/request.pause',
  resume: 'x-cascade/request.resume',
  resolve: 'x-cascade/request.resolve',
  push: 'x-cascade/request.push',
  commit: 'x-cascade/request.commit',
};

export type CascadeActionMethod =
  (typeof CASCADE_ACTION_METHODS)[CascadeAction];

export const CASCADE_ACTION_METHOD_SET: ReadonlySet<string> = new Set(
  Object.values(CASCADE_ACTION_METHODS)
);

// ─────────────────────────────────────────────────────────────────────────────
// Param shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Field shared by every cascade action: the target cascade stream id.
 */
interface CascadeActionBase {
  /** The cascade stream_id (not a hub row id). */
  stream_id: string;
}

/**
 * Request a `mergeStream` on the runtime. When `target_stream_id` is omitted
 * the runtime merges into the source stream's parent.
 */
export interface CascadeActionMergeParams extends CascadeActionBase {
  /** Target stream to merge into. Omit to use the source stream's parent. */
  target_stream_id?: string;
  /** Optional metadata thread-through (e.g., `{ task_ref }`). */
  metadata?: Record<string, unknown>;
}

/**
 * Request a `abandonStream` on the runtime.
 */
export interface CascadeActionAbandonParams extends CascadeActionBase {
  /** Human-readable reason recorded in the resulting stream.abandoned event. */
  reason?: string;
}

/**
 * Request a `pauseStream` on the runtime.
 */
export interface CascadeActionPauseParams extends CascadeActionBase {
  /** Human-readable reason recorded in the resulting stream.paused event. */
  reason?: string;
}

/**
 * Request a `resumeStream` on the runtime.
 */
export interface CascadeActionResumeParams extends CascadeActionBase {}

/**
 * Request conflict resolution on the runtime. `strategy` is a hint to the
 * runtime — actual resolution policy is decided runtime-side.
 */
export interface CascadeActionResolveParams extends CascadeActionBase {
  /** Conflict record id (cf-xxxxxxxx) to resolve. */
  conflict_id?: string;
  /** Resolution strategy hint ('ours' | 'theirs' | 'manual' | …). */
  strategy?: string;
}

/**
 * Request a push of the stream's head to a remote.
 */
export interface CascadeActionPushParams extends CascadeActionBase {
  /** Remote name (default: 'origin'). */
  remote?: string;
  /** Target ref (default: `stream/<id>`). */
  target_ref?: string;
}

/**
 * Request a commit on the runtime — typically used by orchestrators driving
 * commits remotely. Runtime-side handlers may reject this if commits are
 * expected to come from local agents only.
 */
export interface CascadeActionCommitParams extends CascadeActionBase {
  /** Commit message. */
  message?: string;
  /** Optional metadata thread-through (e.g., `{ task_ref }`). */
  metadata?: Record<string, unknown>;
}

/**
 * Discriminated union over every action-param shape, keyed by the action
 * name. Useful for handler-table dispatch with compile-time narrowing.
 */
export interface CascadeActionParamsMap {
  merge: CascadeActionMergeParams;
  abandon: CascadeActionAbandonParams;
  pause: CascadeActionPauseParams;
  resume: CascadeActionResumeParams;
  resolve: CascadeActionResolveParams;
  push: CascadeActionPushParams;
  commit: CascadeActionCommitParams;
}

/**
 * Method-keyed param map. Mirrors `CascadeActionParamsMap` but indexes on
 * the full `x-cascade/request.*` method strings rather than the bare
 * action name.
 */
export interface CascadeActionMethodMap {
  'x-cascade/request.merge': CascadeActionMergeParams;
  'x-cascade/request.abandon': CascadeActionAbandonParams;
  'x-cascade/request.pause': CascadeActionPauseParams;
  'x-cascade/request.resume': CascadeActionResumeParams;
  'x-cascade/request.resolve': CascadeActionResolveParams;
  'x-cascade/request.push': CascadeActionPushParams;
  'x-cascade/request.commit': CascadeActionCommitParams;
}

/**
 * Union over every action-param shape. Useful when a single handler accepts
 * any action; combine with the method name to narrow.
 */
export type CascadeActionParams =
  | CascadeActionMergeParams
  | CascadeActionAbandonParams
  | CascadeActionPauseParams
  | CascadeActionResumeParams
  | CascadeActionResolveParams
  | CascadeActionPushParams
  | CascadeActionCommitParams;
