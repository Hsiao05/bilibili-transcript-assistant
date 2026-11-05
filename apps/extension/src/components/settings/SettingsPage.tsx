import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Save,
  Server,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { AppActions, AppState } from "@/sidepanel/state";
import type { GlossaryEntry } from "@/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { applyTheme, type CleanStrength, type ExtensionSettings } from "@/lib/settings";

const STRENGTH_OPTIONS: { value: CleanStrength; label: string; description: string }[] = [
  {
    value: "light",
    label: "轻度",
    description: "补标点、合并字幕断句，只处理确定的格式噪声。",
  },
  {
    value: "standard",
    label: "标准",
    description: "处理无效口水词和重复起句，统一已确认术语，生成可读段落。",
  },
  {
    value: "compact",
    label: "精简",
    description: "进一步压缩重复表达，保留原始材料与标准稿。",
  },
];

export function SettingsPage({ state, actions }: { state: AppState; actions: AppActions }) {
  const [draft, setDraft] = useState<ExtensionSettings>(state.settings);
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  const [glossaryLoading, setGlossaryLoading] = useState(false);
  const [glossaryError, setGlossaryError] = useState<string | null>(null);
  const savedTheme = useRef(state.settings.theme);

  useEffect(() => {
    setDraft(state.settings);
    savedTheme.current = state.settings.theme;
  }, [state.settings]);

  useEffect(() => {
    if (state.demo) return;
    const api = actions.getApi();
    if (!api.configured) return;
    let cancelled = false;
    setGlossaryLoading(true);
    setGlossaryError(null);
    api
      .getGlossary()
      .then((entries) => {
        if (!cancelled) setGlossary(entries);
      })
      .catch((error: Error) => {
        if (!cancelled) setGlossaryError(error.message);
      })
      .finally(() => {
        if (!cancelled) setGlossaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Load once per settings screen; reload after explicit save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = <K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const goBack = () => {
    if (draft.theme !== savedTheme.current) applyTheme(savedTheme.current);
    actions.closeSettings();
  };

  const handleSave = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      const result = await actions.saveSettings(draft);
      savedTheme.current = draft.theme;
      setTestResult(result);
      if (result.ok) toast.success("设置已保存");
      else toast.error(result.message);
      if (result.ok) {
        if (state.demo) {
          toast.info("演示模式：设置已保存在本地");
          return;
        }
        const api = actions.getApi();
        try {
          setGlossary(await api.getGlossary());
          setGlossaryError(null);
        } catch (error) {
          setGlossaryError((error as Error).message);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await actions.testConnection(draft);
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  };

  const saveGlossary = async () => {
    if (state.demo) {
      toast.info("演示模式不会写入真实词表");
      return;
    }
    const cleaned = glossary
      .map((entry) => ({
        ...entry,
        canonical: entry.canonical.trim(),
        variants: entry.variants.map((variant) => variant.trim()).filter(Boolean),
      }))
      .filter((entry) => entry.canonical);
    try {
      const saved = await actions.getApi().putGlossary(cleaned);
      setGlossary(saved);
      toast.success("术语词表已保存");
      setGlossaryError(null);
    } catch (error) {
      toast.error((error as Error).message);
      setGlossaryError((error as Error).message);
    }
  };

  const capabilities = state.capabilities;
  const connected = Boolean(capabilities);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Button variant="ghost" size="icon" onClick={goBack} aria-label="返回">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-semibold">设置</span>
        <Badge variant="outline" className="ml-auto">
          {state.demo ? "演示" : connected ? "已连接" : "未连接"}
        </Badge>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
        <section className="space-y-3">
          <div className="flex items-center gap-1.5">
            <Server className="h-4 w-4 text-muted" />
            <h2 className="text-sm font-semibold">任务服务</h2>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="service-url">服务地址</Label>
            <Input
              id="service-url"
              value={draft.serviceUrl}
              onChange={(event) => update("serviceUrl", event.target.value)}
              placeholder="http://127.0.0.1:8765"
              inputMode="url"
            />
            <p className="text-xs leading-[18px] text-muted">
              音频和文字将在该地址处理。默认本机回环地址；远端服务必须使用 HTTPS。修改地址后需授权扩展访问。
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="service-token">访问令牌</Label>
            <div className="relative">
              <Input
                id="service-token"
                type={showToken ? "text" : "password"}
                value={draft.serviceToken}
                onChange={(event) => update("serviceToken", event.target.value)}
                placeholder="粘贴 task-api 生成的 token"
                className="pr-9"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-9 w-9"
                onClick={() => setShowToken((value) => !value)}
                aria-label={showToken ? "隐藏令牌" : "显示令牌"}
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs leading-[18px] text-muted">
              服务首次启动会把令牌写入其数据目录的 <code className="rounded-sm bg-surface px-1">token.txt</code>。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleTest} disabled={testing}>
              {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              测试连接
            </Button>
            {connected ? (
              <span className="flex items-center gap-1 text-xs text-success">
                <CheckCircle2 className="h-3.5 w-3.5" /> 服务可用
              </span>
            ) : (
              state.serviceError && (
                <span className="flex min-w-0 items-center gap-1 text-xs text-destructive">
                  <XCircle className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{state.serviceError}</span>
                </span>
              )
            )}
          </div>
          {testResult && (
            <Alert variant={testResult.ok ? "success" : "destructive"}>
              <AlertTitle className="text-xs">{testResult.ok ? "连接成功" : "连接失败"}</AlertTitle>
              <AlertDescription>{testResult.message}</AlertDescription>
            </Alert>
          )}
          {capabilities && (
            <div className="space-y-2 rounded-md bg-surface px-3 py-2 text-xs leading-[18px]">
              <div className="flex justify-between gap-2">
                <span className="text-muted">文本模型</span>
                <span className="text-right">
                  {capabilities.llm.configured
                    ? `${capabilities.llm.model}（JSON 模式）`
                    : "未配置 · 仅规则清洗"}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted">语音识别</span>
                <span className="text-right">
                  {capabilities.asr.configured
                    ? capabilities.asr.providers
                        .filter((provider) => provider.available)
                        .map((provider) => provider.label)
                        .join(" / ")
                    : "未配置"}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted">音频上限</span>
                <span>
                  {Math.round(capabilities.limits.maxUploadBytes / 1024 / 1024)} MB ·{" "}
                  {capabilities.limits.maxDurationMinutes} 分钟
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted">原始音频保留</span>
                <span>{capabilities.limits.retentionHours} 小时</span>
              </div>
            </div>
          )}
        </section>

        <Separator />

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">处理方式</h2>
          <div className="space-y-1.5">
            <Label>字幕语言</Label>
            <Select value={draft.language} onValueChange={(value) => update("language", value)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zh-CN">中文优先</SelectItem>
                <SelectItem value="en-US">English</SelectItem>
                <SelectItem value="ja-JP">日本語</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>语音识别服务</Label>
            <Select
              value={draft.asrProvider}
              onValueChange={(value) => update("asrProvider", value as ExtensionSettings["asrProvider"])}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">自动（服务端优先）</SelectItem>
                <SelectItem value="faster-whisper">本机 faster-whisper</SelectItem>
                <SelectItem value="dashscope-filetrans">阿里云百炼 Filetrans</SelectItem>
                <SelectItem value="openai-compatible">OpenAI 兼容云 ASR</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs leading-[18px] text-muted">
              以任务服务 /v1/capabilities 列出的可用服务为准；“自动”由服务端 ASR_PROVIDER 决定。
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>清洗强度</Label>
            <RadioGroup
              value={draft.strength}
              onValueChange={(value) => update("strength", value as CleanStrength)}
              className="gap-1.5"
            >
              {STRENGTH_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-2.5 py-2 hover:bg-surface"
                >
                  <RadioGroupItem value={option.value} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="block text-xs leading-[18px] text-muted">{option.description}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm">字幕不可用时自动转写</p>
              <p className="text-xs text-muted">首次音频上传仍会展示处理端地址与预计大小。</p>
            </div>
            <Switch
              checked={draft.autoAsrFallback}
              onCheckedChange={(value) => update("autoAsrFallback", value)}
              aria-label="字幕不可用时自动转写"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm">显示时间点</p>
              <p className="text-xs text-muted">关闭后导出仍保留本地来源映射。</p>
            </div>
            <Switch
              checked={draft.showTimestamps}
              onCheckedChange={(value) => update("showTimestamps", value)}
              aria-label="显示时间点"
            />
          </div>
        </section>

        <Separator />

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">术语词表</h2>
              <p className="text-xs text-muted">已确认词表可直接用于清洗；只影响本任务服务。</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setGlossary((prev) => [...prev, { canonical: "", variants: [], entityType: "term" }])}>
              <Plus className="h-3.5 w-3.5" /> 添加
            </Button>
          </div>
          {glossaryError && (
            <Alert variant="destructive">
              <AlertDescription className="mt-0">{glossaryError}</AlertDescription>
            </Alert>
          )}
          {glossaryLoading ? (
            <p className="text-xs text-muted">正在加载术语表…</p>
          ) : glossary.length === 0 ? (
            <p className="text-xs text-muted">还没有词表条目。可以添加产品名、人名或缩写。</p>
          ) : (
            <div className="space-y-2">
              {glossary.map((entry, index) => (
                <div key={index} className="space-y-1.5 rounded-md border border-border px-2.5 py-2">
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={entry.canonical}
                      placeholder="规范写法，如 DeepSeek"
                      onChange={(event) =>
                        setGlossary((prev) =>
                          prev.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, canonical: event.target.value } : item,
                          ),
                        )
                      }
                      className="h-8"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="删除术语"
                      onClick={() => setGlossary((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <Input
                    value={entry.variants.join("，")}
                    placeholder="其他写法，用逗号分隔"
                    onChange={(event) =>
                      setGlossary((prev) =>
                        prev.map((item, itemIndex) =>
                          itemIndex === index
                            ? {
                                ...item,
                                variants: event.target.value
                                  .split(/[,，;；]/)
                                  .map((value) => value.trim())
                                  .filter(Boolean),
                              }
                            : item,
                        ),
                      )
                    }
                    className="h-8 text-xs"
                  />
                </div>
              ))}
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!actions.getApi().configured || glossaryLoading || state.demo}
            onClick={saveGlossary}
          >
            <Save className="h-3.5 w-3.5" /> 保存词表
          </Button>
        </section>

        <Separator />

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">外观</h2>
          <RadioGroup
            value={draft.theme}
            onValueChange={(value) => {
              update("theme", value as ExtensionSettings["theme"]);
              applyTheme(value as ExtensionSettings["theme"]);
            }}
            className="grid grid-cols-3 gap-1.5"
          >
            {[
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
              { value: "system", label: "跟随系统" },
            ].map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border px-2 py-2 text-xs hover:bg-surface"
              >
                <RadioGroupItem value={option.value} />
                {option.label}
              </label>
            ))}
          </RadioGroup>
        </section>

        <Separator />

        <section className="space-y-1.5 pb-2">
          <h2 className="text-sm font-semibold">关于</h2>
          <p className="text-xs leading-[18px] text-muted">
            版本 {capabilities?.appVersion || "0.1.0"} · API {capabilities?.apiVersion || "v1"}。
            B站 Cookie 只留在扩展侧，任务服务只接收音频字节和字幕文字。所有模型调用由任务服务按你的配置发起。
          </p>
          <p className="text-xs leading-[18px] text-muted">
            字幕与转写只能覆盖视频中的文字和语音，图表、画面操作、表情与未被说出的信息无法从这些材料取得。
          </p>
        </section>
      </div>

      <div className="border-t border-border px-4 py-2.5">
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={goBack}>
            取消
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            保存设置
          </Button>
        </div>
      </div>
    </div>
  );
}
