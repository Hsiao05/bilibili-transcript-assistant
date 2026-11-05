export interface BiliPage {
  cid: number | string;
  page: number;
  part: string;
  duration: number;
  first_frame?: string;
}

export interface BiliViewData {
  bvid: string;
  aid: number;
  cid: number | string;
  title: string;
  pic: string;
  desc?: string;
  duration: number;
  owner: { mid: number; name: string; face?: string };
  pages: BiliPage[];
}

export interface BiliSubtitleRaw {
  id?: number | string;
  id_str?: string;
  lan?: string;
  lan_doc?: string;
  subtitle_url?: string;
  subtitle_url_v2?: string;
  type?: number;
  ai_type?: number;
  is_lock?: boolean;
}

export interface BiliPlayerData {
  need_login_subtitle?: boolean;
  asr_language?: string;
  subtitle?: {
    allow_submit?: boolean;
    subtitles?: BiliSubtitleRaw[];
  };
}

export interface BiliAudioRaw {
  id?: number;
  baseUrl?: string;
  base_url?: string;
  backupUrl?: string[];
  backup_url?: string[];
  bandwidth?: number;
  mimeType?: string;
  mime_type?: string;
  codecs?: string;
  codecid?: number;
}

export interface BiliPlayUrlData {
  dash?: {
    duration?: number;
    audio?: BiliAudioRaw[];
  };
  durl?: unknown[];
}

export type SubtitleType = "human" | "ai" | "unknown";

export interface NormalizedTrack {
  id: string;
  lan: string;
  lanDoc: string;
  url: string;
  type: SubtitleType;
}

export interface NormalizedAudio {
  id: string;
  url: string;
  backupUrls: string[];
  bandwidth: number;
  mimeType: string;
  codecs: string;
  durationMs: number;
  estimatedBytes: number;
}

export interface SubtitleBodyItem {
  from: number;
  to: number;
  content: string;
}
