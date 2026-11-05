// 服务级 E2E 验收：自包含启动 task-api（uvicorn）+ worker，跑通“扩展 → 任务服务”的完整协议链。
//
// 不依赖浏览器、不依赖外网、不写仓库文件：临时数据目录 + 随机端口 + 固定 token。
//
// 覆盖（阶段 0：配置）
//   0. services/task-api/.env 生效：文件提供端口/令牌/数据目录；同名进程环境变量优先
//
// 覆盖（阶段 A：未配置 LLM/ASR，走 HeuristicLLM 离线路径）
//   1. 启动横幅：数据目录 / 监听地址 / token / LLM 与 ASR 状态；不泄漏任何 API Key
//   2. /health 公开；无 token / 错误 token 访问 /v1/capabilities → 401 unauthorized；正确 token → 200
//   3. 词表 PUT/GET 往返
//   4. POST /v1/documents：fixture 建文稿，校验 bundle、find by bvid/cid/page
//   5. clean job：幂等键去重、轮询 SUCCEEDED、cleaned revision（blocks/时间戳/片段归属/appliedEdits）
//   6. summarize job：overview、chapters 引用 segmentIds 真实性、markdown 时间链接
//   7. 导出 md/json：Content-Disposition 文件名、章节时间链接、内容与选项开关
//   8. 人工修订 POST revisions：父版本、内容、latestRevisionId、导出文件名变化；空 blocks → 400
//   9. 上传会话：分块 SHA256、错误 SHA → 400、错误 totalBytes → 409、complete、重复 PUT 幂等
//  10. transcribe job 在无 ASR 时 → NEEDS_INPUT + asr_not_configured；缺少 uploadId → 400
//  11. 错误契约：404 not_found、409 conflict、400 invalid_request
//
// 阶段 B（可选加分，默认开启；BTA_TASKAPI_E2E_SKIP_LLM=1 跳过）
//  用 Node 起一个 OpenAI 兼容 /chat/completions mock，让服务走真实 LLM 代码路径：
//  术语发现 → 逐段清洗 → 一致性检查 → 章节总结 → 汇总，并验证 pending corrections
//  结构、/corrections/apply 补丁应用、以及“启动横幅绝不打印密钥”。
//
// 用法：
//   node scripts/taskapi-e2e.mjs
//   node scripts/taskapi-e2e.mjs --keep        # 失败/成功后保留临时数据目录便于排查
//   BTA_TASKAPI_E2E_KEEP=1 node scripts/taskapi-e2e.mjs
//   BTA_TASKAPI_E2E_SKIP_LLM=1 node scripts/taskapi-e2e.mjs
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const serviceDir = path.join(root, "services", "task-api");
const fixturePath = path.join(__dirname, "fixtures", "subtitle-sample.json");
const pythonPath = path.join(
  serviceDir,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);
const keepDirs = process.argv.includes("--keep") || process.env.BTA_TASKAPI_E2E_KEEP === "1";
const skipLLM = process.env.BTA_TASKAPI_E2E_SKIP_LLM === "1";
const CHUNK_SIZE = 4096;
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "NEEDS_INPUT", "PARTIAL", "CANCELLED"]);
const CORRECTION_TYPES = new Set(["term", "filler", "consistency", "recognition", "format", "note"]);

if (!existsSync(pythonPath)) {
  console.error(`python venv not found: ${pythonPath}\nRun: cd services/task-api && python -m venv .venv && .venv\\Scripts\\pip install -e ".[dev]"`);
  process.exit(1);
}
if (!existsSync(fixturePath)) {
  console.error(`fixture not found: ${fixturePath}`);
  process.exit(1);
}

const checks = [];
const startedAt = new Date();
let failure = null;
let stackA = null;
let stackB = null;
let mockLLM = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, status, details, error) {
  const entry = {
    name,
    status,
    details,
    error: error ? String(error.message || error) : undefined,
  };
  checks.push(entry);
  const icon = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
  console.log(`[${icon}] ${name}`);
  if (status !== "pass" && details !== undefined) console.log(`       ${JSON.stringify(details)}`);
  if (error) console.log(`       ${(error.stack || error.message || String(error)).split("\n").slice(0, 6).join("\n       ")}`);
  return entry;
}

async function runCheck(name, fn) {
  try {
    const details = await fn();
    check(name, "pass", details);
    return details;
  } catch (error) {
    check(name, "fail", undefined, error);
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(haystack, needle, label) {
  assert(haystack.includes(needle), `${label}: missing ${JSON.stringify(needle)} (len=${haystack?.length})`);
}

function tail(text, size = 4000) {
  const value = String(text || "");
  return value.length <= size ? value : "..." + value.slice(-size);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- processes

/** Strip inherited task-api / LLM / ASR env vars so phases are deterministic. */
function strippedEnv() {
  const env = { ...process.env };
  const managed = new Set([
    "LLM_API_KEY",
    "LLM_BASE_URL",
    "LLM_MODEL",
    "LLM_TEMPERATURE",
    "ASR_API_KEY",
    "ASR_BASE_URL",
    "ASR_MODEL",
    "ASR_PROVIDER",
    "WHISPER_MODEL",
    "WHISPER_DEVICE",
    "TASKAPI_DATA_DIR",
    "TASKAPI_HOST",
    "TASKAPI_PORT",
    "TASKAPI_TOKEN",
    "TASKAPI_AUTH_DISABLED",
    "TASKAPI_ASR_DISABLED",
    "TASKAPI_ENV_FILE",
    "TASKAPI_CHUNK_SIZE",
    "TASKAPI_MAX_UPLOAD_BYTES",
    "TASKAPI_MAX_DURATION_MINUTES",
    "TASKAPI_RETENTION_HOURS",
    "TASKAPI_MAX_ATTEMPTS",
  ]);
  for (const key of Object.keys(env)) {
    if (managed.has(key.toUpperCase())) delete env[key];
  }
  return env;
}

function spawnLogged(label, args, options) {
  const child = spawn(pythonPath, args, {
    cwd: serviceDir,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const info = { label, child, pid: child.pid, logs: "", exited: false, code: null, signal: null };
  const append = (chunk) => {
    info.logs += chunk.toString();
    if (info.logs.length > 600_000) info.logs = info.logs.slice(-500_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", (code, signal) => {
    info.exited = true;
    info.code = code;
    info.signal = signal;
  });
  child.on("error", (error) => {
    append(`\n[spawn error] ${error.message}\n`);
    info.exited = true;
  });
  return info;
}

async function stopLogged(info) {
  if (!info || info.exited) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(info.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("exit", resolve);
      killer.on("error", resolve);
      setTimeout(resolve, 8000);
    });
  } else {
    try {
      info.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  const deadline = Date.now() + 8000;
  while (!info.exited && Date.now() < deadline) await sleep(100);
  if (!info.exited) {
    try {
      info.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

// --------------------------------------------------------------------------- HTTP

async function request(stack, method, apiPath, options = {}) {
  const { token, body, json, headers = {} } = options;
  const requestHeaders = { ...headers };
  const authToken = token === undefined ? stack.token : token;
  if (authToken !== null) requestHeaders.Authorization = `Bearer ${authToken}`;
  let payload = body;
  if (json !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    payload = JSON.stringify(json);
  }
  const response = await fetch(`${stack.base}${apiPath}`, {
    method,
    headers: requestHeaders,
    body: payload,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, data: parseJson(text) };
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${response.status}\n${tail(response.text, 1200)}`);
  }
}

async function waitForHealth(stack, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stack.api.exited) {
      throw new Error(`API process exited early (code ${stack.api.code})\n${tail(stack.api.logs)}`);
    }
    try {
      const response = await fetch(`${stack.base}/health`, { signal: AbortSignal.timeout(2500) });
      if (response.ok) return response.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`API did not become healthy on ${stack.base}\n${tail(stack.api.logs)}`);
}

async function waitForText(info, needle, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (info.logs.includes(needle)) return info.logs;
    await sleep(150);
  }
  throw new Error(`${info.label} did not print ${JSON.stringify(needle)}\n${tail(info.logs)}`);
}

async function waitJob(stack, jobId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await request(stack, "GET", `/v1/jobs/${jobId}`);
    if (response.status !== 200) {
      throw new Error(`job ${jobId} poll failed: HTTP ${response.status}\n${tail(response.text, 800)}`);
    }
    last = response.data;
    if (TERMINAL.has(last.status)) return last;
    await sleep(250);
  }
  throw new Error(`job ${jobId} did not reach a terminal state in ${timeoutMs}ms (last: ${last?.status})`);
}

// --------------------------------------------------------------------------- service stack

async function createStack(label, envOverrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `bta-taskapi-${label}-`));
  const port = await freePort();
  const token = `e2e-${label}-${randomBytes(9).toString("hex")}`;
  // Point .env loading at a file that intentionally does not exist: the E2E must not
  // inherit a developer's services/task-api/.env (LLM/ASR keys would change the path).
  const envFile = path.join(dataDir, "no-dotenv.env");
  const commonEnv = {
    ...strippedEnv(),
    TASKAPI_DATA_DIR: dataDir,
    TASKAPI_HOST: "127.0.0.1",
    TASKAPI_PORT: String(port),
    TASKAPI_TOKEN: token,
    TASKAPI_CHUNK_SIZE: String(CHUNK_SIZE),
    TASKAPI_ENV_FILE: envFile,
    // Phase A must exercise the offline path even on a machine with faster-whisper installed.
    TASKAPI_ASR_DISABLED: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    ...envOverrides,
  };
  const stack = {
    label,
    dataDir,
    port,
    token,
    envFile,
    env: commonEnv,
    base: `http://127.0.0.1:${port}`,
  };
  stack.api = spawnLogged(`api-${label}`, ["-u", "-m", "taskapi.serve", "--host", "127.0.0.1", "--port", String(port)], {
    env: commonEnv,
  });
  stack.worker = spawnLogged(`worker-${label}`, ["-u", "-m", "taskapi.worker"], { env: commonEnv });
  try {
    stack.health = await waitForHealth(stack);
  } catch (error) {
    await stopStack(stack, false);
    throw error;
  }
  return stack;
}

async function stopStack(stack, removeDir) {
  if (!stack) return;
  await stopLogged(stack.worker);
  await stopLogged(stack.api);
  const cleanupDir = stack.cleanupDir || stack.dataDir;
  if (removeDir && !keepDirs) {
    await rm(cleanupDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// --------------------------------------------------------------------------- mock OpenAI-compatible LLM

function classifyPrompt(system) {
  if (system.includes("术语审校助手")) return "term_discovery";
  if (system.includes("文字稿的编辑")) return "clean";
  if (system.includes("一致性审校员")) return "consistency";
  if (system.includes("校对编辑")) return "suggest";
  if (system.includes("摘要编辑")) return "summary_chunk";
  if (system.includes("汇总编辑")) return "summary_aggregate";
  return "unknown";
}

function mockResponse(kind, user) {
  const payload = parseJson(user) || {};
  if (kind === "term_discovery") {
    const segments = payload.segments || [];
    const hit = segments.find((segment) => String(segment.text || "").includes("滴普西克")) || segments[0] || {};
    return {
      terms: [
        {
          canonical: "DeepSeek",
          variants: ["滴普西克"],
          entityType: "product",
          evidenceType: "context_only",
          evidenceSegmentIds: hit.id ? [hit.id] : [],
          note: "E2E mock：读音相近的写法",
        },
      ],
    };
  }
  if (kind === "clean") {
    const segments = payload.segments || [];
    return { segments: segments.map((segment) => ({ id: segment.id, text: String(segment.text || "") })), notes: ["e2e mock: keep text"] };
  }
  if (kind === "consistency") {
    const blocks = payload.blocks || [];
    const target = blocks.find((block) => String(block.text || "").includes("三个模式")) || null;
    if (!target) return { issues: [] };
    return {
      issues: [
        {
          blockId: target.blockId,
          quote: "三个模式",
          suggestion: null,
          type: "contradiction",
          reason: "后文改成支持四个模式，没有明确修正关系，需要人工确认",
          evidenceSegmentIds: (target.segmentIds || []).slice(0, 2),
        },
      ],
    };
  }
  if (kind === "suggest") {
    const issues = payload.items || payload;
    return {
      suggestions: (Array.isArray(issues) ? issues : []).map((item) => ({
        blockId: item.blockId,
        quote: item.quote,
        suggestion: String(item.quote || "").replace("三个模式", "四个模式"),
      })),
    };
  }
  if (kind === "summary_chunk") {
    const blocks = payload.blocks || [];
    const points = [];
    for (const block of blocks.slice(0, 3)) {
      const segmentIds = (block.segmentIds || []).slice(0, 2);
      if (!segmentIds.length) continue;
      points.push({ text: String(block.text || "").slice(0, 80), segmentIds, kind: "step" });
    }
    return {
      chapterTitle: `E2E 章节 ${Number(payload.chunkIndex || 0) + 1}`,
      points,
      keyNumbers: [],
      uncertainties: [],
    };
  }
  if (kind === "summary_aggregate") {
    const chunks = payload.chunks || [];
    const chapters = chunks.map((chunk, index) => ({
      title: String(chunk.chapterTitle || `章节 ${index + 1}`),
      startSegmentId: chunk.startSegmentId || "",
      endSegmentId: chunk.endSegmentId || "",
      points: chunk.points || [],
    }));
    const firstPoints = chapters[0]?.points || [];
    return {
      overview: firstPoints.map((point) => point.text).join("；").slice(0, 240) || "E2E mock 总结概览。",
      viewpoints: firstPoints.slice(0, 2),
      chapters,
      conclusion: firstPoints[0] || null,
      keyNumbers: [],
      coverage: { sources: ["B站AI字幕"], gaps: ["E2E mock 未覆盖图表与画面"], uncertainties: [] },
    };
  }
  return { error: "unknown prompt" };
}

async function startMockLLM() {
  const port = await freePort();
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST" || !String(req.url || "").endsWith("/chat/completions")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        /* ignore */
      }
      const messages = payload.messages || [];
      const system = String(messages.find((message) => message.role === "system")?.content || "");
      const user = String(messages.find((message) => message.role === "user")?.content || "");
      const kind = classifyPrompt(system);
      calls.push(kind);
      const content = JSON.stringify(mockResponse(kind, user));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-e2e-${calls.length}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "e2e-mock-model",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// --------------------------------------------------------------------------- fixture / payloads

function assertBasePatchEdits(appliedEdits, baseBlocks, label) {
  assert(Array.isArray(appliedEdits), `${label}: appliedEdits must be an array`);
  assert(appliedEdits.length > 0, `${label}: expected at least one applied edit`);
  const baseById = new Map(baseBlocks.map((block) => [block.id, block]));
  for (const edit of appliedEdits) {
    assert(typeof edit.blockId === "string" && edit.blockId.length > 0, `${label}: appliedEdit.blockId missing`);
    const base = baseById.get(edit.blockId);
    assert(base, `${label}: appliedEdit.blockId ${edit.blockId} is not a block of the parent revision`);
    assert(Number.isInteger(edit.startOffset) && Number.isInteger(edit.endOffset), `${label}: appliedEdit offsets must be integers`);
    assert(edit.startOffset >= 0 && edit.startOffset <= edit.endOffset, `${label}: appliedEdit offsets out of order`);
    assert(edit.endOffset <= base.text.length, `${label}: appliedEdit ${edit.endOffset} exceeds block text length ${base.text.length}`);
    assertEqual(base.text.slice(edit.startOffset, edit.endOffset), edit.original, `${label}: appliedEdit.original must match parent block text`);
    assert(typeof edit.replacement === "string", `${label}: appliedEdit.replacement must be a string`);
    assert(typeof edit.reason === "string" && edit.reason.length > 0, `${label}: appliedEdit.reason empty`);
    assert(typeof edit.changeType === "string" && edit.changeType.length > 0, `${label}: appliedEdit.changeType empty`);
    assert(Array.isArray(edit.sourceSegmentIds) && edit.sourceSegmentIds.length > 0, `${label}: appliedEdit.sourceSegmentIds empty`);
  }
}

function assertCorrections(corrections, blocks, segmentIds, label) {
  assert(Array.isArray(corrections), `${label}: corrections must be an array`);
  assert(corrections.length > 0, `${label}: expected pending corrections`);
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const ids = new Set();
  for (const correction of corrections) {
    assert(typeof correction.id === "string" && correction.id.length > 0, `${label}: correction.id missing`);
    assert(!ids.has(correction.id), `${label}: duplicate correction id ${correction.id}`);
    ids.add(correction.id);
    const block = blockById.get(correction.blockId);
    assert(block, `${label}: correction.blockId ${correction.blockId} is not a block of this revision`);
    assert(Number.isInteger(correction.startOffset) && Number.isInteger(correction.endOffset), `${label}: correction offsets must be integers`);
    assert(correction.startOffset >= 0 && correction.startOffset <= correction.endOffset, `${label}: correction offsets out of order`);
    assert(correction.endOffset <= block.text.length, `${label}: correction ${correction.id} offset exceeds block text`);
    assertEqual(block.text.slice(correction.startOffset, correction.endOffset), correction.original, `${label}: correction.original mismatch`);
    assert(correction.replacement === null || typeof correction.replacement === "string", `${label}: correction.replacement invalid`);
    assert(CORRECTION_TYPES.has(correction.changeType), `${label}: correction.changeType ${correction.changeType} invalid`);
    assertEqual(correction.status, "pending", `${label}: correction.status`);
    assert(typeof correction.reason === "string" && correction.reason.length > 0, `${label}: correction.reason empty`);
    assert(Array.isArray(correction.evidenceSegmentIds), `${label}: correction.evidenceSegmentIds must be an array`);
    for (const segmentId of correction.evidenceSegmentIds) {
      assert(segmentIds.has(segmentId), `${label}: correction evidence segment ${segmentId} does not exist`);
    }
  }
}

function makeWavBytes(seconds = 0.5, sampleRate = 16000) {
  const sampleCount = Math.round(seconds * sampleRate);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

// --------------------------------------------------------------------------- phase 0: .env loading

/** Prove services/task-api/.env is honored (port/token/data dir) and that process env wins. */
async function phaseDotenv() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "bta-taskapi-dotenv-"));
  const dataDir = path.join(baseDir, "data-from-dotenv");
  const port = await freePort();
  const token = `dotenv-${randomBytes(6).toString("hex")}`;
  const envFile = path.join(baseDir, ".env");
  await writeFile(
    envFile,
    [
      "# E2E: values below come from this file; process environment wins for keys that are set.",
      `TASKAPI_DATA_DIR=${dataDir}`,
      "TASKAPI_HOST=127.0.0.1",
      `TASKAPI_PORT=${port}`,
      `TASKAPI_TOKEN=${token}`,
      "TASKAPI_CHUNK_SIZE=2048",
      "",
    ].join("\n"),
    "utf8",
  );
  const env = {
    ...strippedEnv(),
    TASKAPI_ENV_FILE: envFile,
    TASKAPI_CHUNK_SIZE: "8192", // process env must override the .env value 2048
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
  };
  const stack = {
    label: "dotenv",
    dataDir,
    cleanupDir: baseDir,
    port,
    token,
    envFile,
    env,
    base: `http://127.0.0.1:${port}`,
  };
  stack.api = spawnLogged("api-dotenv", ["-u", "-m", "taskapi.serve"], { env });
  try {
    stack.health = await waitForHealth(stack);
    await runCheck("services/task-api/.env: file supplies port/token/data dir; process env wins", async () => {
      const banner = await waitForText(stack.api, "访问令牌", 30_000);
      assertIncludes(banner, `http://127.0.0.1:${port}`, ".env port applied to the bind address");
      assertIncludes(banner, token, ".env token applied");
      assertIncludes(banner.toLowerCase(), dataDir.toLowerCase(), ".env data dir applied");
      assert(existsSync(dataDir), `.env data dir was not created: ${dataDir}`);
      assert(existsSync(path.join(dataDir, "db", "taskapi.sqlite3")), ".env data dir is missing the sqlite database");

      const capabilities = await request(stack, "GET", "/v1/capabilities");
      assertStatus(capabilities, 200, "GET /v1/capabilities via .env token");
      assertEqual(capabilities.data.limits.chunkSize, 8192, "process env must override .env TASKAPI_CHUNK_SIZE");
      return { port, dataDir, chunkSize: capabilities.data.limits.chunkSize };
    });
  } finally {
    await stopStack(stack, true);
  }
}

// --------------------------------------------------------------------------- phase A: offline (heuristic)

async function phaseHeuristic() {
  const stack = await createStack("heuristic");
  stackA = stack;
  const state = {};

  await runCheck("startup banner: data dir / bind address / token / LLM+ASR status (no secrets)", async () => {
    const banner = await waitForText(stack.api, "访问令牌", 30_000);
    const workerBanner = await waitForText(stack.worker, "数据目录", 30_000);
    assertIncludes(banner, "数据目录", "api banner");
    assertIncludes(banner.toLowerCase(), stack.dataDir.toLowerCase(), "api banner data dir");
    assertIncludes(banner, `http://127.0.0.1:${stack.port}`, "api banner bind address");
    assertIncludes(banner, stack.token, "api banner token");
    assertIncludes(banner, "扩展设置页", "api banner pairing hint");
    assertIncludes(banner, "HeuristicLLM", "api banner LLM status");
    assertIncludes(banner, "未配置可用识别服务", "api banner ASR status");
    assertIncludes(banner, "FFmpeg", "api banner FFmpeg status");
    assertIncludes(workerBanner, "HeuristicLLM", "worker banner LLM status");
    return { apiBannerLines: banner.split("\n").length, workerBannerLines: workerBanner.split("\n").length };
  });

  await runCheck("health is public; capabilities requires the paired token", async () => {
    const health = await request(stack, "GET", "/health", { token: null });
    assertStatus(health, 200, "GET /health");
    assertEqual(health.data.status, "ok", "health.status");
    assertEqual(health.data.apiVersion, "v1", "health.apiVersion");

    const missing = await request(stack, "GET", "/v1/capabilities", { token: null });
    assertStatus(missing, 401, "GET /v1/capabilities without token");
    assertEqual(missing.data.code, "unauthorized", "401 error code");

    const wrong = await request(stack, "GET", "/v1/capabilities", { token: "definitely-wrong-token" });
    assertStatus(wrong, 401, "GET /v1/capabilities with wrong token");

    const capabilities = await request(stack, "GET", "/v1/capabilities");
    assertStatus(capabilities, 200, "GET /v1/capabilities with token");
    const data = capabilities.data;
    assertEqual(data.apiVersion, "v1", "capabilities.apiVersion");
    assertEqual(data.llm.provider, "local-heuristic", "capabilities.llm.provider");
    assertEqual(data.llm.configured, false, "capabilities.llm.configured");
    assertEqual(data.asr.configured, false, "capabilities.asr.configured");
    assertEqual(data.asr.defaultProvider, "none", "capabilities.asr.defaultProvider");
    assertEqual(data.asr.providers.length, 3, "capabilities.asr.providers");
    assert(data.asr.providers.every((provider) => provider.available === false), "offline ASR providers must be unavailable");
    assertEqual(data.limits.chunkSize, CHUNK_SIZE, "capabilities.limits.chunkSize");
    assertEqual(data.limits.maxUploadBytes, 512 * 1024 * 1024, "capabilities.limits.maxUploadBytes");
    for (const feature of ["clean", "summary", "glossary", "manual_edit", "audio_upload", "term_discovery", "markdown_export"]) {
      assert(data.features.includes(feature), `capabilities.features missing ${feature}`);
    }
    return { llm: data.llm.provider, asrConfigured: data.asr.configured, chunkSize: data.limits.chunkSize };
  });

  await runCheck("glossary PUT/GET round-trip", async () => {
    const empty = await request(stack, "GET", "/v1/glossary");
    assertStatus(empty, 200, "GET /v1/glossary");
    assert(Array.isArray(empty.data.entries) && empty.data.entries.length === 0, "glossary should start empty");

    const entries = [
      { canonical: "DeepSeek", variants: ["滴普西克"], entityType: "product" },
      { canonical: "B站", variants: ["b站", "哔哩哔哩"], entityType: "org" },
    ];
    const put = await request(stack, "PUT", "/v1/glossary", { json: { entries } });
    assertStatus(put, 200, "PUT /v1/glossary");
    assertEqual(put.data.entries.length, 2, "glossary entry count");

    const get = await request(stack, "GET", "/v1/glossary");
    assertStatus(get, 200, "GET /v1/glossary after PUT");
    const byCanonical = new Map(get.data.entries.map((entry) => [entry.canonical, entry]));
    assert(byCanonical.has("DeepSeek"), "glossary missing DeepSeek");
    assert(byCanonical.get("DeepSeek").variants.includes("滴普西克"), "glossary variants not normalized");
    state.glossary = get.data.entries;
    return { entries: get.data.entries };
  });

  await runCheck("POST /v1/documents from fixture builds a valid bundle", async () => {
    const fixture = parseJson(await readFile(fixturePath, "utf8"));
    state.fixture = fixture;
    state.segmentIds = new Set(fixture.source.segments.map((segment) => segment.id));
    const created = await request(stack, "POST", "/v1/documents", {
      json: { video: fixture.video, source: fixture.source },
    });
    assertStatus(created, 201, "POST /v1/documents");
    const bundle = created.data;
    state.bundle = bundle;
    state.documentId = bundle.document.id;
    state.originalRevisionId = bundle.document.originalRevisionId;

    assert(bundle.document.id.startsWith("doc_"), "document.id prefix");
    assertEqual(bundle.document.video.bvid, fixture.video.bvid, "document.video.bvid");
    assertEqual(bundle.document.video.cid, fixture.video.cid, "document.video.cid");
    assertEqual(bundle.document.video.page, fixture.video.page, "document.video.page");
    assertEqual(bundle.document.video.title, fixture.video.title, "document.video.title");
    assertEqual(bundle.source.type, fixture.source.type, "source.type");
    assertEqual(bundle.source.segmentCount, fixture.source.segments.length, "source.segmentCount");
    assertEqual(bundle.source.startMs, fixture.source.segments[0].startMs, "source.startMs");
    assertEqual(bundle.source.endMs, fixture.source.segments.at(-1).endMs, "source.endMs");
    assertEqual(bundle.revisions.length, 1, "bundle.revisions length");
    assertEqual(bundle.revisions[0].kind, "original", "original revision kind");
    assertEqual(bundle.revisions[0].blockCount, fixture.source.segments.length, "original revision blockCount");
    assertEqual(bundle.document.originalRevisionId, bundle.document.latestRevisionId, "original/latest revision ids");
    assertEqual(bundle.terms.length, 0, "new document terms");

    const found = await request(
      stack,
      "GET",
      `/v1/documents?bvid=${encodeURIComponent(fixture.video.bvid)}&cid=${encodeURIComponent(fixture.video.cid)}&page=${fixture.video.page}`,
    );
    assertStatus(found, 200, "GET /v1/documents?bvid&cid&page");
    assertEqual(found.data.document.id, bundle.document.id, "find document id");
    const fetched = await request(stack, "GET", `/v1/documents/${bundle.document.id}`);
    assertStatus(fetched, 200, "GET /v1/documents/{id}");
    assertEqual(fetched.data.document.id, bundle.document.id, "fetched document id");
    return {
      documentId: bundle.document.id,
      originalRevisionId: bundle.document.originalRevisionId,
      segments: bundle.source.segmentCount,
    };
  });

  await runCheck("clean job (heuristic): idempotency, SUCCEEDED, cleaned revision contract", async () => {
    const payload = {
      type: "clean",
      documentId: state.documentId,
      options: { strength: "standard" },
      idempotencyKey: "e2e-clean-heuristic-1",
    };
    const created = await request(stack, "POST", "/v1/jobs", { json: payload });
    assertStatus(created, 201, "POST /v1/jobs (clean)");
    assertEqual(created.data.type, "clean", "clean job.type");
    assertEqual(created.data.status, "QUEUED", "clean job initial status");
    assertEqual(created.data.idempotencyKey, undefined, "idempotencyKey is not echoed (contract: ignored field)");
    state.cleanJobId = created.data.id;

    const duplicate = await request(stack, "POST", "/v1/jobs", { json: payload });
    assert(duplicate.status === 201 || duplicate.status === 200, `idempotent duplicate should succeed, got ${duplicate.status}`);
    assertEqual(duplicate.data.id, created.data.id, "idempotent clean job id");

    const job = await waitJob(stack, state.cleanJobId);
    assertEqual(job.status, "SUCCEEDED", `clean job status (${JSON.stringify(job.error || null)})`);
    assertEqual(job.stage, "done", "clean job stage");
    assertEqual(job.progress.percent, 100, "clean job progress");
    assert(job.result && job.result.revisionId, "clean job result.revisionId");
    assert(job.result.stats && job.result.stats.llm === "heuristic", "clean stats.llm");
    state.cleanedRevisionId = job.result.revisionId;

    const original = await request(stack, "GET", `/v1/documents/${state.documentId}/revisions/${state.originalRevisionId}`);
    assertStatus(original, 200, "GET original revision");
    const cleaned = await request(
      stack,
      "GET",
      `/v1/documents/${state.documentId}/revisions/${state.cleanedRevisionId}`,
    );
    assertStatus(cleaned, 200, "GET cleaned revision");
    const revision = cleaned.data;
    assertEqual(revision.kind, "cleaned", "cleaned revision kind");
    assertEqual(revision.parentRevisionId, state.originalRevisionId, "cleaned revision parent");
    assert(revision.blocks.length > 0, "cleaned revision has no blocks");
    assert(revision.contentHash && revision.contentHash !== original.data.contentHash, "cleaned content hash must differ");
    assertEqual(revision.pipelineVersion, "clean-v1:standard", "cleaned pipelineVersion");
    assert(revision.glossaryVersion.startsWith("glossary-"), "cleaned glossaryVersion");
    assertEqual(revision.appliedEdits.length, job.result.stats.appliedEdits, "stats.appliedEdits count");

    const blockIds = new Set();
    let previousStart = -1;
    for (const block of revision.blocks) {
      assert(typeof block.id === "string" && block.id.length > 0, "cleaned block.id missing");
      assert(!blockIds.has(block.id), `duplicate cleaned block id ${block.id}`);
      blockIds.add(block.id);
      assert(block.text.trim().length > 0, `cleaned block ${block.id} is empty`);
      assert(block.startMs >= 0 && block.endMs >= block.startMs, `cleaned block ${block.id} timestamps invalid`);
      assert(block.startMs >= previousStart, `cleaned block ${block.id} startMs not monotonic`);
      previousStart = block.startMs;
      assert(Array.isArray(block.sourceSegmentIds) && block.sourceSegmentIds.length > 0, `cleaned block ${block.id} lacks source segments`);
      for (const segmentId of block.sourceSegmentIds) {
        assert(state.segmentIds.has(segmentId), `cleaned block references unknown segment ${segmentId}`);
      }
    }
    const covered = new Set(revision.blocks.flatMap((block) => block.sourceSegmentIds));
    for (const segmentId of state.segmentIds) {
      assert(covered.has(segmentId), `source segment ${segmentId} has no processed block`);
    }
    assert(Array.isArray(revision.corrections), "cleaned revision corrections must be an array");

    assertBasePatchEdits(revision.appliedEdits, original.data.blocks, "heuristic clean");
    const cleanedText = revision.blocks.map((block) => block.text).join("");
    assertIncludes(cleanedText, "DeepSeek", "cleaned text (confirmed glossary replacement)");
    assert(!cleanedText.includes("滴普西克"), "cleaned text still contains glossary variant");
    assertIncludes(cleanedText, "大家好", "cleaned text content");
    assert(!cleanedText.includes("呃"), "cleaned text still contains filler 呃");
    assert(!cleanedText.includes("我们我们"), "cleaned text still contains stutter 我们我们");
    assert(
      revision.appliedEdits.some((edit) => edit.changeType === "term" && edit.original === "滴普西克" && edit.replacement === "DeepSeek"),
      "expected a term applied edit for 滴普西克 -> DeepSeek",
    );
    assert(revision.appliedEdits.some((edit) => edit.changeType === "format"), "expected rule/format applied edits");

    const updated = await request(stack, "GET", `/v1/documents/${state.documentId}`);
    assertEqual(updated.data.document.latestRevisionId, state.cleanedRevisionId, "document latestRevisionId after clean");
    assertEqual(updated.data.revisions.length, 2, "revision count after clean");
    assertEqual(updated.data.revisions.at(-1).kind, "cleaned", "latest revision summary kind");

    const jobs = await request(stack, "GET", `/v1/jobs?documentId=${state.documentId}&limit=10`);
    assertStatus(jobs, 200, "GET /v1/jobs?documentId");
    assert(jobs.data.some((item) => item.id === state.cleanJobId), "clean job missing from list");
    return {
      jobId: state.cleanJobId,
      revisionId: state.cleanedRevisionId,
      blocks: revision.blocks.length,
      appliedEdits: revision.appliedEdits.length,
      pendingCorrections: revision.corrections.length,
    };
  });

  await runCheck("summarize job (heuristic): overview, citations, markdown time links", async () => {
    const created = await request(stack, "POST", "/v1/jobs", {
      json: {
        type: "summarize",
        documentId: state.documentId,
        revisionId: state.cleanedRevisionId,
        idempotencyKey: "e2e-summary-heuristic-1",
      },
    });
    assertStatus(created, 201, "POST /v1/jobs (summarize)");
    const job = await waitJob(stack, created.data.id);
    assertEqual(job.status, "SUCCEEDED", `summarize job status (${JSON.stringify(job.error || null)})`);
    assert(job.result && job.result.summaryId, "summarize job result.summaryId");
    assertEqual(job.result.revisionId, state.cleanedRevisionId, "summarize job result.revisionId");
    state.summaryId = job.result.summaryId;

    const response = await request(
      stack,
      "GET",
      `/v1/documents/${state.documentId}/summaries/latest?revisionId=${state.cleanedRevisionId}`,
    );
    assertStatus(response, 200, "GET summaries/latest");
    const summary = response.data;
    state.summary = summary;
    assertEqual(summary.documentId, state.documentId, "summary.documentId");
    assertEqual(summary.revisionId, state.cleanedRevisionId, "summary.revisionId");
    assert(typeof summary.overview === "string" && summary.overview.trim().length >= 5, "summary.overview too short");
    assert(Array.isArray(summary.chapters) && summary.chapters.length > 0, "summary.chapters empty");
    let previousStart = -1;
    for (const chapter of summary.chapters) {
      assert(typeof chapter.title === "string" && chapter.title.length > 0, "summary chapter title missing");
      assert(chapter.startMs >= 0 && chapter.endMs >= chapter.startMs, "summary chapter timestamps invalid");
      assert(chapter.startMs >= previousStart, "summary chapters not time-ordered");
      previousStart = chapter.startMs;
      assert(Array.isArray(chapter.points) && chapter.points.length > 0, "summary chapter has no points");
      for (const point of chapter.points) {
        assert(typeof point.text === "string" && point.text.trim().length > 0, "summary point text empty");
        assert(Array.isArray(point.segmentIds) && point.segmentIds.length > 0, "summary point has no segmentIds");
        for (const segmentId of point.segmentIds) {
          assert(state.segmentIds.has(segmentId), `summary point references unknown segment ${segmentId}`);
        }
      }
    }
    assert(summary.coverage.sources.includes("B站AI字幕"), "summary coverage sources missing source label");
    assertEqual(summary.model, "extractive-v1", "heuristic summary model");
    assert(typeof summary.markdown === "string" && summary.markdown.length > 0, "summary.markdown empty");
    assertIncludes(summary.markdown, "## 整理稿", "summary.markdown");
    const timeLinkPattern = /\[[0-9]{2}:[0-9]{2}\]\(https:\/\/www\.bilibili\.com\/video\/BV1E2eT4sKp\/\?p=2&t=\d+\)/;
    assert(timeLinkPattern.test(summary.markdown), "summary.markdown missing B站 time links");

    const bundle = await request(stack, "GET", `/v1/documents/${state.documentId}`);
    assert(bundle.data.summary && bundle.data.summary.id === summary.id, "bundle.summary missing");
    return {
      summaryId: summary.id,
      overviewLength: summary.overview.length,
      chapters: summary.chapters.length,
      citations: summary.chapters.reduce((count, chapter) => count + chapter.points.length, 0),
    };
  });

  await runCheck("export Markdown: filename header, sections, time links, option toggles", async () => {
    const response = await request(stack, "GET", `/v1/documents/${state.documentId}/export?format=md`);
    assertStatus(response, 200, "GET export md");
    assert(/text\/markdown/.test(response.headers.get("content-type") || ""), "export md content-type");
    const disposition = response.headers.get("content-disposition") || "";
    assertIncludes(disposition, "attachment", "export md content-disposition");
    assertIncludes(disposition, "filename*=UTF-8''", "export md filename encoding");
    const filename = decodeURIComponent(response.headers.get("x-export-filename") || "");
    assert(filename.endsWith("-P02-整理稿.md"), `export filename: ${filename}`);
    const markdown = response.text;
    state.exportMarkdown = markdown;
    assertIncludes(markdown, `# ${state.fixture.video.title}`, "export md title");
    assertIncludes(markdown, `作者　${state.fixture.video.author}`, "export md author");
    assertIncludes(markdown, "分P　第 2 P · P2 · 任务服务全链路验收", "export md part");
    assertIncludes(markdown, `来源　https://www.bilibili.com/video/${state.fixture.video.bvid}/?p=2`, "export md source url");
    assertIncludes(markdown, "文本来源　B站AI字幕", "export md source label");
    assertIncludes(markdown, "整理方式　标准清洗", "export md strength label");
    assertIncludes(markdown, "待核对　0处", "export md pending corrections");
    for (const section of ["## 内容概览", "## 章节要点", "## 整理稿", "## 术语与存疑内容", "## 材料覆盖与处理记录"]) {
      assertIncludes(markdown, section, `export md section ${section}`);
    }
    assertIncludes(markdown, "处理版本：clean-v1:standard", "export md pipeline version");
    assertIncludes(markdown, "术语表版本：glossary-", "export md glossary version");
    assertIncludes(markdown, "- 原始片段：30 段", "export md segment accounting");
    assert(/&t=\d+/.test(markdown), "export md missing time links");

    const noTimestamps = await request(stack, "GET", `/v1/documents/${state.documentId}/export?includeTimestamps=false`);
    assertStatus(noTimestamps, 200, "export md includeTimestamps=false");
    const transcriptSection = noTimestamps.text.split("## 整理稿")[1]?.split("## 术语与存疑内容")[0] || "";
    assert(transcriptSection.length > 0, "includeTimestamps=false export missing 整理稿 section");
    assert(!/\[[0-9]{2}:[0-9]{2}\]\(https:\/\/www\.bilibili\.com\/video\//.test(transcriptSection), "includeTimestamps=false still has time links in 整理稿");
    assertIncludes(noTimestamps.text, "## 内容概览", "includeTimestamps=false should keep summary");

    const noSummary = await request(stack, "GET", `/v1/documents/${state.documentId}/export?includeSummary=false`);
    assertStatus(noSummary, 200, "export md includeSummary=false");
    assert(!noSummary.text.includes("## 内容概览"), "includeSummary=false still renders summary");
    assertIncludes(noSummary.text, "## 整理稿", "export md includeSummary=false body");
    return { filename, length: markdown.length };
  });

  await runCheck("export JSON: document / revision / summary / terms payload", async () => {
    const response = await request(stack, "GET", `/v1/documents/${state.documentId}/export?format=json`);
    assertStatus(response, 200, "GET export json");
    assertIncludes(response.headers.get("content-type") || "", "application/json", "export json content-type");
    const payload = response.data;
    assertEqual(payload.document.id, state.documentId, "export json document.id");
    assertEqual(payload.revision.id, state.cleanedRevisionId, "export json revision.id");
    assertEqual(payload.revision.kind, "cleaned", "export json revision.kind");
    assert(payload.summary && payload.summary.id === state.summary.id, "export json summary");
    assertEqual(payload.summary.overview, state.summary.overview, "export json summary overview");
    assert(Array.isArray(payload.terms) && payload.terms.length === 2, "export json terms");
    const terms = new Set(payload.terms.map((term) => term.canonical));
    assert(terms.has("DeepSeek") && terms.has("B站"), "export json terms content");
    return { revision: payload.revision.id, summary: payload.summary.id, terms: payload.terms.length };
  });

  await runCheck("manual revision: POST revisions creates an edited latest version", async () => {
    const cleaned = await request(stack, "GET", `/v1/documents/${state.documentId}/revisions/${state.cleanedRevisionId}`);
    const blocks = cleaned.data.blocks.map((block) => ({
      id: block.id,
      sourceSegmentIds: block.sourceSegmentIds,
      text: block.text,
      startMs: block.startMs,
      endMs: block.endMs,
    }));
    blocks[0] = { ...blocks[0], text: `${blocks[0].text}（人工校对：补充说明）` };
    const created = await request(stack, "POST", `/v1/documents/${state.documentId}/revisions`, {
      json: { parentRevisionId: state.cleanedRevisionId, blocks, createdBy: "user" },
    });
    assertStatus(created, 201, "POST manual revision");
    const revision = created.data;
    assertEqual(revision.kind, "edited", "manual revision kind");
    assertEqual(revision.parentRevisionId, state.cleanedRevisionId, "manual revision parent");
    assertEqual(revision.createdBy, "user", "manual revision createdBy");
    assertEqual(revision.blocks.length, blocks.length, "manual revision block count");
    assert(revision.blocks[0].text.endsWith("（人工校对：补充说明）"), "manual revision text not persisted");
    assert(revision.contentHash !== cleaned.data.contentHash, "manual revision content hash unchanged");

    const document = await request(stack, "GET", `/v1/documents/${state.documentId}`);
    assertEqual(document.data.document.latestRevisionId, revision.id, "document latestRevisionId after manual edit");
    assertEqual(document.data.revisions.at(-1).kind, "edited", "latest revision summary kind");

    const exported = await request(stack, "GET", `/v1/documents/${state.documentId}/export?format=md`);
    assertStatus(exported, 200, "export after manual revision");
    const filename = decodeURIComponent(exported.headers.get("x-export-filename") || "");
    assert(filename.endsWith("人工修订稿.md"), `export filename after manual edit: ${filename}`);
    assertIncludes(exported.text, "整理方式　人工修订稿", "export md after manual edit");
    assertIncludes(exported.text, "（人工校对：补充说明）", "export md after manual edit content");
    state.editedRevisionId = revision.id;

    const invalid = await request(stack, "POST", `/v1/documents/${state.documentId}/revisions`, {
      json: { parentRevisionId: revision.id, blocks: [] },
    });
    assertStatus(invalid, 400, "manual revision with empty blocks");
    assertEqual(invalid.data.code, "invalid_request", "empty blocks error code");

    const badCorrection = await request(
      stack,
      "POST",
      `/v1/documents/${state.documentId}/corrections/apply`,
      { json: { revisionId: revision.id, acceptedIds: ["corr_does_not_exist"], keptIds: [] } },
    );
    assertStatus(badCorrection, 409, "apply non-pending correction");
    assertEqual(badCorrection.data.code, "conflict", "apply correction conflict code");
    return { editedRevisionId: revision.id, filename };
  });

  await runCheck("upload session: chunk SHA256, conflict paths, complete, transcribe → NEEDS_INPUT", async () => {
    const wav = makeWavBytes(0.5);
    const digest = sha256(wav);
    const created = await request(stack, "POST", "/v1/uploads", {
      json: { filename: "e2e-sample.wav", size: wav.length, sha256: digest },
    });
    assertStatus(created, 201, "POST /v1/uploads");
    const upload = created.data;
    state.uploadId = upload.id;
    assertEqual(upload.status, "open", "upload status");
    assertEqual(upload.chunkSize, CHUNK_SIZE, "upload chunkSize");
    assertEqual(upload.maxBytes, 512 * 1024 * 1024, "upload maxBytes");
    assert(Array.isArray(upload.receivedChunks) && upload.receivedChunks.length === 0, "upload receivedChunks");

    const parts = [];
    for (let offset = 0; offset < wav.length; offset += CHUNK_SIZE) parts.push(wav.subarray(offset, offset + CHUNK_SIZE));
    assertEqual(parts.length, 4, "wav chunk count");

    const badChunk = await request(stack, "PUT", `/v1/uploads/${upload.id}/chunks/0`, {
      body: parts[0],
      headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": "0".repeat(64) },
    });
    assertStatus(badChunk, 400, "chunk with wrong SHA256");
    assertEqual(badChunk.data.code, "invalid_request", "wrong chunk SHA error code");

    for (let index = 0; index < parts.length; index += 1) {
      const response = await request(stack, "PUT", `/v1/uploads/${upload.id}/chunks/${index}`, {
        body: parts[index],
        headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": sha256(parts[index]) },
      });
      assertStatus(response, 200, `PUT chunk ${index}`);
      assertEqual(response.data.receivedChunks.length, index + 1, `receivedChunks after chunk ${index}`);
    }

    const replay = await request(stack, "PUT", `/v1/uploads/${upload.id}/chunks/0`, {
      body: parts[0],
      headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": sha256(parts[0]) },
    });
    assertStatus(replay, 200, "idempotent chunk replay");
    assertEqual(replay.data.receivedChunks.length, 4, "receivedChunks after replay");

    const wrongTotal = await request(stack, "POST", `/v1/uploads/${upload.id}/complete`, {
      json: { chunkCount: parts.length, totalBytes: wav.length - 1, sha256: digest },
    });
    assertStatus(wrongTotal, 409, "complete with wrong totalBytes");
    assertEqual(wrongTotal.data.code, "conflict", "wrong totalBytes error code");

    const complete = await request(stack, "POST", `/v1/uploads/${upload.id}/complete`, {
      json: { chunkCount: parts.length, totalBytes: wav.length, sha256: digest },
    });
    assertStatus(complete, 200, "complete upload");
    assertEqual(complete.data.status, "complete", "upload completed status");
    const fetched = await request(stack, "GET", `/v1/uploads/${upload.id}`);
    assertStatus(fetched, 200, "GET upload");
    assertEqual(fetched.data.status, "complete", "fetched upload status");

    const missingUpload = await request(stack, "POST", "/v1/jobs", {
      json: { type: "transcribe", video: state.fixture.video },
    });
    assertStatus(missingUpload, 400, "transcribe without uploadId");
    assertEqual(missingUpload.data.code, "invalid_request", "missing uploadId error code");

    const createdJob = await request(stack, "POST", "/v1/jobs", {
      json: {
        type: "transcribe",
        video: state.fixture.video,
        uploadId: upload.id,
        options: { autoClean: true, strength: "standard" },
      },
    });
    assertStatus(createdJob, 201, "POST /v1/jobs (transcribe)");
    const job = await waitJob(stack, createdJob.data.id);
    assertEqual(job.status, "NEEDS_INPUT", `transcribe without ASR status (${JSON.stringify(job.error || null)})`);
    assertEqual(job.error.code, "asr_not_configured", "transcribe error code");
    assert(typeof job.error.message === "string" && job.error.message.length > 0, "transcribe error message");
    assert(job.attempt >= 1, "transcribe job attempt");

    const zero = await request(stack, "POST", "/v1/uploads", { json: { filename: "zero.wav", size: 0, sha256: digest } });
    assertStatus(zero, 400, "upload with size 0");
    return {
      uploadId: upload.id,
      chunks: parts.length,
      bytes: wav.length,
      transcribeJob: job.id,
      status: job.status,
    };
  });

  await runCheck("error contract: 404 not_found and health/capabilities version consistency", async () => {
    const missingDocument = await request(stack, "GET", "/v1/documents/doc_missing");
    assertStatus(missingDocument, 404, "GET unknown document");
    assertEqual(missingDocument.data.code, "not_found", "unknown document error code");

    const missingJob = await request(stack, "GET", "/v1/jobs/job_missing");
    assertStatus(missingJob, 404, "GET unknown job");
    assertEqual(missingJob.data.code, "not_found", "unknown job error code");

    const health = await request(stack, "GET", "/health", { token: null });
    const capabilities = await request(stack, "GET", "/v1/capabilities");
    assertEqual(health.data.version, capabilities.data.appVersion, "health.version == capabilities.appVersion");
    return { version: health.data.version };
  });
}

// --------------------------------------------------------------------------- phase B: real LLM code path via mock

async function phaseLLM(mock) {
  const llmBaseUrl = `http://127.0.0.1:${mock.port}/v1`;
  const stack = await createStack("llm", {
    LLM_API_KEY: "sk-e2e-secret-must-not-be-printed",
    LLM_BASE_URL: llmBaseUrl,
    LLM_MODEL: "e2e-mock-model",
    LLM_TEMPERATURE: "0",
    ASR_API_KEY: "asr-e2e-secret-must-not-be-printed",
    ASR_PROVIDER: "openai-compatible",
    TASKAPI_ASR_DISABLED: "0",
  });
  stackB = stack;
  const state = {};

  await runCheck("LLM phase startup banner: configured providers, API keys never printed", async () => {
    const banner = await waitForText(stack.api, "访问令牌", 30_000);
    const workerBanner = await waitForText(stack.worker, "数据目录", 30_000);
    assertIncludes(banner, "已配置", "llm banner configured status");
    assertIncludes(banner, "e2e-mock-model", "llm banner model");
    assertIncludes(banner, llmBaseUrl, "llm banner base url");
    assertIncludes(banner, "openai-compatible", "llm banner provider");
    const secrets = ["sk-e2e-secret-must-not-be-printed", "asr-e2e-secret-must-not-be-printed"];
    for (const secret of secrets) {
      assert(!banner.includes(secret), "API key leaked into the API startup banner");
      assert(!workerBanner.includes(secret), "API key leaked into the worker startup banner");
    }
    return { apiBannerHasToken: banner.includes(stack.token), secretsChecked: secrets.length };
  });

  await runCheck("LLM phase capabilities reflect configured LLM + cloud ASR", async () => {
    const response = await request(stack, "GET", "/v1/capabilities");
    assertStatus(response, 200, "GET /v1/capabilities");
    const data = response.data;
    assertEqual(data.llm.configured, true, "capabilities.llm.configured");
    assertEqual(data.llm.provider, "openai-compatible", "capabilities.llm.provider");
    assertEqual(data.llm.model, "e2e-mock-model", "capabilities.llm.model");
    assertEqual(data.llm.jsonMode, true, "capabilities.llm.jsonMode");
    assertEqual(data.asr.configured, true, "capabilities.asr.configured");
    assertEqual(data.asr.defaultProvider, "openai-compatible", "capabilities.asr.defaultProvider");
    const cloud = data.asr.providers.find((provider) => provider.id === "openai-compatible");
    assert(cloud && cloud.available === true, "cloud ASR provider should be available with fake key");
    return { llm: data.llm.provider, model: data.llm.model, asrDefault: data.asr.defaultProvider };
  });

  await runCheck("LLM clean job: term discovery, consistency corrections, block-scoped patches", async () => {
    const fixture = parseJson(await readFile(fixturePath, "utf8"));
    state.fixture = fixture;
    state.segmentIds = new Set(fixture.source.segments.map((segment) => segment.id));
    const created = await request(stack, "POST", "/v1/documents", {
      json: { video: fixture.video, source: fixture.source },
    });
    assertStatus(created, 201, "POST /v1/documents (llm phase)");
    state.documentId = created.data.document.id;
    state.originalRevisionId = created.data.document.originalRevisionId;

    const jobCreated = await request(stack, "POST", "/v1/jobs", {
      json: { type: "clean", documentId: state.documentId, options: { strength: "standard" }, idempotencyKey: "e2e-clean-llm-1" },
    });
    assertStatus(jobCreated, 201, "POST /v1/jobs (clean, llm)");
    const job = await waitJob(stack, jobCreated.data.id);
    assertEqual(job.status, "SUCCEEDED", `llm clean job status (${JSON.stringify(job.error || null)})`);
    assertEqual(job.result.stats.llm, "e2e-mock-model", "llm clean stats.llm");
    assert(job.result.stats.notes.length === 0, `llm clean should have no fallback notes: ${JSON.stringify(job.result.stats.notes)}`);
    state.cleanedRevisionId = job.result.revisionId;

    const original = await request(stack, "GET", `/v1/documents/${state.documentId}/revisions/${state.originalRevisionId}`);
    const cleaned = await request(stack, "GET", `/v1/documents/${state.documentId}/revisions/${state.cleanedRevisionId}`);
    assertStatus(cleaned, 200, "GET cleaned revision (llm)");
    const revision = cleaned.data;
    assertEqual(revision.kind, "cleaned", "llm cleaned revision kind");
    assertBasePatchEdits(revision.appliedEdits, original.data.blocks, "llm clean");
    assertCorrections(revision.corrections, revision.blocks, state.segmentIds, "llm clean");

    const termCorrection = revision.corrections.find(
      (correction) => correction.changeType === "term" && correction.original === "滴普西克",
    );
    assert(termCorrection, "missing term correction for 滴普西克");
    assertEqual(termCorrection.replacement, "DeepSeek", "term correction replacement");
    assertEqual(termCorrection.evidenceType, "context_only", "term correction evidenceType");

    const consistencyCorrection = revision.corrections.find(
      (correction) => correction.changeType === "consistency" && correction.original.includes("三个模式"),
    );
    assert(consistencyCorrection, "missing consistency correction for 三个模式");
    assertEqual(consistencyCorrection.replacement, "四个模式", "consistency correction AI suggestion");
    assert(consistencyCorrection.evidenceSegmentIds.length > 0, "consistency correction evidence");
    assert(
      revision.corrections.every((correction) => Boolean(correction.replacement)),
      "every pending correction must carry an AI suggestion",
    );

    assertEqual(job.result.stats.pendingCorrections, revision.corrections.length, "stats.pendingCorrections");
    assert(job.result.stats.terms >= 1, "term discovery should produce at least one term");
    state.termCorrection = termCorrection;
    state.consistencyCorrection = consistencyCorrection;
    return {
      revisionId: revision.id,
      corrections: revision.corrections.length,
      appliedEdits: revision.appliedEdits.length,
      terms: job.result.stats.terms,
    };
  });

  await runCheck("apply selected corrections: term replacement becomes an edited revision", async () => {
    const response = await request(
      stack,
      "POST",
      `/v1/documents/${state.documentId}/corrections/apply`,
      {
        json: {
          revisionId: state.cleanedRevisionId,
          acceptedIds: [state.termCorrection.id],
          keptIds: [state.consistencyCorrection.id],
        },
      },
    );
    assertStatus(response, 201, "POST corrections/apply");
    const revision = response.data;
    assertEqual(revision.kind, "edited", "applied correction revision kind");
    assertEqual(revision.parentRevisionId, state.cleanedRevisionId, "applied correction parent");
    assert(Array.isArray(revision.corrections) && revision.corrections.length === 0, "applied revision must not retain pending corrections");
    const block = revision.blocks.find((item) => item.id === state.termCorrection.blockId);
    assert(block, "term correction target block missing in applied revision");
    assert(!block.text.includes("滴普西克"), "term correction not applied");
    assertIncludes(block.text, "DeepSeek", "term correction replacement text");
    const confirmed = revision.appliedEdits.filter((edit) => edit.reason.startsWith("用户确认："));
    assertEqual(confirmed.length, 1, "confirmed applied edit count");
    assertEqual(confirmed[0].changeType, "term", "confirmed applied edit changeType");
    assertIncludes(confirmed[0].reason, "用户确认：", "confirmed applied edit reason");
    const document = await request(stack, "GET", `/v1/documents/${state.documentId}`);
    assertEqual(document.data.document.latestRevisionId, revision.id, "latest revision after corrections/apply");
    state.editedRevisionId = revision.id;
    return { editedRevisionId: revision.id, appliedEdits: revision.appliedEdits.length };
  });

  await runCheck("manual correction edit: custom replacement becomes an edited revision", async () => {
    const replacement = "四个模式（手动确认）";
    const response = await request(
      stack,
      "POST",
      `/v1/documents/${state.documentId}/corrections/apply`,
      {
        json: {
          revisionId: state.cleanedRevisionId,
          manualEdits: [{ correctionId: state.consistencyCorrection.id, replacement }],
        },
      },
    );
    assertStatus(response, 201, "POST corrections/apply (manual)");
    const revision = response.data;
    assertEqual(revision.kind, "edited", "manual correction revision kind");
    assertEqual(revision.parentRevisionId, state.cleanedRevisionId, "manual correction parent");
    const block = revision.blocks.find((item) => item.id === state.consistencyCorrection.blockId);
    assert(block, "manual correction target block missing");
    assertIncludes(block.text, replacement, "manual replacement text");
    assert(!block.text.includes("三个模式"), "manual replacement original text still present");
    const manual = revision.appliedEdits.find((edit) => edit.reason.startsWith("用户手动修改："));
    assert(manual, "manual applied edit missing");
    assertEqual(manual.replacement, replacement, "manual applied edit replacement");
    state.editedRevisionId = revision.id;
    return { revisionId: revision.id, replacement };
  });

  await runCheck("LLM summarize job: sections/citations from mock, markdown rendered", async () => {
    const created = await request(stack, "POST", "/v1/jobs", {
      json: { type: "summarize", documentId: state.documentId, revisionId: state.editedRevisionId, idempotencyKey: "e2e-summary-llm-1" },
    });
    assertStatus(created, 201, "POST /v1/jobs (summarize, llm)");
    const job = await waitJob(stack, created.data.id);
    assertEqual(job.status, "SUCCEEDED", `llm summarize status (${JSON.stringify(job.error || null)})`);
    const response = await request(
      stack,
      "GET",
      `/v1/documents/${state.documentId}/summaries/latest?revisionId=${state.editedRevisionId}`,
    );
    assertStatus(response, 200, "GET summaries/latest (llm)");
    const summary = response.data;
    assert(typeof summary.overview === "string" && summary.overview.trim().length >= 5, "llm summary overview");
    assert(Array.isArray(summary.chapters) && summary.chapters.length > 0, "llm summary chapters");
    for (const chapter of summary.chapters) {
      assert(typeof chapter.title === "string" && chapter.title.length > 0, "llm chapter title");
      assert(chapter.startMs >= 0 && chapter.endMs >= chapter.startMs, "llm chapter timestamps");
      for (const point of chapter.points) {
        assert(Array.isArray(point.segmentIds) && point.segmentIds.length > 0, "llm point segmentIds");
        for (const segmentId of point.segmentIds) {
          assert(state.segmentIds.has(segmentId), `llm summary points reference unknown segment ${segmentId}`);
        }
      }
    }
    assertEqual(summary.revisionId, state.editedRevisionId, "llm summary revisionId");
    assertIncludes(summary.markdown, "## 内容概览", "llm summary markdown");
    const exported = await request(stack, "GET", `/v1/documents/${state.documentId}/export?format=json`);
    assertStatus(exported, 200, "export json (llm)");
    assert(exported.data.summary && exported.data.summary.chapters.length > 0, "export json llm summary");

    const expectedKinds = ["term_discovery", "clean", "consistency", "summary_chunk", "summary_aggregate"];
    const counts = {};
    for (const kind of mock.calls) counts[kind] = (counts[kind] || 0) + 1;
    for (const kind of expectedKinds) assert((counts[kind] || 0) > 0, `mock LLM was never called for ${kind}`);
    assert(!(counts.unknown > 0), `mock LLM received unknown prompts: ${JSON.stringify(counts)}`);
    return { summaryId: summary.id, chapters: summary.chapters.length, mockCalls: counts };
  });
}

// --------------------------------------------------------------------------- runner

console.log("B站文字稿助手 · task-api 服务级 E2E");
console.log(`service: ${serviceDir}`);
console.log(`python : ${pythonPath}\n`);

try {
  await phaseDotenv();
  await phaseHeuristic();
  await stopStack(stackA, true);
  stackA = null;

  if (skipLLM) {
    check("LLM mock phase (optional bonus)", "skip", { reason: "BTA_TASKAPI_E2E_SKIP_LLM=1" });
  } else {
    mockLLM = await startMockLLM();
    try {
      await phaseLLM(mockLLM);
    } finally {
      await stopStack(stackB, true);
      stackB = null;
      await mockLLM.close();
      mockLLM = null;
    }
  }
  console.log("\nSecrets policy: fake LLM/ASR API keys were configured in the LLM phase; banners above stay token-only.");
} catch (error) {
  failure = error;
} finally {
  await stopStack(stackA, !failure);
  await stopStack(stackB, !failure);
  if (mockLLM) await mockLLM.close().catch(() => undefined);
}

const failed = checks.filter((item) => item.status === "fail").length;
const skipped = checks.filter((item) => item.status === "skip").length;
const passed = checks.filter((item) => item.status === "pass").length;
const ok = !failure && failed === 0;
const durationMs = Date.now() - startedAt.getTime();

if (failure) {
  console.log(`\nBOOTSTRAP / ABORTED: ${failure.message}`);
}
console.log(`\n${passed}/${checks.length} checks passed${skipped ? ` (${skipped} skipped)` : ""}${failed ? `, ${failed} failed` : ""}`);
console.log(`duration: ${(durationMs / 1000).toFixed(1)}s`);
if (checks.some((item) => item.status === "fail")) {
  console.log("\nFailed checks:");
  for (const item of checks.filter((entry) => entry.status === "fail")) console.log(`  - ${item.name}: ${item.error}`);
}
process.exitCode = ok ? 0 : 1;
