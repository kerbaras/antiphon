// Blob storage for chunk frame bytes. Two real drivers — filesystem (dev)
// and S3-compatible (Cloudflare R2 in prod; free egress is the point.
// MinIO locally exercises the same driver — see docker-compose.yml).
// Keys are `${takeId}/${streamId}/${seq}`; values are the exact wire frame
// (68-byte header + payload) so a blob is self-describing and re-servable.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createLogger } from "../logger.ts";

/** `get` on a missing key rejects with this — both drivers, no raw
 * ENOENT/NoSuchKey leaking through. */
export class BlobNotFoundError extends Error {
  constructor(key: string) {
    super(`blob not found: ${key}`);
    this.name = "BlobNotFoundError";
  }
}

export interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Rejects with {@link BlobNotFoundError} when the key does not exist. */
  get(key: string): Promise<Uint8Array>;
  /** Idempotent: deleting a missing key resolves without error. */
  delete(key: string): Promise<void>;
}

export function chunkBlobKey(takeId: string, streamId: string, seq: number): string {
  return `${takeId}/${streamId}/${seq}`;
}

export class FsBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private path(key: string): string {
    if (key.includes("..")) throw new Error(`invalid blob key: ${key}`);
    return join(this.root, key);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BlobNotFoundError(key);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export interface S3BlobConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing (`endpoint/bucket/key`). Required for MinIO;
   * leave off for R2/AWS virtual-hosted buckets. */
  forcePathStyle: boolean;
}

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly log = createLogger({ module: "blob-s3" });

  constructor(config: S3BlobConfig) {
    this.bucket = config.bucket;
    this.endpoint = config.endpoint;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /** Boot-time bucket check: HeadBucket → CreateBucket when missing →
   * warn-and-continue on AccessDenied (R2 tokens scoped to one bucket
   * usually can't create; the bucket already exists in that setup). An
   * unreachable endpoint throws — the server must fail fast, not limp
   * into serving with a dead blob store. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      const status = httpStatus(error);
      if (status === undefined) {
        throw new Error(
          `S3 endpoint unreachable at ${this.endpoint} (bucket "${this.bucket}"): ${String(error)}`,
          { cause: error },
        );
      }
      if (status === 403) {
        this.log.warn("HeadBucket denied; assuming bucket exists (restricted token)", {
          bucket: this.bucket,
        });
        return;
      }
      if (status !== 404) throw error;
    }
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.log.info("created blob bucket", { bucket: this.bucket });
    } catch (error) {
      const name = (error as Error).name;
      if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") return;
      if (httpStatus(error) === 403 || name === "AccessDenied") {
        this.log.warn("CreateBucket denied; continuing (token may lack create rights)", {
          bucket: this.bucket,
        });
        return;
      }
      throw error;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes }));
  }

  async get(key: string): Promise<Uint8Array> {
    let res: GetObjectCommandOutput;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if ((error as Error).name === "NoSuchKey" || httpStatus(error) === 404) {
        throw new BlobNotFoundError(key);
      }
      throw error;
    }
    if (!res.Body) throw new Error(`blob ${key} has no body`);
    return new Uint8Array(await res.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    // S3 DeleteObject is idempotent by protocol: missing keys return 204.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}
