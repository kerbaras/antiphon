// Browser-native gzip via CompressionStream (W3-B) — the .als container
// format (a Live set is gzipped XML). Dependency-free by design; the API
// is Baseline-available in every browser the desk supports (and in Node
// ≥ 18, so unit tests run it for real). Feature-checked anyway: a clear
// error beats a ReferenceError from inside an export job.

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("this browser cannot write .als files (CompressionStream unavailable)");
  }
  const compressed = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}
