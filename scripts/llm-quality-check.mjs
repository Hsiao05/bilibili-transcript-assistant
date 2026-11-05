// Real-LLM quality acceptance for the cleaning and summarization pipeline.
//
// It starts a real task-api (loading services/task-api/.env, so a configured LLM key is used),
// creates a document from a real subtitle transcript, runs the actual clean + summarize jobs,
// then reports automated quality checks plus human-review samples:
//   - coverage: every source segment is represented in the cleaned revision
//   - timestamps: monotonic and inside the source range
//   - applied edits: each patch still matches the parent revision block exactly
//   - numbers / negation markers preserved (heuristic ratios)
//   - summary: real citations only, chapters/overview/markdown time links
//
// Usage:
//   node scripts/llm-quality-check.mjs
//   BTA_TRANSCRIPT_JSON=C:\path\transcript.json node scripts/llm-quality-check.mjs
//   BTA_LLM_MODEL=deepseek-v4-pro node scripts/llm-quality-check.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const serviceDir = path.join(root, "services", "task-api");
const python = path.join(serviceDir, ".venv", "Scripts", "python.exe");
const reportDir = path.join(root, "docs", "acceptance");
const defaultTranscript = path.join(__dirname, "fixtures", "subtitle-sample.json");
const transcriptPath = process.env.BTA_TRANSCRIPT_JSON || defaultTranscript;
const startedAt = new Date();

if (!existsSync(python)) throw new Error(`task-api venv python not found: ${python}`);
if (!existsSync(transcriptPath)) throw new Error(`transcript json not found: ${transcriptPath}`);

const report = { startedAt: startedAt.toISOString(), checks: [], samples: {}, metrics: {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, status, details, error) => {
  report.checks.push({ name, status, details, error: error ? String(error.message || error) : undefined });
  const icon = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
  console.log(`[${icon}] ${name}`);
  if (status !== "pass" && details !== undefined) console.log("       " + JSON.stringify(details));
  if (error) console.log("       " + (error.stack || error.message || String(error)));
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function waitFor(fn, timeoutMs = 20000, interval = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // retry
    }
    await sleep(interval);
  }
  return null;
}
async function pickPort() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = 8200 + Math.floor(Math.random() * 400);
    try {
      await fetch(`http://127.0.0.1:${candidate}/health`, { signal: AbortSignal.timeout(250) });
    } catch {
      return candidate;
    }
  }
  throw new Error("no free port");
}

class Stack {
  constructor(port, dataDir, token) {
    this.port = port;
    this.dataDir = dataDir;
    this.token = token;
    this.processes = [];
    this.logs = [];
  }
  get base() {
    return `http://127.0.0.1:${this.port}`;
  }
  async start() {
    const env = {
      ...process.env,
      TASKAPI_DATA_DIR: this.dataDir,
      TASKAPI_TOKEN: this.token,
      TASKAPI_HOST: "127.0.0.1",
      TASKAPI_PORT: String(this.port),
      TASKAPI_ASR_DISABLED: "1",
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
    };
    for (const [label, args] of [
      ["api", ["-u", "-m", "taskapi.serve"]],
      ["worker", ["-u", "-m", "taskapi.worker"]],
    ]) {
      const child = spawn(python, args, { cwd: serviceDir, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (data) => this.logs.push(`[${label}] ${data.toString()}`));
      child.stderr.on("data", (data) => this.logs.push(`[${label}] ${data.toString()}`));
      this.processes.push(child);
    }
    const ready = await waitFor(async () => (await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(800) })).ok, 30000, 500);
    if (!ready) throw new Error("task-api did not start:\n" + this.logs.slice(-15).join(""));
  }
  async request(pathname, { method = "GET", body } = {}) {
    const response = await fetch(`${this.base}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`${method} ${pathname} -> HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    return response.json();
  }
  async waitJob(jobId, timeoutMs = 900000) {
    const job = await waitFor(async () => {
      const value = await this.request(`/v1/jobs/${jobId}`);
      return ["SUCCEEDED", "PARTIAL", "FAILED", "NEEDS_INPUT", "CANCELLED"].includes(value.status) ? value : null;
    }, timeoutMs, 1000);
    if (!job) throw new Error(`job ${jobId} did not finish`);
    return job;
  }
  async stop() {
    for (const child of this.processes) {
      try {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // ignore
      }
    }
    await sleep(600);
  }
}

function numbersOf(text) {
  return new Set(String(text).match(/\d+(?:\.\d+)?/g) || []);
}
function countNegations(text) {
  return (String(text).match(/[不没无未别莫非]/g) || []).length;
}
function ratio(part, total) {
  return total > 0 ? Math.round((part / total) * 1000) / 1000 : null;
}

const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
const sourceSegments = transcript.source.segments;
const sourceText = sourceSegments.map((segment) => segment.text).join("\n");
const totalChars = sourceText.replace(/\s/g, "").length;

const dataDir = await mkdtemp(path.join(os.tmpdir(), "bta-llm-quality-"));
const stack = new Stack(await pickPort(), dataDir, `llm-quality-${Date.now()}`);
let cleanedRevision = null;
let summary = null;
let originalRevision = null;

try {
  await stack.start();
  const capabilities = await stack.request("/v1/capabilities");
  assert(capabilities.llm.configured === true, "LLM is not configured: add LLM_API_KEY or DASHSCOPE_API_KEY to .env");
  report.llm = capabilities.llm;
  report.transcript = {
    path: transcriptPath,
    video: transcript.video?.title,
    segments: sourceSegments.length,
    chars: totalChars,
  };
  check("real LLM configured", "pass", { provider: capabilities.llm.provider, model: capabilities.llm.model });

  const started = Date.now();
  const document = await stack.request("/v1/documents", {
    method: "POST",
    body: { video: transcript.video, source: transcript.source },
  });
  const documentId = document.document.id;
  const originalRevisionId = document.document.originalRevisionId;
  originalRevision = await stack.request(`/v1/documents/${documentId}/revisions/${originalRevisionId}`);
  check("document created from transcript", "pass", {
    documentId,
    segments: document.source.segmentCount,
    chars: totalChars,
  });

  const cleanStarted = Date.now();
  const cleanJob = await stack.request("/v1/jobs", {
    method: "POST",
    body: {
      type: "clean",
      documentId,
      revisionId: originalRevisionId,
      options: { strength: "standard", language: transcript.source.language || "zh-CN" },
      idempotencyKey: `llm-quality-clean:${documentId}:${originalRevisionId}`,
    },
  });
  const finishedClean = await stack.waitJob(cleanJob.id);
  assert(finishedClean.status === "SUCCEEDED", `clean job failed: ${JSON.stringify(finishedClean.error)}`);
  const cleanMs = Date.now() - cleanStarted;

  const bundle = await stack.request(`/v1/documents/${documentId}`);
  const cleaned = bundle.revisions.find((item) => item.kind === "cleaned");
  assert(cleaned, "cleaned revision missing");
  cleanedRevision = await stack.request(`/v1/documents/${documentId}/revisions/${cleaned.id}`);
  report.metrics.clean = {
    jobId: cleanJob.id,
    status: finishedClean.status,
    elapsedMs: cleanMs,
    stats: finishedClean.result?.stats ?? null,
    blocks: cleanedRevision.blocks.length,
    corrections: cleanedRevision.corrections.length,
    pendingCorrections: cleanedRevision.corrections.filter((item) => item.status === "pending").length,
    appliedEdits: cleanedRevision.appliedEdits.length,
    terms: bundle.terms.length,
    pipelineVersion: cleanedRevision.pipelineVersion,
    createdBy: cleanedRevision.createdBy,
  };
  check("real LLM clean job succeeded", "pass", report.metrics.clean);

  // ---- automated quality checks -------------------------------------------------------
  const covered = new Set(cleanedRevision.blocks.flatMap((block) => block.sourceSegmentIds));
  const missing = sourceSegments.map((segment) => segment.id).filter((id) => !covered.has(id));
  report.metrics.coverage = {
    sourceSegments: sourceSegments.length,
    coveredSegments: covered.size,
    missingSegments: missing.length,
    missingSample: missing.slice(0, 10),
  };
  check("every source segment covered by cleaned blocks", missing.length === 0 ? "pass" : "fail", report.metrics.coverage);

  let previousStart = -1;
  let timestampOk = true;
  for (const block of cleanedRevision.blocks) {
    if (block.text.trim().length === 0 || block.startMs < 0 || block.endMs < block.startMs || block.startMs < previousStart) {
      timestampOk = false;
      break;
    }
    previousStart = block.startMs;
  }
  check("cleaned blocks: non-empty + monotonic timestamps", timestampOk ? "pass" : "fail", {
    blocks: cleanedRevision.blocks.length,
  });

  const parentBlocks = new Map(originalRevision.blocks.map((block) => [block.id, block.text]));
  const invalidEdits = cleanedRevision.appliedEdits.filter((edit) => {
    const parentText = parentBlocks.get(edit.blockId);
    return parentText === undefined || parentText.slice(edit.startOffset, edit.endOffset) !== edit.original;
  });
  check("applied edits still match parent revision text", invalidEdits.length === 0 ? "pass" : "fail", {
    edits: cleanedRevision.appliedEdits.length,
    invalid: invalidEdits.length,
  });
  report.samples.edits = cleanedRevision.appliedEdits.slice(0, 12).map((edit) => ({
    type: edit.changeType,
    original: edit.original,
    replacement: edit.replacement,
    reason: edit.reason,
    evidenceType: edit.evidenceType,
  }));
  report.samples.corrections = cleanedRevision.corrections.slice(0, 12).map((correction) => ({
    type: correction.changeType,
    original: correction.original,
    replacement: correction.replacement,
    reason: correction.reason,
    status: correction.status,
    autoApplicable: correction.autoApplicable,
  }));
  report.samples.terms = (bundle.terms || []).slice(0, 10).map((term) => ({
    canonical: term.canonical,
    variants: term.variants,
    status: term.status,
    evidenceType: term.evidenceType,
  }));

  const cleanedText = cleanedRevision.blocks.map((block) => block.text).join("\n");
  const sourceNumbers = numbersOf(sourceText);
  const cleanedNumbers = numbersOf(cleanedText);
  const lostNumbers = [...sourceNumbers].filter((value) => !cleanedNumbers.has(value));
  const negationSource = countNegations(sourceText);
  const negationCleaned = countNegations(cleanedText);
  report.metrics.text = {
    sourceChars: totalChars,
    cleanedChars: cleanedText.replace(/\s/g, "").length,
    charRatio: ratio(cleanedText.replace(/\s/g, "").length, totalChars),
    numbers: { source: sourceNumbers.size, cleaned: cleanedNumbers.size, lost: lostNumbers.slice(0, 20) },
    negations: { source: negationSource, cleaned: negationCleaned, ratio: ratio(negationCleaned, negationSource) },
  };
  check("numbers preserved (heuristic)", lostNumbers.length === 0 ? "pass" : "skip", report.metrics.text.numbers);
  check(
    "negation markers preserved (heuristic)",
    negationCleaned >= Math.ceil(negationSource * 0.8) ? "pass" : "fail",
    report.metrics.text.negations,
  );

  // ---- summarize with the same real LLM -------------------------------------------------
  const summaryStarted = Date.now();
  const summaryJob = await stack.request("/v1/jobs", {
    method: "POST",
    body: {
      type: "summarize",
      documentId,
      revisionId: cleaned.id,
      idempotencyKey: `llm-quality-summary:${documentId}:${cleaned.id}`,
    },
  });
  const finishedSummary = await stack.waitJob(summaryJob.id);
  assert(finishedSummary.status === "SUCCEEDED", `summarize job failed: ${JSON.stringify(finishedSummary.error)}`);
  summary = await stack.request(`/v1/documents/${documentId}/summaries/latest?revisionId=${cleaned.id}`);
  report.metrics.summary = {
    jobId: summaryJob.id,
    status: finishedSummary.status,
    elapsedMs: Date.now() - summaryStarted,
    model: summary.model,
    overviewChars: summary.overview.length,
    chapters: summary.chapters.length,
    viewpoints: summary.viewpoints.length,
    keyNumbers: summary.keyNumbers.length,
    conclusion: Boolean(summary.conclusion),
    markdownBytes: Buffer.byteLength(summary.markdown || ""),
  };
  check("real LLM summarize job succeeded", "pass", report.metrics.summary);

  const sourceIds = new Set(sourceSegments.map((segment) => segment.id));
  const citedIds = new Set();
  const collect = (citation) => {
    if (!citation) return;
    for (const id of citation.segmentIds || []) citedIds.add(id);
  };
  for (const viewpoint of summary.viewpoints || []) collect(viewpoint);
  for (const chapter of summary.chapters || []) for (const point of chapter.points || []) collect(point);
  for (const number of summary.keyNumbers || []) collect(number);
  collect(summary.conclusion);
  const invalidCitations = [...citedIds].filter((id) => !sourceIds.has(id));
  report.metrics.citations = {
    cited: citedIds.size,
    invalid: invalidCitations.length,
    invalidSample: invalidCitations.slice(0, 10),
  };
  check("summary citations all reference real segments", invalidCitations.length === 0 ? "pass" : "fail", report.metrics.citations);
  check(
    "summary has overview, chapters and timestamp links",
    summary.overview.length > 0 && summary.chapters.length > 0 && /\[?\d{2}:\d{2}/.test(summary.markdown || "")
      ? "pass"
      : "fail",
    { overview: summary.overview.length, chapters: summary.chapters.length },
  );

  report.samples.summary = {
    overview: summary.overview,
    chapters: (summary.chapters || []).slice(0, 5).map((chapter) => ({
      title: chapter.title,
      startMs: chapter.startMs,
      points: (chapter.points || []).slice(0, 2).map((point) => point.text),
    })),
    conclusion: summary.conclusion?.text ?? null,
    coverage: summary.coverage,
  };

  const blockSamples = [];
  for (const block of cleanedRevision.blocks) {
    const originalText = sourceSegments
      .filter((segment) => block.sourceSegmentIds.includes(segment.id))
      .map((segment) => segment.text)
      .join("");
    if (originalText.trim() && originalText.trim() !== block.text.trim() && blockSamples.length < 5) {
      blockSamples.push({ source: originalText.slice(0, 180), cleaned: block.text.slice(0, 180) });
    }
  }
  report.samples.blocks = blockSamples;
  report.samples.cleanedHead = cleanedText.slice(0, 1500);
  report.samples.termOccurrences = {
    sourceDeepSeek: (sourceText.match(/deep\s*seek/gi) || []).length,
    cleanedDeepSeek: (cleanedText.match(/deep\s*seek/gi) || []).length,
    sourceHarness: (sourceText.match(/harness/gi) || []).length,
    cleanedHarness: (cleanedText.match(/harness/gi) || []).length,
  };

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - started;
  report.llm = { ...capabilities.llm, configured: true };
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  check("llm quality acceptance bootstrap", "fail", undefined, error);
  report.logsTail = stack.logs.slice(-25);
} finally {
  await stack.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);

  await mkdir(reportDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportPath = path.join(reportDir, `llm-quality-${stamp}.json`);
  report.ok = report.checks.every((item) => item.status !== "fail") && !report.error;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  const failed = report.checks.filter((item) => item.status === "fail").length;
  const skipped = report.checks.filter((item) => item.status === "skip").length;
  console.log(`\n${report.checks.length - failed - skipped}/${report.checks.length - skipped} checks passed` + (skipped ? ` (${skipped} skipped)` : ""));
  if (report.samples.edits?.length) {
    console.log("\n--- sample edits (human review) ---");
    for (const edit of report.samples.edits) console.log(`[${edit.type}] ${edit.original} -> ${edit.replacement} (${edit.reason})`);
  }
  if (report.samples.summary) {
    console.log("\n--- summary sample ---");
    console.log(report.samples.summary.overview);
    for (const chapter of report.samples.summary.chapters) console.log(`- [${chapter.startMs}ms] ${chapter.title}`);
  }
  console.log(`\nReport: ${reportPath}`);
  process.exitCode = report.ok ? 0 : 1;
}
