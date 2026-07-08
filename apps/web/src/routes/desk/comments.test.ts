import { describe, expect, it } from "vitest";
import {
  AUTHOR_PREF_KEY,
  addComment,
  commentsKey,
  DEFAULT_COMMENT_AUTHOR,
  editCommentText,
  loadAuthorPref,
  loadComments,
  MAX_COMMENT_AUTHOR,
  MAX_COMMENT_TEXT,
  openCommentCount,
  removeComment,
  resolveComment,
  saveAuthorPref,
  saveComments,
  sortComments,
  type TakeComment,
  unresolveComment,
} from "./comments";

const c = (id: string, atSec: number, over: Partial<TakeComment> = {}): TakeComment => ({
  id,
  atSec,
  streamId: null,
  text: id,
  author: "Desk",
  createdAtMs: 1_000,
  resolvedAtMs: null,
  ...over,
});

/** Minimal Storage double for the persistence round-trip tests. */
function memStore(): Pick<Storage, "getItem" | "setItem"> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("comment model", () => {
  it("addComment keeps the list sorted regardless of insertion order", () => {
    let list: TakeComment[] = [];
    for (const at of [151, 4, 88, 20]) {
      list = addComment(list, {
        atSec: at,
        text: `note at ${at}`,
        author: "Desk",
        streamId: null,
      }).comments;
    }
    expect(list.map((x) => x.atSec)).toEqual([4, 20, 88, 151]);
  });

  it("addComment trims/bounds text and author, clamps atSec, starts open", () => {
    const { added } = addComment([], {
      atSec: -2,
      text: `  alto flat  ${"x".repeat(600)}`,
      author: `  Maria ${"y".repeat(60)}`,
      streamId: "stream-1",
    });
    expect(added).not.toBeNull();
    expect(added?.atSec).toBe(0);
    expect(added?.text.startsWith("alto flat")).toBe(true);
    expect(added?.text.length).toBeLessThanOrEqual(MAX_COMMENT_TEXT);
    expect(added?.author.startsWith("Maria")).toBe(true);
    expect(added?.author.length).toBeLessThanOrEqual(MAX_COMMENT_AUTHOR);
    expect(added?.streamId).toBe("stream-1");
    expect(added?.resolvedAtMs).toBeNull();
  });

  it("addComment rejects empty text and defaults a blank author", () => {
    const empty = addComment([], { atSec: 3, text: "   ", author: "Desk", streamId: null });
    expect(empty.added).toBeNull();
    expect(empty.comments).toEqual([]);
    const blank = addComment([], { atSec: 3, text: "ok", author: "   ", streamId: null });
    expect(blank.added?.author).toBe(DEFAULT_COMMENT_AUTHOR);
  });

  it("sortComments ties on atSec break by createdAtMs, then id", () => {
    const sorted = sortComments([
      c("b", 4, { createdAtMs: 2_000 }),
      c("z", 4, { createdAtMs: 1_000 }),
      c("a", 4, { createdAtMs: 1_000 }),
      c("late", 1),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["late", "a", "z", "b"]);
  });

  it("editCommentText trims and ignores empty results; removeComment deletes by id", () => {
    const list = [c("a", 0), c("b", 10)];
    expect(editCommentText(list, "a", "  sharper attack  ")[0]?.text).toBe("sharper attack");
    expect(editCommentText(list, "a", "   ")[0]?.text).toBe("a");
    expect(removeComment(list, "a").map((x) => x.id)).toEqual(["b"]);
  });

  it("resolve stamps once, unresolve reopens (round-trip), openCommentCount follows", () => {
    let list = [c("a", 0), c("b", 10)];
    expect(openCommentCount(list)).toBe(2);
    list = resolveComment(list, "a", 5_000);
    expect(list.find((x) => x.id === "a")?.resolvedAtMs).toBe(5_000);
    expect(openCommentCount(list)).toBe(1);
    // Resolving an already-resolved comment keeps the original stamp.
    list = resolveComment(list, "a", 9_000);
    expect(list.find((x) => x.id === "a")?.resolvedAtMs).toBe(5_000);
    list = unresolveComment(list, "a");
    expect(list.find((x) => x.id === "a")?.resolvedAtMs).toBeNull();
    expect(openCommentCount(list)).toBe(2);
  });
});

describe("persistence", () => {
  it("round-trips through the versioned document, sorted, with resolution state", () => {
    const store = memStore();
    const resolved = c("b", 20, { text: "tenor early", resolvedAtMs: 7_000 });
    const open = c("a", 3, { text: "alto flat", streamId: "s-1", author: "Maria" });
    saveComments("sess", "take", [resolved, open], store);
    expect(store.map.has(commentsKey("sess", "take"))).toBe(true);
    expect(loadComments("sess", "take", store)).toEqual([open, resolved]);
    // Keyed per (session, take): neighbors see nothing.
    expect(loadComments("sess", "other-take", store)).toEqual([]);
    expect(loadComments("other-sess", "take", store)).toEqual([]);
  });

  it("tolerates malformed JSON, unknown schema versions, and wrong shapes", () => {
    const store = memStore();
    const key = commentsKey("s", "t");
    for (const raw of [
      "not json{",
      "null",
      "[]",
      JSON.stringify({ v: 999, comments: [c("a", 1)] }),
      JSON.stringify({ v: 1, comments: "nope" }),
      JSON.stringify({ comments: [c("a", 1)] }),
    ]) {
      store.map.set(key, raw);
      expect(loadComments("s", "t", store)).toEqual([]);
    }
  });

  it("filters invalid entries instead of rejecting the document", () => {
    const store = memStore();
    store.map.set(
      commentsKey("s", "t"),
      JSON.stringify({
        v: 1,
        comments: [
          c("good", 5),
          { ...c("no-id", 1), id: "" },
          { ...c("nan", 1), atSec: Number.NaN },
          { ...c("neg", 1), atSec: -4 },
          { ...c("no-text", 1), text: "" },
          { ...c("bad-stream", 1), streamId: 7 },
          { ...c("bad-created", 1), createdAtMs: "yesterday" },
          { ...c("bad-resolved", 1), resolvedAtMs: "done" },
          null,
          "junk",
        ],
      }),
    );
    expect(loadComments("s", "t", store)).toEqual([c("good", 5)]);
  });

  it("survives a throwing store (private mode) by degrading to empty", () => {
    const throwing: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadComments("s", "t", throwing)).toEqual([]);
    expect(() => saveComments("s", "t", [c("a", 1)], throwing)).not.toThrow();
  });
});

describe("author preference", () => {
  it("round-trips trimmed and falls back to the default when unset/blank", () => {
    const store = memStore();
    expect(loadAuthorPref(store)).toBe(DEFAULT_COMMENT_AUTHOR);
    saveAuthorPref("  Maestra  ", store);
    expect(store.map.get(AUTHOR_PREF_KEY)).toBe("Maestra");
    expect(loadAuthorPref(store)).toBe("Maestra");
    saveAuthorPref("   ", store);
    expect(loadAuthorPref(store)).toBe(DEFAULT_COMMENT_AUTHOR);
  });

  it("bounds the label and survives a throwing store", () => {
    const store = memStore();
    saveAuthorPref("z".repeat(100), store);
    expect(loadAuthorPref(store).length).toBeLessThanOrEqual(MAX_COMMENT_AUTHOR);
    const throwing: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadAuthorPref(throwing)).toBe(DEFAULT_COMMENT_AUTHOR);
    expect(() => saveAuthorPref("x", throwing)).not.toThrow();
  });
});
