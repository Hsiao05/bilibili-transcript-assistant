import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatDuration(ms: number): string {
  if (!ms) return "未知时长";
  const total = Math.floor(ms / 1000);
  const minutes = Math.round(total / 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时 ${minutes % 60} 分`;
  }
  return `${Math.max(1, minutes)} 分钟`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "未知";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function videoUrl(video: { bvid: string; page: number }): string {
  return `https://www.bilibili.com/video/${video.bvid}/?p=${video.page}`;
}

export function timeUrl(video: { bvid: string; page: number }, ms: number): string {
  return `${videoUrl(video)}&t=${Math.max(0, Math.floor(ms / 1000))}`;
}

export function sourceTypeLabel(type: string | null | undefined): string {
  switch (type) {
    case "bilibili_human_subtitle":
      return "B站人工字幕";
    case "bilibili_ai_subtitle":
      return "B站AI字幕";
    case "bilibili_subtitle":
      return "B站字幕";
    case "bilibili_subtitle_unknown":
      return "B站字幕（类型未知）";
    case "asr_local":
      return "本机 ASR";
    case "asr_cloud":
      return "云 ASR";
    default:
      return type || "未知来源";
  }
}

export function revisionLabel(kind: string): string {
  switch (kind) {
    case "original":
      return "原始稿";
    case "cleaned":
      return "整理稿";
    case "edited":
      return "人工修订稿";
    default:
      return kind;
  }
}

export function strengthLabel(strength: string): string {
  switch (strength) {
    case "light":
      return "轻度清洗";
    case "compact":
      return "精简稿";
    default:
      return "标准清洗";
  }
}
