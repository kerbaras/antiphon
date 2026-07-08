// FLAC download naming (F14). The server's Content-Disposition beats the
// desk's `a.download` in Chromium, so the header must speak the same naming
// contract as every other export (W1-D): `<fileSafe(nickname)>-<streamId8>`.
// Unlabeled peers keep the historical full-uuid name.

/** Byte-for-byte mirror of the desk's fileSafe
 * (apps/web/src/routes/desk/track-model.ts): runs of anything that is not a
 * Unicode letter/number collapse to "-", edges trimmed, empty → "track". */
export function fileSafe(name: string): string {
  return name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "track";
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/** RFC 5987 ext-value percent-encoding: UTF-8 octets, attr-char kept.
 * encodeURIComponent covers everything except `*'()`, which attr-char
 * excludes. */
function rfc5987Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[*'()]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Content-Disposition for GET /api/streams/:streamId/flac.
 *
 * - Labeled peer: `attachment; filename="<fileSafe(label)>-<streamId8>.flac"`,
 *   matching the desk's exportFlacAll / stems naming. fileSafe output is only
 *   letters/numbers/hyphens, so the quoted-string needs no escaping.
 * - Non-ASCII label: RFC 6266/5987 — the true name travels in
 *   `filename*=UTF-8''…` and `filename` degrades to the ASCII-stripped form
 *   (or the bare short id when nothing printable survives).
 * - No label: the historical `<streamId>.flac` (full uuid). */
export function flacContentDisposition(streamId: string, label: string | null): string {
  const nickname = label?.trim();
  if (!nickname) return `attachment; filename="${streamId}.flac"`;
  const shortId = streamId.slice(0, 8);
  const base = fileSafe(nickname);
  const name = `${base}-${shortId}.flac`;
  if (ASCII_PRINTABLE.test(name)) return `attachment; filename="${name}"`;
  const asciiBase = base
    .replace(/[^\x20-\x7e]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const fallback = asciiBase ? `${asciiBase}-${shortId}.flac` : `${shortId}.flac`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987Encode(name)}`;
}
