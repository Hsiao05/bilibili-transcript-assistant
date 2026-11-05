import { ExternalLink, PlaySquare } from "lucide-react";

import type { VideoRef } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/progress";
import { formatDuration, videoUrl } from "@/lib/utils";

export function VideoHeader({ video, demo }: { video: VideoRef | null; demo?: boolean }) {
  if (!video) {
    return (
      <div className="flex gap-2.5">
        <Skeleton className="h-12 w-20 shrink-0 rounded-md" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2.5">
      <a
        href={videoUrl(video)}
        target="_blank"
        rel="noreferrer"
        className="relative h-12 w-20 shrink-0 overflow-hidden rounded-md bg-surface"
        aria-label="打开原视频"
      >
        {video.coverUrl ? (
          <img src={video.coverUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-muted">
            <PlaySquare className="h-5 w-5" />
          </span>
        )}
      </a>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <a
            href={videoUrl(video)}
            target="_blank"
            rel="noreferrer"
            className="line-clamp-2 text-sm font-semibold leading-5 hover:underline"
            title={video.title}
          >
            {video.title || "未命名视频"}
          </a>
          {demo && (
            <Badge variant="outline" className="mt-0.5 shrink-0">
              演示
            </Badge>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
          <span className="truncate">{video.author || "未知UP主"}</span>
          <span>·</span>
          <span>第 {video.page} P</span>
          {video.partTitle && video.partTitle !== video.title && (
            <>
              <span>·</span>
              <span className="line-clamp-1 max-w-[12rem]">{video.partTitle}</span>
            </>
          )}
          <span>·</span>
          <span>{formatDuration(video.durationMs)}</span>
          <a
            href={videoUrl(video)}
            target="_blank"
            rel="noreferrer"
            className="ml-0.5 inline-flex items-center gap-0.5 text-primary hover:underline"
          >
            原视频 <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
}
