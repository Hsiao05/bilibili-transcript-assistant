import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useMemo } from "react";

import type { Citation, Revision, Summary } from "@/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TimeLink } from "@/components/transcript/TimeLink";

function SegmentTimeMap(revision: Revision | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!revision) return map;
  for (const block of revision.blocks) {
    for (const segmentId of block.sourceSegmentIds) {
      if (!map.has(segmentId)) map.set(segmentId, block.startMs);
    }
  }
  return map;
}

function CitationLine({
  item,
  times,
  onSeek,
  showTime = true,
}: {
  item: Citation;
  times: Map<string, number>;
  onSeek: (ms: number) => void;
  showTime?: boolean;
}) {
  const ms = item.segmentIds.map((id) => times.get(id)).find((value) => value !== undefined);
  return (
    <li className="leading-[26px]">
      {showTime && ms !== undefined && <TimeLink ms={ms} onSeek={onSeek} className="timestamp mr-1.5 align-[0.1em]" />}
      {item.text}
    </li>
  );
}

export function SummaryView({
  summary,
  revision,
  activeRevisionId,
  generating,
  onRegenerate,
  onSeek,
}: {
  summary: Summary;
  revision: Revision | null;
  activeRevisionId: string | null;
  generating?: boolean;
  onRegenerate: () => void;
  onSeek: (ms: number) => void;
}) {
  const times = useMemo(() => SegmentTimeMap(revision), [revision]);
  const stale = Boolean(activeRevisionId && summary.revisionId !== activeRevisionId);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted">
          所用版本：{summary.revisionId === activeRevisionId ? "当前文稿" : "另一文稿版本"} · {summary.model}
        </div>
        <Button variant="outline" size="sm" disabled={generating} onClick={onRegenerate}>
          {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          重新生成
        </Button>
      </div>
      {stale && (
        <Alert variant="warning">
          <AlertTitle className="flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" />
            文稿已变化
          </AlertTitle>
          <AlertDescription>当前总结基于另一个文稿版本，修改术语或正文后建议重新生成。</AlertDescription>
        </Alert>
      )}
      {summary.overview && (
        <section>
          <h2 className="mb-1.5 text-base font-semibold">内容概览</h2>
          <p className="transcript-body text-foreground">{summary.overview}</p>
        </section>
      )}
      {summary.viewpoints.length > 0 && (
        <section>
          <h2 className="mb-1.5 text-base font-semibold">核心观点</h2>
          <ul className="transcript-body list-disc pl-5">
            {summary.viewpoints.map((item, index) => (
              <CitationLine key={index} item={item} times={times} onSeek={onSeek} />
            ))}
          </ul>
        </section>
      )}
      {summary.chapters.length > 0 && (
        <section>
          <h2 className="mb-2 text-base font-semibold">章节要点</h2>
          <div className="space-y-4">
            {summary.chapters.map((chapter, index) => (
              <div key={index}>
                <h3 className="flex flex-wrap items-baseline gap-1.5 text-sm font-semibold leading-6">
                  <TimeLink ms={chapter.startMs} onSeek={onSeek} />
                  <span>{chapter.title}</span>
                  {chapter.editorialTitle && (
                    <span className="text-xs font-normal text-muted">编辑性标题</span>
                  )}
                </h3>
                <ul className="transcript-body mt-1 list-disc pl-5">
                  {chapter.points.map((point, pointIndex) => (
                    <CitationLine key={pointIndex} item={point} times={times} onSeek={onSeek} showTime={false} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
      {summary.conclusion && summary.conclusion.text && (
        <section>
          <h2 className="mb-1.5 text-base font-semibold">结论</h2>
          <p className="transcript-body">{summary.conclusion.text}</p>
        </section>
      )}
      {summary.keyNumbers.length > 0 && (
        <section>
          <h2 className="mb-1.5 text-base font-semibold">重要数字</h2>
          <ul className="transcript-body list-disc pl-5">
            {summary.keyNumbers.map((item, index) => (
              <CitationLine key={index} item={item} times={times} onSeek={onSeek} />
            ))}
          </ul>
        </section>
      )}
      <section>
        <h2 className="mb-1.5 text-base font-semibold">材料覆盖与存疑内容</h2>
        <div className="space-y-2 text-sm">
          <div>
            <p className="text-xs font-medium text-muted">材料来源</p>
            <p>{summary.coverage.sources.join("、") || "未记录"}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted">未覆盖的内容</p>
            <ul className="list-disc pl-5">
              {summary.coverage.gaps.map((gap, index) => (
                <li key={index}>{gap}</li>
              ))}
            </ul>
          </div>
          {summary.coverage.uncertainties.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted">存疑</p>
              <ul className="list-disc pl-5">
                {summary.coverage.uncertainties.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
