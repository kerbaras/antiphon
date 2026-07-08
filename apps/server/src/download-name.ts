// FLAC download naming (F14 + wave-2 follow-up). The server's
// Content-Disposition beats the desk's `a.download` in Chromium, so the
// header must speak the same naming contract as every other export (W1-D):
// `<fileSafe(nickname)>-<streamId8>`. Unlabeled peers fall back to the
// device family the desk titles their lane with (`iPhone-3f2a1b8c.flac`);
// only a stream with no peer attribution at all keeps the historical
// full-uuid name.

/** Byte-for-byte mirror of the desk's fileSafe
 * (apps/web/src/routes/desk/track-model.ts): runs of anything that is not a
 * Unicode letter/number collapse to "-", edges trimmed, empty → "track". */
export function fileSafe(name: string): string {
  return name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "track";
}

/** Byte-for-byte mirror of the desk's deviceName
 * (apps/web/src/routes/desk/track-model.ts): the device family an unlabeled
 * lane is titled with. Always ASCII letters from a fixed set. */
export function deviceName(userAgent: string): string {
  const m = /iPhone|iPad|Android|Macintosh|Windows/.exec(userAgent);
  return m ? m[0] : "Browser";
}

/** What the download filename derives from: the peer row behind the stream
 * (Archive.streamPeer), or null when the stream has no attribution. */
export interface StreamPeerIdentity {
  label: string | null;
  userAgent: string;
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
 * - Unlabeled peer: `<deviceName(userAgent)>-<streamId8>.flac`, the desk's
 *   lane-title fallback (always ASCII, so it always takes the plain path).
 * - No peer row: the historical `<streamId>.flac` (full uuid). */
export function flacContentDisposition(streamId: string, peer: StreamPeerIdentity | null): string {
  if (!peer) return `attachment; filename="${streamId}.flac"`;
  const nickname = peer.label?.trim();
  const shortId = streamId.slice(0, 8);
  const base = nickname ? fileSafe(nickname) : deviceName(peer.userAgent);
  const name = `${base}-${shortId}.flac`;
  if (ASCII_PRINTABLE.test(name)) return `attachment; filename="${name}"`;
  const asciiBase = base
    .replace(/[^\x20-\x7e]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const fallback = asciiBase ? `${asciiBase}-${shortId}.flac` : `${shortId}.flac`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987Encode(name)}`;
}
