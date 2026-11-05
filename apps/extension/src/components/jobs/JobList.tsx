import { AlertCircle, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";

import type { Job } from "@/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/transcript/EmptyState";
import { cn } from "@/lib/utils";

const JOB_LABELS: Record<string, string> = {
  transcribe: "音频转写",
  clean: "文字清洗",
  summarize: "视频总结",
};

const STATUS_LABELS: Record<string, string> = {
  CREATED: "已创建",
  QUEUED: "排队中",
  RUNNING: "处理中",
  SUCCEEDED: "已完成",
  PARTIAL: "部分完成",
  NEEDS_INPUT: "需要处理",
  FAILED: "失败",
  CANCEL_REQUESTED: "正在取消",
  CANCELLED: "已取消",
};

function statusVariant(status: string): "secondary" | "success" | "warning" | "destructive" | "outline" {
  if (status === "SUCCEEDED") return "success";
  if (status === "FAILED") return "destructive";
  if (status === "NEEDS_INPUT" || status === "PARTIAL" || status === "CANCEL_REQUESTED") return "warning";
  if (status === "RUNNING" || status === "QUEUED") return "outline";
  return "secondary";
}

function StatusIcon({ status }: { status: string }) {
  if (status === "RUNNING") return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
  if (status === "SUCCEEDED") return <CheckCircle2 className="h-4 w-4 text-success" />;
  if (status === "FAILED") return <XCircle className="h-4 w-4 text-destructive" />;
  if (status === "NEEDS_INPUT" || status === "PARTIAL") return <AlertCircle className="h-4 w-4 text-warning" />;
  return <Clock className="h-4 w-4 text-muted" />;
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

export function JobList({ jobs, onCancel }: { jobs: Job[]; onCancel: (id: string) => void }) {
  if (!jobs.length) {
    return (
      <EmptyState
        title="还没有任务"
        description="提取文字稿或总结视频后，这里会显示任务阶段、进度和错误信息。关闭侧栏后，已提交的任务会继续在任务服务中执行。"
      />
    );
  }
  return (
    <div className="space-y-2">
      {jobs.map((job) => {
        const active = ["CREATED", "QUEUED", "RUNNING", "CANCEL_REQUESTED"].includes(job.status);
        return (
          <div key={job.id} className={cn("rounded-md border border-border px-3 py-2.5", active && "border-primary-soft")}>
            <div className="flex items-center gap-2">
              <StatusIcon status={job.status} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {JOB_LABELS[job.type] || job.type}
                {job.video?.title ? ` · ${job.video.title}` : ""}
              </span>
              <Badge variant={statusVariant(job.status)}>{STATUS_LABELS[job.status] || job.status}</Badge>
            </div>
            {job.status === "RUNNING" && (
              <div className="mt-2 space-y-1">
                <Progress value={job.progress.percent ?? null} />
                <div className="flex justify-between text-xs text-muted">
                  <span>{job.progress.label || job.stage}</span>
                  <span>{job.progress.percent != null ? `${Math.round(job.progress.percent)}%` : "进行中"}</span>
                </div>
              </div>
            )}
            {job.error && (
              <Alert variant={job.status === "FAILED" ? "destructive" : "warning"} className="mt-2 px-2 py-1.5">
                <AlertDescription className="mt-0">{job.error.message}</AlertDescription>
              </Alert>
            )}
            <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
              <span>{formatDate(job.createdAt)}</span>
              {job.attempt > 1 && <span>第 {job.attempt} 次尝试</span>}
              <span className="ml-auto flex items-center gap-1">
                {active && (
                  <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => onCancel(job.id)}>
                    取消
                  </Button>
                )}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
