import type {
  ApiErrorBody,
  Block,
  Capabilities,
  DocumentBundle,
  GlossaryEntry,
  Job,
  Revision,
  Segment,
  Summary,
  UploadSession,
  VideoRef,
} from "@/contracts";

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (!/^https?:\/\//i.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export interface JobCreatePayload {
  type: "transcribe" | "clean" | "summarize";
  video?: VideoRef;
  documentId?: string;
  revisionId?: string;
  uploadId?: string;
  options?: Record<string, unknown>;
  idempotencyKey?: string;
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(serviceUrl: string, token: string) {
    this.baseUrl = normalizeBaseUrl(serviceUrl);
    this.token = token.trim();
  }

  get configured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  private async request<T>(path: string, init: RequestInit = {}, allow404 = false, timeoutMs = 20_000): Promise<T> {
    if (!this.baseUrl) throw new ApiError(0, "not_configured", "尚未填写任务服务地址");
    const headers = new Headers(init.headers);
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (init.body && typeof init.body === "string") headers.set("Content-Type", "application/json");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new ApiError(0, "timeout", "任务服务响应超时");
      }
      throw new ApiError(0, "network", `无法连接任务服务：${(error as Error).message}`);
    } finally {
      window.clearTimeout(timer);
    }
    if (response.status === 404 && allow404) {
      return null as T;
    }
    if (!response.ok) {
      let body: ApiErrorBody | null = null;
      try {
        body = (await response.json()) as ApiErrorBody;
      } catch {
        // non-JSON error
      }
      throw new ApiError(
        response.status,
        body?.code || `http_${response.status}`,
        body?.message || `任务服务返回错误（HTTP ${response.status}）`,
        body?.details,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async capabilities(): Promise<Capabilities> {
    return this.request<Capabilities>("/v1/capabilities", {}, false, 8_000);
  }

  async findDocument(video: Pick<VideoRef, "bvid" | "cid" | "page">): Promise<DocumentBundle | null> {
    return this.request<DocumentBundle | null>(
      `/v1/documents${query({ bvid: video.bvid, cid: video.cid, page: video.page })}`,
      {},
      true,
    );
  }

  async createDocument(
    video: VideoRef,
    source: {
      type: string;
      trackId?: string | null;
      language: string;
      segments: Segment[];
    },
  ): Promise<DocumentBundle> {
    return this.request<DocumentBundle>("/v1/documents", {
      method: "POST",
      body: JSON.stringify({ video, source }),
    });
  }

  async getBundle(documentId: string): Promise<DocumentBundle> {
    return this.request<DocumentBundle>(`/v1/documents/${documentId}`);
  }

  async getRevision(documentId: string, revisionId: string): Promise<Revision> {
    return this.request<Revision>(`/v1/documents/${documentId}/revisions/${revisionId}`);
  }

  async createRevision(documentId: string, parentRevisionId: string, blocks: Block[]): Promise<Revision> {
    return this.request<Revision>(`/v1/documents/${documentId}/revisions`, {
      method: "POST",
      body: JSON.stringify({ parentRevisionId, blocks, createdBy: "user" }),
    });
  }

  async applyCorrections(
    documentId: string,
    revisionId: string,
    acceptedIds: string[],
    keptIds: string[],
  ): Promise<Revision> {
    return this.request<Revision>(`/v1/documents/${documentId}/corrections/apply`, {
      method: "POST",
      body: JSON.stringify({ revisionId, acceptedIds, keptIds }),
    });
  }

  async createJob(payload: JobCreatePayload): Promise<Job> {
    return this.request<Job>("/v1/jobs", { method: "POST", body: JSON.stringify(payload) });
  }

  async getJob(jobId: string): Promise<Job> {
    return this.request<Job>(`/v1/jobs/${jobId}`);
  }

  async listJobs(documentId?: string): Promise<Job[]> {
    return this.request<Job[]>(`/v1/jobs${query({ documentId, limit: 30 })}`);
  }

  async cancelJob(jobId: string): Promise<Job> {
    return this.request<Job>(`/v1/jobs/${jobId}/cancel`, { method: "POST" });
  }

  async getSummary(documentId: string, revisionId?: string): Promise<Summary | null> {
    return this.request<Summary | null>(
      `/v1/documents/${documentId}/summaries/latest${query({ revisionId })}`,
      {},
      true,
    );
  }

  async exportMarkdown(
    documentId: string,
    revisionId: string,
    options: { includeTimestamps: boolean; includeSummary: boolean; includeTerms: boolean },
  ): Promise<{ text: string; filename: string }> {
    if (!this.baseUrl) throw new ApiError(0, "not_configured", "尚未填写任务服务地址");
    const headers = new Headers();
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    const url = `${this.baseUrl}/v1/documents/${documentId}/export${query({
      revisionId,
      includeTimestamps: options.includeTimestamps,
      includeSummary: options.includeSummary,
      includeTerms: options.includeTerms,
    })}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new ApiError(response.status, "export_failed", "导出失败，请稍后重试");
    }
    const text = await response.text();
    const encoded = response.headers.get("X-Export-Filename") || "";
    const filename = encoded ? decodeURIComponent(encoded) : "文字稿.md";
    return { text, filename };
  }

  async getGlossary(): Promise<GlossaryEntry[]> {
    const data = await this.request<{ entries: GlossaryEntry[] }>("/v1/glossary");
    return data.entries;
  }

  async putGlossary(entries: GlossaryEntry[]): Promise<GlossaryEntry[]> {
    const data = await this.request<{ entries: GlossaryEntry[] }>("/v1/glossary", {
      method: "PUT",
      body: JSON.stringify({ entries }),
    });
    return data.entries;
  }

  async createUpload(filename: string, size: number, sha256?: string): Promise<UploadSession> {
    return this.request<UploadSession>("/v1/uploads", {
      method: "POST",
      body: JSON.stringify({ filename, size, sha256 }),
    });
  }

  async getUpload(uploadId: string): Promise<UploadSession | null> {
    return this.request<UploadSession | null>(`/v1/uploads/${uploadId}`, {}, true);
  }

  async putChunk(uploadId: string, index: number, data: Uint8Array, sha256: string): Promise<UploadSession> {
    return this.request<UploadSession>(
      `/v1/uploads/${uploadId}/chunks/${index}`,
      {
        method: "PUT",
        body: data as unknown as BodyInit,
        headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": sha256 },
      },
      false,
      120_000,
    );
  }

  async completeUpload(
    uploadId: string,
    chunkCount: number,
    totalBytes: number,
    sha256: string,
  ): Promise<UploadSession> {
    return this.request<UploadSession>(
      `/v1/uploads/${uploadId}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ chunkCount, totalBytes, sha256 }),
      },
      false,
      120_000,
    );
  }
}
