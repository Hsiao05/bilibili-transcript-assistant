import { Badge } from "@/components/ui/badge";
import type { Revision } from "@/contracts";
import { TimeLink } from "@/components/transcript/TimeLink";

export function TranscriptProse({
  revision,
  showTimestamps,
  onSeek,
  pendingBlockIds = new Set<string>(),
}: {
  revision: Revision;
  showTimestamps: boolean;
  onSeek: (ms: number) => void;
  pendingBlockIds?: Set<string>;
}) {
  if (!revision.blocks.length) {
    return <p className="text-sm text-muted">该版本没有正文。</p>;
  }
  return (
    <div className="transcript-body">
      {revision.blocks.map((block) => (
        <p key={block.id} className="transcript-block" data-block-id={block.id}>
          {showTimestamps && <TimeLink ms={block.startMs} onSeek={onSeek} />}
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
