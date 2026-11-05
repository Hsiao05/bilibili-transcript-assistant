import { ChevronDown, Info, PencilLine } from "lucide-react";
import { useState } from "react";

import type { Correction } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TimeLink } from "@/components/transcript/TimeLink";

const TYPE_LABELS: Record<string, string> = {
  term: "专名 / 术语",
  consistency: "一致性",
  recognition: "识别纠错",
  format: "格式",
  filler: "口语",
  note: "存疑",
};

const EVIDENCE_LABELS: Record<string, string> = {
  user_glossary: "用户词表",
  material_spelling: "材料明确拼写",
  context_only: "上下文推测",
  none: "无可靠依据",
  rule: "规则",
};

export function CorrectionItem({
  correction,
  startMs,
  selected,
  busy,
  onSelect,
  onAccept,
  onKeep,
  onSeek,
  onManual,
}: {
  correction: Correction;
  startMs: number;
  selected: boolean;
  busy?: boolean;
  onSelect: (checked: boolean) => void;
  onAccept: () => void;
  onKeep: () => void;
  onSeek: (ms: number) => void;
  onManual: (replacement: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(correction.replacement ?? correction.original);
  const hasReplacement = Boolean(correction.replacement);

  return (
    <div className="rounded-md border border-border px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Checkbox
          className="mt-0.5"
          checked={selected}
          onCheckedChange={(value) => onSelect(value === true)}
          aria-label="选择这条修订"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <TimeLink ms={startMs} onSeek={onSeek} />
            <Badge variant={correction.changeType === "consistency" ? "warning" : "outline"}>
              {TYPE_LABELS[correction.changeType] || correction.changeType}
            </Badge>
            {correction.evidenceType && (
              <span className="text-xs text-muted">{EVIDENCE_LABELS[correction.evidenceType] || correction.evidenceType}</span>
            )}
          </div>
          <div className="mt-1.5 space-y-1">
            <div className="rounded-sm bg-destructive-soft px-2 py-1 text-sm leading-5">
              <span className={hasReplacement ? "line-through decoration-destructive" : ""}>{correction.original}</span>
            </div>
            {hasReplacement ? (
              <div className="rounded-sm bg-success-soft px-2 py-1 text-sm leading-5">
                <span className="mr-1 text-xs text-muted">AI 建议</span>
                {correction.replacement}
              </div>
            ) : (
              <div className="rounded-sm bg-surface px-2 py-1 text-xs leading-[18px] text-muted">
                AI 建议生成失败，请点击「手动修改」填写。
              </div>
            )}
          </div>
          <p className="mt-1.5 text-xs leading-[18px] text-muted">{correction.reason}</p>

          {editing ? (
            <div className="mt-2 space-y-1.5">
              <textarea
                className="min-h-16 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm leading-5 outline-none focus:border-accent"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-label="手动修改内容"
              />
              <div className="flex justify-end gap-1.5">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>
                  取消
                </Button>
                <Button
                  size="sm"
                  disabled={busy || !draft.trim()}
                  onClick={() => {
                    onManual(draft.trim());
                    setEditing(false);
                  }}
                >
                  保存修改
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <Collapsible open={open} onOpenChange={setOpen}>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-6 gap-1 px-1 text-xs text-muted">
                    <Info className="h-3.5 w-3.5" />
                    依据与技术信息
                    <ChevronDown className={"h-3.5 w-3.5 transition-transform " + (open ? "rotate-180" : "")} />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-1 space-y-1 rounded-sm bg-surface px-2 py-1.5 text-xs leading-[18px] text-muted">
                  <p>修改类型：{TYPE_LABELS[correction.changeType] || correction.changeType}</p>
                  <p>依据：{EVIDENCE_LABELS[correction.evidenceType || ""] || correction.evidenceType || "无"}</p>
                  {correction.evidenceQuote && <p>引用：{correction.evidenceQuote}</p>}
                  <p className="break-all">片段：{correction.sourceSegmentIds.join("、") || "未记录"}</p>
                </CollapsibleContent>
              </Collapsible>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button variant="outline" size="sm" disabled={busy} onClick={onKeep}>
                  保留原文
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(true)}>
                  <PencilLine className="h-3.5 w-3.5" />
                  手动修改
                </Button>
                <Button size="sm" disabled={busy || !hasReplacement} onClick={onAccept}>
                  接受 AI 建议
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
