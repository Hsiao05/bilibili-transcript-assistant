// Stage-A acceptance smoke test: load the built extension in a real Chromium browser (Edge by
// default, because branded Chrome 137+ ignores --load-extension), then exercise the extension's
// background message API against live Bilibili endpoints and captured login-only payloads.
//
// Checks
//   1. service worker registers, manifest/sidePanel wiring is present
//   2. side panel UI renders in demo mode (screenshot + console errors)
//   3. identity:current resolves the active B站 tab (multi-P, ?p=N)
//   4. content script answers content:getIdentity and reports in-site navigation (page:changed)
//   5. bili:view returns metadata + 分P list
//   6. bili:player anonymous: WBI-signed call succeeds, tracks are login-gated (evidence)
//   7. bili:player with a replayed logged-in payload: 8 AI tracks normalized correctly
//   8. bili:subtitle: real subtitle JSON -> normalized segments (BTA_SUBTITLE_URL)
//   9. bili:playurl: independent AAC audio stream discovered
//  10. audio CDN range fetch from extension page vs background service worker (DNR Referer path)
//
// Usage
//   node scripts/extension-smoke.mjs
//   CHROME_PATH="C:\...\msedge.exe" node scripts/extension-smoke.mjs
//   BTA_PROBE_CHROME=1 node scripts/extension-smoke.mjs      # also prove Chrome ignores --load-extension
//   BTA_SUBTITLE_URL="https://aisubtitle.hdslb.com/..." node scripts/extension-smoke.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Cdp,
  activateTab as libActivateTab,
  attachWorker,
  cleanupStaleProcesses,
  closeBrowser,
  evaluate,
  killTree,
  launchBrowser,
  openTab as libOpenTab,
  pickPort,
  sendMessageScript,
  sleep,
  waitFor,
} from "./lib/browser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "apps", "extension", "dist");
const fixturePath = path.join(__dirname, "fixtures", "bilibili-player-logged-in.json");
const reportDir = path.join(root, "docs", "acceptance");
const screenshotDir = path.join(root, "docs", "screenshots");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const enginePath = process.env.CHROME_PATH || (existsSync(EDGE) ? EDGE : existsSync(CHROME) ? CHROME : "");
let port = Number(process.env.BTA_PORT || 0);
const MULTI_VIDEO = process.env.BTA_MULTI_VIDEO || "BV1XwxU6xEnL";
const MULTI_PAGE = Number(process.env.BTA_MULTI_PAGE || 2);
const SINGLE_VIDEO = process.env.BTA_VIDEO || "BV1REx46NEc4";
const SUBTITLE_URL = process.env.BTA_SUBTITLE_URL || "";
const PROBE_CHROME = process.env.BTA_PROBE_CHROME === "1";
const startedAt = new Date();

if (!enginePath || !existsSync(enginePath)) throw new Error("Chrome or Edge not found; set CHROME_PATH");
if (!existsSync(path.join(dist, "manifest.json"))) throw new Error("Build the extension first: cd apps/extension && npm run build");

const report = {
  startedAt: startedAt.toISOString(),
  engine: { path: enginePath, version: null },
  samples: { single: SINGLE_VIDEO, multi: { bvid: MULTI_VIDEO, page: MULTI_PAGE }, subtitleUrlProvided: Boolean(SUBTITLE_URL) },
  extension: null,
  checks: [],
  findings: [],
  consoleErrors: [],
  screenshots: [],
  chromeLoadExtensionPolicy: null,
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

let launched = null;
let demoCdp = null;
let workerCdp = null;
let biliCdp = null;

async function openTab(url) {
  return libOpenTab(port, url);
}

async function activateTab(id) {
  return libActivateTab(port, id);
}

try {
  launched = await launchBrowser({ enginePath, dist, prefix: "bta-smoke-", width: 1150, height: 920 });
  port = launched.port;
  report.engine.version = launched.version.Browser || null;

  const attached = await attachWorker(port);
  workerCdp = attached.cdp;
  const extensionId = attached.extensionId;
  report.extension = { id: extensionId, workerUrl: attached.target.url };
  check("extension service worker registered", "pass", { id: extensionId });
  await workerCdp.send("Network.enable");

  const manifestSummary = await evaluate(workerCdp, `(() => {
    const manifest = chrome.runtime.getManifest();
    return {
      name: manifest.name,
      version: manifest.version,
      manifestVersion: manifest.manifest_version,
      permissions: manifest.permissions,
      hostPermissions: manifest.host_permissions,
      sidePanelPath: manifest.side_panel?.default_path,
      serviceWorker: manifest.background?.service_worker,
      contentScripts: manifest.content_scripts?.map((entry) => entry.matches)
    };
  })()`);
  report.extension.manifest = manifestSummary;
  check("manifest wiring", "pass", manifestSummary);

  await (async () => {
    try {
      const api = await evaluate(workerCdp, `(async () => ({
        hasSidePanel: typeof chrome.sidePanel === "object",
        setPanelBehavior: typeof chrome.sidePanel?.setPanelBehavior === "function",
        getOptions: typeof chrome.sidePanel?.getOptions === "function",
        hasDnr: typeof chrome.declarativeNetRequest === "object",
        sessionRules: (await chrome.declarativeNetRequest.getSessionRules()).map((rule) => ({
          id: rule.id,
          filter: rule.condition.urlFilter,
          tabIds: rule.condition.tabIds,
          excludedInitiatorDomains: rule.condition.excludedInitiatorDomains,
          referer: rule.action.requestHeaders?.find((header) => header.header === "Referer")?.value
        }))
      }))()`);
      assert(api.hasSidePanel && api.setPanelBehavior, "sidePanel API unavailable");
      assert(api.hasDnr, "declarativeNetRequest unavailable");
      assert(api.sessionRules.length > 0, "no session DNR rules installed");
      report.dnr = api;
      check("sidePanel + DNR session rules", "pass", api);
    } catch (error) {
      check("sidePanel + DNR session rules", "fail", undefined, error);
    }
  })();

  // ---- demo UI (visual baseline) -------------------------------------------------------
  const demoPage = await openTab(`chrome-extension://${extensionId}/index.html?demo=ready`);
  demoCdp = new Cdp(demoPage.webSocketDebuggerUrl);
  await demoCdp.open();
  await demoCdp.send("Runtime.enable");
  await demoCdp.send("Page.enable");
  await demoCdp.send("Log.enable");
  await sleep(1600);
  const demo = await evaluate(demoCdp, `({
    title: document.title,
    text: document.body.innerText.slice(0, 220),
    tabs: [...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent.trim()),
    theme: document.documentElement.className
  })`, 30000);
  const shot = await demoCdp.send("Page.captureScreenshot", { format: "png" });
  await mkdir(screenshotDir, { recursive: true });
  const shotPath = path.join(screenshotDir, "sidepanel-demo.png");
  await writeFile(shotPath, Buffer.from(shot.data, "base64"));
  report.screenshots.push(shotPath);
  const errors = demoCdp.events.filter(
    (event) => event.method === "Runtime.exceptionThrown" || (event.method === "Log.entryAdded" && ["error", "warning"].includes(event.params?.entry?.level)),
  );
  report.consoleErrors = errors.map((event) => event.params?.exceptionDetails?.text || event.params?.entry?.text);
  assert(demo.text.includes("文字稿助手"), "side panel did not render");
  assert(demo.tabs.length === 4, `expected 4 tabs, got ${demo.tabs.length}`);
  check("side panel UI renders (demo)", "pass", { ...demo, screenshot: shotPath, consoleErrors: report.consoleErrors.length });

  // ---- identity + content script -------------------------------------------------------
  // Keep the B站 tab and the extension page in the same window so identity:current sees the
  // active B站 tab while sendMessage runs from the (background) extension page.
  const biliPage = await openTab(`https://www.bilibili.com/video/${MULTI_VIDEO}/?p=1`);
  await sleep(3500);
  await activateTab(biliPage.id);
  await sleep(800);
  biliCdp = new Cdp(biliPage.webSocketDebuggerUrl);
  await biliCdp.open();
  await biliCdp.send("Page.enable");
  await biliCdp.send("Network.enable");

  const identity1 = await evaluate(demoCdp, sendMessageScript({ type: "identity:current" }), 30000);
  assert(identity1?.ok, `identity:current failed: ${JSON.stringify(identity1?.error)}`);
  assert(identity1.data.bvid === MULTI_VIDEO, `bvid ${identity1.data.bvid} != ${MULTI_VIDEO}`);
  assert(identity1.data.page === 1, `page ${identity1.data.page} != 1`);
  assert(identity1.data.supported, "tab not recognized as supported");
  check("identity:current (p1, active B站 tab)", "pass", identity1.data);

  const contentScript = await evaluate(demoCdp, `(async () => {
    const tabs = await chrome.tabs.query({ url: "*://www.bilibili.com/video/*" });
    if (!tabs.length) return { ok: false, error: "no B站 video tab" };
    const tab = tabs[0];
    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: "content:getIdentity" }, (value) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(value);
      });
    });
    return { ok: true, tabUrl: tab.url, response };
  })()`, 30000);
  assert(contentScript?.ok && contentScript.response?.ok, `content script unavailable: ${JSON.stringify(contentScript)}`);
  assert(contentScript.response.data.page === 1, "content script page != 1");
  check("content script responds (content:getIdentity)", "pass", contentScript.response.data);

  // In-site navigation: same tab, ?p=1 -> ?p=2 must be picked up by the content script and
  // broadcast to any open extension page.
  await evaluate(demoCdp, `(() => {
    window.__btaPageChanged = [];
    if (!window.__btaListenerInstalled) {
      window.__btaListenerInstalled = true;
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === "page:changed" && message.identity) window.__btaPageChanged.push(message.identity);
      });
    }
    return true;
  })()`, 15000);
  await biliCdp.send("Page.navigate", { url: `https://www.bilibili.com/video/${MULTI_VIDEO}/?p=${MULTI_PAGE}` });
  await sleep(4500);
  await activateTab(biliPage.id);
  await sleep(600);
  const identity2 = await evaluate(demoCdp, sendMessageScript({ type: "identity:current" }), 30000);
  assert(identity2?.ok && identity2.data.page === MULTI_PAGE, `page not updated: ${JSON.stringify(identity2)}`);
  const broadcasts = await evaluate(demoCdp, `window.__btaPageChanged || []`, 15000);
  const sawBroadcast = broadcasts.some((identity) => identity.page === MULTI_PAGE && identity.bvid === MULTI_VIDEO);
  assert(sawBroadcast, `page:changed not broadcast: ${JSON.stringify(broadcasts)}`);
  const contentAfterNav = await evaluate(demoCdp, `(async () => {
    const tabs = await chrome.tabs.query({ url: "*://www.bilibili.com/video/*" });
    const tab = tabs[0];
    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: "content:getIdentity" }, (value) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(value);
      });
    });
    return { ok: true, response };
  })()`, 30000);
  assert(contentAfterNav?.response?.data?.page === MULTI_PAGE, "content script did not follow in-site navigation");
  check("in-site navigation (p1 -> pN)", "pass", {
    identityPage: identity2.data.page,
    contentScriptPage: contentAfterNav.response.data.page,
    broadcasts: broadcasts.map((item) => item.page),
  });

  // The DNR Referer rule must not touch requests initiated by the bilibili.com page itself,
  // otherwise normal playback could be affected.
  const cdnResponses = biliCdp.events.filter((event) => {
    if (event.method !== "Network.responseReceived") return false;
    const { response } = event.params;
    try {
      const host = new URL(response.url).hostname;
      if (!/(^|\.)(bilivideo\.com|bilivideo\.cn|hdslb\.com)$/i.test(host)) return false;
    } catch {
      return false;
    }
    return [200, 206].includes(response.status);
  });
  if (cdnResponses.length) {
    const byType = {};
    for (const event of cdnResponses) byType[event.params.type] = (byType[event.params.type] || 0) + 1;
    check("B站 page playback requests unaffected by DNR", "pass", {
      requests: cdnResponses.length,
      byType,
      sample: cdnResponses.slice(0, 3).map((event) => ({
        type: event.params.type,
        status: event.params.response.status,
        mimeType: event.params.response.mimeType,
        url: event.params.response.url.slice(0, 110),
      })),
    });
  } else {
    check("B站 page playback requests unaffected by DNR", "skip", { reason: "no CDN media response captured on the B站 tab" });
  }

  // ---- bili:view / bili:player / bili:subtitle / bili:playurl ---------------------------
  const view = await evaluate(demoCdp, sendMessageScript({ type: "bili:view", bvid: MULTI_VIDEO }), 45000);
  assert(view?.ok, `bili:view failed: ${JSON.stringify(view?.error)}`);
  const pageInfo = view.data.pages.find((item) => item.page === MULTI_PAGE);
  assert(pageInfo, `p${MULTI_PAGE} missing from pages`);
  check("bili:view (metadata + 分P)", "pass", {
    title: view.data.title,
    author: view.data.owner?.name,
    pages: view.data.pages.length,
    currentCid: String(pageInfo.cid),
    part: pageInfo.part,
  });

  const player = await evaluate(demoCdp, sendMessageScript({ type: "bili:player", bvid: MULTI_VIDEO, cid: String(pageInfo.cid) }), 60000);
  assert(player?.ok, `bili:player failed: ${JSON.stringify(player?.error)}`);
  assert(Array.isArray(player.data.tracks), "tracks missing");
  assert(player.data.tracks.length === 0, "anonymous player unexpectedly returned subtitle tracks");
  check("bili:player anonymous (subtitle tracks login-gated)", "pass", {
    rawTrackCount: player.data.rawTrackCount,
    allowSubmit: player.data.allowSubmit,
    note: "B站 returns need_login_subtitle=true and an empty track list for anonymous requests",
  });
  report.findings.push({
    id: "subtitle-login-gated",
    severity: "info",
    summary:
      "Subtitle track discovery requires a logged-in bilibili.com session: anonymous /x/player/wbi/v2 responses carry need_login_subtitle=true and no tracks. The extension fetches with credentials:'include', so a logged-in browser works; the anonymous smoke run cannot enumerate live tracks, so the captured logged-in payload is replayed instead.",
  });

  // Replay the captured logged-in player payload through the real background handler.
  if (workerCdp && existsSync(fixturePath)) {
    const fixtureText = await readFile(fixturePath, "utf8");
    const fixture = JSON.parse(fixtureText);
    let paused = 0;
    let fulfilled = 0;
    workerCdp.onEvent = (message) => {
      if (message.method !== "Fetch.requestPaused") return;
      paused += 1;
      workerCdp
        .send("Fetch.fulfillRequest", {
          requestId: message.params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/json; charset=utf-8" }],
          body: Buffer.from(fixtureText, "utf8").toString("base64"),
        })
        .then(() => { fulfilled += 1; })
        .catch(() => undefined);
    };
    await workerCdp.send("Fetch.enable", { patterns: [{ urlPattern: "*player/wbi/v2*", requestStage: "Request" }] });
    try {
      const mocked = await evaluate(
        demoCdp,
        sendMessageScript({ type: "bili:player", bvid: fixture.data.bvid, cid: String(fixture.data.cid) }),
        60000,
      );
      assert(mocked?.ok, `mocked bili:player failed: ${JSON.stringify(mocked?.error)}`);
      const tracks = mocked.data.tracks;
      assert(tracks.length === 8, `expected 8 replayed tracks, got ${tracks.length}`);
      assert(tracks[0].lan === "ai-zh", `zh track not first: ${tracks[0].lan}`);
      assert(tracks.every((track) => track.type === "ai"), "track type classification wrong");
      assert(tracks.every((track) => track.url.startsWith("https://aisubtitle.hdslb.com/")), "track url normalization wrong");
      check("bili:player with replayed logged-in payload", "pass", {
        interceptedRequests: paused,
        fulfilledRequests: fulfilled,
        tracks: tracks.map((track) => ({ id: track.id, lan: track.lan, lanDoc: track.lanDoc, type: track.type })),
      });
    } finally {
      workerCdp.onEvent = null;
      await workerCdp.send("Fetch.disable").catch(() => undefined);
    }
  } else {
    check("bili:player with replayed logged-in payload", "skip", { reason: "fixture missing or worker CDP unavailable" });
  }

  if (SUBTITLE_URL) {
    const subtitle = await evaluate(demoCdp, sendMessageScript({ type: "bili:subtitle", url: SUBTITLE_URL }), 60000);
    assert(subtitle?.ok, `bili:subtitle failed: ${JSON.stringify(subtitle?.error)}`);
    const segments = subtitle.data.segments;
    assert(segments.length > 0, "no subtitle segments");
    assert(segments[0].startMs >= 0 && segments[segments.length - 1].endMs > segments[0].startMs, "bad segment times");
    assert(segments.every((segment) => segment.text.length > 0 && segment.endMs >= segment.startMs), "bad segment payload");
    check("bili:subtitle (real subtitle JSON)", "pass", {
      count: segments.length,
      first: segments[0],
      last: segments[segments.length - 1],
    });
  } else {
    check("bili:subtitle (real subtitle JSON)", "skip", { reason: "set BTA_SUBTITLE_URL to run this check" });
  }

  const playurl = await evaluate(demoCdp, sendMessageScript({ type: "bili:playurl", bvid: MULTI_VIDEO, cid: String(pageInfo.cid) }), 60000);
  assert(playurl?.ok, `bili:playurl failed: ${JSON.stringify(playurl?.error)}`);
  assert(playurl.data.url.startsWith("https://"), "audio url not https");
  assert(playurl.data.bandwidth > 0, "bandwidth missing");
  assert(/audio\//.test(playurl.data.mimeType), `unexpected mimeType ${playurl.data.mimeType}`);
  check("bili:playurl (independent audio stream)", "pass", {
    id: playurl.data.id,
    bandwidth: playurl.data.bandwidth,
    mimeType: playurl.data.mimeType,
    codecs: playurl.data.codecs,
    durationMs: playurl.data.durationMs,
    estimatedMb: Math.round(playurl.data.estimatedBytes / 1048576),
  });

  // ---- audio CDN access from both extension contexts -----------------------------------
  const rangeProbe = (url) => `fetch(${JSON.stringify(url)}, { headers: { Range: "bytes=0-1023" }, cache: "no-store" })
    .then(async (response) => ({
      status: response.status,
      contentRange: response.headers.get("content-range"),
      contentType: response.headers.get("content-type"),
      bytes: (await response.arrayBuffer()).byteLength
    }))
    .catch((error) => ({ error: error.message }))`;
  const pageProbe = await evaluate(demoCdp, rangeProbe(playurl.data.url), 45000);
  const workerProbe = await evaluate(workerCdp, rangeProbe(playurl.data.url), 45000);

  report.audioProbe = {
    page: pageProbe,
    serviceWorker: workerProbe,
    note: "The audio CDN answers 403 without a Referer and 206 with one (see scripts/bilibili-adapter-check.mjs), so a 206 here proves the DNR rule applied to both extension contexts.",
  };

  if (workerProbe.status === 206 || workerProbe.status === 200) {
    check("audio CDN reachable from background service worker", "pass", workerProbe);
  } else {
    check("audio CDN reachable from background service worker", "fail", workerProbe);
  }
  if (pageProbe.status === 206 || pageProbe.status === 200) {
    check("audio CDN reachable from extension page (side-panel path)", "pass", pageProbe);
  } else {
    check("audio CDN reachable from extension page (side-panel path)", "fail", pageProbe);
    report.findings.push({
      id: "audio-referer-sidepanel",
      severity: "high",
      summary:
        "Range fetch from an extension page was rejected by the audio CDN while the background service worker succeeded, i.e. the DNR Referer rule only matches tab-less requests. The audio download in lib/audio.ts runs in the side panel, which is tab-associated, so production downloads would fail with HTTP 403.",
    });
  }

  // ---- optional: reproduce Chrome's --load-extension policy -------------------------------
  if (PROBE_CHROME && existsSync(CHROME)) {
    const probePort = await pickPort();
    const probeProfile = await mkdtemp(path.join(os.tmpdir(), "bta-smoke-chrome-"));
    const probe = spawn(
      CHROME,
      [
        `--remote-debugging-port=${probePort}`,
        `--user-data-dir=${probeProfile}`,
        `--load-extension=${dist}`,
        `--disable-extensions-except=${dist}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=900,700",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    try {
      const found = await waitFor(async () => {
        const response = await fetch(`http://127.0.0.1:${probePort}/json/list`);
        const list = await response.json();
        return list.some((item) => item.type === "service_worker" && item.url.includes("/background.js"));
      }, 12000, 500);
      const probeVersion = await fetch(`http://127.0.0.1:${probePort}/json/version`).then((response) => response.json()).catch(() => null);
      const honored = found === true;
      report.chromeLoadExtensionPolicy = {
        chrome: probeVersion?.Browser || "unknown",
        loadExtensionHonored: honored,
        note: honored ? "Chrome loaded the unpacked extension" : "branded Chrome ignored --load-extension (expected since Chrome 137)",
      };
      check("branded Chrome --load-extension policy", honored ? "pass" : "skip", report.chromeLoadExtensionPolicy);
    } finally {
      await killTree(probe.pid);
      await sleep(500);
      await rm(probeProfile, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.finishedAt = new Date().toISOString();
  check("smoke test bootstrap", "fail", undefined, error);
} finally {
  try { demoCdp?.close(); } catch { /* ignore */ }
  try { biliCdp?.close(); } catch { /* ignore */ }
  try { workerCdp?.close(); } catch { /* ignore */ }
  await closeBrowser(launched);
  await sleep(600);

  await mkdir(reportDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportPath = path.join(reportDir, `extension-smoke-${stamp}.json`);
  report.ok = report.checks.every((item) => item.status !== "fail") && !report.error;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  report.reportPath = reportPath;

  const failed = report.checks.filter((item) => item.status === "fail").length;
  const skipped = report.checks.filter((item) => item.status === "skip").length;
  console.log(`\n${report.checks.length - failed - skipped}/${report.checks.length - skipped} checks passed` + (skipped ? ` (${skipped} skipped)` : ""));
  if (report.findings.length) {
    console.log("\nFindings:");
    for (const finding of report.findings) console.log(`  [${finding.severity}] ${finding.id}: ${finding.summary}`);
  }
  console.log(`\nReport: ${reportPath}`);
  process.exitCode = report.ok ? 0 : 1;
}
