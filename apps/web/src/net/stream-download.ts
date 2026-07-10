// /api/streams/:id/flac sits behind desk auth when auth is on, and a bare
// <a href> can't carry an Authorization header. Keyless keeps plain anchor
// navigation; auth mode fetches with the token and downloads a blob.

import { authActive, authFetch } from "./auth-token";

/** RFC 6266-lite: pull a filename out of Content-Disposition — the
 * filename* (UTF-8) form first (what the server emits for nicknamed
 * lanes), plain filename= as fallback. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // fall through to the plain form
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain?.[1]?.trim() || null;
}

function clickAnchor(href: string, download: string | null): void {
  const a = document.createElement("a");
  a.href = href;
  if (download) a.download = download;
  a.click();
}

/**
 * Download one archived stream as .flac. `preferredName` (the desk's
 * lane-derived filename) wins when given — matching the old `a.download`
 * behavior — otherwise the server's Content-Disposition name is used.
 */
export async function downloadStreamFlac(
  streamId: string,
  preferredName: string | null = null,
): Promise<void> {
  const href = `/api/streams/${streamId}/flac`;
  if (!authActive()) {
    clickAnchor(href, preferredName);
    return;
  }
  const res = await authFetch(href);
  if (!res.ok) return; // desk UI already reflects completeness; stay quiet
  const name =
    preferredName ??
    filenameFromDisposition(res.headers.get("content-disposition")) ??
    `${streamId.slice(0, 8)}.flac`;
  const url = URL.createObjectURL(await res.blob());
  clickAnchor(url, name);
  // Give the click a tick to start the save before releasing the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
