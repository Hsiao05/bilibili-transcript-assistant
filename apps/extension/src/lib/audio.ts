import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import type { UploadSession, VideoRef } from "@/contracts";
import type { NormalizedAudio } from "@/bilibili/types";
import { ApiClient } from "@/lib/api";
import {
  clearUploadCheckpoint,
  clearUploadChunks,
  getUploadCheckpoint,
  getUploadChunk,
  saveUploadCheckpoint,
  saveUploadChunk,
} from "@/lib/idb";

export interface AudioUploadProgress {
  phase: "prepare" | "download" | "upload" | "complete";
  downloadedBytes: number;
  uploadedBytes: number;
  totalBytes: number;
  chunkIndex: number;
  chunkCount: number;
  message: string;
}

export interface AudioUploadResult {
  uploadId: string;
  size: number;
  sha256: string;
}

export class UploadExpiredError extends Error {}

function parseTotalFromRange(header: string | null): number | null {
  if (!header) return null;
  const match = header.match(/\/(\d+)\s*$/);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

export async function probeAudioSize(audio: NormalizedAudio): Promise<number> {
  for (const url of [audio.url, ...audio.backupUrls]) {
    const controller = new AbortController();
    try {
      const response = await fetch(url, {
        headers: { Range: "bytes=0-0" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status === 206) {
        const total = parseTotalFromRange(response.headers.get("content-range"));
        if (total) {
          controller.abort();
          return total;
        }
      }
      if (response.status === 200) {
        const length = Number.parseInt(response.headers.get("content-length") || "", 10);
        controller.abort();
        if (Number.isFinite(length) && length > 0) return length;
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") continue;
    } finally {
      controller.abort();
    }
  }
  if (audio.estimatedBytes > 0) {
    // Last resort: return the estimate only when the CDN refuses range probes.
    throw new Error("无法获取音频文件大小，请稍后重试或改用字幕");
  }
  throw new Error("无法获取音频文件大小");
}

async function fetchRange(url: string, start: number, end: number, signal: AbortSignal): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new Error(`音频下载网络错误：${(error as Error).message}`);
  }
  if (response.status === 403 || response.status === 401) {
    throw new UploadExpiredError("音频链接已过期");
  }
  if (response.status === 206) {
    return new Uint8Array(await response.arrayBuffer());
  }
  if (response.status === 200) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.slice(start, end + 1);
  }
  if (response.status >= 500) throw new Error(`音频 CDN 暂时不可用（HTTP ${response.status}）`);
  throw new Error(`音频下载失败（HTTP ${response.status}）`);
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export async function uploadAudio(params: {
  api: ApiClient;
  video: VideoRef;
  audio: NormalizedAudio;
  checkpointKey: string;
  signal: AbortSignal;
  onProgress: (progress: AudioUploadProgress) => void;
  refreshAudio: () => Promise<NormalizedAudio>;
}): Promise<AudioUploadResult> {
  const { api, video, checkpointKey, signal, onProgress } = params;
  let audio = params.audio;

  onProgress({
    phase: "prepare",
    downloadedBytes: 0,
    uploadedBytes: 0,
    totalBytes: 0,
    chunkIndex: 0,
    chunkCount: 0,
    message: "获取音频大小",
  });
  let size = await probeAudioSize(audio);
  const filename = `bilibili-${video.bvid}-p${video.page}.m4a`;

  let session: UploadSession | null = null;
  const checkpoint = await getUploadCheckpoint(checkpointKey);
  if (checkpoint && checkpoint.size === size) {
    session = await api.getUpload(checkpoint.uploadId);
    if (session && session.size !== size) session = null;
  }
  if (!session || session.status === "complete" && session.receivedChunks.length === 0) {
    session = await api.createUpload(filename, size);
  }
  if (size > session.maxBytes) {
    throw new Error(`音频大小超过任务服务上限（${Math.round(session.maxBytes / 1024 / 1024)} MB）`);
  }
  await saveUploadCheckpoint(checkpointKey, {
    uploadId: session.id,
    size,
    audioId: audio.id,
    createdAt: new Date().toISOString(),
    identity: checkpointKey,
  });

  const chunkSize = session.chunkSize;
  const chunkCount = Math.max(1, Math.ceil(size / chunkSize));
  const received = new Set(session.receivedChunks);
  const hasher = sha256.create();
  let downloaded = 0;
  let uploaded = 0;
  let currentAudio = audio;

  const refresh = async () => {
    const updated = await params.refreshAudio();
    if (updated.id !== audio.id) throw new Error("音轨已变化，已停止上传，请重新开始");
    currentAudio = updated;
    audio = updated;
    return updated;
  };

  for (let index = 0; index < chunkCount; index += 1) {
    if (signal.aborted) throw new DOMException("上传已取消", "AbortError");
    const start = index * chunkSize;
    const end = Math.min(size - 1, start + chunkSize - 1);
    const expectedLength = end - start + 1;
    let data = await getUploadChunk(session.id, index);

    if (!data || data.byteLength !== expectedLength) {
      if (received.has(index)) {
        // Resume: bytes are already on the server, but the local hash cache is missing.
        data = await fetchRangeWithRetry(currentAudio.url, start, end, signal, refresh);
      } else {
        data = await fetchRangeWithRetry(currentAudio.url, start, end, signal, refresh);
        await saveUploadChunk(session.id, index, data);
        downloaded += data.byteLength;
        onProgress({
          phase: "upload",
          downloadedBytes: downloaded,
          uploadedBytes: uploaded,
          totalBytes: size,
          chunkIndex: index,
          chunkCount,
          message: `上传第 ${index + 1}/${chunkCount} 块`,
        });
        const chunkDigest = bytesToHex(sha256(data));
        session = await api.putChunk(session.id, index, data, chunkDigest);
        received.add(index);
        uploaded += data.byteLength;
      }
    }
    hasher.update(data);
    onProgress({
      phase: "upload",
      downloadedBytes: downloaded,
      uploadedBytes: uploaded,
      totalBytes: size,
      chunkIndex: index + 1,
      chunkCount,
      message: `已处理 ${index + 1}/${chunkCount} 块`,
    });
  }

  onProgress({
    phase: "complete",
    downloadedBytes: downloaded,
    uploadedBytes: uploaded,
    totalBytes: size,
    chunkIndex: chunkCount,
    chunkCount,
    message: "校验音频完整性",
  });
  const digest = bytesToHex(hasher.digest());
  const finished = await api.completeUpload(session.id, chunkCount, size, digest);
  await clearUploadChunks(session.id, chunkCount);
  await clearUploadCheckpoint(checkpointKey);
  return { uploadId: finished.id, size, sha256: digest };
}

async function fetchRangeWithRetry(
  initialUrl: string,
  start: number,
  end: number,
  signal: AbortSignal,
  refresh: () => Promise<NormalizedAudio>,
): Promise<Uint8Array> {
  let url = initialUrl;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal.aborted) throw new DOMException("上传已取消", "AbortError");
    try {
      return await fetchRange(url, start, end, signal);
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      lastError = error as Error;
      if (error instanceof UploadExpiredError) {
        const updated = await refresh();
        url = updated.url;
        continue;
      }
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastError || new Error("音频下载失败");
}
