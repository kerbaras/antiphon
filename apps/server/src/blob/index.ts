// Blob storage for chunk frame bytes. Two real drivers — filesystem (dev)
// and S3-compatible (Cloudflare R2 in prod; free egress is the point).
// Keys are `${takeId}/${streamId}/${seq}`; values are the exact wire frame
// (68-byte header + payload) so a blob is self-describing and re-servable.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
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
    return await readFile(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(endpoint: string, bucket: string) {
    this.bucket = bucket;
    this.client = new S3Client({
      endpoint,
      region: process.env.S3_REGION ?? "auto",
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
      },
    });
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes }));
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`blob ${key} has no body`);
    return new Uint8Array(await res.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
