import {
  AlertTriangle,
  ArrowRight,
  AudioLines,
  FileText,
  Loader2,
  RefreshCw,
  Settings2,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import type { Job, Revision } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { JobList } from "@/components/jobs/JobList";
import { TaskStatus } from "@/components/jobs/TaskStatus";
import { RevisionList } from "@/components/revisions/RevisionList";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { SummaryView } from "@/components/summary/SummaryView";
import { EmptyState } from "@/components/transcript/EmptyState";
import { TranscriptProse } from "@/components/transcript/TranscriptProse";
import { TranscriptToolbar } from "@/components/transcript/TranscriptToolbar";
import { VideoHeader } from "@/components/transcript/VideoHeader";
import { useApp, type MainTab } from "@/sidepanel/state";
import { formatBytes, formatDuration, formatTime, sourceTypeLabel } from "@/lib/utils";

function isActive(job: Job): boolean {
  return ["CREATED", "QUEUED", "RUNNING", "CANCEL_REQUESTED"].includes(job.status);
}

function typeLabel(type: string): string {
  if (type === "human") return "人工";
  if (type === "ai") return "AI";
  return "未知";
}

export function App() {
  const { state, actions } = useApp();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [state.tab, state.activeRevisionId]);

  const autoFallbackTried = useRef(new Set<string>());
  useEffect(() => {
    if (state.demo || state.phase !== "ready" || state.tracksLoading) return;
    if (!state.settings.autoAsrFallback || !state.capabilities) return;
    if (state.document || state.tracks.length > 0 || state.audioConfirm || state.audioRunning) return;
    if (!state.video) return;
    const key = `${state.video.bvid}:${state.video.cid}`;
    if (autoFallbackTried.current.has(key)) return;
    autoFallbackTried.current.add(key);
    void actions.prepareAudio();
  }, [
    state.demo,
    state.phase,
    state.tracksLoading,
    state.tracks.length,
    state.document,
    state.settings.autoAsrFallback,
    state.capabilities,
    state.video,
    state.audioConfirm,
    state.audioRunning,
    actions,
  ]);

  const activeJob = useMemo(() => state.jobs.find(isActive) ?? null, [state.jobs]);
  const hasTranscript = Boolean(
    state.document?.revisions.some((revision) => revision.kind === "cleaned" || revision.kind === "edited"),
  );
  const pendingCount = state.revision?.corrections.filter((item) => item.status === "pending").length ?? 0;
  const pendingBlockIds = useMemo(
    () =>
      new Set(
        (state.revision?.corrections ?? [])
          .filter((item) => item.status === "pending")
          .map((item) => item.blockId),
      ),
    [state.revision],
  );
  const localRevision = useMemo<Revision | null>(() => {
    if (!state.localSource || !state.video) return null;
    return {
      id: "local",
      documentId: "local",
      parentRevisionId: null,
      kind: "original",
      sourceId: null,
      blocks: state.localSource.segments.map((segment, index) => ({
        id: `local_block_${index}`,
        sourceSegmentIds: [segment.id],
        text: segment.text,
        startMs: segment.startMs,
        endMs: segment.endMs,
      })),
      corrections: [],
      appliedEdits: [],
      contentHash: "",
      pipelineVersion: "local",
      glossaryVersion: "",
      createdBy: "source",
      createdAt: state.localSource.fetchedAt,
    };
  }, [state.localSource, state.video]);

  const selectedTrack = state.tracks.find((track) => track.id === state.selectedTrackId) ?? state.tracks[0];
  const summaryJob = state.jobs.find((job) => job.type === "summarize" && isActive(job));

  const handleExtract = () => {
    void actions.startExtract();
  };
  const handleSummary = () => {
    void actions.startSummary();
  };

  if (state.screen === "settings") {
    return <SettingsPage state={state} actions={actions} />;
  }

  const serviceBadge = (
    <button
      type="button"
      onClick={actions.openSettings}
      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted hover:bg-surface"
      title="打开任务服务设置"
    >
      <span
        className={
          "h-1.5 w-1.5 rounded-full " +
          (state.serviceLoading
            ? "bg-warning"
            : state.capabilities
              ? "bg-success"
              : "bg-destructive")
        }
      />
      {state.serviceLoading ? "连接中" : state.capabilities ? "服务已连接" : "服务未连接"}
    </button>
  );

  return (
    <Tabs
      value={state.tab}
      onValueChange={(value) => actions.switchTab(value as MainTab)}
      className="flex h-full flex-col bg-background"
    >
      <header className="shrink-0 space-y-2.5 border-b border-border px-4 pb-2.5 pt-2.5">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <FileText className="h-4 w-4 text-primary" />
            文字稿助手
          </div>
          <div className="ml-auto flex items-center gap-0.5">
            {serviceBadge}
            <Button variant="ghost" size="sm" className="px-2 text-xs" onClick={actions.openSettings}>
              <Settings2 className="h-4 w-4" />
              设置
            </Button>
          </div>
        </div>

        {state.phase === "no-video" ? (
          <div className="rounded-md bg-surface px-3 py-2 text-xs leading-[18px] text-muted">
            {state.identity?.reason || state.videoError || "请打开一个 B 站普通视频页"}
          </div>
        ) : (
          <>
            <VideoHeader video={state.video} demo={state.demo} />
            {state.videoError && (
              <Alert variant="warning" className="px-2.5 py-2">
                <AlertDescription className="mt-0">{state.videoError}</AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Button
                variant={hasTranscript ? "outline" : "default"}
                onClick={handleExtract}
                disabled={state.busy.extract || state.booting || !state.video}
              >
                {state.busy.extract ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                提取文字稿
              </Button>
              <Button
                variant={hasTranscript ? "default" : "outline"}
                onClick={handleSummary}
                disabled={state.busy.summary || state.booting || !state.video}
              >
                {state.busy.summary ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                总结视频
              </Button>
            </div>

            {!state.document && state.tracks.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="shrink-0 text-xs text-muted">字幕来源</span>
                <Select value={state.selectedTrackId} onValueChange={actions.selectTrack}>
                  <SelectTrigger className="h-7 min-w-0 flex-1 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {state.tracks.map((track) => (
                      <SelectItem key={track.id} value={track.id}>
                        {track.lanDoc}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Badge variant={selectedTrack?.type === "human" ? "success" : selectedTrack?.type === "ai" ? "warning" : "outline"}>
                  {typeLabel(selectedTrack?.type || "unknown")}
                </Badge>
              </div>
            )}
            {!state.document && state.tracksLoading && (
              <div className="flex items-center gap-1.5 text-xs text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在查询字幕轨…
              </div>
            )}
            {!state.document && !state.tracksLoading && state.tracks.length === 0 && (
              <Alert variant="warning" className="px-2.5 py-2">
                <AlertTitle className="flex items-center gap-1.5 text-xs">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  当前未取得可用字幕
                </AlertTitle>
                <AlertDescription>
                  {state.tracksError?.message || "可以改用音频转写；登录后可能取得字幕。"}
                </AlertDescription>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void actions.prepareAudio()}>
                    <AudioLines className="h-3.5 w-3.5" /> 转写音频
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void actions.reboot()}>
                    <RefreshCw className="h-3.5 w-3.5" /> 重新识别
                  </Button>
                </div>
              </Alert>
            )}

            {activeJob && (
              <TaskStatus job={activeJob} onCancel={(id) => void actions.cancelJob(id)} />
            )}

            {state.audioRunning && state.audioUpload && (
              <Alert variant="info" className="space-y-1.5 px-2.5 py-2">
                <AlertTitle className="flex items-center gap-1.5 text-xs">
                  <UploadCloud className="h-3.5 w-3.5" />
                  {state.audioUpload.message}
                </AlertTitle>
                <Progress
                  value={
                    state.audioUpload.totalBytes
                      ? (state.audioUpload.uploadedBytes / state.audioUpload.totalBytes) * 100
                      : null
                  }
                />
                <div className="flex items-center justify-between text-xs text-muted">
                  <span>
                    {formatBytes(state.audioUpload.uploadedBytes)} / {formatBytes(state.audioUpload.totalBytes)} · 处理端{" "}
                    {state.settings.serviceUrl}
                  </span>
                  <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={actions.cancelAudioUpload}>
                    暂停
                  </Button>
                </div>
              </Alert>
            )}

            {state.actionError && (
              <Alert variant="destructive" className="flex items-start gap-2 px-2.5 py-2">
                <AlertDescription className="mt-0 flex-1 text-xs">{state.actionError}</AlertDescription>
                <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0" onClick={actions.dismissError} aria-label="关闭错误提示">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </Alert>
            )}
            {state.notice && (
              <Alert variant="info" className="flex items-start gap-2 px-2.5 py-2">
                <AlertDescription className="mt-0 flex-1 text-xs">{state.notice}</AlertDescription>
                <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0" onClick={actions.dismissNotice} aria-label="关闭提示">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </Alert>
            )}
            {state.serviceError && !state.capabilities && !state.audioRunning && (
              <Alert variant="warning" className="px-2.5 py-2">
                <AlertDescription className="mt-0 flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="min-w-0 flex-1">任务服务未连接，仍可提取并导出原始字幕。</span>
                  <Button variant="outline" size="sm" className="h-6 text-xs" onClick={actions.openSettings}>
                    连接服务
                  </Button>
                </AlertDescription>
              </Alert>
            )}
          </>
        )}

        {state.phase !== "no-video" && (
          <TabsList className="grid h-8 w-full grid-cols-4">
            <TabsTrigger value="transcript" className="text-xs">
              文字稿
            </TabsTrigger>
            <TabsTrigger value="summary" className="text-xs">
              总结
            </TabsTrigger>
            <TabsTrigger value="revisions" className="gap-1 text-xs">
              修订
              {pendingCount > 0 && <Badge variant="warning">{pendingCount}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="jobs" className="gap-1 text-xs">
              任务
              {activeJob && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
            </TabsTrigger>
          </TabsList>
        )}
      </header>

      <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {state.phase === "no-video" ? (
          <EmptyState
            icon={FileText}
            title="打开一个 B 站视频"
            description="在 Chrome 或 Edge 打开 bilibili.com 的普通视频页，再点击扩展图标。首版支持当前分 P，番剧、直播和互动视频暂不支持。"
            className="pt-16"
          >
            <Button variant="outline" size="sm" onClick={actions.openSettings}>
              打开设置
            </Button>
          </EmptyState>
        ) : (
          <>
            <TabsContent value="transcript" className="pt-3">
              {state.booting ? (
                <div className="space-y-3 pt-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-4/5" />
                </div>
              ) : state.revision ? (
                <>
                  <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    <span>{sourceTypeLabel(state.document?.source?.type)}</span>
                    {state.document?.source && <span>· {state.document.source.segmentCount} 段</span>}
                    {state.document?.source && (
                      <span>
                        · {formatTime(state.document.source.startMs)}–{formatTime(state.document.source.endMs)}
                      </span>
                    )}
                    {pendingCount > 0 && (
                      <button
                        type="button"
                        className="ml-auto inline-flex items-center gap-0.5 text-warning hover:underline"
                        onClick={() => actions.switchTab("revisions")}
                      >
                        {pendingCount} 处待核对 <ArrowRight className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <TranscriptToolbar
                    revisions={state.document?.revisions ?? []}
                    activeRevisionId={state.activeRevisionId}
                    onSelect={(id) => void actions.selectRevision(id)}
                    onCopy={() => void actions.copyTranscript()}
                    onExport={(which) => void actions.exportCurrent(which)}
                  />
                  <div className="pt-3">
                    <TranscriptProse
                      video={state.video!}
                      revision={state.revision}
                      showTimestamps={state.settings.showTimestamps}
                      pendingBlockIds={pendingBlockIds}
                    />
                  </div>
                </>
              ) : state.localSource && localRevision ? (
                <>
                  <Alert variant="info" className="mt-3 px-2.5 py-2">
                    <AlertDescription className="mt-0">
                      当前显示本地缓存的 B站原始字幕，尚未经过任务服务清洗。
                    </AlertDescription>
                  </Alert>
                  <div className="mt-2">
                    <TranscriptToolbar
                      revisions={[]}
                      activeRevisionId={null}
                      localMode
                      onSelect={() => undefined}
                      onCopy={() => void actions.copyTranscript()}
                      onExport={(which) => void actions.exportCurrent(which)}
                    />
                  </div>
                  <div className="pt-3">
                    <TranscriptProse
                      video={state.video!}
                      revision={localRevision}
                      showTimestamps={state.settings.showTimestamps}
                    />
                  </div>
                </>
              ) : state.videoError ? (
                <EmptyState
                  icon={AlertTriangle}
                  title="无法识别当前视频"
                  description={state.videoError}
                  className="pt-12"
                >
                  <Button size="sm" onClick={() => void actions.reboot()}>
                    <RefreshCw className="h-3.5 w-3.5" /> 重试
                  </Button>
                </EmptyState>
              ) : (
                <EmptyState
                  icon={state.tracks.length ? FileText : AudioLines}
                  title={state.tracks.length ? "可以开始提取" : "还没有文字稿"}
                  description={
                    state.tracks.length
                      ? `已找到 ${state.tracks.length} 条字幕轨。提取后会先保存原始稿，再按当前清洗强度生成整理稿。`
                      : "字幕不可用时可以改用音频转写；登录后也可能取得字幕，可先重新识别。"
                  }
                  className="pt-12"
                >
                  {state.tracks.length > 0 && (
                    <Button size="sm" onClick={handleExtract} disabled={state.busy.extract}>
                      {state.busy.extract ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                      提取文字稿
                    </Button>
                  )}
                </EmptyState>
              )}
            </TabsContent>

            <TabsContent value="summary" className="pt-3">
              {state.summary && state.video ? (
                <SummaryView
                  video={state.video}
                  summary={state.summary}
                  revision={state.revision}
                  activeRevisionId={state.activeRevisionId}
                  generating={state.busy.summary || Boolean(summaryJob)}
                  onRegenerate={() => void actions.startSummary(true)}
                />
              ) : summaryJob ? (
                <div className="space-y-3 pt-3">
                  <TaskStatus job={summaryJob} onCancel={(id) => void actions.cancelJob(id)} />
                  <EmptyState title="正在生成总结" description="总结会复用当前文稿版本，长视频按章节分块处理。" className="py-8" />
                </div>
              ) : (
                <EmptyState
                  icon={Sparkles}
                  title="还没有总结"
                  description={
                    state.document
                      ? "基于当前文稿生成概览、章节要点、结论和材料覆盖说明。"
                      : "总结会先自动提取字幕或转写音频，再复用已有材料生成。"
                  }
                  className="pt-12"
                >
                  <Button size="sm" onClick={handleSummary} disabled={state.busy.summary}>
                    {state.busy.summary ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    总结视频
                  </Button>
                </EmptyState>
              )}
            </TabsContent>

            <TabsContent value="revisions" className="pt-3">
              <RevisionList
                revision={state.revision}
                document={state.document}
                video={state.video}
                busy={state.busy.extract}
                onResolve={actions.resolveCorrections}
              />
            </TabsContent>

            <TabsContent value="jobs" className="pt-3">
              <div className="space-y-3">
                <div className="rounded-md border border-border px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        "h-2 w-2 rounded-full " + (state.capabilities ? "bg-success" : "bg-destructive")
                      }
                    />
                    <span className="text-sm font-medium">
                      {state.capabilities ? "任务服务已连接" : "任务服务未连接"}
                    </span>
                    <Badge variant="outline" className="ml-auto">
                      {state.capabilities?.appVersion || "未连接"}
                    </Badge>
                  </div>
                  <div className="mt-1.5 space-y-0.5 text-xs leading-[18px] text-muted">
                    <p className="truncate">地址：{state.settings.serviceUrl}</p>
                    {state.capabilities && (
                      <p>
                        模型：{state.capabilities.llm.configured ? state.capabilities.llm.model : "仅规则清洗"} · ASR：
                        {state.capabilities.asr.configured ? state.capabilities.asr.defaultProvider : "未配置"}
                      </p>
                    )}
                    {state.serviceError && <p className="text-destructive">{state.serviceError}</p>}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void actions.refreshAll()}>
                      <RefreshCw className="h-3.5 w-3.5" /> 刷新
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={actions.openSettings}>
                      <Settings2 className="h-3.5 w-3.5" /> 设置
                    </Button>
                  </div>
                </div>

                {state.uploadCheckpoint && !state.audioRunning && (
                  <Alert variant="warning" className="space-y-1.5 px-2.5 py-2">
                    <AlertTitle className="flex items-center gap-1.5 text-xs">
                      <UploadCloud className="h-3.5 w-3.5" />
                      发现未完成的音频上传
                    </AlertTitle>
                    <AlertDescription>
                      已上传 {formatBytes(state.uploadCheckpoint.size)} 的音频分块。继续上传会跳过服务端已有的块。
                    </AlertDescription>
                    <div className="flex gap-1.5">
                      <Button size="sm" className="h-7 text-xs" onClick={() => void actions.resumeAudio()}>
                        继续上传
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => actions.switchTab("transcript")}>
                        前往文字稿
                      </Button>
                    </div>
                  </Alert>
                )}

                {state.audioUpload && state.audioRunning && (
                  <div className="rounded-md border border-border px-3 py-2">
                    <div className="flex items-center justify-between text-xs">
                      <span>{state.audioUpload.message}</span>
                      <span>{formatBytes(state.audioUpload.totalBytes)}</span>
                    </div>
                    <Progress
                      className="mt-1.5"
                      value={
                        state.audioUpload.totalBytes
                          ? (state.audioUpload.uploadedBytes / state.audioUpload.totalBytes) * 100
                          : null
                      }
                    />
                  </div>
                )}

                <JobList jobs={state.jobs} onCancel={(id) => void actions.cancelJob(id)} />

                <div className="pt-1 text-center text-xs leading-[18px] text-muted">
                  任务提交后由独立 worker 执行。关闭侧栏不会中断已提交的任务；未完成的音频下载需要重新打开侧栏继续。
                </div>
              </div>
            </TabsContent>
          </>
        )}
      </main>

      <AlertDialog
        open={Boolean(state.audioConfirm)}
        onOpenChange={(open) => {
          if (!open) actions.dismissAudioConfirm();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>上传音频并转写？</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1.5">
                <p>音频字节将发送到任务服务地址进行处理：</p>
                <p className="break-all rounded-sm bg-surface px-2 py-1 font-mono text-xs text-foreground">
                  {state.settings.serviceUrl}
                </p>
                {state.audioConfirm && (
                  <ul className="space-y-0.5 text-xs">
                    <li>音频大小：{formatBytes(state.audioConfirm.size)}</li>
                    <li>音频时长：{formatDuration(state.audioConfirm.audio.durationMs)}</li>
                    <li>编码：{state.audioConfirm.audio.codecs || state.audioConfirm.audio.mimeType}</li>
                    <li>原始音频将在转写完成后按服务设置自动删除（默认 24 小时）。</li>
                  </ul>
                )}
                <p>上传过程中关闭侧栏会暂停上传，可重新打开后继续。提交后的转写任务会继续执行。</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void actions.confirmAudio()}>开始上传</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Tabs>
  );
}
