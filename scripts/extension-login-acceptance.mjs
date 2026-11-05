// Logged-in end-to-end acceptance.
//
// This is the only acceptance path that needs a real Bilibili login: subtitle track discovery
// is login-gated, so the anonymous smoke test can only replay a captured payload. The script
// opens a dedicated Edge window with the extension and waits for you to sign in once (QR code),
// then it automatically verifies the real chain:
//
//   login -> subtitle tracks -> 提取文字稿 -> task-api document + clean revision ->
//   rendered transcript -> 总结视频 -> rendered summary -> Markdown export
//
// The Edge profile is persistent (%LOCALAPPDATA%\bta-login-profile), so the next run reuses
// the login and does not ask again.
//
// Usage: node scripts/extension-login-acceptance.mjs
//   BTA_LOGIN_TIMEOUT_MS=900000  (default 15 min; the script waits for you to log in)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  findUnpackedExtensionId,
  launchBrowser,
  openTab,
  sendMessageScript,
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
const LOGIN_TIMEOUT_MS = Number(process.env.BTA_LOGIN_TIMEOUT_MS || 900000);
const PROFILE = path.join(process.env.LOCALAPPDATA || os.homedir(), "bta-login-profile");
const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
const VIDEO = {
  bvid: process.env.BTA_VIDEO || "BV1REx46NEc4",
  cid: process.env.BTA_VIDEO_CID || "43235280963",
  page: 1,
  // Real metadata is read back from the service document; these are only display fallbacks.
  title: "登录态验收视频",
  author: "",
};
const TOKEN = `login-${Math.random().toString(36).slice(2, 10)}`;
const startedAt = new Date();

if (!enginePath || !existsSync(enginePath)) throw new Error("Chrome or Edge not found; set CHROME_PATH");
if (!existsSync(path.join(dist, "manifest.json"))) throw new Error("Build the extension first: npm --prefix apps/extension run build");
if (!existsSync(python)) throw new Error(`task-api venv python not found: ${python}`);

const report = {
  startedAt: startedAt.toISOString(),
  profile: PROFILE,
  video: VIDEO,
  checks: [],
  consoleErrors: [],
  screenshots: [],
  downloads: [],
};
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

async function pickPort() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = 8300 + Math.floor(Math.random() * 400);
    try {
      await fetch(`http://127.0.0.1:${candidate}/health`, { signal: AbortSignal.timeout(250) });
    } catch {
      return candidate;
    }
  }
  throw new Error("no free port");
}

class Service {
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
      TASKAPI_ENV_FILE: path.join(this.dataDir, "absent.env"),
      TASKAPI_ASR_DISABLED: "1",
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
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
    const ready = await waitFor(async () => (await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(800) })).ok, 30000, 500);
    if (!ready) throw new Error("task-api did not start");
  }
  async request(pathname, { method = "GET", body } = {}) {
    const response = await fetch(`${this.base}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`${method} ${pathname} -> HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response.json();
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

const settings = {
  serviceUrl: "",
  serviceToken: TOKEN,
  language: "zh-CN",
  strength: "standard",
  autoAsrFallback: false,
  showTimestamps: true,
  theme: "light",
  asrProvider: "auto",
};

const dataDir = await mkdtemp(path.join(os.tmpdir(), "bta-login-service-"));
const downloadDir = await mkdtemp(path.join(os.tmpdir(), "bta-login-download-"));
const service = new Service(await pickPort(), dataDir, TOKEN);
settings.serviceUrl = service.base;
let launched = null;
let navCdp = null;
let videoCdp = null;
let demoCdp = null;
let realCdp = null;
let workerCdp = null;
let browserCdp = null;

try {
  await service.start();
  check("task-api starts for logged-in acceptance", "pass", { port: service.port });

  await mkdir(PROFILE, { recursive: true });
  launched = await launchBrowser({ enginePath, dist, prefix: "bta-login-", width: 1220, height: 1000, profileDir: PROFILE });
  const port = launched.port;
  report.engine = { path: enginePath, version: launched.version.Browser || null };

  // With a persistent profile the extension is already installed and its MV3 worker may be
  // dormant: read the id from the profile, open an extension page to wake it, then attach.
  let extensionId = await waitFor(() => findUnpackedExtensionId(PROFILE, dist), 20000, 500);
  if (!extensionId) {
    const attached = await attachWorker(port);
    extensionId = attached.extensionId;
    workerCdp = attached.cdp;
  }
  report.extension = { id: extensionId };

  const demoPage = await openTab(port, `chrome-extension://${extensionId}/index.html?demo=ready`);
  demoCdp = await attachPage(demoPage);
  await sleep(1500);
  if (!workerCdp) {
    const attached = await attachWorker(port);
    workerCdp = attached.cdp;
  }
  check("extension loads with persistent profile", "pass", { id: extensionId, profile: PROFILE });

  // Settings must be in place before the real side panel boots.
  await evaluate(demoCdp, `new Promise((resolve) => chrome.storage.local.set({ "bili-transcript-settings": ${JSON.stringify(settings)} }, () => resolve(true)))`, 20000);

  // Login page + a nav probe tab that is reloaded while waiting for the QR sign-in.
  const biliTab = await openTab(port, "https://www.bilibili.com/");
  await activateTab(port, biliTab.id);
  const navTab = await openTab(port, NAV_URL);
  navCdp = await attachPage(navTab);
  await navCdp.send("Page.enable");

  const readLogin = async () => {
    try {
      const text = await evaluate(navCdp, "document.body.innerText", 15000);
      const payload = JSON.parse(text);
      return { isLogin: Boolean(payload?.data?.isLogin) };
    } catch {
      return { isLogin: false };
    }
  };

  let login = await readLogin();
  if (!login.isLogin) {
    console.log("================================================================");
    console.log(" 需要你在打开的 Edge 窗口中登录 B 站");
    console.log(" （扫码即可，登录状态会保存在专用测试 profile 中，下次不用重复登录）");
    console.log(` 窗口 profile: ${PROFILE}`);
    console.log(` 最多等待 ${Math.round(LOGIN_TIMEOUT_MS / 1000)} 秒；登录成功后脚本自动继续。`);
    console.log("================================================================");
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let lastNote = 0;
    while (Date.now() < deadline) {
      await sleep(3000);
      await navCdp.send("Page.reload", { ignoreCache: true }).catch(() => undefined);
      await sleep(2200);
      login = await readLogin();
      if (login.isLogin) break;
      if (Date.now() - lastNote > 15000) {
        lastNote = Date.now();
        console.log(`[wait] 仍在等待 B 站登录（已等待 ${Math.round((Date.now() - (deadline - LOGIN_TIMEOUT_MS)) / 1000)}s）`);
      }
    }
  }
  assert(login.isLogin, "B站登录未完成（超时）");
  check("Bilibili login detected", "pass", { isLogin: true });

  // Real video page and the real side panel.
  const videoTab = await openTab(port, `https://www.bilibili.com/video/${VIDEO.bvid}/?p=${VIDEO.page}`);
  await sleep(5000);
  await activateTab(port, videoTab.id);
  videoCdp = await attachPage(videoTab);

  const realPage = await openTab(port, `chrome-extension://${extensionId}/index.html`);
  realCdp = await attachPage(realPage);
  await realCdp.send("Log.enable");
  await sleep(2500);
  await activateTab(port, videoTab.id);
  await sleep(4500);

  const bootText = await evaluate(realCdp, "document.body.innerText", 20000);
  const booted = await waitFor(async () => {
    const text = await evaluate(realCdp, "document.body.innerText", 20000);
    return text.includes("条字幕轨") || text.includes("B站") && text.includes("字幕") ? text : null;
  }, 30000, 800);
  assert(booted, `side panel did not identify the video: ${bootText.slice(0, 300)}`);
  assert(!booted.includes("任务服务未连接"), "service reported as disconnected");

  const player = await evaluate(realCdp, sendMessageScript({ type: "bili:player", bvid: VIDEO.bvid, cid: VIDEO.cid }), 60000);
  assert(player?.ok, `bili:player failed: ${JSON.stringify(player?.error)}`);
  const tracks = player.data.tracks;
  assert(tracks.length > 0, "logged-in browser still returned no subtitle tracks");
  const trackBrief = tracks.map((track) => ({ lan: track.lan, lanDoc: track.lanDoc, type: track.type }));
  check("logged-in subtitle track discovery (through extension)", "pass", { count: tracks.length, tracks: trackBrief });

  const beforeShot = await realCdp.send("Page.captureScreenshot", { format: "png" });
  await mkdir(screenshotDir, { recursive: true });
  const beforeShotPath = path.join(screenshotDir, "login-e2e-tracks.png");
  await writeFile(beforeShotPath, Buffer.from(beforeShot.data, "base64"));
  report.screenshots.push(beforeShotPath);

  // 提取文字稿: real subtitle download -> document -> clean job.
  const clicked = await evaluate(realCdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((node) => node.offsetParent !== null && node.textContent.includes("提取文字稿"));
    if (!button) return false;
    button.click();
    return true;
  })()`, 15000);
  assert(clicked, "提取文字稿 button not found");

  const document = await waitFor(async () => {
    const response = await fetch(`${service.base}/v1/documents?bvid=${VIDEO.bvid}&cid=${VIDEO.cid}&page=${VIDEO.page}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (response.status !== 200) return null;
    return response.json();
  }, 180000, 2000);
  assert(document, "document was not created from the real subtitle track");
  assert(
    !(document.revisions || []).some((item) => item.kind === "cleaned"),
    "clean job should not start automatically after extraction",
  );
  check("document created from live subtitle body", "pass", {
    documentId: document.document.id,
    sourceType: document.source?.type,
    segments: document.source?.segmentCount,
  });

  const clickedClean = await waitFor(async () => {
    return evaluate(realCdp, `(() => {
      const button = [...document.querySelectorAll("button")].find((node) => node.offsetParent !== null && /清洗文字稿|重新清洗文字稿/.test(node.textContent));
      if (!button) return false;
      button.click();
      return true;
    })()`, 15000);
  }, 30000, 500);
  assert(clickedClean, "清洗文字稿 button not found");
  check("manual clean click starts the real clean job", "pass", {});

  const cleaned = await waitFor(async () => {
    const bundle = await service.request(`/v1/documents/${document.document.id}`);
    const revision = bundle.revisions.find((item) => item.kind === "cleaned");
    return revision ? { bundle, revision } : null;
  }, 120000, 1500);
  assert(cleaned, "clean job did not produce a cleaned revision");
  const cleanedRevision = await service.request(`/v1/documents/${document.document.id}/revisions/${cleaned.revision.id}`);
  const firstText = cleanedRevision.blocks[0]?.text ?? "";
  assert(firstText.length > 0, "cleaned revision is empty");
  const transcriptVisible = await waitFor(async () => {
    const text = await evaluate(realCdp, "document.body.innerText", 20000);
    return text.includes(firstText.slice(0, 12)) ? text : null;
  }, 60000, 1000);
  assert(transcriptVisible, "cleaned transcript did not render in the side panel");
  const transcriptShot = await realCdp.send("Page.captureScreenshot", { format: "png" });
  const transcriptShotPath = path.join(screenshotDir, "login-e2e-transcript.png");
  await writeFile(transcriptShotPath, Buffer.from(transcriptShot.data, "base64"));
  report.screenshots.push(transcriptShotPath);
  check("cleaned transcript rendered in side panel", "pass", {
    revisionId: cleaned.revision.id,
    blocks: cleanedRevision.blocks.length,
    sourceType: document.source?.type,
    segments: document.source?.segmentCount,
  });

  // 总结视频 -> summary rendered.
  const summaryClicked = await evaluate(realCdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((node) => node.offsetParent !== null && node.textContent.includes("总结视频"));
    if (!button) return false;
    button.click();
    return true;
  })()`, 15000);
  assert(summaryClicked, "总结视频 button not found");
  const summary = await waitFor(async () => {
    const response = await fetch(`${service.base}/v1/documents/${document.document.id}/summaries/latest`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    return response.status === 200 ? response.json() : null;
  }, 120000, 1500);
  assert(summary, "summary was not generated");
  assert(summary.chapters.length > 0, "summary has no chapters");
  const summaryVisible = await waitFor(async () => {
    const text = await evaluate(realCdp, "document.body.innerText", 20000);
    return text.includes(summary.overview.slice(0, 10)) || text.includes("内容概览") ? text : null;
  }, 60000, 1000);
  assert(summaryVisible, "summary did not render in the side panel");
  const summaryShot = await realCdp.send("Page.captureScreenshot", { format: "png" });
  const summaryShotPath = path.join(screenshotDir, "login-e2e-summary.png");
  await writeFile(summaryShotPath, Buffer.from(summaryShot.data, "base64"));
  report.screenshots.push(summaryShotPath);
  check("summary rendered from real transcript", "pass", {
    summaryId: summary.id,
    chapters: summary.chapters.length,
    overview: summary.overview.slice(0, 80),
    model: summary.model,
  });

  // Export the current cleaned revision.
  const backClicked = await evaluate(realCdp, `(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes("文字稿"));
    if (!tab) return false;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      tab.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  })()`, 15000);
  assert(backClicked, "transcript tab not found");
  await sleep(1200);
  browserCdp = await attachBrowser(port);
  await browserCdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
  const exportReady = await waitFor(async () => evaluate(realCdp, `Boolean(document.querySelector('button[aria-label="导出当前版本"]'))`, 10000), 15000, 400);
  assert(exportReady, "export button not found");
  await evaluate(realCdp, `(() => { document.querySelector('button[aria-label="导出当前版本"]').click(); return true; })()`, 15000);
  const markdown = await waitFor(async () => {
    const files = (await readdir(downloadDir)).filter((name) => name.endsWith(".md"));
    if (!files.length) return null;
    const text = await readFile(path.join(downloadDir, files[0]), "utf8");
    return text.length > 300 ? { name: files[0], text } : null;
  }, 30000, 600);
  assert(markdown, "markdown export did not appear");
  assert(markdown.name.includes("整理稿"), `unexpected export filename ${markdown.name}`);
  assert(markdown.text.includes(firstText.slice(0, 12)), "exported markdown missing live transcript text");
  report.downloads.push({ filename: markdown.name, bytes: Buffer.byteLength(markdown.text) });
  check("export live transcript as Markdown", "pass", { filename: markdown.name, bytes: Buffer.byteLength(markdown.text) });

  const errors = realCdp.events.filter(
    (event) => event.method === "Runtime.exceptionThrown" || (event.method === "Log.entryAdded" && event.params?.entry?.level === "error"),
  );
  report.consoleErrors = errors.map((event) => {
    const entry = event.params?.entry;
    const exception = event.params?.exceptionDetails;
    return {
      text: entry?.text || exception?.text || "",
      url: entry?.url || exception?.url || "",
      source: entry?.source || event.method,
      level: entry?.level || "error",
    };
  });
  // Expected network noise (not product errors):
  //  - favicon 404 when opening the extension page directly as a tab
  //  - GET /v1/documents?... 404, the designed "no document yet" probe before extraction
  const fatalErrors = report.consoleErrors.filter((item) => {
    if (item.source !== "network" || !/404/.test(item.text)) return true;
    if (/favicon\.ico$/.test(item.url || "")) return false;
    if (/\/v1\/documents\?/.test(item.url || "")) return false;
    return true;
  });
  if (fatalErrors.length) {
    console.log("       console errors: " + JSON.stringify(report.consoleErrors));
  }
  assert(fatalErrors.length === 0, `console errors: ${JSON.stringify(fatalErrors)}`);
  check("no unexpected console errors in logged-in side panel", "pass", {
    errors: report.consoleErrors.length,
    expected404: report.consoleErrors.length - fatalErrors.length,
  });

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.finishedAt = new Date().toISOString();
  check("logged-in acceptance bootstrap", "fail", undefined, error);
  if (service.logs?.length) report.serviceLogsTail = service.logs.slice(-20);
} finally {
  for (const cdp of [videoCdp, navCdp, demoCdp, realCdp, workerCdp, browserCdp]) {
    try { cdp?.close(); } catch { /* ignore */ }
  }
  await closeBrowser(launched);
  await service.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(downloadDir, { recursive: true, force: true }).catch(() => undefined);

  await mkdir(reportDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportPath = path.join(reportDir, `login-e2e-${stamp}.json`);
  report.ok = report.checks.every((item) => item.status !== "fail") && !report.error;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  const failed = report.checks.filter((item) => item.status === "fail").length;
  const skipped = report.checks.filter((item) => item.status === "skip").length;
  console.log(`\n${report.checks.length - failed - skipped}/${report.checks.length - skipped} checks passed` + (skipped ? ` (${skipped} skipped)` : ""));
  if (report.screenshots.length) console.log("screenshots: " + report.screenshots.map((item) => path.basename(item)).join(", "));
  console.log(`Report: ${reportPath}`);
  process.exitCode = report.ok ? 0 : 2;
}
