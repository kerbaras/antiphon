import { describe, expect, it } from "vitest";
import { extractSessionId } from "./join-code";

const ID = "8f14e45f-ceea-467f-ab8a-91f3c1e0f1aa";

describe("extractSessionId", () => {
  it("accepts a bare uuid", () => {
    expect(extractSessionId(ID)).toBe(ID);
  });

  it("trims surrounding whitespace and newlines", () => {
    expect(extractSessionId(`  ${ID}\n`)).toBe(ID);
  });

  it("extracts from a join link", () => {
    expect(extractSessionId(`https://antiphon.example/join/${ID}`)).toBe(ID);
  });

  it("extracts from a desk link", () => {
    expect(extractSessionId(`https://antiphon.example/session/${ID}`)).toBe(ID);
  });

  it("extracts from a link with query and fragment", () => {
    expect(extractSessionId(`https://x.dev/join/${ID}?utm=qr#top`)).toBe(ID);
  });

  it("lowercases uppercase uuids", () => {
    expect(extractSessionId(ID.toUpperCase())).toBe(ID);
  });

  it("takes the first uuid when several are present", () => {
    const other = "00000000-0000-4000-8000-000000000000";
    expect(extractSessionId(`${ID} ${other}`)).toBe(ID);
  });

  it("rejects text without a uuid", () => {
    expect(extractSessionId("")).toBeNull();
    expect(extractSessionId("hello")).toBeNull();
    expect(extractSessionId("https://antiphon.example/join/not-a-uuid")).toBeNull();
  });

  it("rejects almost-uuids", () => {
    expect(extractSessionId("8f14e45f-ceea-467f-ab8a-91f3c1e0f1a")).toBeNull(); // 11-char tail
    expect(extractSessionId("8f14e45fceea467fab8a91f3c1e0f1aa")).toBeNull(); // no dashes
    expect(extractSessionId("gf14e45f-ceea-467f-ab8a-91f3c1e0f1aa")).toBeNull(); // non-hex
  });

  it("finds a uuid embedded in longer hex-ish text", () => {
    expect(extractSessionId(`code: ${ID}.`)).toBe(ID);
  });
});
