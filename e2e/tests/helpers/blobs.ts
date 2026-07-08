// Filesystem-level assertions against the server's fs blob store. The
// playwright config starts the server with BLOB_FS_ROOT=./data/e2e-blobs
// and pnpm runs it from apps/server; a locally reused dev server may use
// the .env default ./data/blobs instead, so we probe both.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const CANDIDATE_BLOB_ROOTS = [
  path.join(repoRoot, "apps", "server", "data", "e2e-blobs"),
  path.join(repoRoot, "apps", "server", "data", "blobs"),
];

/** Count regular files under `dir`, recursively. 0 when the dir is absent —
 * FsBlobStore.delete removes files but leaves empty directories behind. */
export async function countBlobFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries.filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

/** Locate the blob directory of a take that is known to be archived. */
export async function findTakeBlobDir(takeId: string): Promise<string | null> {
  for (const root of CANDIDATE_BLOB_ROOTS) {
    const dir = path.join(root, takeId);
    if ((await countBlobFiles(dir)) > 0) return dir;
  }
  return null;
}
