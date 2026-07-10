// Browser-native gzip via CompressionStream — the .als container format
// (a Live set is gzipped XML). Feature-checked: a clear error beats a
// ReferenceError from inside an export job.

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("this browser cannot write .als files (CompressionStream unavailable)");
  }
  const compressed = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}
