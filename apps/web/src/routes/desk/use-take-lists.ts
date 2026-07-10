// Per-take markers/comments through the shared project doc. localStorage
// stays as SHADOW persistence: it seeds the doc once per take, serves as
// the display fallback while the doc has no entry, and is rewritten on
// every change — remote edits included — as cheap offline insurance.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  displayTakeList,
  hasTakeList,
  type ListKind,
  seedTakeListOnce,
  writeTakeList,
} from "../../net/collab-doc";
import {
  addComment,
  editCommentText,
  loadComments,
  type NewComment,
  openCommentCount,
  removeComment,
  resolveComment,
  saveComments,
  sortComments,
  type TakeComment,
  unresolveComment,
} from "./comments";
import { getDeskCollab } from "./desk-state";
import {
  addMarker,
  loadMarkers,
  type Marker,
  removeMarker,
  renameMarker,
  saveMarkers,
  sortMarkers,
} from "./markers";

function useCollabTakeList<T extends { id: string }>(
  sessionId: string,
  takeId: string | null,
  kind: ListKind,
  loadLocal: (sessionId: string, takeId: string) => T[],
  saveLocal: (sessionId: string, takeId: string, items: readonly T[]) => void,
  sort: (items: readonly T[]) => T[],
): { items: T[]; commit: (next: readonly T[]) => void } {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    if (!takeId) {
      setItems([]);
      return;
    }
    const collab = getDeskCollab(sessionId);
    const refresh = () => {
      const list = sort(displayTakeList<T>(collab.doc, kind, takeId, loadLocal(sessionId, takeId)));
      setItems(list);
      if (hasTakeList(collab.doc, kind, takeId)) saveLocal(sessionId, takeId, list);
    };
    refresh();
    // Seed-once: after the first sync (immediately when already synced;
    // never while offline — the fallback covers), migrate the local
    // snapshot of a take the doc doesn't know. The doc-level seeded flag
    // keeps a second desk with the same localStorage from duplicating.
    const unSynced = collab.onSynced(() => {
      if (seedTakeListOnce(collab.doc, kind, takeId, loadLocal(sessionId, takeId), collab.origin)) {
        refresh();
      }
    });
    const map = collab.doc.getMap(kind);
    const observer = () => refresh();
    map.observeDeep(observer);
    return () => {
      unSynced();
      map.unobserveDeep(observer);
    };
  }, [sessionId, takeId, kind, loadLocal, saveLocal, sort]);

  const ref = useRef({ sessionId, takeId });
  ref.current = { sessionId, takeId };
  const commit = useCallback(
    (next: readonly T[]) => {
      const { sessionId: sid, takeId: tid } = ref.current;
      if (!tid) return;
      const collab = getDeskCollab(sid);
      // First edit while the doc lacks the take migrates the whole
      // fallback list (callers derive `next` from the displayed items).
      writeTakeList(collab.doc, kind, tid, next, collab.origin);
      saveLocal(sid, tid, next); // shadow write (observer also refreshes state)
    },
    [kind, saveLocal],
  );

  return { items, commit };
}

export interface TakeMarkersApi {
  /** Timeline-sorted markers of the current take ([] when none selected). */
  markers: Marker[];
  /** Add at a take-timeline position; null when the spot is taken. */
  addAt(atSec: number): Marker | null;
  rename(id: string, name: string): void;
  remove(id: string): void;
}

/** The selected take's song markers through the shared project doc,
 * localStorage as seed/fallback/shadow. Mutation callbacks are
 * identity-stable: safe in effect deps. */
export function useTakeMarkers(sessionId: string, takeId: string | null): TakeMarkersApi {
  const { items: markers, commit } = useCollabTakeList<Marker>(
    sessionId,
    takeId,
    "markers",
    loadMarkers,
    saveMarkers,
    sortMarkers,
  );

  const ref = useRef({ takeId, markers });
  ref.current = { takeId, markers };

  const addAt = useCallback(
    (atSec: number): Marker | null => {
      if (!ref.current.takeId) return null;
      const { markers: next, added } = addMarker(ref.current.markers, atSec);
      if (added) commit(next);
      return added;
    },
    [commit],
  );
  const rename = useCallback(
    (id: string, name: string) => commit(renameMarker(ref.current.markers, id, name)),
    [commit],
  );
  const remove = useCallback(
    (id: string) => commit(removeMarker(ref.current.markers, id)),
    [commit],
  );

  return { markers, addAt, rename, remove };
}

export interface TakeCommentsApi {
  /** Timeline-sorted comments of the current take ([] when none selected). */
  comments: TakeComment[];
  /** Comments not yet marked done (the panel-tab badge count). */
  openCount: number;
  /** Add a comment; null when the trimmed text is empty. */
  add(input: NewComment): TakeComment | null;
  editText(id: string, text: string): void;
  resolve(id: string): void;
  unresolve(id: string): void;
  remove(id: string): void;
}

/** The selected take's comments through the shared project doc,
 * localStorage as seed/fallback/shadow. Mutation callbacks are
 * identity-stable: safe in effect deps. */
export function useTakeComments(sessionId: string, takeId: string | null): TakeCommentsApi {
  const { items: comments, commit } = useCollabTakeList<TakeComment>(
    sessionId,
    takeId,
    "comments",
    loadComments,
    saveComments,
    sortComments,
  );

  const ref = useRef({ takeId, comments });
  ref.current = { takeId, comments };

  const add = useCallback(
    (input: NewComment): TakeComment | null => {
      if (!ref.current.takeId) return null;
      const { comments: next, added } = addComment(ref.current.comments, input);
      if (added) commit(next);
      return added;
    },
    [commit],
  );
  const editText = useCallback(
    (id: string, text: string) => commit(editCommentText(ref.current.comments, id, text)),
    [commit],
  );
  const resolve = useCallback(
    (id: string) => commit(resolveComment(ref.current.comments, id)),
    [commit],
  );
  const unresolve = useCallback(
    (id: string) => commit(unresolveComment(ref.current.comments, id)),
    [commit],
  );
  const remove = useCallback(
    (id: string) => commit(removeComment(ref.current.comments, id)),
    [commit],
  );

  return {
    comments,
    openCount: openCommentCount(comments),
    add,
    editText,
    resolve,
    unresolve,
    remove,
  };
}
