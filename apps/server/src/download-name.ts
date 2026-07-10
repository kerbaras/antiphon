// FLAC download naming. The server's Content-Disposition beats the desk's
// `a.download` in Chromium, so it must match the export naming contract:
// `<fileSafe(nickname)>-<streamId8>`; unlabeled peers fall back to the
// device family (`iPhone-3f2a1b8c.flac`); only a stream with no peer
// attribution keeps the historical full-uuid name.

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

/** Content-Disposition for GET /api/streams/:streamId/flac. fileSafe
 * output needs no quoted-string escaping; non-ASCII names travel per RFC
 * 6266/5987 in `filename*=UTF-8''…` with an ASCII-stripped `filename`. */
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
