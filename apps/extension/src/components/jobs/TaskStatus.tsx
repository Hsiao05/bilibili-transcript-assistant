import { Loader2 } from "lucide-react";

import type { Job } from "@/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

const STAGE_LABELS: Record<string, string> = {
  queued: "等待处理",
  starting: "准备处理",
  identifying: "识别视频",
  subtitle: "获取字幕",
  audio: "获取音频",
  asr: "语音识别",
  terms: "发现术语",
  clean: "清洗文稿",
  check: "一致性检查",
  summarize: "生成总结",
  done: "已完成",
};

const JOB_LABELS: Record<string, string> = {
  transcribe: "音频转写",
  clean: "文字清洗",
  summarize: "视频总结",
};

export function TaskStatus({ job, onCancel }: { job: Job; onCancel?: (id: string) => void }) {
  const percent = job.progress.percent;
  const label = job.progress.label || STAGE_LABELS[job.stage] || "处理中";
  return (
    <Alert variant="info" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <AlertTitle className="flex min-w-0 items-center gap-1.5 text-sm">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
          <span className="truncate">
            {JOB_LABELS[job.type] || job.type} · {label}
          </span>
        </AlertTitle>
        <Badge variant="outline" className="shrink-0 bg-background">
          {percent != null ? `${Math.round(percent)}%` : "进行中"}
        </Badge>
      </div>
      <Progress value={percent ?? null} />
      <div className="flex items-center justify-between gap-2">
        <AlertDescription className="line-clamp-1">
          {job.video?.title ? `视频：${job.video.title}` : "任务进行中，关闭侧栏后服务仍会继续处理"}
        </AlertDescription>
        {onCancel && (
          <Button variant="ghost" size="sm" className="h-6 shrink-0 px-1.5 text-xs" onClick={() => onCancel(job.id)}>
            取消
          </Button>
        )}
      </div>
    </Alert>
  );
}
