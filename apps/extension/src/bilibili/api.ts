import type { VideoRef } from "@/contracts";
import type {
  BiliAudioRaw,
  BiliPlayerData,
  BiliPlayUrlData,
  BiliSubtitleRaw,
  BiliViewData,
  NormalizedAudio,
  NormalizedTrack,
  SubtitleBodyItem,
} from "./types";
import { signWbi, toQuery } from "./wbi";

export type BiliErrorKind = "login" | "risk" | "network" | "api" | "empty" | "unsupported" | "invalid_url";

export class BiliError extends Error {
  kind: BiliErrorKind;
  code: string | number;

  constructor(kind: BiliErrorKind, code: string | number, message: string) {
    super(message);
    this.name = "BiliError";
    this.kind = kind;
    this.code = code;
  }
}

interface ApiEnvelope<T> {
  code: number;
  message?: string;
  data?: T;
}

function mapApiError(code: number, message: string): BiliError {
  if (code === -101) return new BiliError("login", code, "需要登录 B 站后才能继续");
  if (code === -403 || code === -412 || code === -352) {
    return new BiliError("risk", code, "B站暂时拒绝了这次请求，请稍后再试");
  }
  return new BiliError("api", code, message || `B站接口返回错误 ${code}`);
}

async function getJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include", cache: "no-store" });
  } catch (error) {
    throw new BiliError("network", "network", `网络请求失败：${(error as Error).message}`);
  }
  if (response.status === 412 || response.status === 403) {
    throw new BiliError("risk", response.status, "B站暂时拒绝了这次请求，请稍后再试");
  }
  if (!response.ok) {
    throw new BiliError("network", response.status, `B站请求失败（HTTP ${response.status}）`);
  }
  let payload: ApiEnvelope<T>;
  try {
    payload = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new BiliError("api", "invalid_json", "B站返回内容无法解析");
  }
  if (payload.code !== 0) throw mapApiError(payload.code, payload.message || "");
  if (payload.data === undefined) throw new BiliError("empty", "no_data", "B站没有返回数据");
  return payload.data;
}

export async function getViewData(bvid: string): Promise<BiliViewData> {
  return getJson<BiliViewData>(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
  );
}

export function toVideoRef(view: BiliViewData, pageNumber: number): VideoRef {
  const page =
    view.pages?.find((item) => item.page === pageNumber) ??
    view.pages?.[0] ?? {
      cid: view.cid,
      page: pageNumber,
      part: view.title,
      duration: view.duration,
    };
  return {
    bvid: view.bvid,
    cid: String(page.cid),
    page: page.page,
    title: view.title,
    partTitle: page.part,
    author: view.owner?.name ?? "",
    durationMs: Math.round((page.duration || view.duration || 0) * 1000),
    coverUrl: view.pic,
    sourceUrl: `https://www.bilibili.com/video/${view.bvid}/?p=${page.page}`,
  };
}

export async function getPlayerData(bvid: string, cid: string): Promise<BiliPlayerData> {
  const signed = await signWbi({ bvid, cid });
  return getJson<BiliPlayerData>(`https://api.bilibili.com/x/player/wbi/v2?${toQuery(signed)}`);
}

const SUBTITLE_HOST_ALLOWLIST = ["hdslb.com", "bilibili.com", "bilivideo.com"];

/** Domain-boundary match: www.hdslb.com matches hdslb.com, but evilhdslb.com does not. */
function isAllowedHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function normalizeSubtitleUrl(raw: string): string | null {
  let value = raw.trim();
  if (value.startsWith("//")) value = `https:${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (!SUBTITLE_HOST_ALLOWLIST.some((domain) => isAllowedHost(host, domain))) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function classifyTrack(track: BiliSubtitleRaw): NormalizedTrack["type"] {
  const lan = (track.lan || "").toLowerCase();
  const doc = track.lan_doc || "";
  if (track.ai_type !== undefined || /^ai[-_]/.test(lan) || /自动|机器|生成的|ai\s*字幕/i.test(doc)) {
    return "ai";
  }
  if (lan || doc) return "human";
  return "unknown";
}

export function normalizeTracks(raws: BiliSubtitleRaw[] | undefined): NormalizedTrack[] {
  const tracks: NormalizedTrack[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of (raws || []).entries()) {
    if (!raw.subtitle_url) continue;
    const url = normalizeSubtitleUrl(raw.subtitle_url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const lan = raw.lan || "";
    const type = classifyTrack(raw);
    tracks.push({
      // B站 ids exceed Number.MAX_SAFE_INTEGER; prefer the exact string form when provided.
      id: raw.id_str ?? (raw.id !== undefined ? String(raw.id) : `${lan || "track"}-${index}`),
      lan,
      lanDoc: raw.lan_doc || lan || "未命名字幕",
      url,
      type,
    });
  }
  const typeRank = { human: 0, unknown: 1, ai: 2 };
  tracks.sort((a, b) => {
    const aZh = a.lan.startsWith("zh") || a.lan.includes("zh") ? 0 : 1;
    const bZh = b.lan.startsWith("zh") || b.lan.includes("zh") ? 0 : 1;
    if (aZh !== bZh) return aZh - bZh;
    if (typeRank[a.type] !== typeRank[b.type]) return typeRank[a.type] - typeRank[b.type];
    return a.lanDoc.localeCompare(b.lanDoc, "zh-CN");
  });
  return tracks;
}

export async function getSubtitleSegments(url: string): Promise<SubtitleBodyItem[]> {
  const normalized = normalizeSubtitleUrl(url);
  if (!normalized) throw new BiliError("invalid_url", "invalid_url", "字幕地址不在允许的域名内");
  let response: Response;
  try {
    response = await fetch(normalized, { credentials: "include", cache: "no-store" });
  } catch (error) {
    throw new BiliError("network", "network", `字幕下载失败：${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new BiliError("network", response.status, `字幕下载失败（HTTP ${response.status}）`);
  }
  const payload = (await response.json()) as { body?: SubtitleBodyItem[] };
  const body = payload.body;
  if (!Array.isArray(body) || body.length === 0) {
    throw new BiliError("empty", "subtitle_empty", "字幕返回了空内容");
  }
  return body
    .map((item) => ({
      from: Math.max(0, Number(item.from) || 0),
      to: Math.max(0, Number(item.to) || 0),
      content: String(item.content || "").replace(/[\r\n]+/g, " ").replace(/​/g, "").trim(),
    }))
    .filter((item) => item.content.length > 0)
    .map((item) => ({ ...item, to: Math.max(item.from, item.to) }));
}

function audioUrl(raw: BiliAudioRaw): string {
  return raw.baseUrl || raw.base_url || "";
}

export async function getAudioTrack(bvid: string, cid: string): Promise<NormalizedAudio> {
  const signed = await signWbi({ bvid, cid, fnval: 4048, fnver: 0, fourk: 1, platform: "pc" });
  const data = await getJson<BiliPlayUrlData>(`https://api.bilibili.com/x/player/wbi/playurl?${toQuery(signed)}`);
  const audios = (data.dash?.audio || []).filter((item) => Boolean(audioUrl(item)));
  if (audios.length === 0) {
    throw new BiliError(
      "unsupported",
      "no_audio",
      "当前未取得独立音频流（可能需要登录，或该视频类型暂不支持）",
    );
  }
  const aac = audios.filter((item) => {
    const marker = `${item.mimeType || item.mime_type || ""} ${item.codecs || ""}`.toLowerCase();
    return marker.includes("mp4a") || marker.includes("audio/mp4");
  });
  const candidates = (aac.length ? aac : audios).slice().sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
  const chosen = candidates.find((item) => (item.bandwidth || 0) >= 64000) || candidates[0];
  const durationMs = Math.round((data.dash?.duration || 0) * 1000);
  const bandwidth = chosen.bandwidth || 0;
  const url = audioUrl(chosen);
  const backupUrls = (chosen.backupUrl || chosen.backup_url || [])
    .map((item) => normalizeSubtitleUrl(item))
    .filter((item): item is string => Boolean(item));
  return {
    id: String(chosen.id ?? "audio"),
    url,
    backupUrls,
    bandwidth,
    mimeType: chosen.mimeType || chosen.mime_type || "audio/mp4",
    codecs: chosen.codecs || "",
    durationMs,
    estimatedBytes: bandwidth && durationMs ? Math.round((durationMs / 1000) * (bandwidth / 8)) : 0,
  };
}
