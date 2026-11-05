export interface VideoRef {
  bvid: string;
  cid: string;
  page: number;
  title: string;
  partTitle?: string | null;
  author: string;
  durationMs: number;
  coverUrl?: string | null;
  sourceUrl?: string | null;
}

export interface Segment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  recognizerConfidence?: number | null;
  speaker?: string | null;
}

export interface SourceInfo {
  id: string;
  documentId: string | null;
  type: string;
  trackId: string | null;
  language: string;
  contentHash: string;
  segmentCount: number;
  startMs: number;
  endMs: number;
  createdAt: string;
}

export interface Block {
  id: string;
  sourceSegmentIds: string[];
  text: string;
  startMs: number;
  endMs: number;
}

export type CorrectionType = "term" | "filler" | "consistency" | "recognition" | "format" | "note";
export type CorrectionStatus = "pending" | "applied" | "kept" | "superseded";

export interface Correction {
  id: string;
  blockId: string;
  sourceSegmentIds: string[];
  startOffset: number;
  endOffset: number;
  original: string;
  replacement: string | null;
  changeType: CorrectionType;
  reason: string;
  evidenceType: string | null;
  evidenceSegmentIds: string[];
  evidenceQuote: string | null;
  status: CorrectionStatus;
  termId: string | null;
  autoApplicable: boolean;
}

export interface AppliedEdit {
  blockId: string;
  sourceSegmentIds: string[];
  startOffset: number;
  endOffset: number;
  original: string;
  replacement: string;
  changeType: string;
  reason: string;
  evidenceType: string | null;
}

export type RevisionKind = "original" | "cleaned" | "edited" | "summary";

export interface Revision {
  id: string;
  documentId: string;
  parentRevisionId: string | null;
  kind: RevisionKind;
  sourceId: string | null;
  blocks: Block[];
  corrections: Correction[];
  appliedEdits: AppliedEdit[];
  contentHash: string;
  pipelineVersion: string;
  glossaryVersion: string;
  createdBy: string;
  createdAt: string;
}

export interface RevisionSummary {
  id: string;
  kind: string;
  createdBy: string;
  createdAt: string;
  parentRevisionId: string | null;
  blockCount: number;
  pendingCount: number;
}

export interface Term {
  termId: string;
  entityType: string;
  canonical: string;
  variants: string[];
  status: "confirmed" | "suggested" | "disputed";
  evidenceType: string;
  evidenceSegmentIds: string[];
  scope: Record<string, unknown>;
  confirmedBy: string | null;
}

export interface Citation {
  text: string;
  segmentIds: string[];
}

export interface Chapter {
  title: string;
  startMs: number;
  endMs: number;
  points: Citation[];
  editorialTitle: boolean;
}

export interface Coverage {
  sources: string[];
  gaps: string[];
  uncertainties: string[];
}

export interface Summary {
  id: string;
  documentId: string;
  revisionId: string;
  overview: string;
  viewpoints: Citation[];
  chapters: Chapter[];
  conclusion: Citation | null;
  keyNumbers: Citation[];
  coverage: Coverage;
  markdown: string;
  model: string;
  createdAt: string;
}

export interface DocumentMeta {
  id: string;
  video: VideoRef;
  createdAt: string;
  updatedAt: string;
  originalRevisionId: string | null;
  latestRevisionId: string | null;
}

export interface DocumentBundle {
  document: DocumentMeta;
  source: SourceInfo | null;
  revisions: RevisionSummary[];
  terms: Term[];
  summary: Summary | null;
}

export interface JobProgress {
  completed: number;
  total: number | null;
  unit: string;
  percent: number | null;
  label: string;
}

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
  details: unknown;
}

export type JobType = "transcribe" | "clean" | "summarize";
export type JobStatus =
  | "CREATED"
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "PARTIAL"
  | "NEEDS_INPUT"
  | "FAILED"
  | "CANCEL_REQUESTED"
  | "CANCELLED";

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  stage: string;
  progress: JobProgress;
  video: VideoRef | null;
  documentId: string | null;
  revisionId: string | null;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: JobError | null;
  attempt: number;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Capabilities {
  apiVersion: string;
  appVersion: string;
  asr: {
    configured: boolean;
    defaultProvider: string;
    providers: { id: string; label: string; available: boolean; detail: string }[];
    maxDurationMinutes: number;
  };
  llm: { configured: boolean; provider: string; model: string; jsonMode: boolean };
  limits: {
    maxUploadBytes: number;
    maxDurationMinutes: number;
    chunkSize: number;
    retentionHours: number;
  };
  features: string[];
}

export interface UploadSession {
  id: string;
  filename: string;
  size: number;
  chunkSize: number;
  maxBytes: number;
  status: "open" | "complete";
  receivedChunks: number[];
  createdAt: string;
}

export interface GlossaryEntry {
  canonical: string;
  variants: string[];
  entityType?: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}
