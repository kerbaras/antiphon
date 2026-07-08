// Join-by-code: session ids are UUIDs (crypto.randomUUID()). Accept
// anything a user might paste — a full join/desk link, a bare uuid,
// surrounding whitespace or punctuation — and pull the first uuid out.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** First session UUID found in the pasted text (lowercased), or null. */
export function extractSessionId(input: string): string | null {
  const match = UUID_RE.exec(input);
  return match ? match[0].toLowerCase() : null;
}
