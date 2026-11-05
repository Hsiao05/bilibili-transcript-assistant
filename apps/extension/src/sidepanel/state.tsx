import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import type {
  Capabilities,
  DocumentBundle,
  Job,
  Revision,
  Segment,
  Summary,
  VideoRef,
} from "@/contracts";
import type { BiliViewData, NormalizedAudio, NormalizedTrack } from "@/bilibili/types";
import { toVideoRef } from "@/bilibili/api";
import { ApiClient, ApiError } from "@/lib/api";
import { uploadAudio, probeAudioSize, type AudioUploadProgress } from "@/lib/audio";
import type { LocalTranscript, UploadCheckpoint } from "@/lib/idb";
import {
  getLocalTranscript,
  getUploadCheckpoint,
  identityKey,
  saveLocalTranscript,
} from "@/lib/idb";
import { buildDemo, type DemoData } from "@/lib/demo";
import { localFilename, localTranscriptMarkdown } from "@/lib/localMarkdown";
import type { BiliIdentity } from "@/lib/messages";
import { sendBackground, extensionAvailable } from "@/lib/messages";
import {
  DEFAULT_SETTINGS,
  applyTheme,
  ensureServicePermission,
  loadSettings,
  saveSettings as persistSettings,
  type ExtensionSettings,
} from "@/lib/settings";
import { formatTime, videoUrl } from "@/lib/utils";
export type MainTab = "transcript" | "summary" | "revisions" | "jobs";

export interface AppState {
  demo: boolean;
  booting: boolean;
  phase: "booting" | "no-video" | "ready";
  identity: BiliIdentity | null;
  video: VideoRef | null;
  videoError: string | null;
  tracks: NormalizedTrack[];
  tracksLoading: boolean;
  tracksError: { code: string; message: string } | null;
  selectedTrackId: string;
  serviceLoading: boolean;
  capabilities: Capabilities | null;
  serviceError: string | null;
  document: DocumentBundle | null;
  revision: Revision | null;
  activeRevisionId: string | null;
  summary: Summary | null;
  localSource: LocalTranscript | null;
  jobs: Job[];
  uploadCheckpoint: UploadCheckpoint | null;
  busy: { extract: boolean; summary: boolean; refresh: boolean; audio: boolean; clean: boolean };
  actionError: string | null;
  notice: string | null;
  audioConfirm: { audio: NormalizedAudio; size: number } | null;
  audioUpload: AudioUploadProgress | null;
  audioRunning: boolean;
  tab: MainTab;
  screen: "main" | "settings";
  settings: ExtensionSettings;
}

export interface AppActions {
  refreshAll: () => Promise<void>;
  reboot: () => Promise<void>;
  selectTrack: (id: string) => void;
  switchTab: (tab: MainTab) => void;
  startExtract: () => Promise<DocumentBundle | null>;
  startClean: () => Promise<void>;
  startSummary: (force?: boolean) => Promise<void>;
  prepareAudio: () => Promise<void>;
  confirmAudio: () => Promise<void>;
  resumeAudio: () => Promise<void>;
  cancelAudioUpload: () => void;
  dismissAudioConfirm: () => void;
  cancelJob: (id: string) => Promise<void>;
  selectRevision: (id: string) => Promise<void>;
  resolveCorrections: (
    acceptedIds: string[],
    keptIds: string[],
    manualEdits?: { correctionId: string; replacement: string }[],
  ) => Promise<void>;
  seekTo: (ms: number) => Promise<void>;
  copyTranscript: () => Promise<void>;
  exportCurrent: (which: "current" | "original" | "local") => Promise<void>;
  saveSettings: (next: ExtensionSettings) => Promise<{ ok: boolean; message: string }>;
  testConnection: (next: ExtensionSettings) => Promise<{ ok: boolean; message: string }>;
  getApi: () => ApiClient;
  openSettings: () => void;
  closeSettings: () => void;
  dismissError: () => void;
  dismissNotice: () => void;
  setTheme: (theme: ExtensionSettings["theme"]) => void;
}

export interface AppContextValue {
  state: AppState;
  actions: AppActions;
}

const initialState: AppState = {
  demo: false,
  booting: true,
  phase: "booting",
  identity: null,
  video: null,
  videoError: null,
  tracks: [],
  tracksLoading: false,
  tracksError: null,
  selectedTrackId: "",
  serviceLoading: false,
  capabilities: null,
  serviceError: null,
  document: null,
  revision: null,
  activeRevisionId: null,
  summary: null,
  localSource: null,
  jobs: [],
  uploadCheckpoint: null,
  busy: { extract: false, summary: false, refresh: false, audio: false, clean: false },
  actionError: null,
  notice: null,
  audioConfirm: null,
  audioUpload: null,
  audioRunning: false,
  tab: "transcript",
  screen: "main",
  settings: DEFAULT_SETTINGS,
};

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function trackSourceType(track: NormalizedTrack): string {
  if (track.type === "human") return "bilibili_human_subtitle";
  if (track.type === "ai") return "bilibili_ai_subtitle";
  return "bilibili_subtitle_unknown";
}

function trackLanguage(track: NormalizedTrack, fallback: string): string {
  const lan = track.lan.replace(/^ai-/, "");
  if (!lan) return fallback;
  if (lan.startsWith("zh")) return "zh-CN";
  if (lan.startsWith("en")) return "en-US";
  if (lan.startsWith("ja")) return "ja-JP";
  return lan;
}

function latestRevisionId(bundle: DocumentBundle): string | null {
  const candidates = bundle.revisions.filter((item) => item.kind === "edited" || item.kind === "cleaned");
  if (candidates.length) return candidates[candidates.length - 1].id;
  return bundle.document.latestRevisionId || bundle.document.originalRevisionId;
}

function downloadText(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isActiveJob(job: Job): boolean {
  return ["CREATED", "QUEUED", "RUNNING", "CANCEL_REQUESTED"].includes(job.status);
}

function isTerminal(job: Job): boolean {
  return ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED", "NEEDS_INPUT"].includes(job.status);
}

export function useAppController(): AppContextValue {
  const [state, setState] = useState<AppState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const demosRef = useRef<Record<string, Revision>>({});
  const demoSummaryRef = useRef<Summary | null>(null);
  const bootEpoch = useRef(0);
  const handledJobs = useRef(new Set<string>());
  const pendingSummary = useRef(false);
  const uploadAbort = useRef<AbortController | null>(null);

  const patch = useCallback((partial: Partial<AppState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  const apiFor = useCallback((settings: ExtensionSettings) => {
    return new ApiClient(settings.serviceUrl, settings.serviceToken);
  }, []);

  const getApi = useCallback(() => {
    const settings = stateRef.current.settings;
    return new ApiClient(settings.serviceUrl, settings.serviceToken);
  }, []);

  const applyDemo = useCallback((demo: DemoData, settings: ExtensionSettings) => {
    demosRef.current = demo.revisions;
    demoSummaryRef.current = demo.summary;
    const activeRevision = demo.revision ?? null;
    setState({
      ...initialState,
      demo: true,
      booting: false,
      phase: "ready",
      settings,
      video: demo.video,
      identity: { bvid: demo.video.bvid, page: demo.video.page, url: videoUrl(demo.video), supported: true },
      tracks: demo.tracks,
      selectedTrackId: demo.selectedTrackId,
      capabilities: demo.capabilities,
      serviceError: demo.serviceError,
      tracksError: demo.tracksError ? { code: "demo", message: demo.tracksError } : null,
      document: demo.document,
      revision: activeRevision,
      activeRevisionId: activeRevision?.id ?? null,
      summary: demo.summary,
      localSource: demo.localSource,
      jobs: demo.jobs,
      uploadCheckpoint: null,
    });
  }, []);

  const refreshAll = useCallback(async () => {
    const current = stateRef.current;
    if (current.demo || !current.video) return;
    const api = apiFor(current.settings);
    if (!api.configured) {
      patch({ serviceError: "尚未配置任务服务地址和访问令牌" });
      return;
    }
    patch({ busy: { ...current.busy, refresh: true } });
    try {
      const bundle = await api.findDocument(current.video);
      if (!bundle) {
        patch({
          document: null,
          revision: null,
          activeRevisionId: null,
          summary: null,
          jobs: [],
          serviceError: null,
        });
        return;
      }
      const target =
        current.activeRevisionId && bundle.revisions.some((item) => item.id === current.activeRevisionId)
          ? current.activeRevisionId
          : latestRevisionId(bundle);
      const revision =
        current.revision?.id === target && current.revision
          ? current.revision
          : target
            ? await api.getRevision(bundle.document.id, target)
            : null;
      const jobs = await api.listJobs(bundle.document.id);
      patch({
        document: bundle,
        revision,
        activeRevisionId: revision?.id ?? null,
        summary: bundle.summary,
        jobs,
        serviceError: null,
      });
    } catch (error) {
      patch({ serviceError: errorText(error) });
    } finally {
      patch({ busy: { ...stateRef.current.busy, refresh: false } });
    }
  }, [apiFor, patch]);

  const bootTab = useCallback(
    async (settings: ExtensionSettings) => {
      if (!extensionAvailable()) {
        patch({ booting: false, phase: "no-video", videoError: "请在 Chrome 或 Edge 扩展环境打开侧栏" });
        return;
      }
      const epoch = ++bootEpoch.current;
      patch({
        booting: true,
        phase: stateRef.current.video ? "ready" : "booting",
        videoError: null,
        actionError: null,
        tracksLoading: true,
        serviceLoading: true,
        tracksError: null,
      });
      try {
        const identity = await sendBackground<BiliIdentity>("identity:current");
        if (epoch !== bootEpoch.current) return;
        if (!identity.supported) {
          patch({
            phase: "no-video",
            identity,
            booting: false,
            tracksLoading: false,
            serviceLoading: false,
            video: null,
            tracks: [],
            selectedTrackId: "",
          });
          return;
        }
        patch({ identity });
        let view: BiliViewData;
        try {
          view = await sendBackground<BiliViewData>("bili:view", { bvid: identity.bvid });
        } catch (error) {
          if (epoch !== bootEpoch.current) return;
          patch({ videoError: errorText(error), booting: false, tracksLoading: false, serviceLoading: false });
          return;
        }
        if (epoch !== bootEpoch.current) return;
        const video = toVideoRef(view, identity.page);
        const pageMismatch = video.page !== identity.page;
        patch({
          video,
          phase: "ready",
          booting: false,
          videoError: pageMismatch ? `分P ${identity.page} 不存在，已切换到第 ${video.page} P` : null,
        });

        const api = apiFor(settings);
        let capabilities: Capabilities | null = null;
        try {
          if (!api.configured) throw new Error("尚未配置任务服务地址和访问令牌");
          capabilities = await api.capabilities();
          patch({ capabilities, serviceError: null, serviceLoading: false });
        } catch (error) {
          if (epoch !== bootEpoch.current) return;
          patch({ capabilities: null, serviceError: errorText(error), serviceLoading: false });
        }

        try {
          const player = await sendBackground<{ tracks: NormalizedTrack[] }>("bili:player", {
            bvid: video.bvid,
            cid: video.cid,
          });
          if (epoch !== bootEpoch.current) return;
          const chosen =
            player.tracks.find((track) => track.id === stateRef.current.selectedTrackId)?.id ??
            player.tracks[0]?.id ??
            "";
          patch({ tracks: player.tracks, selectedTrackId: chosen, tracksLoading: false, tracksError: null });
        } catch (error) {
          if (epoch !== bootEpoch.current) return;
          patch({
            tracks: [],
            selectedTrackId: "",
            tracksLoading: false,
            tracksError: { code: "track_error", message: errorText(error) },
          });
        }

        const local = await getLocalTranscript(video);
        const checkpoint = await getUploadCheckpoint(identityKey(video));
        if (epoch !== bootEpoch.current) return;
        patch({ localSource: local, uploadCheckpoint: checkpoint });

        if (capabilities) {
          try {
            const bundle = await api.findDocument(video);
            if (epoch !== bootEpoch.current) return;
            if (bundle) {
              const target = latestRevisionId(bundle);
              const revision = target ? await api.getRevision(bundle.document.id, target) : null;
              const jobs = await api.listJobs(bundle.document.id);
              if (epoch !== bootEpoch.current) return;
              patch({
                document: bundle,
                revision,
                activeRevisionId: revision?.id ?? null,
                summary: bundle.summary,
                jobs,
              });
            } else {
              patch({ document: null, revision: null, activeRevisionId: null, summary: null, jobs: [] });
            }
          } catch (error) {
            if (epoch !== bootEpoch.current) return;
            patch({ serviceError: errorText(error) });
          }
        }
      } catch (error) {
        patch({ booting: false, videoError: errorText(error), tracksLoading: false, serviceLoading: false });
      } finally {
        if (epoch === bootEpoch.current) {
          patch({ booting: false, tracksLoading: false });
        }
      }
    },
    [apiFor, patch],
  );

  useEffect(() => {
    let cancelled = false;
    const demoParam = new URLSearchParams(window.location.search).get("demo");
    const demoMode = demoParam !== null;
    void (async () => {
      const settings = await loadSettings();
      applyTheme(settings.theme);
      if (cancelled) return;
      patch({ settings });
      if (demoMode) {
        applyDemo(buildDemo(demoParam), { ...settings, serviceToken: settings.serviceToken || "demo-token" });
        return;
      }
      await bootTab(settings);
    })();

    if (!demoMode && extensionAvailable()) {
      const listener = (message: { type?: string; identity?: BiliIdentity }) => {
        if (message?.type !== "page:changed" || !message.identity?.supported) return;
        const current = stateRef.current.video;
        if (current && current.bvid === message.identity.bvid && current.page === message.identity.page) return;
        if (stateRef.current.demo) return;
        void bootTab(stateRef.current.settings);
      };
      chrome.runtime.onMessage.addListener(listener);
      return () => {
        cancelled = true;
        chrome.runtime.onMessage.removeListener(listener);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [applyDemo, bootTab, patch]);

  // Poll active jobs.
  useEffect(() => {
    if (state.demo) return;
    const active = state.jobs.filter(isActiveJob);
    if (!active.length) return;
    let cancelled = false;
    const api = apiFor(state.settings);
    if (!api.configured) return;

    const tick = async () => {
      for (const job of active) {
        try {
          const updated = await api.getJob(job.id);
          if (cancelled) return;
          setState((prev) => ({
            ...prev,
            jobs: (() => {
              const exists = prev.jobs.some((item) => item.id === updated.id);
              return exists
                ? prev.jobs.map((item) => (item.id === updated.id ? updated : item))
                : [updated, ...prev.jobs];
            })(),
          }));
          if (isTerminal(updated) && !handledJobs.current.has(updated.id)) {
            handledJobs.current.add(updated.id);
            await handleTerminalJob(updated);
          }
        } catch {
          // Transient poll failures are ignored; the next tick retries.
        }
      }
    };

    const handleTerminalJob = async (job: Job) => {
      if (job.status === "SUCCEEDED" || job.status === "PARTIAL") {
        toast.success(job.type === "summarize" ? "总结已生成" : "处理完成");
        await refreshAll();
        if (job.type === "clean" && pendingSummary.current) {
          pendingSummary.current = false;
          const result = (job.result || {}) as { documentId?: string; revisionId?: string };
          await enqueueSummary(result.documentId || job.documentId, result.revisionId || job.revisionId);
        }
      } else if (job.status === "NEEDS_INPUT" || job.status === "FAILED") {
        const message = job.error?.message || "任务处理失败";
        patch({ actionError: message });
        toast.error(message);
      }
    };

    const enqueueSummary = async (documentId?: string | null, revisionId?: string | null) => {
      if (!documentId || !revisionId) return;
      try {
        const created = await api.createJob({
          type: "summarize",
          documentId,
          revisionId,
          idempotencyKey: `summary:${documentId}:${revisionId}`,
        });
        setState((prev) => ({
          ...prev,
          jobs: prev.jobs.some((item) => item.id === created.id) ? prev.jobs : [created, ...prev.jobs],
          tab: "summary",
        }));
      } catch (error) {
        patch({ actionError: errorText(error) });
      }
    };

    void tick();
    const timer = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [state.jobs, state.demo, state.settings.serviceUrl, state.settings.serviceToken, apiFor, patch, refreshAll]);

  const selectTrack = useCallback((id: string) => patch({ selectedTrackId: id }), [patch]);

  const reboot = useCallback(async () => {
    await bootTab(stateRef.current.settings);
  }, [bootTab]);

  const switchTab = useCallback((tab: MainTab) => patch({ tab }), [patch]);

  const selectRevision = useCallback(
    async (id: string) => {
      const current = stateRef.current;
      if (!current.document) return;
      try {
        let revision: Revision | null = null;
        if (current.demo) {
          revision = demosRef.current[id] ?? null;
        } else {
          revision = await apiFor(current.settings).getRevision(current.document.document.id, id);
        }
        if (revision) patch({ revision, activeRevisionId: revision.id });
      } catch (error) {
        toast.error(errorText(error));
      }
    },
    [apiFor, patch],
  );

  const seekTo = useCallback(async (ms: number) => {
    const current = stateRef.current;
    if (current.demo) {
      toast.info(`演示模式：真实环境会跳到视频 ${formatTime(ms)} 处`);
      return;
    }
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs[0];
      if (!tab?.id) throw new Error("no active tab");
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "player:seek",
        seconds: Math.max(0, ms) / 1000,
      });
      if (!response?.ok) throw new Error(response?.error || "seek failed");
    } catch {
      toast.error("无法在当前页面跳转，请切回 B站视频页后重试");
    }
  }, []);

  const createCleanJob = useCallback(
    async (bundle: DocumentBundle, force = false) => {
      const current = stateRef.current;
      if (!current.video) return;
      const api = apiFor(current.settings);
      const base = bundle.document.originalRevisionId || bundle.document.latestRevisionId;
      if (!base) throw new Error("文稿缺少原始版本");
      const job = await api.createJob({
        type: "clean",
        documentId: bundle.document.id,
        revisionId: base,
        options: {
          strength: current.settings.strength,
          language: current.settings.language,
        },
        idempotencyKey: force
          ? `clean:${bundle.document.id}:${base}:${current.settings.strength}:retry:${Date.now()}`
          : `clean:${bundle.document.id}:${base}:${current.settings.strength}`,
      });
      setState((prev) => ({
        ...prev,
        jobs: prev.jobs.some((item) => item.id === job.id) ? prev.jobs : [job, ...prev.jobs],
        tab: "transcript",
      }));
    },
    [apiFor],
  );

  const startExtract = useCallback(async (): Promise<DocumentBundle | null> => {
    const current = stateRef.current;
    if (!current.video || current.busy.extract) return null;
    if (current.demo) {
      toast.info("演示模式：真实环境会在这里获取字幕并保存原始稿");
      patch({ tab: "transcript" });
      return null;
    }
    patch({ busy: { ...current.busy, extract: true }, actionError: null, tab: "transcript" });
    try {
      const api = apiFor(current.settings);
      if (!current.document) {
        const track = current.tracks.find((item) => item.id === current.selectedTrackId) ?? current.tracks[0];
        if (!track) {
          throw new Error("当前没有可用字幕轨，请使用音频转写");
        }
        const body = await sendBackground<{ segments: Segment[] }>("bili:subtitle", { url: track.url });
        if (!body.segments.length) throw new Error("字幕返回了空内容");
        const source: LocalTranscript = {
          video: current.video,
          sourceType: trackSourceType(track),
          trackId: track.id,
          language: trackLanguage(track, current.settings.language),
          segments: body.segments,
          fetchedAt: new Date().toISOString(),
        };
        await saveLocalTranscript(source);
        patch({ localSource: source });

        if (!api.configured) {
          toast.info("原始字幕已保存在本地。连接任务服务后可清洗并生成总结。");
          return null;
        }
        const bundle = await api.createDocument(current.video, {
          type: source.sourceType,
          trackId: track.id,
          language: source.language,
          segments: body.segments,
        });
        const originalId = bundle.document.originalRevisionId;
        const original = originalId ? await api.getRevision(bundle.document.id, originalId) : null;
        patch({
          document: bundle,
          revision: original,
          activeRevisionId: original?.id ?? null,
          summary: null,
          jobs: [],
        });
        toast.info("原始稿已保存。确认标点和分段后，点击「清洗文字稿」生成整理稿。");
        return bundle;
      }
      const cleaned = current.document.revisions.filter(
        (item) => item.kind === "cleaned" || item.kind === "edited",
      );
      if (cleaned.length) {
        await selectRevision(cleaned[cleaned.length - 1].id);
        toast.info("已有整理稿");
        return current.document;
      }
      const originalId = current.document.document.originalRevisionId;
      if (originalId && current.activeRevisionId !== originalId) {
        await selectRevision(originalId);
      }
      toast.info("已有原始稿，可点击「清洗文字稿」");
      return current.document;
    } catch (error) {
      const message = errorText(error);
      patch({ actionError: message });
      toast.error(message);
      return null;
    } finally {
      patch({ busy: { ...stateRef.current.busy, extract: false } });
    }
  }, [apiFor, patch, selectRevision]);

  const startClean = useCallback(async () => {
    const current = stateRef.current;
    if (!current.video || current.busy.clean) return;
    if (current.demo) {
      toast.info("演示模式：真实环境会在这里清洗文稿");
      return;
    }
    const api = apiFor(current.settings);
    if (!api.configured) {
      patch({ actionError: "请先在设置中连接任务服务" });
      toast.error("请先在设置中连接任务服务");
      return;
    }
    patch({ busy: { ...current.busy, clean: true }, actionError: null });
    try {
      let bundle = current.document;
      if (!bundle) {
        const source = current.localSource;
        if (!source) throw new Error("请先提取文字稿或转写音频");
        bundle = await api.createDocument(current.video, {
          type: source.sourceType,
          trackId: source.trackId,
          language: source.language,
          segments: source.segments,
        });
        patch({ document: bundle, summary: null, jobs: [] });
      }
      const hasCleanRevision = bundle.revisions.some(
        (item) => item.kind === "cleaned" || item.kind === "edited",
      );
      await createCleanJob(bundle, hasCleanRevision);
      toast.info(hasCleanRevision ? "已开始重新清洗" : "已开始清洗，可切换到其他页签");
    } catch (error) {
      const message = errorText(error);
      patch({ actionError: message });
      toast.error(message);
    } finally {
      patch({ busy: { ...stateRef.current.busy, clean: false } });
    }
  }, [apiFor, createCleanJob, patch]);

  const createSummaryJob = useCallback(
    async (documentId: string, revisionId: string, force: boolean) => {
      const current = stateRef.current;
      const api = apiFor(current.settings);
      const job = await api.createJob({
        type: "summarize",
        documentId,
        revisionId,
        idempotencyKey: force
          ? `summary:${documentId}:${revisionId}:retry:${Date.now()}`
          : `summary:${documentId}:${revisionId}`,
      });
      setState((prev) => ({
        ...prev,
        jobs: prev.jobs.some((item) => item.id === job.id) ? prev.jobs : [job, ...prev.jobs],
        tab: "summary",
      }));
    },
    [apiFor],
  );

  const startSummary = useCallback(
    async (force = false) => {
      const current = stateRef.current;
      if (current.busy.summary) return;
      if (current.demo) {
        toast.info("演示模式：真实环境会基于当前文稿生成总结");
        patch({ tab: "summary" });
        return;
      }
      const api = apiFor(current.settings);
      if (!api.configured) {
        patch({ actionError: "请先在设置中连接任务服务" });
        toast.error("请先在设置中连接任务服务");
        return;
      }
      if (!current.document) {
        pendingSummary.current = true;
        const bundle = await startExtract();
        if (!bundle) {
          pendingSummary.current = false;
          if (!stateRef.current.actionError) {
            patch({ actionError: "需要先取得字幕或转写音频，才能生成总结" });
          }
          return;
        }
        const ready = bundle.revisions.filter(
          (item) => item.kind === "cleaned" || item.kind === "edited",
        );
        if (ready.length) {
          pendingSummary.current = false;
          await createSummaryJob(bundle.document.id, ready[ready.length - 1].id, force);
        } else {
          pendingSummary.current = false;
          patch({ tab: "transcript" });
          toast.info("已提取原始稿，请先点击「清洗文字稿」，再生成总结");
        }
        return;
      }
      if (current.summary && !force) {
        patch({ tab: "summary" });
        toast.info("已有有效总结；如需重新生成，请在总结页点击重新生成");
        return;
      }
      const cleaned = current.document.revisions.filter(
        (item) => item.kind === "cleaned" || item.kind === "edited",
      );
      if (!cleaned.length) {
        patch({
          actionError: "当前只有原始稿，请先在文字稿页点击「清洗文字稿」，再生成总结",
          tab: "transcript",
        });
        toast.info("请先清洗文字稿");
        return;
      }
      const revisionId = cleaned[cleaned.length - 1].id;
      try {
        patch({ busy: { ...current.busy, summary: true } });
        await createSummaryJob(current.document.document.id, revisionId, force);
        toast.info("已开始生成总结");
      } catch (error) {
        patch({ actionError: errorText(error) });
      } finally {
        patch({ busy: { ...stateRef.current.busy, summary: false } });
      }
    },
    [apiFor, createSummaryJob, patch, startExtract],
  );

  const startAudioUpload = useCallback(
    async (audio: NormalizedAudio, size: number) => {
      const current = stateRef.current;
      if (!current.video) return;
      const api = apiFor(current.settings);
      if (!api.configured) throw new Error("请先在设置中连接任务服务");
      const controller = new AbortController();
      uploadAbort.current = controller;
      patch({
        audioRunning: true,
        audioConfirm: null,
        actionError: null,
        audioUpload: {
          phase: "prepare",
          downloadedBytes: 0,
          uploadedBytes: 0,
          totalBytes: size,
          chunkIndex: 0,
          chunkCount: 0,
          message: "准备上传",
        },
      });
      try {
        const result = await uploadAudio({
          api,
          video: current.video,
          audio,
          checkpointKey: identityKey(current.video),
          signal: controller.signal,
          onProgress: (progress) => patch({ audioUpload: progress }),
          refreshAudio: async () => {
            const refreshed = await sendBackground<NormalizedAudio>("bili:playurl", {
              bvid: current.video!.bvid,
              cid: current.video!.cid,
            });
            if (refreshed.id !== audio.id) throw new Error("音轨已变化，请重新开始");
            return refreshed;
          },
        });
        const job = await api.createJob({
          type: "transcribe",
          video: current.video,
          uploadId: result.uploadId,
          options: {
            autoClean: false,
            strength: current.settings.strength,
            language: current.settings.language,
            asrProvider: current.settings.asrProvider,
          },
          idempotencyKey: `transcribe:${current.video.bvid}:${current.video.cid}:${result.sha256}:${current.settings.strength}`,
        });
        setState((prev) => ({
          ...prev,
          audioConfirm: null,
          audioUpload: null,
          audioRunning: false,
          uploadCheckpoint: null,
          jobs: prev.jobs.some((item) => item.id === job.id) ? prev.jobs : [job, ...prev.jobs],
          tab: "transcript",
        }));
        toast.success("音频已提交，正在转写");
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          toast.info("已暂停上传，重新打开后可继续");
          patch({ notice: "上传已暂停。任务服务保留已上传的分块，可稍后继续。" });
        } else {
          const message = errorText(error);
          patch({ actionError: message, audioUpload: null });
          toast.error(message);
        }
        const checkpoint = await getUploadCheckpoint(identityKey(current.video));
        patch({ audioRunning: false, uploadCheckpoint: checkpoint, audioUpload: null });
      } finally {
        uploadAbort.current = null;
      }
    },
    [apiFor, patch],
  );

  const prepareAudio = useCallback(async () => {
    const current = stateRef.current;
    if (!current.video) return;
    if (current.demo) {
      toast.info("演示模式：真实环境会显示音频大小与处理端地址");
      return;
    }
    const api = apiFor(current.settings);
    if (!api.configured) {
      toast.error("请先在设置中连接任务服务");
      patch({ actionError: "请先在设置中连接任务服务" });
      return;
    }
    patch({ busy: { ...current.busy, audio: true }, actionError: null });
    try {
      const audio = await sendBackground<NormalizedAudio>("bili:playurl", {
        bvid: current.video.bvid,
        cid: current.video.cid,
      });
      const size = await probeAudioSize(audio);
      const limit = current.capabilities?.limits.maxUploadBytes;
      if (limit && size > limit) {
        throw new Error(`音频大小 ${Math.round(size / 1024 / 1024)} MB 超过服务上限 ${Math.round(limit / 1024 / 1024)} MB`);
      }
      patch({ audioConfirm: { audio, size } });
    } catch (error) {
      const message = errorText(error);
      patch({ actionError: message });
      toast.error(message);
    } finally {
      patch({ busy: { ...stateRef.current.busy, audio: false } });
    }
  }, [apiFor, patch]);

  const confirmAudio = useCallback(async () => {
    const current = stateRef.current;
    if (!current.audioConfirm) return;
    try {
      await startAudioUpload(current.audioConfirm.audio, current.audioConfirm.size);
    } catch (error) {
      const message = errorText(error);
      patch({ actionError: message });
      toast.error(message);
    }
  }, [patch, startAudioUpload]);

  const resumeAudio = useCallback(async () => {
    const current = stateRef.current;
    if (!current.video || !current.uploadCheckpoint) return;
    patch({ busy: { ...current.busy, audio: true }, actionError: null });
    try {
      const audio = await sendBackground<NormalizedAudio>("bili:playurl", {
        bvid: current.video.bvid,
        cid: current.video.cid,
      });
      const size = await probeAudioSize(audio);
      if (size !== current.uploadCheckpoint.size) {
        throw new Error("音频大小已变化，无法安全续传，请重新开始");
      }
      await startAudioUpload(audio, size);
    } catch (error) {
      const message = errorText(error);
      patch({ actionError: message });
      toast.error(message);
    } finally {
      patch({ busy: { ...stateRef.current.busy, audio: false } });
    }
  }, [patch, startAudioUpload]);

  const cancelAudioUpload = useCallback(() => {
    uploadAbort.current?.abort();
  }, []);

  const dismissAudioConfirm = useCallback(() => patch({ audioConfirm: null }), [patch]);

  const cancelJob = useCallback(
    async (id: string) => {
      const current = stateRef.current;
      if (current.demo) return;
      try {
        const job = await apiFor(current.settings).cancelJob(id);
        setState((prev) => ({ ...prev, jobs: prev.jobs.map((item) => (item.id === id ? job : item)) }));
        toast.info("已请求取消任务");
      } catch (error) {
        toast.error(errorText(error));
      }
    },
    [apiFor],
  );

  const resolveCorrections = useCallback(
    async (
      acceptedIds: string[],
      keptIds: string[],
      manualEdits: { correctionId: string; replacement: string }[] = [],
    ) => {
      const current = stateRef.current;
      if (!current.document || !current.revision) return;
      const manual = new Map(manualEdits.map((item) => [item.correctionId, item.replacement]));
      if (current.demo) {
        const revision = demosRef.current[current.revision.id];
        if (!revision) return;
        const blocks = revision.blocks.map((block) => ({ ...block }));
        const accepted = revision.corrections.filter((item) => acceptedIds.includes(item.id));
        const manualCorrections = revision.corrections.filter((item) => manual.has(item.id));
        for (const correction of [...accepted, ...manualCorrections]) {
          const block = blocks.find((item) => item.id === correction.blockId);
          const replacement = manual.get(correction.id) ?? correction.replacement;
          if (!block || !replacement) continue;
          block.text =
            block.text.slice(0, correction.startOffset) +
            replacement +
            block.text.slice(correction.endOffset);
        }
        const edited: Revision = {
          ...revision,
          id: `rev_demo_edited_${Date.now()}`,
          parentRevisionId: revision.id,
          kind: "edited",
          blocks,
          corrections: [],
          createdBy: "user",
          createdAt: new Date().toISOString(),
        };
        demosRef.current[edited.id] = edited;
        const bundle = current.document;
        const nextBundle: DocumentBundle = {
          ...bundle,
          document: { ...bundle.document, latestRevisionId: edited.id },
          revisions: [
            ...bundle.revisions,
            {
              id: edited.id,
              kind: "edited",
              createdBy: "user",
              createdAt: edited.createdAt,
              parentRevisionId: revision.id,
              blockCount: edited.blocks.length,
              pendingCount: 0,
            },
          ],
        };
        patch({
          revision: edited,
          activeRevisionId: edited.id,
          document: nextBundle,
        });
        toast.success("已创建人工修订稿（演示）");
        return;
      }
      try {
        const revision = await apiFor(current.settings).applyCorrections(
          current.document.document.id,
          current.revision.id,
          acceptedIds,
          keptIds,
          manualEdits,
        );
        patch({
          revision,
          activeRevisionId: revision.id,
          notice: "已生成人工修订稿。后续重新生成会保留原稿与本次修订。",
        });
        toast.success("修改已应用");
        await refreshAll();
      } catch (error) {
        const message = errorText(error);
        patch({ actionError: message });
        toast.error(message);
      }
    },
    [apiFor, patch, refreshAll],
  );

  const copyTranscript = useCallback(async () => {
    const current = stateRef.current;
    const text = current.revision
      ? current.revision.blocks.map((block) => block.text).join("\n\n")
      : current.localSource
        ? current.localSource.segments.map((segment) => segment.text).join("\n")
        : "";
    if (!text) {
      toast.error("当前没有可复制的文稿");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success("已复制文稿");
    } catch {
      toast.error("复制失败，请手动选择文本");
    }
  }, []);

  const exportCurrent = useCallback(
    async (which: "current" | "original" | "local") => {
      const current = stateRef.current;
      if (which === "local") {
        if (!current.localSource) {
          toast.error("没有本地原始字幕");
          return;
        }
        downloadText(
          localTranscriptMarkdown(current.localSource.video, current.localSource.segments, {
            includeTimestamps: current.settings.showTimestamps,
            sourceType: current.localSource.sourceType,
          }),
          localFilename(current.localSource.video),
        );
        return;
      }
      if (!current.document || !current.video) {
        toast.error("当前没有可导出的文稿");
        return;
      }
      if (current.demo) {
        const revision =
          which === "original"
            ? demosRef.current[current.document.document.originalRevisionId || ""]
            : current.revision;
        const segments = (revision?.blocks ?? []).map((block) => ({
          id: block.id,
          startMs: block.startMs,
          endMs: block.endMs,
          text: block.text,
        }));
        downloadText(
          localTranscriptMarkdown(current.video, segments, {
            includeTimestamps: current.settings.showTimestamps,
            sourceType: current.document.source?.type,
          }),
          localFilename(current.video),
        );
        return;
      }
      const revisionId =
        which === "original"
          ? current.document.document.originalRevisionId
          : current.revision?.id;
      if (!revisionId) {
        toast.error("找不到要导出的版本");
        return;
      }
      try {
        const result = await apiFor(current.settings).exportMarkdown(
          current.document.document.id,
          revisionId,
          {
            includeTimestamps: current.settings.showTimestamps,
            includeSummary: which !== "original",
            includeTerms: which !== "original",
          },
        );
        downloadText(result.text, result.filename);
        toast.success("已开始下载");
      } catch (error) {
        toast.error(errorText(error));
      }
    },
    [apiFor],
  );

  const testConnection = useCallback(
    async (next: ExtensionSettings) => {
      if (stateRef.current.demo) {
        return { ok: true, message: "演示模式：未发起真实连接" };
      }
      const api = new ApiClient(next.serviceUrl, next.serviceToken);
      try {
        const capabilities = await api.capabilities();
        patch({ capabilities, serviceError: null });
        return { ok: true, message: `已连接 ${capabilities.appVersion}（API ${capabilities.apiVersion}）` };
      } catch (error) {
        patch({ serviceError: errorText(error) });
        return { ok: false, message: errorText(error) };
      }
    },
    [patch],
  );

  const saveSettings = useCallback(
    async (next: ExtensionSettings) => {
      if (stateRef.current.demo) {
        applyTheme(next.theme);
        await persistSettings(next);
        patch({ settings: next });
        return { ok: true, message: "演示模式：设置已保存在本地" };
      }
      const granted = await ensureServicePermission(next.serviceUrl);
      if (!granted) return { ok: false, message: "需要授权扩展访问该任务服务地址" };
      applyTheme(next.theme);
      await persistSettings(next);
      patch({ settings: next });
      const result = await testConnection(next);
      if (result.ok && stateRef.current.video) {
        await refreshAll();
      }
      return result;
    },
    [patch, refreshAll, testConnection],
  );

  const openSettings = useCallback(() => patch({ screen: "settings" }), [patch]);
  const closeSettings = useCallback(() => patch({ screen: "main" }), [patch]);
  const dismissError = useCallback(() => patch({ actionError: null }), [patch]);
  const dismissNotice = useCallback(() => patch({ notice: null }), [patch]);
  const setTheme = useCallback(
    (theme: ExtensionSettings["theme"]) => {
      applyTheme(theme);
      setState((prev) => ({ ...prev, settings: { ...prev.settings, theme } }));
    },
    [],
  );

  const actions: AppActions = {
    refreshAll,
    reboot,
    selectTrack,
    switchTab,
    startExtract,
    startClean,
    startSummary,
    prepareAudio,
    confirmAudio,
    resumeAudio,
    cancelAudioUpload,
    dismissAudioConfirm,
    cancelJob,
    selectRevision,
    resolveCorrections,
    seekTo,
    copyTranscript,
    exportCurrent,
    saveSettings,
    testConnection,
    getApi,
    openSettings,
    closeSettings,
    dismissError,
    dismissNotice,
    setTheme,
  };

  return { state, actions };
}

export const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const value = useAppController();
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}
