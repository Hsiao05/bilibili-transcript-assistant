// Browser end-to-end acceptance: real Edge with the unpacked extension + a real task-api instance.
//
// Flow
//   1. start task-api (API + worker) with a temporary data dir, random port and a fixed token
//   2. seed a document for the test video (subtitles -> document -> clean job)
//   3. launch Edge with the built extension, write service settings into chrome.storage
//   4. open the real side-panel page next to a B站 video tab and wait for the document to load
//   5. click "总结视频" -> summarize job -> summary rendered in the UI
//   6. open settings -> connected state + provider status
//   7. export the current revision -> downloaded Markdown checked on disk
//   8. screenshots + JSON report under docs/acceptance/
//
// Usage: node scripts/extension-e2e.mjs           (requires apps/extension/dist built)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activateTab,
  attachBrowser,
  attachPage,
  attachWorker,
  closeBrowser,
  evaluate,
  launchBrowser,
  openTab,
  sleep,
  waitFor,
} from "./lib/browser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "apps", "extension", "dist");
const serviceDir = path.join(root, "services", "task-api");
const python = path.join(serviceDir, ".venv", "Scripts", "python.exe");
const reportDir = path.join(root, "docs", "acceptance");
const screenshotDir = path.join(root, "docs", "screenshots");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const enginePath = process.env.CHROME_PATH || (existsSync(EDGE) ? EDGE : existsSync(CHROME) ? CHROME : "");
const MULTI_VIDEO = process.env.BTA_MULTI_VIDEO || "BV1XwxU6xEnL";
const MULTI_PAGE = Number(process.env.BTA_MULTI_PAGE || 2);
const MULTI_CID = process.env.BTA_MULTI_CID || "43307110047";
const TOKEN = `e2e-${Math.random().toString(36).slice(2, 10)}`;
const startedAt = new Date();

if (!existsSync(path.join(dist, "manifest.json"))) throw new Error("Build the extension first: cd apps/extension && npm run build");
if (!existsSync(python)) throw new Error(`task-api venv python not found: ${python}`);

const report = {
  startedAt: startedAt.toISOString(),
  service: null,
  extension: null,
  checks: [],
  consoleErrors: [],
  screenshots: [],
  downloads: [],
};

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

async function pickHttpPort() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = 8400 + Math.floor(Math.random() * 500);
    try {
      await fetch(`http://127.0.0.1:${candidate}/health`, { signal: AbortSignal.timeout(250) });
    } catch {
      return candidate;
    }
  }
  throw new Error("no free HTTP port found");
}

class Service {
  constructor(port, dataDir, token) {
    this.port = port;
    this.dataDir = dataDir;
    this.token = token;
    this.processes = [];
    this.logs = [];
  }

  baseUrl() {
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
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
    };
    for (const [name, args] of [
      ["api", ["-u", "-m", "taskapi.serve"]],
      ["worker", ["-u", "-m", "taskapi.worker"]],
    ]) {
      const child = spawn(python, args, { cwd: serviceDir, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (data) => this.logs.push(`[${name}] ${data.toString()}`));
      child.stderr.on("data", (data) => this.logs.push(`[${name}] ${data.toString()}`));
      this.processes.push(child);
    }
    const ready = await waitFor(async () => {
      const response = await fetch(`${this.baseUrl()}/health`, { signal: AbortSignal.timeout(800) });
      return response.ok;
    }, 30000, 500);
    if (!ready) throw new Error("task-api did not become healthy:\n" + this.logs.slice(-20).join(""));
  }

  async api(pathname, { method = "GET", body, raw = false } = {}) {
    const response = await fetch(`${this.baseUrl()}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${method} ${pathname} -> HTTP ${response.status}: ${text.slice(0, 400)}`);
    }
    return raw ? response : response.json();
  }

  async waitJob(jobId, timeoutMs = 30000) {
    const job = await waitFor(async () => {
      const value = await this.api(`/v1/jobs/${jobId}`);
      return ["SUCCEEDED", "PARTIAL", "FAILED", "NEEDS_INPUT", "CANCELLED"].includes(value.status) ? value : null;
    }, timeoutMs, 400);
    if (!job) throw new Error(`job ${jobId} did not finish in time`);
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
    await sleep(700);
  }
}

const SEGMENTS = [
  ["seg_00001", 0, 12400, "大家好，这一期我们做一个端到端验收样本，用来测试文字稿助手的完整流程。"],
  ["seg_00002", 12400, 24800, "呃，先说结论，这个工具的核心价值是把字幕或者音频变成可以校对、可以引用的文字稿。"],
  ["seg_00003", 24800, 37200, "第一步是拿到原始材料，有字幕就优先用字幕，没有字幕才走音频转写。"],
  ["seg_00004", 37200, 49600, "这里要特别强调，模型整理的时候不能随便改数字和否定词。"],
  ["seg_00005", 49600, 62000, "我们之前说过支持三个档位，哦不对，是四个档位：轻度、标准、精简和自定义。"],
  ["seg_00006", 62000, 74400, "滴普西克这类音近词，需要结合上下文判断，不能只按发音替换。"],
  ["seg_00007", 74400, 86800, "接着看清洗流程，先做确定性规则清理，再让模型做语义整理。"],
  ["seg_00008", 86800, 99200, "如果模型发现前后矛盾，会把它标成待核对，而不是直接按多数写法改掉。"],
  ["seg_00009", 99200, 111600, "这个接口返回的时间单位是毫秒，前端展示的时候再格式化。"],
  ["seg_00010", 111600, 124000, "然后是总结，总结必须能引用回原始片段，否则读者无法核对。"],
  ["seg_00011", 124000, 136400, "我们认为关键的一条是保留不确定性，作者说可能、应该的地方不能写成确定。"],
  ["seg_00012", 136400, 148800, "导出的时候会带上时间链接，点击可以回到视频对应的位置。"],
  ["seg_00013", 148800, 161200, "呃，这里再补充一下，任务服务负责长任务，浏览器只负责界面和上传。"],
  ["seg_00014", 161200, 173600, "这样即使关闭侧栏，转写和清洗也还能继续执行。"],
  ["seg_00015", 173600, 186000, "最后我们检查一遍，原始稿、整理稿和人工修订稿三个版本都能找回。"],
].map(([id, startMs, endMs, text]) => ({ id, startMs, endMs, text }));

const VIDEO = {
  bvid: MULTI_VIDEO,
  cid: MULTI_CID,
  page: MULTI_PAGE,
  title: "【2026全球总决赛】11月4日 TES vs IG",
  partTitle: "第二局",
  author: "哔哩哔哩英雄联盟赛事",
  durationMs: 3822000,
};

function settingsFor(port) {
  return {
    serviceUrl: `http://127.0.0.1:${port}`,
    serviceToken: TOKEN,
    language: "zh-CN",
    strength: "standard",
    autoAsrFallback: false,
    showTimestamps: true,
    theme: "light",
    asrProvider: "auto",
  };
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "bta-e2e-service-"));
const downloadDir = await mkdtemp(path.join(os.tmpdir(), "bta-e2e-download-"));
const service = new Service(await pickHttpPort(), dataDir, TOKEN);
let launched = null;
let realCdp = null;
let demoCdp = null;
let workerCdp = null;
let browserCdp = null;

try {
  await service.start();
  report.service = { port: service.port, dataDir, token: "***", logsTail: [] };

  const health = await fetch(`${service.baseUrl()}/health`).then((response) => response.json());
  assert(health.status === "ok", "service not healthy");
  check("task-api starts (health)", "pass", health);

  const unauthorized = await fetch(`${service.baseUrl()}/v1/capabilities`);
  assert(unauthorized.status === 401, `expected 401 without token, got ${unauthorized.status}`);
  const capabilities = await service.api("/v1/capabilities");
  assert(capabilities.apiVersion, "capabilities missing apiVersion");
  report.service.capabilities = {
    apiVersion: capabilities.apiVersion,
    llm: capabilities.llm,
    asr: { configured: capabilities.asr.configured, defaultProvider: capabilities.asr.defaultProvider },
  };
  check("capabilities + token auth", "pass", report.service.capabilities);

  const document = await service.api("/v1/documents", {
    method: "POST",
    body: {
      video: VIDEO,
      source: { type: "bilibili_ai_subtitle", trackId: "track_e2e", language: "zh-CN", segments: SEGMENTS },
    },
  });
  const documentId = document.document.id;
  const originalRevisionId = document.document.originalRevisionId;
  assert(document.source?.segmentCount === SEGMENTS.length, "source segment count mismatch");
  check("document created from subtitle segments", "pass", {
    documentId,
    originalRevisionId,
    segments: document.source.segmentCount,
  });

  const cleanJob = await service.api("/v1/jobs", {
    method: "POST",
    body: {
      type: "clean",
      documentId,
      revisionId: originalRevisionId,
      options: { strength: "standard", language: "zh-CN" },
      idempotencyKey: `clean:${documentId}:${originalRevisionId}:standard`,
    },
  });
  const finishedClean = await service.waitJob(cleanJob.id);
  assert(finishedClean.status === "SUCCEEDED", `clean job ${finishedClean.status}`);
  const cleanedBundle = await service.api(`/v1/documents/${documentId}`);
  const cleanedRevision = cleanedBundle.revisions.find((item) => item.kind === "cleaned");
  assert(cleanedRevision, "cleaned revision missing");
  check("clean job (heuristic pipeline)", "pass", {
    jobId: cleanJob.id,
    status: finishedClean.status,
    revisionId: cleanedRevision.id,
    pending: cleanedRevision.pendingCount,
  });

  // ---- extension ------------------------------------------------------------------
  launched = await launchBrowser({ enginePath, dist, prefix: "bta-e2e-", width: 1180, height: 940 });
  const port = launched.port;
  report.engine = { path: enginePath, version: launched.version.Browser || null };
  const attached = await attachWorker(port);
  workerCdp = attached.cdp;
  const extensionId = attached.extensionId;
  report.extension = { id: extensionId };
  check("extension loads in real browser", "pass", { id: extensionId });

  const demoPage = await openTab(port, `chrome-extension://${extensionId}/index.html?demo=ready`);
  demoCdp = await attachPage(demoPage);
  await evaluate(demoCdp, `new Promise((resolve) => chrome.storage.local.set({ "bili-transcript-settings": ${JSON.stringify(settingsFor(service.port))} }, () => resolve(true)))`, 20000);
  const stored = await evaluate(demoCdp, `new Promise((resolve) => chrome.storage.local.get("bili-transcript-settings", (value) => resolve(value["bili-transcript-settings"])))`, 20000);
  assert(stored?.serviceUrl?.includes(String(service.port)) && stored.serviceToken === TOKEN, "settings not persisted");
  check("extension settings persisted", "pass", { serviceUrl: stored.serviceUrl });

  const biliPage = await openTab(port, `https://www.bilibili.com/video/${MULTI_VIDEO}/?p=${MULTI_PAGE}`);
  const biliCdp = await attachPage(biliPage);
  await sleep(4000);
  await activateTab(port, biliPage.id);

  const realPage = await openTab(port, `chrome-extension://${extensionId}/index.html`);
  realCdp = await attachPage(realPage);
  await realCdp.send("Log.enable");
  await sleep(2500);
  // The extension page boots while itself is the active tab (unsupported). Activating the
  // B站 tab fires tabs.onActivated -> page:changed broadcast -> the side panel re-boots.
  await activateTab(port, biliPage.id);
  await sleep(4500);

  const bootText = await evaluate(realCdp, `document.body.innerText`, 20000);
  report.ui = { bootText: bootText.slice(0, 400) };
  const loaded = await waitFor(async () => {
    const text = await evaluate(realCdp, `document.body.innerText`, 20000);
    return text.includes("端到端验收样本") ? text : null;
  }, 30000, 800);
  assert(loaded, `document did not load into the UI: ${bootText.slice(0, 300)}`);
  assert(!loaded.includes("任务服务未连接"), "service reported as not connected");
  assert(loaded.includes("整理稿"), "cleaned revision label missing");
  check("side panel loads seeded document from task-api", "pass", {
    text: loaded.slice(0, 260),
    hasTranscript: loaded.includes("端到端验收样本"),
    hasCleanedLabel: loaded.includes("整理稿"),
  });

  // Clicking an in-app timestamp must seek the B站 <video> instead of opening a new tab.
  const seekTarget = await evaluate(realCdp, `(() => {
    const candidates = [...document.querySelectorAll("button.timestamp[data-time-ms]")];
    const button = candidates.find((node) => Number(node.dataset.timeMs) > 1000);
    if (!button) return null;
    const ms = Number(button.dataset.timeMs);
    button.click();
    return ms;
  })()`, 15000);
  assert(seekTarget, "no in-app timestamp button found");
  const seeked = await waitFor(async () => {
    const value = await evaluate(biliCdp, `(() => {
      const video = document.querySelector("video");
      return video ? { currentTime: video.currentTime, duration: video.duration, readyState: video.readyState } : null;
    })()`);
    return value && value.currentTime > 0 ? value : null;
  }, 15000, 300);
  assert(seeked, "B站 video did not seek after timestamp click");
  assert(Math.abs(seeked.currentTime - seekTarget / 1000) < 2.5, `seek mismatch: ${seeked.currentTime} vs ${seekTarget / 1000}`);
  check("timestamp click seeks the current B站 video", "pass", {
    targetMs: seekTarget,
    videoCurrentTime: Math.round(seeked.currentTime * 1000),
  });

  const transcriptShot = await realCdp.send("Page.captureScreenshot", { format: "png" });
  await mkdir(screenshotDir, { recursive: true });
  const transcriptShotPath = path.join(screenshotDir, "sidepanel-e2e-transcript.png");
  await writeFile(transcriptShotPath, Buffer.from(transcriptShot.data, "base64"));
  report.screenshots.push(transcriptShotPath);

  // Click "总结视频": the UI must create a summarize job through the real service.
  const clickedSummary = await evaluate(realCdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((node) => node.offsetParent !== null && node.textContent.includes("总结视频"));
    if (!button) return false;
    button.click();
    return true;
  })()`, 15000);
  assert(clickedSummary, "总结视频 button not found");
  const summary = await waitFor(async () => {
    const response = await fetch(`${service.baseUrl()}/v1/documents/${documentId}/summaries/latest`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (response.status !== 200) return null;
    return response.json();
  }, 40000, 600);
  assert(summary, "summary was not generated by the UI action");
  assert(summary.chapters.length > 0, "summary has no chapters");
  assert(summary.overview.length > 0, "summary overview empty");
  const overviewHint = summary.overview.slice(0, 10);
  const summaryVisible = await waitFor(async () => {
    const text = await evaluate(realCdp, `document.body.innerText`, 20000);
    return text.includes(overviewHint) || text.includes("内容概览") ? text : null;
  }, 30000, 700);
  assert(summaryVisible, "summary not rendered in the side panel");
  check("UI 总结视频 -> summarize job -> rendered summary", "pass", {
    summaryId: summary.id,
    chapters: summary.chapters.length,
    overview: summary.overview.slice(0, 80),
    model: summary.model,
  });
  const summaryShot = await realCdp.send("Page.captureScreenshot", { format: "png" });
  const summaryShotPath = path.join(screenshotDir, "sidepanel-e2e-summary.png");
  await writeFile(summaryShotPath, Buffer.from(summaryShot.data, "base64"));
  report.screenshots.push(summaryShotPath);

  // Settings page: connected badge + provider status.
  const openedSettings = await evaluate(realCdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((node) => node.offsetParent !== null && node.textContent.trim() === "设置");
    if (!button) return false;
    button.click();
    return true;
  })()`, 15000);
  assert(openedSettings, "settings button not found");
  const settingsText = await waitFor(async () => {
    const text = await evaluate(realCdp, `document.body.innerText`, 20000);
    return text.includes("已连接") ? text : null;
  }, 15000, 500);
  assert(settingsText, "settings page did not report connected state");
  assert(!settingsText.includes("未连接"), "settings page still shows 未连接");
  const settingsShot = await realCdp.send("Page.captureScreenshot", { format: "png" });
  const settingsShotPath = path.join(screenshotDir, "sidepanel-e2e-settings.png");
  await writeFile(settingsShotPath, Buffer.from(settingsShot.data, "base64"));
  report.screenshots.push(settingsShotPath);
  check("settings page reports connected service", "pass", { text: settingsText.slice(0, 220) });

  // Back to the transcript tab and export the current revision as Markdown.
  const backClicked = await evaluate(realCdp, `(() => {
    const back = document.querySelector('button[aria-label="返回"]');
    if (!back) return false;
    back.click();
    return true;
  })()`, 15000);
  assert(backClicked, "settings back button not found");
  await sleep(800);
  const transcriptTabClicked = await evaluate(realCdp, `(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes("文字稿"));
    if (!tab) return false;
    // Radix tabs activate on mousedown, so a bare .click() is not enough.
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      tab.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  })()`, 15000);
  assert(transcriptTabClicked, "transcript tab not found after leaving settings");
  await sleep(1200);
  browserCdp = await attachBrowser(port);
  await browserCdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
  const exportReady = await waitFor(
    async () => evaluate(realCdp, `Boolean(document.querySelector('button[aria-label="导出当前版本"]'))`, 10000),
    15000,
    400,
  );
  assert(exportReady, "export button did not appear: " + (await evaluate(realCdp, `document.body.innerText.slice(0, 300)`, 10000)));
  const exported = await evaluate(realCdp, `(() => {
    const button = document.querySelector('button[aria-label="导出当前版本"]');
    if (!button) return false;
    button.click();
    return true;
  })()`, 15000);
  assert(exported, "export button not found");
  const markdownPath = await waitFor(async () => {
    const files = (await readdir(downloadDir)).filter((name) => name.endsWith(".md"));
    if (!files.length) return null;
    const candidate = path.join(downloadDir, files[0]);
    const text = await readFile(candidate, "utf8");
    return text.length > 200 ? { path: candidate, text } : null;
  }, 20000, 500);
  assert(markdownPath, "markdown export did not appear in the download directory");
  assert(markdownPath.text.includes(VIDEO.title) || markdownPath.text.includes("端到端验收样本"), "exported markdown missing title/content");
  assert(/###?\s*\[?\d{2}:\d{2}\]?/.test(markdownPath.text) || markdownPath.text.includes("## 章节要点"), "exported markdown missing timestamps/sections");
  const exportedName = path.basename(markdownPath.path);
  assert(exportedName.includes(`P0${MULTI_PAGE}`) && exportedName.includes("整理稿"), `export filename not derived from server header: ${exportedName}`);
  report.downloads.push({ path: markdownPath.path, bytes: Buffer.byteLength(markdownPath.text), filename: exportedName });
  check("export current revision as Markdown", "pass", {
    file: exportedName,
    bytes: Buffer.byteLength(markdownPath.text),
    head: markdownPath.text.slice(0, 120),
  });

  const errors = realCdp.events.filter(
    (event) => event.method === "Runtime.exceptionThrown" || (event.method === "Log.entryAdded" && event.params?.entry?.level === "error"),
  );
  report.consoleErrors = errors.map((event) => event.params?.exceptionDetails?.text || event.params?.entry?.text);
  assert(report.consoleErrors.length === 0, `console errors: ${report.consoleErrors.join(" | ")}`);
  check("no console errors in real side panel", "pass", { errors: 0 });

  const jobs = await service.api(`/v1/jobs?documentId=${documentId}`);
  report.service.jobs = jobs.map((job) => ({ type: job.type, status: job.status }));
  assert(jobs.some((job) => job.type === "clean" && job.status === "SUCCEEDED"), "clean job missing");
  assert(jobs.some((job) => job.type === "summarize" && job.status === "SUCCEEDED"), "summarize job missing");
  check("job history consistent", "pass", report.service.jobs);

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.finishedAt = new Date().toISOString();
  check("extension e2e bootstrap", "fail", undefined, error);
  if (service.logs?.length) report.service.logsTail = service.logs.slice(-25);
} finally {
  try { realCdp?.close(); } catch { /* ignore */ }
  try { demoCdp?.close(); } catch { /* ignore */ }
  try { workerCdp?.close(); } catch { /* ignore */ }
  try { browserCdp?.close(); } catch { /* ignore */ }
  await closeBrowser(launched);
  await service.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(downloadDir, { recursive: true, force: true }).catch(() => undefined);

  await mkdir(reportDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportPath = path.join(reportDir, `extension-e2e-${stamp}.json`);
  report.ok = report.checks.every((item) => item.status !== "fail") && !report.error;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  const failed = report.checks.filter((item) => item.status === "fail").length;
  const skipped = report.checks.filter((item) => item.status === "skip").length;
  console.log(`\n${report.checks.length - failed - skipped}/${report.checks.length - skipped} checks passed` + (skipped ? ` (${skipped} skipped)` : ""));
  if (report.screenshots.length) console.log("screenshots: " + report.screenshots.map((item) => path.basename(item)).join(", "));
  console.log(`Report: ${reportPath}`);
  process.exitCode = report.ok ? 0 : 1;
}
