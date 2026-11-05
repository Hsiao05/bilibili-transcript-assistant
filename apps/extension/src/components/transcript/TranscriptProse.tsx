import { Badge } from "@/components/ui/badge";
import type { Revision, VideoRef } from "@/contracts";
import { formatTime, timeUrl } from "@/lib/utils";

export function TranscriptProse({
  video,
  revision,
  showTimestamps,
  pendingBlockIds = new Set<string>(),
}: {
  video: VideoRef;
  revision: Revision;
  showTimestamps: boolean;
  pendingBlockIds?: Set<string>;
}) {
  if (!revision.blocks.length) {
    return <p className="text-sm text-muted">该版本没有正文。</p>;
  }
  return (
    <div className="transcript-body">
      {revision.blocks.map((block) => (
        <p key={block.id} className="transcript-block" data-block-id={block.id}>
          {showTimestamps && (
            <a
              className="timestamp"
              href={timeUrl(video, block.startMs)}
              target="_blank"
              rel="noreferrer"
              title={`跳到 ${formatTime(block.startMs)}`}
            >
              {formatTime(block.startMs)}
            </a>
          )}
          <span>{block.text}</span>
          {pendingBlockIds.has(block.id) && (
            <Badge variant="warning" className="ml-1.5 align-[0.15em]">
              待核对
            </Badge>
          )}
        </p>
      ))}
    </div>
  );
}
