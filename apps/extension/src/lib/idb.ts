import type { Segment, VideoRef } from "@/contracts";

export interface LocalTranscript {
  video: VideoRef;
  sourceType: string;
  trackId: string | null;
  language: string;
  segments: Segment[];
  fetchedAt: string;
}

export interface UploadCheckpoint {
  uploadId: string;
  size: number;
  audioId: string | null;
  createdAt: string;
  identity: string;
}

const DB_NAME = "bili-transcript";
const STORE = "kv";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    } finally {
      db.close();
    }
  });
}

export async function idbGet<T>(key: string): Promise<T | null> {
  return withStore<T>("readonly", (store) => store.get(key) as IDBRequest<T>);
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  await withStore("readwrite", (store) => store.put(value, key) as IDBRequest<IDBValidKey>);
}

export async function idbDelete(key: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(key) as IDBRequest<undefined>);
}

export function identityKey(video: Pick<VideoRef, "bvid" | "cid" | "page">): string {
  return `${video.bvid}:${video.cid}:${video.page}`;
}

export async function saveLocalTranscript(transcript: LocalTranscript): Promise<void> {
  await idbSet(`doc:${identityKey(transcript.video)}`, transcript);
}

export async function getLocalTranscript(
  video: Pick<VideoRef, "bvid" | "cid" | "page">,
): Promise<LocalTranscript | null> {
  return idbGet<LocalTranscript>(`doc:${identityKey(video)}`);
}

export async function saveUploadCheckpoint(key: string, checkpoint: UploadCheckpoint): Promise<void> {
  await idbSet(`upload:${key}`, checkpoint);
}

export async function getUploadCheckpoint(key: string): Promise<UploadCheckpoint | null> {
  return idbGet<UploadCheckpoint>(`upload:${key}`);
}

export async function clearUploadCheckpoint(key: string): Promise<void> {
  await idbDelete(`upload:${key}`);
}

export async function saveUploadChunk(uploadId: string, index: number, data: Uint8Array): Promise<void> {
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  await idbSet(`chunk:${uploadId}:${index}`, buffer);
}

export async function getUploadChunk(uploadId: string, index: number): Promise<Uint8Array | null> {
  const buffer = await idbGet<ArrayBuffer>(`chunk:${uploadId}:${index}`);
  return buffer ? new Uint8Array(buffer) : null;
}

export async function clearUploadChunks(uploadId: string, count: number): Promise<void> {
  await Promise.all(Array.from({ length: count }, (_, index) => idbDelete(`chunk:${uploadId}:${index}`)));
}
