import type { Segment, VideoRef } from "@/contracts";
import { formatTime, sourceTypeLabel, timeUrl, videoUrl } from "@/lib/utils";

function escapeLine(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (/^(#{1,6}\s|>\s|[-*+]\s|\d+[.)]\s|\|)/.test(trimmed)) return `\\${trimmed}`;
  return trimmed;
}

export function localTranscriptMarkdown(
  video: VideoRef,
  segments: Segment[],
  options: { includeTimestamps: boolean; sourceType?: string },
): string {
  const start = segments.length ? segments[0].startMs : 0;
  const end = segments.length ? segments[segments.length - 1].endMs : 0;
  const lines = [
    `# ${video.title || "未命名视频"}`,
    "",
    `作者　${video.author || "未知"}`,
    `分P　第 ${video.page} P · ${video.partTitle || "正文"}`,
    `来源　${videoUrl(video)}`,
    `文本来源　${sourceTypeLabel(options.sourceType || "bilibili_subtitle")}`,
    `处理范围　${formatTime(start)}–${formatTime(end)}`,
    "整理方式　原始稿（本地缓存，未经任务服务清洗）",
    "",
    "## 原始稿",
    "",
  ];
  for (const segment of segments) {
    const text = escapeLine(segment.text);
    if (!text) continue;
    lines.push(
      options.includeTimestamps
        ? `[${formatTime(segment.startMs)}](${timeUrl(video, segment.startMs)})　${text}`
        : text,
    );
    lines.push("");
  }
  lines.push("## 材料覆盖与处理记录", "");
  lines.push("- 文本来源：B站字幕（本地保存）");
  lines.push("- 覆盖限制：仅字幕文字，未覆盖图表、画面操作、表情和未被说出的信息。");
  return `${lines.join("\n").trim()}\n`;
}

export function localFilename(video: VideoRef): string {
  const safe = (video.title || "视频文字稿")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 60);
  return `${safe || "视频文字稿"}-P${String(video.page).padStart(2, "0")}-原始稿.md`;
}
