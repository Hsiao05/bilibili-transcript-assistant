import type {
  Block,
  Capabilities,
  Correction,
  DocumentBundle,
  Job,
  Revision,
  Segment,
  Summary,
  Term,
  VideoRef,
} from "@/contracts";
import type { NormalizedTrack } from "@/bilibili/types";
import type { LocalTranscript } from "@/lib/idb";

export interface DemoData {
  video: VideoRef;
  tracks: NormalizedTrack[];
  selectedTrackId: string;
  capabilities: Capabilities | null;
  document: DocumentBundle | null;
  revisions: Record<string, Revision>;
  revision: Revision | null;
  summary: Summary | null;
  localSource: LocalTranscript | null;
  jobs: Job[];
  serviceError: string | null;
  tracksError: string | null;
}

const video: VideoRef = {
  bvid: "BV1xx411c7mD",
  cid: "123456789",
  page: 2,
  title: "如何用 DeepSeek 整理一场两小时的访谈",
  partTitle: "第二章 · 术语与修订",
  author: "文字实验室",
  durationMs: 98_000,
  coverUrl: null,
  sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD/?p=2",
};

const tracks: NormalizedTrack[] = [
  {
    id: "track-human-zh",
    lan: "zh-CN",
    lanDoc: "中文（人工字幕）",
    url: "https://i0.hdslb.com/bfs/subtitle/demo-human.json",
    type: "human",
  },
  {
    id: "track-ai-zh",
    lan: "ai-zh",
    lanDoc: "中文（自动生成）",
    url: "https://i0.hdslb.com/bfs/subtitle/demo-ai.json",
    type: "ai",
  },
  {
    id: "track-en",
    lan: "en-US",
    lanDoc: "English",
    url: "https://i0.hdslb.com/bfs/subtitle/demo-en.json",
    type: "human",
  },
];

const segmentTexts: { start: number; end: number; text: string }[] = [
  { start: 0, end: 6000, text: "呃，这期我们聊聊怎么用模型整理长访谈。" },
  { start: 6000, end: 13000, text: "先说获取材料，字幕和音频是两条独立的路径。" },
  { start: 13000, end: 21000, text: "如果视频有字幕，优先用人工轨；没有人工轨时再用 AI 字幕。" },
  { start: 21000, end: 28000, text: "没有字幕的时候，才需要把音轨下载下来做语音识别。" },
  { start: 28000, end: 38000, text: "我这里说的“滴普西克”，其实就是 DeepSeek。" },
  { start: 38000, end: 46000, text: "它在整理长访谈时比较稳，能把段落结构保留下来。" },
  { start: 46000, end: 54000, text: "标准清洗会删掉明显的口水词，比如单独的“呃”。" },
  { start: 54000, end: 63000, text: "但是“然后”“可能”这类表达要保留，它们往往带着顺序和不确定性。" },
  { start: 63000, end: 72000, text: "这个版本支持三个模式，后面又说支持四个模式，前后需要核对。" },
  { start: 72000, end: 81000, text: "数字和版本号不能凭模型熟悉度直接改。" },
  { start: 81000, end: 90000, text: "最后导出 Markdown，段落时间点仍然能回到原视频。" },
  { start: 90000, end: 98000, text: "这样写稿和核对就不用两头切换了。" },
];

const segments: Segment[] = segmentTexts.map((item, index) => ({
  id: `seg_${String(index + 1).padStart(5, "0")}`,
  startMs: item.start,
  endMs: item.end,
  text: item.text,
}));

const segmentById = new Map(segments.map((segment) => [segment.id, segment]));

const originalBlocks: Block[] = segments.map((segment, index) => ({
  id: `block_${String(index + 1).padStart(4, "0")}`,
  sourceSegmentIds: [segment.id],
  text: segment.text,
  startMs: segment.startMs,
  endMs: segment.endMs,
}));

const cleanedTexts = [
  "这期我们聊聊怎么用模型整理长访谈。",
  "先说获取材料，字幕和音频是两条独立的路径。如果视频有字幕，优先用人工轨；没有人工轨时再用 AI 字幕。",
  "没有字幕的时候，才需要把音轨下载下来做语音识别。",
  "我这里说的“滴普西克”，其实就是 DeepSeek。它在整理长访谈时比较稳，能把段落结构保留下来。",
  "标准清洗会删掉明显的口水词，比如单独的“呃”。但是“然后”“可能”这类表达要保留，它们往往带着顺序和不确定性。",
  "这个版本支持三个模式，后面又说支持四个模式，前后需要核对。数字和版本号不能凭模型熟悉度直接改。",
  "最后导出 Markdown，段落时间点仍然能回到原视频。这样写稿和核对就不用两头切换了。",
];

const cleanedGroups: { ids: string[]; text: string }[] = [
  { ids: ["seg_00001"], text: cleanedTexts[0] },
  { ids: ["seg_00002", "seg_00003"], text: cleanedTexts[1] },
  { ids: ["seg_00004"], text: cleanedTexts[2] },
  { ids: ["seg_00005", "seg_00006"], text: cleanedTexts[3] },
  { ids: ["seg_00007", "seg_00008"], text: cleanedTexts[4] },
  { ids: ["seg_00009", "seg_00010"], text: cleanedTexts[5] },
  { ids: ["seg_00011", "seg_00012"], text: cleanedTexts[6] },
];

const cleanedBlocks: Block[] = cleanedGroups.map((group, index) => {
  const first = segmentById.get(group.ids[0]);
  const last = segmentById.get(group.ids[1] ?? group.ids[0]);
  return {
    id: `block_${String(index + 1).padStart(4, "0")}`,
    sourceSegmentIds: group.ids,
    text: group.text,
    startMs: first?.startMs ?? 0,
    endMs: last?.endMs ?? 0,
  };
});

function correctionForTerm(): Correction {
  const block = cleanedBlocks[3];
  const start = block.text.indexOf("滴普西克");
  return {
    id: "corr_term_0001",
    blockId: block.id,
    sourceSegmentIds: block.sourceSegmentIds,
    startOffset: start,
    endOffset: start + 4,
    original: "滴普西克",
    replacement: "DeepSeek",
    changeType: "term",
    reason: "用户词表将「滴普西克」确认为 DeepSeek；此处为引用中的原写法，保留待确认。",
    evidenceType: "user_glossary",
    evidenceSegmentIds: ["seg_00005"],
    evidenceQuote: "我这里说的“滴普西克”",
    status: "pending",
    termId: "term_g001",
    autoApplicable: false,
  };
}

function correctionForConsistency(): Correction {
  const block = cleanedBlocks[5];
  const start = block.text.indexOf("支持三个模式");
  return {
    id: "corr_consistency_0001",
    blockId: block.id,
    sourceSegmentIds: block.sourceSegmentIds,
    startOffset: start,
    endOffset: start + 6,
    original: "支持三个模式",
    replacement: "支持四个模式",
    changeType: "consistency",
    reason: "后文出现「支持四个模式」；这里按后文统一给出建议，证据不足时仍可选择保留原文。",
    evidenceType: "context_only",
    evidenceSegmentIds: ["seg_00009", "seg_00010"],
    evidenceQuote: "后面又说支持四个模式",
    status: "pending",
    termId: null,
    autoApplicable: false,
  };
}

const terms: Term[] = [
  {
    termId: "term_g001",
    entityType: "product",
    canonical: "DeepSeek",
    variants: ["滴普西克", "迪普西克"],
    status: "confirmed",
    evidenceType: "user_glossary",
    evidenceSegmentIds: [],
    scope: {},
    confirmedBy: "user",
  },
  {
    termId: "term_m001",
    entityType: "technical",
    canonical: "Markdown",
    variants: ["mark down"],
    status: "suggested",
    evidenceType: "context_only",
    evidenceSegmentIds: ["seg_00011"],
    scope: {},
    confirmedBy: null,
  },
];

const cleanedRevision: Revision = {
  id: "rev_demo_cleaned",
  documentId: "doc_demo",
  parentRevisionId: "rev_demo_original",
  kind: "cleaned",
  sourceId: "src_demo",
  blocks: cleanedBlocks,
  corrections: [correctionForTerm(), correctionForConsistency()],
  appliedEdits: [
    {
      blockId: "block_0001",
      sourceSegmentIds: ["seg_00001"],
      startOffset: 0,
      endOffset: 2,
      original: "呃，",
      replacement: "",
      changeType: "filler",
      reason: "删除无效口水词",
      evidenceType: "rule",
    },
    {
      blockId: "block_0001",
      sourceSegmentIds: ["seg_00002"],
      startOffset: 0,
      endOffset: 0,
      original: "先说获取材料",
      replacement: "先说获取材料",
      changeType: "format",
      reason: "合并字幕断句",
      evidenceType: "rule",
    },
  ],
  contentHash: "demo-hash",
  pipelineVersion: "clean-v1:standard",
  glossaryVersion: "glossary-demo",
  createdBy: "model",
  createdAt: "2026-11-04T09:30:00Z",
};

const originalRevision: Revision = {
  id: "rev_demo_original",
  documentId: "doc_demo",
  parentRevisionId: null,
  kind: "original",
  sourceId: "src_demo",
  blocks: originalBlocks,
  corrections: [],
  appliedEdits: [],
  contentHash: "demo-original-hash",
  pipelineVersion: "original-v1",
  glossaryVersion: "",
  createdBy: "source",
  createdAt: "2026-11-04T09:28:00Z",
};

function cite(text: string, ids: string[]) {
  return { text, segmentIds: ids };
}

const summary: Summary = {
  id: "sum_demo",
  documentId: "doc_demo",
  revisionId: cleanedRevision.id,
  overview:
    "这期内容讲的是长访谈文字稿的处理流程：先确定字幕或音频来源，再按保留语义的原则清洗口语，最后导出带时间点的 Markdown。作者强调术语、数字和不确定表达需要核对，不能只凭模型推断。",
  viewpoints: [
    cite("字幕与音频是两条独立路径：有字幕优先用字幕，没有字幕才转写音频。", ["seg_00002", "seg_00004"]),
    cite("标准清洗只处理确定的口语噪声，「然后」「可能」等表达必须保留。", ["seg_00008"]),
    cite("数字和版本号存在冲突时，应列出待核对项，而不是按多数写法修改。", ["seg_00009", "seg_00010"]),
  ],
  chapters: [
    {
      title: "字幕与音频的两条获取路径",
      startMs: 6000,
      endMs: 28000,
      points: [
        cite("先检查人工字幕和 AI 字幕，没有可用字幕时才进入音频转写。", ["seg_00002", "seg_00003"]),
        cite("音轨下载与字幕获取相互独立，失败时可以切换到另一条路径。", ["seg_00004"]),
      ],
      editorialTitle: true,
    },
    {
      title: "清洗原则与专名处理",
      startMs: 28000,
      endMs: 63000,
      points: [
        cite("「滴普西克」在上下文中指 DeepSeek，但引号内原话不自动替换。", ["seg_00005"]),
        cite("口水词可删，顺序词和不确定性词要保留。", ["seg_00007", "seg_00008"]),
      ],
      editorialTitle: true,
    },
    {
      title: "数字冲突与导出",
      startMs: 63000,
      endMs: 98000,
      points: [
        cite("「三个模式」和「四个模式」没有明确修正关系，应标记待核对。", ["seg_00009", "seg_00010"]),
        cite("导出 Markdown 时保留段落时间点，便于回看原视频。", ["seg_00011", "seg_00012"]),
      ],
      editorialTitle: true,
    },
  ],
  conclusion: cite("字幕/转写只能覆盖说出来的内容，整理后仍需人工核对专名、数字和引文。", ["seg_00012"]),
  keyNumbers: [cite("视频中出现「三个模式」与「四个模式」两种说法。", ["seg_00009"])],
  coverage: {
    sources: ["B站人工字幕"],
    gaps: ["未覆盖图表、画面操作、表情和未被说出的信息"],
    uncertainties: ["支持模式的个数前后不一致，需要人工确认"],
  },
  markdown: "",
  model: "deepseek-chat",
  createdAt: "2026-11-04T09:32:00Z",
};

const bundle: DocumentBundle = {
  document: {
    id: "doc_demo",
    video,
    createdAt: "2026-11-04T09:28:00Z",
    updatedAt: "2026-11-04T09:32:00Z",
    originalRevisionId: originalRevision.id,
    latestRevisionId: cleanedRevision.id,
  },
  source: {
    id: "src_demo",
    documentId: "doc_demo",
    type: "bilibili_human_subtitle",
    trackId: "track-human-zh",
    language: "zh-CN",
    contentHash: "demo-source",
    segmentCount: 12,
    startMs: 0,
    endMs: 98000,
    createdAt: "2026-11-04T09:28:00Z",
  },
  revisions: [
    {
      id: originalRevision.id,
      kind: "original",
      createdBy: "source",
      createdAt: originalRevision.createdAt,
      parentRevisionId: null,
      blockCount: originalBlocks.length,
      pendingCount: 0,
    },
    {
      id: cleanedRevision.id,
      kind: "cleaned",
      createdBy: "model",
      createdAt: cleanedRevision.createdAt,
      parentRevisionId: originalRevision.id,
      blockCount: cleanedBlocks.length,
      pendingCount: 2,
    },
  ],
  terms,
  summary,
};

const succeededJob: Job = {
  id: "job_demo_clean",
  type: "clean",
  status: "SUCCEEDED",
  stage: "done",
  progress: { completed: 1, total: 1, unit: "fraction", percent: 100, label: "清洗完成" },
  video,
  documentId: "doc_demo",
  revisionId: cleanedRevision.id,
  input: {},
  result: { documentId: "doc_demo", revisionId: cleanedRevision.id },
  error: null,
  attempt: 1,
  cancelRequested: false,
  createdAt: "2026-11-04T09:29:00Z",
  updatedAt: "2026-11-04T09:30:00Z",
};

const runningJob: Job = {
  id: "job_demo_running",
  type: "clean",
  status: "RUNNING",
  stage: "clean",
  progress: { completed: 0.48, total: 1, unit: "fraction", percent: 48, label: "逐块清洗" },
  video,
  documentId: "doc_demo",
  revisionId: originalRevision.id,
  input: {},
  result: null,
  error: null,
  attempt: 1,
  cancelRequested: false,
  createdAt: "2026-11-04T09:31:00Z",
  updatedAt: "2026-11-04T09:31:30Z",
};

const capabilities: Capabilities = {
  apiVersion: "v1",
  appVersion: "0.1.0",
  asr: {
    configured: true,
    defaultProvider: "faster-whisper",
    providers: [
      { id: "faster-whisper", label: "本机 faster-whisper", available: true, detail: "small · auto" },
      {
        id: "openai-compatible",
        label: "云 ASR（OpenAI 兼容接口）",
        available: true,
        detail: "whisper-1",
      },
    ],
    maxDurationMinutes: 120,
  },
  llm: { configured: true, provider: "openai-compatible", model: "deepseek-chat", jsonMode: true },
  limits: {
    maxUploadBytes: 512 * 1024 * 1024,
    maxDurationMinutes: 120,
    chunkSize: 4 * 1024 * 1024,
    retentionHours: 24,
  },
  features: ["bilibili_subtitles", "audio_upload", "asr", "clean", "summary", "markdown_export"],
};

export function buildDemo(variant: string | null): DemoData {
  const normalized = variant || "ready";
  const revisions = { [originalRevision.id]: originalRevision, [cleanedRevision.id]: cleanedRevision };
  const base: DemoData = {
    video,
    tracks,
    selectedTrackId: tracks[0].id,
    capabilities,
    document: bundle,
    revisions,
    revision: cleanedRevision,
    summary,
    localSource: {
      video,
      sourceType: "bilibili_human_subtitle",
      trackId: tracks[0].id,
      language: "zh-CN",
      segments,
      fetchedAt: "2026-11-04T09:28:00Z",
    },
    jobs: [succeededJob],
    serviceError: null,
    tracksError: null,
  };

  if (normalized === "initial") {
    return { ...base, document: null, revisions: {}, revision: null, summary: null, jobs: [], localSource: null };
  }
  if (normalized === "nosub") {
    return {
      ...base,
      tracks: [],
      selectedTrackId: "",
      document: null,
      revisions: {},
      revision: null,
      summary: null,
      jobs: [],
      localSource: null,
      tracksError: "当前未取得可用字幕。登录后可能取得字幕，或改用音频转写。",
    };
  }
  if (normalized === "processing") {
    const partialBundle: DocumentBundle = {
      ...bundle,
      document: { ...bundle.document, latestRevisionId: originalRevision.id },
      revisions: [bundle.revisions[0]],
      summary: null,
    };
    return {
      ...base,
      document: partialBundle,
      revisions: { [originalRevision.id]: originalRevision },
      revision: originalRevision,
      summary: null,
      jobs: [runningJob],
    };
  }
  if (normalized === "offline") {
    return {
      ...base,
      capabilities: null,
      document: null,
      revisions: {},
      revision: null,
      summary: null,
      jobs: [],
      serviceError: "任务服务未连接：请先在设置中填写服务地址和访问令牌。",
    };
  }
  if (normalized === "error") {
    return {
      ...base,
      document: null,
      revisions: {},
      revision: null,
      summary: null,
      jobs: [],
      serviceError: "任务服务响应超时：http://127.0.0.1:8765",
    };
  }
  return base;
}

export const demoVideo = video;
