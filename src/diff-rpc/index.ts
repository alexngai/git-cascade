/**
 * Diff RPC schema for the cascade protocol — hub ↔ sidecar unified diff fetch.
 *
 * git-cascade is the schema-namespace owner for the entire `x-cascade` /
 * `cascade/*` protocol family. This module defines the wire shapes that
 * coordination hubs use to fetch on-demand unified diffs from runtimes
 * embedding git-cascade — passive types only, no transport, no runtime logic.
 *
 * ## Wire protocol
 *
 *   1. Hub sends `cascade/diff.request` as a JSON-RPC notification, carrying
 *      a `request_id` to correlate the response.
 *   2. Runtime answers with one `cascade/diff.response` notification — either
 *      inline (`streaming: false`) for blobs ≤ 512 KB raw, or streaming
 *      (`streaming: true`) with a `chunk_stream_id` for larger payloads. An
 *      error variant carries `{ request_id, error: { code, message } }`.
 *   3. For streaming responses, N `cascade/diff.chunk` notifications follow,
 *      each carrying base64-encoded data, ordered by `seq`, terminated by
 *      `final: true` + `sha256`.
 *
 * ## Why this lives in git-cascade
 *
 * Same reason `CascadeCapability` and the `x-cascade/*` event vocabulary live
 * here: git-cascade owns the protocol's schema namespace. Hubs and sidecars
 * both consume these types so the source-of-truth must be the published
 * package, not either side of the conversation.
 *
 * ## Method-name prefix
 *
 * Unlike the events module, diff RPC methods use the fixed `cascade/` prefix
 * (no `x-`). This matches the existing wire deployments: trajectory-style
 * content fetch methods (`trajectory/content.*`) and the cascade diff family
 * (`cascade/diff.*`) both use a bare namespace prefix rather than the
 * vendor-extension `x-` prefix the events use. The methods are stable
 * constants — no prefix builder is exported.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Method names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full method names for the cascade diff RPC family. These are stable wire
 * constants — register handlers and match incoming methods against these.
 */
export const CASCADE_DIFF_METHODS = {
  REQUEST: 'cascade/diff.request',
  RESPONSE: 'cascade/diff.response',
  CHUNK: 'cascade/diff.chunk',
} as const;

export type CascadeDiffMethod =
  (typeof CASCADE_DIFF_METHODS)[keyof typeof CASCADE_DIFF_METHODS];

export const CASCADE_DIFF_METHOD_SET: ReadonlySet<string> = new Set(
  Object.values(CASCADE_DIFF_METHODS)
);

// ─────────────────────────────────────────────────────────────────────────────
// Tuning constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw-byte threshold for inline vs streamed responses. ≤ this size, the
 * sidecar packs the diff into a single `cascade/diff.response` notification.
 * Mirrors the trajectory protocol's inline threshold.
 */
export const DIFF_INLINE_THRESHOLD_BYTES = 512 * 1024;

/** Per-chunk size when streaming. Matches the trajectory protocol. */
export const DIFF_CHUNK_SIZE_BYTES = 1024 * 1024;

/**
 * Hub-side wait for the initial `cascade/diff.response`. Bumped relative to
 * the trajectory protocol because git can be slow on cold worktrees + large
 * diffs.
 */
export const DIFF_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Hard cap on raw diff output produced by the sidecar. Above this, the
 * sidecar truncates and sets `truncated: true`.
 */
export const DIFF_MAX_RAW_BYTES = 50 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Request (hub → sidecar)
// ─────────────────────────────────────────────────────────────────────────────

export interface CascadeDiffRequestParams {
  request_id: string;
  stream_id: string;
  /** Head commit SHA. Required. */
  head: string;
  /**
   * Base SHA — defines the diff range `base..head`. Omit for a single-commit
   * diff (sidecar uses `git show`, i.e. `head^..head`).
   */
  base?: string;
  /** Restrict to these paths. Omit for the full commit/range. */
  file_paths?: string[];
  /**
   * When true, sidecar runs `git diff --name-only` (or `git show`-style
   * name-only) and returns just `files_touched`. Skips the blob entirely.
   * Resolvers should also bypass any diff cache when this is set —
   * name-only is cheap.
   */
  files_only?: boolean;
  /** Diff format. Only 'unified' is defined; reserved for future formats. */
  format: 'unified';
}

// ─────────────────────────────────────────────────────────────────────────────
// Response (sidecar → hub)
// ─────────────────────────────────────────────────────────────────────────────

interface DiffResponseBase {
  request_id: string;
  files_touched: string[];
}

export interface CascadeDiffInlineResponse extends DiffResponseBase {
  streaming: false;
  /** Unified diff text. Empty string when `files_only: true`. */
  diff: string;
  truncated: boolean;
}

export interface CascadeDiffStreamingResponse extends DiffResponseBase {
  streaming: true;
  chunk_stream_id: string;
  total_size: number;
  /** truncated reported on the final chunk for streamed responses. */
}

/**
 * Error path on the same wire method, mirroring the trajectory content
 * protocol. Sidecars emit this when they cannot produce a diff (missing
 * worktree, git shell-out failed, bad input). `files_touched` is omitted
 * on this shape.
 */
export interface CascadeDiffErrorResponse {
  request_id: string;
  error: { code: DiffErrorCode; message: string };
}

export type CascadeDiffResponseParams =
  | CascadeDiffInlineResponse
  | CascadeDiffStreamingResponse
  | CascadeDiffErrorResponse;

// ─────────────────────────────────────────────────────────────────────────────
// Chunk (sidecar → hub, post-streaming-response)
// ─────────────────────────────────────────────────────────────────────────────

export interface CascadeDiffChunkParams {
  chunk_stream_id: string;
  seq: number;
  /** Base64-encoded raw bytes for this chunk. */
  data: string;
  /** True on the last chunk in the stream. */
  final?: boolean;
  /** Hex-encoded sha256 of the full assembled blob. Present iff `final`. */
  sha256?: string;
  /** True if the sidecar hit `DIFF_MAX_RAW_BYTES`. Present iff `final`. */
  truncated?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver-level payload + error union (hub-side helper shapes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a hub-side diff resolver returns on success. `truncated` mirrors the
 * sidecar's truncation flag (raw-byte cap exceeded). When the caller asked
 * for `files_only`, `diff` is the empty string and `truncated` is false.
 *
 * Exposed alongside the wire types so hubs (or other consumers building on
 * the same vocabulary) can share the return shape without redeclaring it.
 */
export interface DiffPayload {
  diff: string;
  files_touched: string[];
  truncated: boolean;
}

export type DiffErrorCode =
  | 'swarm_offline'
  | 'capability_missing'
  | 'timeout'
  | 'integrity_failed'
  | 'not_found'
  | 'bad_request'
  | 'internal';

export interface DiffError {
  code: DiffErrorCode;
  message: string;
}

export type DiffResult =
  | { ok: true; payload: DiffPayload }
  | { ok: false; error: DiffError };

// ─────────────────────────────────────────────────────────────────────────────
// Type guards
// ─────────────────────────────────────────────────────────────────────────────

export function isErrorResponse(
  r: CascadeDiffResponseParams
): r is CascadeDiffErrorResponse {
  return 'error' in r && r.error != null;
}

export function isStreamingResponse(
  r: CascadeDiffResponseParams
): r is CascadeDiffStreamingResponse {
  return !isErrorResponse(r) && (r as CascadeDiffStreamingResponse).streaming === true;
}

export function isInlineResponse(
  r: CascadeDiffResponseParams
): r is CascadeDiffInlineResponse {
  return !isErrorResponse(r) && (r as CascadeDiffInlineResponse).streaming === false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Method → payload mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps cascade diff RPC method names to their payload types. Useful for
 * handler-table dispatch with compile-time narrowing.
 */
export interface CascadeDiffMethodMap {
  'cascade/diff.request': CascadeDiffRequestParams;
  'cascade/diff.response': CascadeDiffResponseParams;
  'cascade/diff.chunk': CascadeDiffChunkParams;
}
