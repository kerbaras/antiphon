// Take comments (W2-F) — pure model + interim persistence.
//
// A comment is a timestamped note on the loaded take ("alto flat at 2:31"):
// `atSec` lives on the take's room timeline — the exact domain of
// player.position()/seek(), same as markers.atSec — and `streamId` optionally
// pins it to one lane's stream within the take (null = take-wide). Resolving
// is a field update (`resolvedAtMs`), never a delete: the note and its
// resolution history stay addressable.
//
// PERSISTENCE BOUNDARY (W3-A landed): the source of truth is the shared
// project doc — a Y.Array of plain TakeComment objects per takeId
// (net/collab-doc.ts, wired in use-desk.ts). Exactly as documented, ONLY
// the load/save layer changed: the pure model above this line is
// untouched. Resolve/unresolve/edit replace the array element with the
// same uuid — simple and convergent at this scale (concurrent edits of the
// SAME comment can briefly duplicate the stored element; the doc read path
// dedupes and opportunistically heals — F16, see collab-doc.ts; adds/
// removes/edits of different comments merge cleanly). loadComments/
// saveComments remain as the doc's localStorage SHADOW — seed source,
// offline display fallback, and cheap insurance on every change.

import { dedupeById } from "../../net/collab-doc";

export interface TakeComment {
  /** Stable identity — resolve/edit/delete target, survives re-sorting. */
  id: string;
  /** Seconds on the take's room timeline (player.position() domain). */
  atSec: number;
  /** Pinned lane stream within the take; null = take-wide. */
  streamId: string | null;
  text: string;
  /** Free label ("Desk", the conductor's name, …). */
  author: string;
  createdAtMs: number;
  /** null = open; a timestamp marks it done (unresolve nulls it again). */
  resolvedAtMs: number | null;
}

export const MAX_COMMENT_TEXT = 500;
export const MAX_COMMENT_AUTHOR = 40;
export const DEFAULT_COMMENT_AUTHOR = "Desk";

/** Timeline order: by position, creation then id as deterministic tie-breaks
 * (two notes on one spot read in the order they were written). */
export function sortComments(comments: readonly TakeComment[]): TakeComment[] {
  return [...comments].sort(
    (a, b) => a.atSec - b.atSec || a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id),
  );
}

export interface NewComment {
  atSec: number;
  text: string;
  author: string;
  streamId: string | null;
}

/** Add a comment (atSec clamped to ≥ 0, text/author trimmed and bounded).
 * Returns the new sorted list and the comment, or `added: null` (list
 * unchanged) when the trimmed text is empty. */
export function addComment(
  comments: readonly TakeComment[],
  input: NewComment,
  nowMs = Date.now(),
): { comments: TakeComment[]; added: TakeComment | null } {
  const text = input.text.trim().slice(0, MAX_COMMENT_TEXT);
  if (!text) return { comments: sortComments(comments), added: null };
  const added: TakeComment = {
    id: crypto.randomUUID(),
    atSec: Math.max(0, input.atSec),
    streamId: input.streamId,
    text,
    author: input.author.trim().slice(0, MAX_COMMENT_AUTHOR) || DEFAULT_COMMENT_AUTHOR,
    createdAtMs: nowMs,
    resolvedAtMs: null,
  };
  return { comments: sortComments([...comments, added]), added };
}

/** Edit a comment's text (trimmed; an empty result keeps the old text). */
export function editCommentText(
  comments: readonly TakeComment[],
  id: string,
  text: string,
): TakeComment[] {
  const next = text.trim().slice(0, MAX_COMMENT_TEXT);
  return comments.map((c) => (c.id === id && next ? { ...c, text: next } : c));
}

export function resolveComment(
  comments: readonly TakeComment[],
  id: string,
  nowMs = Date.now(),
): TakeComment[] {
  return comments.map((c) =>
    c.id === id && c.resolvedAtMs === null ? { ...c, resolvedAtMs: nowMs } : c,
  );
}

export function unresolveComment(comments: readonly TakeComment[], id: string): TakeComment[] {
  return comments.map((c) => (c.id === id ? { ...c, resolvedAtMs: null } : c));
}

export function removeComment(comments: readonly TakeComment[], id: string): TakeComment[] {
  return comments.filter((c) => c.id !== id);
}

export function openCommentCount(comments: readonly TakeComment[]): number {
  return comments.filter((c) => c.resolvedAtMs === null).length;
}

// ---- persistence (doc shadow — see the W3-A boundary note up top) -------------

const SCHEMA_VERSION = 1;

interface CommentDoc {
  v: number;
  comments: TakeComment[];
}

type KVStore = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): KVStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // private mode / storage disabled: comments become per-load
  }
}

export function commentsKey(sessionId: string, takeId: string): string {
  return `antiphon:comments:${sessionId}:${takeId}`;
}

/** Load a take's comments. Malformed JSON, unknown schema versions and
 * invalid entries all degrade to "no comments" — never a throw: a comment
 * store must not be able to take the desk down. */
export function loadComments(
  sessionId: string,
  takeId: string,
  store: KVStore | null = defaultStore(),
): TakeComment[] {
  let raw: string | null = null;
  try {
    raw = store?.getItem(commentsKey(sessionId, takeId)) ?? null;
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const doc = JSON.parse(raw) as Partial<CommentDoc> | null;
    if (doc?.v !== SCHEMA_VERSION || !Array.isArray(doc.comments)) return [];
    const valid = doc.comments.filter(
      (c): c is TakeComment =>
        typeof c === "object" &&
        c !== null &&
        typeof c.id === "string" &&
        c.id.length > 0 &&
        typeof c.atSec === "number" &&
        Number.isFinite(c.atSec) &&
        c.atSec >= 0 &&
        (c.streamId === null || typeof c.streamId === "string") &&
        typeof c.text === "string" &&
        c.text.length > 0 &&
        typeof c.author === "string" &&
        typeof c.createdAtMs === "number" &&
        Number.isFinite(c.createdAtMs) &&
        (c.resolvedAtMs === null ||
          (typeof c.resolvedAtMs === "number" && Number.isFinite(c.resolvedAtMs))),
    );
    // Same-id entries (an F16-era shadow snapshot) collapse to the last
    // occurrence — the same winner rule as the doc read path, and this
    // list may seed the doc.
    return sortComments(
      dedupeById(valid).map((c) => ({
        id: c.id,
        atSec: c.atSec,
        streamId: c.streamId,
        text: c.text,
        author: c.author,
        createdAtMs: c.createdAtMs,
        resolvedAtMs: c.resolvedAtMs,
      })),
    );
  } catch {
    return [];
  }
}

export function saveComments(
  sessionId: string,
  takeId: string,
  comments: readonly TakeComment[],
  store: KVStore | null = defaultStore(),
): void {
  const doc: CommentDoc = { v: SCHEMA_VERSION, comments: sortComments(comments) };
  try {
    store?.setItem(commentsKey(sessionId, takeId), JSON.stringify(doc));
  } catch {
    // quota / private mode: the in-memory state still serves this page load
  }
}

// ---- author preference --------------------------------------------------------
// One free-text label per browser (the operator's name), not per session:
// the same person runs the desk across sessions.

export const AUTHOR_PREF_KEY = "antiphon:comment-author";

export function loadAuthorPref(store: KVStore | null = defaultStore()): string {
  try {
    const raw = store?.getItem(AUTHOR_PREF_KEY)?.trim();
    return raw?.slice(0, MAX_COMMENT_AUTHOR) || DEFAULT_COMMENT_AUTHOR;
  } catch {
    return DEFAULT_COMMENT_AUTHOR;
  }
}

export function saveAuthorPref(author: string, store: KVStore | null = defaultStore()): void {
  try {
    store?.setItem(AUTHOR_PREF_KEY, author.trim().slice(0, MAX_COMMENT_AUTHOR));
  } catch {
    // quota / private mode: the pref just won't stick
  }
}
