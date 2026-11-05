import { Copy, Download, FileDown } from "lucide-react";

import type { RevisionSummary } from "@/contracts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { revisionLabel } from "@/lib/utils";

export function TranscriptToolbar({
  revisions,
  activeRevisionId,
  localMode,
  onSelect,
  onCopy,
  onExport,
}: {
  revisions: RevisionSummary[];
  activeRevisionId: string | null;
  localMode?: boolean;
  onSelect: (id: string) => void;
  onCopy: () => void;
  onExport: (which: "current" | "original" | "local") => void;
}) {
  return (
    <div className="sticky top-0 z-10 -mx-4 border-b border-border bg-background px-4 py-2">
      <div className="flex items-center gap-1.5">
        {localMode ? (
          <span className="text-sm text-muted">原始稿（本地缓存）</span>
        ) : (
          <Select value={activeRevisionId ?? ""} onValueChange={onSelect}>
            <SelectTrigger className="w-[172px]" aria-label="选择文稿版本">
              <SelectValue placeholder="选择版本" />
            </SelectTrigger>
            <SelectContent>
              {revisions.map((revision) => (
                <SelectItem key={revision.id} value={revision.id}>
                  {revisionLabel(revision.kind)}
                  {revision.pendingCount > 0 ? ` · ${revision.pendingCount} 待核对` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={onCopy} aria-label="复制文稿">
                <Copy className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>复制文稿</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={() => onExport(localMode ? "local" : "current")} aria-label="导出当前版本">
                <Download className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>导出当前版本</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="px-2 text-xs">
                更多
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>导出 Markdown</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => onExport(localMode ? "local" : "current")}>
                <FileDown className="h-4 w-4" />
                {localMode ? "导出本地原始稿" : "导出当前版本（含总结）"}
              </DropdownMenuItem>
              {!localMode && (
                <DropdownMenuItem onSelect={() => onExport("original")}>
                  <FileDown className="h-4 w-4" />
                  导出原始稿
                </DropdownMenuItem>
              )}
              {localMode && (
                <DropdownMenuItem onSelect={() => onExport("local")}>
                  <Download className="h-4 w-4" />
                  导出本地字幕
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
