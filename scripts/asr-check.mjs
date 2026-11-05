// ASR acceptance: prove the audio path works end-to-end.
//
// Phase 1 (local): synthesize Chinese speech (Windows SAPI), upload it to a real task-api
//   instance, run a transcribe job with faster-whisper (tiny model by default) and verify the
//   generated document/revision. Requires `pip install -e ".[asr]"`.
// Phase 2 (cloud adapter): point the service at a local mock of the OpenAI-compatible
//   /audio/transcriptions endpoint and verify the same pipeline with asr_cloud.
//
// Usage:
//   node scripts/asr-check.mjs
//   BTA_WHISPER_MODEL=base node scripts/asr-check.mjs
//   BTA_SKIP_LOCAL=1 node scripts/asr-check.mjs      # only the mock cloud adapter
//   BTA_ASR_WAV=C:\path\speech.wav node scripts/asr-check.mjs  # skip SAPI synthesis
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const serviceDir = path.join(root, "services", "task-api");
const python = path.join(serviceDir, ".venv", "Scripts", "python.exe");
const reportDir = path.join(root, "docs", "acceptance");
const startedAt = new Date();
const WHISPER_MODEL = process.env.BTA_WHISPER_MODEL || "tiny";
const WHISPER_DEVICE = process.env.BTA_WHISPER_DEVICE || "cpu";
const BTA_ASR_WAV = process.env.BTA_ASR_WAV || "";
const SKIP_LOCAL = process.env.BTA_SKIP_LOCAL === "1";

if (!existsSync(python)) throw new Error(`task-api venv python not found: ${python}`);

const report = { startedAt: startedAt.toISOString(), checks: [], logs: [] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read services/task-api/.env so a locally configured key is also visible to this script. */
async function readServiceDotEnv() {
  try {
    const text = await readFile(path.join(serviceDir, ".env"), "utf8");
    const values = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index <= 0) continue;
      const name = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      values[name] = value;
    }
    return values;
  } catch {
    return {};
  }
}
function check(name, status, details, error) {
  report.checks.push({ name, status, details, error: error ? String(error.message || error) : undefined });
  const icon = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
  console.log(`[${icon}] ${name}`);
  if (status !== "pass" && details !== undefined) console.log("       " + JSON.stringify(details));
  if (error) console.log("       " + (error.stack || error.message || String(error)));
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
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
    const candidate = 8500 + Math.floor(Math.random() * 400);
    try {
      await fetch(`http://127.0.0.1:${candidate}/health`, { signal: AbortSignal.timeout(250) });
    } catch {
      return candidate;
    }
  }
  throw new Error("no free port");
}
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function synthesizeSpeech(target) {
  if (BTA_ASR_WAV && existsSync(BTA_ASR_WAV)) return BTA_ASR_WAV;
  if (process.platform !== "win32") return null;
  const script = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice('Microsoft Huihui Desktop') } catch {}
$s.Rate = 0
$s.SetOutputToWaveFile('${target.replace(/'/g, "''")}')
$s.Speak('大家好，这里是文字稿助手的语音识别测试。我们今天验证音频上传和转写的完整流程。')
$s.Dispose()
`;
  await new Promise((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`SAPI synthesis failed (${code})`))));
    child.on("error", reject);
  });
  return existsSync(target) ? target : null;
}

class Stack {
  constructor(port, dataDir, token, extraEnv = {}) {
    this.port = port;
    this.dataDir = dataDir;
    this.token = token;
    this.extraEnv = extraEnv;
    this.processes = [];
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
      TASKAPI_ENV_FILE: path.join(this.dataDir, "absent.env"),
      TASKAPI_ASR_DISABLED: "0",
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      ...this.extraEnv,
    };
    for (const [label, args] of [
      ["api", ["-u", "-m", "taskapi.serve"]],
      ["worker", ["-u", "-m", "taskapi.worker"]],
    ]) {
      const child = spawn(python, args, { cwd: serviceDir, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (data) => report.logs.push(`[${label}] ${data.toString()}`));
      child.stderr.on("data", (data) => report.logs.push(`[${label}] ${data.toString()}`));
      this.processes.push(child);
    }
    const ready = await waitFor(async () => (await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(800) })).ok, 30000, 500);
    if (!ready) throw new Error("task-api did not start:\n" + report.logs.slice(-10).join(""));
  }
  async request(pathname, { method = "GET", body, headers = {}, parseJson = true } = {}) {
    const response = await fetch(`${this.base}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`${method} ${pathname} -> HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return parseJson ? response.json() : response;
  }
  async waitJob(jobId, timeoutMs = 600000) {
    return waitFor(async () => {
      const job = await this.request(`/v1/jobs/${jobId}`);
      return ["SUCCEEDED", "PARTIAL", "FAILED", "NEEDS_INPUT", "CANCELLED"].includes(job.status) ? job : null;
    }, timeoutMs, 1000);
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

async function uploadAudio(stack, audioPath) {
  const data = new Uint8Array(await readFile(audioPath));
  const digest = sha256(data);
  const upload = await stack.request("/v1/uploads", {
    method: "POST",
    body: { filename: path.basename(audioPath), size: data.length, sha256: digest },
  });
  const chunkSize = upload.chunkSize;
  const parts = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) parts.push(data.subarray(offset, offset + chunkSize));
  for (const [index, part] of parts.entries()) {
    await stack.request(`/v1/uploads/${upload.id}/chunks/${index}`, {
      method: "PUT",
      body: part,
      headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": sha256(part) },
    });
  }
  const complete = await stack.request(`/v1/uploads/${upload.id}/complete`, {
    method: "POST",
    body: { chunkCount: parts.length, totalBytes: data.length, sha256: digest },
  });
  assert(complete.status === "complete", "upload did not complete");
  return { uploadId: upload.id, size: data.length, sha256: digest, chunks: parts.length };
}

const VIDEO = {
  bvid: "BV1xx411c7mD",
  cid: "asr-check-1",
  page: 1,
  title: "ASR 验收测试",
  partTitle: "语音识别",
  author: "本地测试",
  durationMs: 12000,
};

async function runTranscribePhase({ label, stack, audioPath, expectedSourceType, expectedProviderId }) {
  const capabilities = await stack.request("/v1/capabilities");
  const upload = await uploadAudio(stack, audioPath);
  check(`${label}: upload audio in chunks`, "pass", upload);
  const job = await stack.request("/v1/jobs", {
    method: "POST",
    body: {
      type: "transcribe",
      video: VIDEO,
      uploadId: upload.uploadId,
      options: { autoClean: true, language: "zh", strength: "standard" },
      idempotencyKey: `${label}:${upload.sha256}`,
    },
  });
  const finished = await stack.waitJob(job.id, 900000);
  assert(finished, `${label}: transcribe job did not finish`);
  assert(
    ["SUCCEEDED", "PARTIAL"].includes(finished.status),
    `${label}: transcribe job failed: ${JSON.stringify(finished.error || finished.status)}`,
  );
  const documentId = finished.result.documentId;
  const bundle = await stack.request(`/v1/documents/${documentId}`);
  assert(bundle.source?.type === expectedSourceType, `${label}: unexpected source type ${bundle.source?.type}`);
  assert(bundle.source.segmentCount > 0, `${label}: no segments`);
  const kinds = bundle.revisions.map((revision) => revision.kind);
  assert(kinds.includes("original"), `${label}: original revision missing`);
  assert(kinds.includes("cleaned"), `${label}: cleaned revision missing`);
  const original = await stack.request(`/v1/documents/${documentId}/revisions/${bundle.document.originalRevisionId}`);
  const text = original.blocks.map((block) => block.text).join(" ").trim();
  assert(text.length > 0, `${label}: no recognized text`);
  assert(original.blocks.every((block) => block.startMs >= 0 && block.endMs >= block.startMs), `${label}: bad timestamps`);
  const exported = await fetch(`${stack.base}/v1/documents/${documentId}/export?includeSummary=false&includeTerms=false`, {
    headers: { Authorization: `Bearer ${stack.token}` },
  });
  const markdown = await exported.text();
  assert(exported.ok, `${label}: export failed`);
  assert(markdown.includes("转写") || markdown.includes("ASR") || markdown.includes("语音"), `${label}: export missing source label`);
  return {
    capabilities: { asr: capabilities.asr, llm: capabilities.llm },
    job: { id: finished.id, status: finished.status, asrProvider: finished.result.asrProvider, asrModel: finished.result.asrModel },
    documentId,
    source: { type: bundle.source.type, segmentCount: bundle.source.segmentCount },
    revisions: kinds,
    blocks: original.blocks.length,
    firstBlock: original.blocks[0],
    lastBlock: original.blocks[original.blocks.length - 1],
    recognizedText: text.slice(0, 160),
    markdownBytes: Buffer.byteLength(markdown),
  };
}

const workDir = await mkdtemp(path.join(os.tmpdir(), "bta-asr-"));
const dataDirs = [];
let activeStack = null;
let mockCloud = null;

try {
  await mkdir(reportDir, { recursive: true });
  const audioPath = await synthesizeSpeech(path.join(workDir, "speech.wav"));
  assert(audioPath, "no test audio: set BTA_ASR_WAV or run on Windows with a zh-CN SAPI voice");
  const audioInfo = await stat(audioPath);
  check("test speech synthesized", "pass", { audioPath, bytes: audioInfo.size });

  if (!SKIP_LOCAL) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "bta-asr-local-"));
    dataDirs.push(dataDir);
    activeStack = new Stack(await pickPort(), dataDir, `asr-local-${Date.now()}`, {
      ASR_PROVIDER: "faster-whisper",
      WHISPER_MODEL,
      WHISPER_DEVICE,
      TASKAPI_MAX_DURATION_MINUTES: "5",
    });
    await activeStack.start();
    const capabilities = await activeStack.request("/v1/capabilities");
    const local = capabilities.asr.providers.find((provider) => provider.id === "faster-whisper");
    assert(local?.available === true, `faster-whisper not available: ${JSON.stringify(capabilities.asr)}`);
    assert(capabilities.asr.defaultProvider === "faster-whisper", "default ASR should be faster-whisper");
    check("local ASR capability", "pass", { defaultProvider: capabilities.asr.defaultProvider, model: WHISPER_MODEL, device: WHISPER_DEVICE });
    const started = Date.now();
    const result = await runTranscribePhase({
      label: "local faster-whisper",
      stack: activeStack,
      audioPath,
      expectedSourceType: "asr_local",
      expectedProviderId: "faster-whisper",
    });
    result.elapsedMs = Date.now() - started;
    check("local faster-whisper transcribe job", "pass", result);
    report.local = result;
    await activeStack.stop();
    activeStack = null;
  } else {
    check("local faster-whisper capability", "skip", { reason: "BTA_SKIP_LOCAL=1" });
    check("local faster-whisper transcribe job", "skip", { reason: "BTA_SKIP_LOCAL=1" });
  }

  // ---- cloud adapter against a local mock ------------------------------------------------
  mockCloud = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.startsWith("/audio/transcriptions")) {
      response.writeHead(404).end("not found");
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          text: "大家好，这里是云语音识别适配器的模拟返回。",
          language: "zh",
          duration: 10,
          segments: [
            { start: 0, end: 3.2, text: "大家好，这里是云语音识别适配器的模拟返回。", avg_logprob: -0.2 },
          ],
        }),
      );
      report.mockCloudRequestBytes = body.length;
    });
  });
  await new Promise((resolve) => mockCloud.listen(0, "127.0.0.1", resolve));
  const mockPort = mockCloud.address().port;
  const cloudDataDir = await mkdtemp(path.join(os.tmpdir(), "bta-asr-cloud-"));
  dataDirs.push(cloudDataDir);
  const cloudStack = new Stack(await pickPort(), cloudDataDir, `asr-cloud-${Date.now()}`, {
    ASR_PROVIDER: "openai-compatible",
    ASR_BASE_URL: `http://127.0.0.1:${mockPort}`,
    ASR_API_KEY: "mock-cloud-key",
    ASR_MODEL: "mock-asr-model",
    TASKAPI_MAX_DURATION_MINUTES: "5",
  });
  await cloudStack.start();
  activeStack = cloudStack;
  const cloudResult = await runTranscribePhase({
    label: "mock cloud ASR",
    stack: cloudStack,
    audioPath,
    expectedSourceType: "asr_cloud",
    expectedProviderId: "openai-compatible",
  });
  check("cloud ASR adapter transcribe job", "pass", { ...cloudResult, mockRequestBytes: report.mockCloudRequestBytes });
  report.cloud = cloudResult;
  await activeStack.stop();
  activeStack = null;

  // ---- Alibaba Cloud Bailian Filetrans (real, only when a key is available) ---------------
  const dotenv = await readServiceDotEnv();
  const dashscopeKey = process.env.DASHSCOPE_API_KEY || dotenv.DASHSCOPE_API_KEY || "";
  const dashscopeModel =
    process.env.BTA_DASHSCOPE_MODEL ||
    process.env.DASHSCOPE_ASR_MODEL ||
    dotenv.DASHSCOPE_ASR_MODEL ||
    "qwen-audio-3.1-asr-flash-filetrans";
  const dashscopeBase =
    process.env.DASHSCOPE_BASE_URL || dotenv.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com";
  if (dashscopeKey) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "bta-asr-dashscope-"));
    dataDirs.push(dataDir);
    const dashscopeStack = new Stack(await pickPort(), dataDir, `asr-dashscope-${Date.now()}`, {
      ASR_PROVIDER: "dashscope-filetrans",
      DASHSCOPE_API_KEY: dashscopeKey,
      DASHSCOPE_ASR_MODEL: dashscopeModel,
      DASHSCOPE_BASE_URL: dashscopeBase,
      DASHSCOPE_POLL_INTERVAL: process.env.DASHSCOPE_POLL_INTERVAL || "2",
      TASKAPI_MAX_DURATION_MINUTES: "5",
    });
    await dashscopeStack.start();
    activeStack = dashscopeStack;
    const capabilities = await dashscopeStack.request("/v1/capabilities");
    const provider = capabilities.asr.providers.find((item) => item.id === "dashscope-filetrans");
    assert(provider?.available === true, "Bailian filetrans provider should be available with a key");
    assert(capabilities.asr.defaultProvider === "dashscope-filetrans", "ASR_PROVIDER=dashscope-filetrans not honored");
    check("Bailian filetrans capability", "pass", {
      defaultProvider: capabilities.asr.defaultProvider,
      model: dashscopeModel,
      timestamps: provider.timestamps,
    });
    const dashscopeStarted = Date.now();
    const dashscopeResult = await runTranscribePhase({
      label: "Bailian filetrans",
      stack: dashscopeStack,
      audioPath,
      expectedSourceType: "asr_cloud",
      expectedProviderId: "dashscope-filetrans",
    });
    dashscopeResult.elapsedMs = Date.now() - dashscopeStarted;
    assert(dashscopeResult.blocks >= 1, "Bailian returned no transcript blocks");
    assert(dashscopeResult.lastBlock.endMs > 0, "Bailian timestamps are all zero");
    check("Bailian filetrans transcribe job (real API)", "pass", dashscopeResult);
    report.dashscope = dashscopeResult;
    await activeStack.stop();
    activeStack = null;
  } else {
    check("Bailian filetrans transcribe job (real API)", "skip", {
      reason: "set DASHSCOPE_API_KEY to run the real Bailian filetrans acceptance",
    });
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  check("asr acceptance bootstrap", "fail", undefined, error);
  report.logsTail = report.logs.slice(-30);
} finally {
  await activeStack?.stop();
  mockCloud?.close();
  for (const dir of dataDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportPath = path.join(reportDir, `asr-check-${stamp}.json`);
  report.ok = report.checks.every((item) => item.status !== "fail") && !report.error;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  const failed = report.checks.filter((item) => item.status === "fail").length;
  const skipped = report.checks.filter((item) => item.status === "skip").length;
  console.log(`\n${report.checks.length - failed - skipped}/${report.checks.length - skipped} checks passed` + (skipped ? ` (${skipped} skipped)` : ""));
  if (report.local?.recognizedText) console.log(`recognized: ${report.local.recognizedText}`);
  console.log(`Report: ${reportPath}`);
  process.exitCode = report.ok ? 0 : 1;
}
