import { CheckCircle2, ListChecks, Tags } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { DocumentBundle, Revision, VideoRef } from "@/contracts";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CorrectionItem } from "@/components/revisions/CorrectionItem";
import { EmptyState } from "@/components/transcript/EmptyState";
import { formatTime, revisionLabel } from "@/lib/utils";

export function RevisionList({
  revision,
  document,
  video,
  busy,
  onResolve,
}: {
  revision: Revision | null;
  document: DocumentBundle | null;
  video: VideoRef | null;
  busy?: boolean;
  onResolve: (acceptedIds: string[], keptIds: string[]) => Promise<void>;
}) {
  const pending = useMemo(
    () => (revision ? revision.corrections.filter((item) => item.status === "pending") : []),
    [revision],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);

  useEffect(() => {
    setSelected(new Set());
  }, [revision?.id]);

  const blockTimes = useMemo(() => {
    const map = new Map<string, number>();
    revision?.blocks.forEach((block) => map.set(block.id, block.startMs));
    return map;
  }, [revision]);

  if (!video) return null;
  if (!revision) {
    return <EmptyState title="还没有整理稿" description="先提取文字稿，修订项会显示在这里。" />;
  }
  if (revision.kind === "original") {
    return (
      <EmptyState
        icon={ListChecks}
        title="当前是原始稿"
        description="原始稿保留所有字幕文字，不做自动修改。提取完成后会生成带待核对项的整理稿。"
      />
    );
  }

  const allSelected = pending.length > 0 && selected.size === pending.length;
  const selectedIds = pending.filter((item) => selected.has(item.id)).map((item) => item.id);

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(pending.map((item) => item.id)));
  };

  const acceptSelected = () => {
    const ids = selectedIds;
    void onResolve(ids, []);
    setSelected(new Set());
    setConfirmOpen(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted">{revisionLabel(revision.kind)}</span>
          <Badge variant={pending.length ? "warning" : "success"}>
            {pending.length ? `${pending.length} 处待核对` : "无待核对项"}
          </Badge>
          {revision.appliedEdits.length > 0 && (
            <span className="text-xs text-muted">已自动修改 {revision.appliedEdits.length} 处</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {pending.length > 0 && (
            <Button variant="ghost" size="sm" className="h-7 px-1.5 text-xs" onClick={toggleAll}>
              {allSelected ? "取消全选" : "全选"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={!selectedIds.length || busy}
            onClick={() => setConfirmOpen(true)}
          >
            接受所选（{selectedIds.length}）
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={!selectedIds.length || busy}
            onClick={() => {
              const ids = selectedIds;
              setSelected(new Set());
              void onResolve([], ids);
            }}
          >
            保留所选
          </Button>
        </div>
      </div>

      {pending.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="没有待确认的修改"
          description={
            revision.kind === "edited"
              ? "当前是人工修订稿。后续模型重跑会生成新分支，可在这里对照选择。"
              : "当前版本没有需要人工确认的专名、术语或一致性问题。"
          }
        />
      ) : (
        <div className="space-y-2">
          {pending.map((correction) => (
            <CorrectionItem
              key={correction.id}
              correction={correction}
              video={video}
              startMs={blockTimes.get(correction.blockId) ?? 0}
              selected={selected.has(correction.id)}
              busy={busy}
              onSelect={(checked) => {
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (checked) next.add(correction.id);
                  else next.delete(correction.id);
                  return next;
                });
              }}
              onAccept={() => void onResolve([correction.id], [])}
              onKeep={() => void onResolve([], [correction.id])}
            />
          ))}
        </div>
      )}

      {document && document.terms.length > 0 && (
        <Collapsible open={termsOpen} onOpenChange={setTermsOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-start gap-1.5 px-1 text-xs text-muted">
              <Tags className="h-3.5 w-3.5" />
              本视频术语表（{document.terms.length}）
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1 space-y-1.5">
            {document.terms.map((term) => (
              <div key={term.termId} className="flex flex-wrap items-center gap-1.5 rounded-sm bg-surface px-2 py-1.5 text-xs">
                <span className="font-medium">{term.canonical}</span>
                <Badge variant={term.status === "confirmed" ? "success" : term.status === "disputed" ? "destructive" : "warning"}>
                  {term.status === "confirmed" ? "已确认" : term.status === "disputed" ? "存疑" : "待确认"}
                </Badge>
                {term.variants.length > 0 && <span className="text-muted">原写法：{term.variants.join("、")}</span>}
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>接受 {selectedIds.length} 处修改？</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>将按顺序应用以下位置的建议，并生成一份新的人工修订稿。原始稿和整理稿都会保留。</p>
                <ul className="mt-2 max-h-32 space-y-0.5 overflow-y-auto text-xs">
                  {pending
                    .filter((item) => selected.has(item.id))
                    .map((item) => (
                      <li key={item.id}>
                        {formatTime(blockTimes.get(item.blockId) ?? 0)} · {item.original}
                        {item.replacement ? ` → ${item.replacement}` : "（仅标记）"}
                      </li>
                    ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={acceptSelected}>确认接受</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
