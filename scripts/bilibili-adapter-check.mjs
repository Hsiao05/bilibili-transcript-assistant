// Adapter-level acceptance check for apps/extension/src/bilibili/*.
//
// Runs the extension's real Bilibili adapter code (bundled with esbuild) against live
// Bilibili endpoints and against a captured logged-in player payload. This covers the
// network/protocol half of stage-A acceptance without needing a browser:
//   - video metadata + 分P -> cid mapping
//   - WBI signing
//   - anonymous player response (subtitle track discovery is login-gated: evidence)
//   - subtitle track normalization with a real logged-in payload
//   - subtitle body download + segment normalization (needs BTA_SUBTITLE_URL)
//   - independent audio track discovery + CDN Referer behaviour
//
// Usage:
//   node scripts/bilibili-adapter-check.mjs
//   BTA_SUBTITLE_URL="https://aisubtitle.hdslb.com/..." node scripts/bilibili-adapter-check.mjs
import { createRequire } from "node:module";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const extensionDir = path.join(root, "apps", "extension");
const require = createRequire(path.join(extensionDir, "package.json"));
const { build } = require("esbuild");

const MULTI_VIDEO = process.env.BTA_MULTI_VIDEO || "BV1XwxU6xEnL";
const MULTI_PAGE = Number(process.env.BTA_MULTI_PAGE || 2);
const SINGLE_VIDEO = process.env.BTA_VIDEO || "BV1REx46NEc4";
const SUBTITLE_URL = process.env.BTA_SUBTITLE_URL || "";
const FIXTURE = path.join(__dirname, "fixtures", "bilibili-player-logged-in.json");

const results = [];
function record(name, status, details, error) {
  results.push({ name, status, details, error });
  const icon = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
  console.log(`[${icon}] ${name}`);
  if (details !== undefined && status !== "pass") console.log("       " + JSON.stringify(details));
  if (error) console.log("       " + (error.stack || error.message || String(error)));
}
async function check(name, fn) {
  try {
    const details = await fn();
    record(name, "pass", details);
    return details;
  } catch (error) {
    record(name, "fail", undefined, error);
    return null;
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function bundleAdapters() {
  const outdir = await mkdtemp(path.join(os.tmpdir(), "bta-adapter-"));
  const apiEntry = path.join(extensionDir, "src", "bilibili", "api.ts");
  const wbiEntry = path.join(extensionDir, "src", "bilibili", "wbi.ts");
  assert(existsSync(apiEntry) && existsSync(wbiEntry), "adapter sources missing");
  await build({
    entryPoints: [apiEntry, wbiEntry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outdir,
    logLevel: "silent",
  });
  const api = await import(pathToFileURL(path.join(outdir, "api.js")).href);
  const wbi = await import(pathToFileURL(path.join(outdir, "wbi.js")).href);
  return { api, wbi, outdir };
}

const summary = {
  startedAt: new Date().toISOString(),
  samples: { single: SINGLE_VIDEO, multi: { bvid: MULTI_VIDEO, page: MULTI_PAGE } },
  subtitleUrlProvided: Boolean(SUBTITLE_URL),
  checks: results,
};

let bundle;
try {
  bundle = await bundleAdapters();
  const { api, wbi } = bundle;

  let viewData = null;
  await check("video metadata (view)", async () => {
    viewData = await api.getViewData(MULTI_VIDEO);
    assert(viewData.bvid === MULTI_VIDEO, "bvid mismatch");
    assert(Array.isArray(viewData.pages) && viewData.pages.length >= 2, "expected a multi-P video");
    return { title: viewData.title, pages: viewData.pages.length };
  });

  await check(`分P -> cid mapping (p${MULTI_PAGE})`, async () => {
    assert(viewData, "view unavailable");
    const ref = api.toVideoRef(viewData, MULTI_PAGE);
    const expected = viewData.pages.find((page) => page.page === MULTI_PAGE);
    assert(ref.page === MULTI_PAGE, `page ${ref.page} != ${MULTI_PAGE}`);
    assert(ref.cid === String(expected.cid), `cid ${ref.cid} != ${expected.cid}`);
    assert(ref.durationMs === Math.round(expected.duration * 1000), "duration mismatch");
    assert(ref.sourceUrl.includes(`p=${MULTI_PAGE}`), "sourceUrl missing p");
    return { cid: ref.cid, partTitle: ref.partTitle, durationMs: ref.durationMs };
  });

  const cid = viewData?.pages.find((page) => page.page === MULTI_PAGE)?.cid
    ? String(viewData.pages.find((page) => page.page === MULTI_PAGE).cid)
    : null;
  assert(cid, "multi-P cid unavailable; remaining player checks will be skipped");

  await check("WBI signing", async () => {
    const keys = await wbi.getWbiKeys();
    assert(/^[0-9a-f]{32}$/.test(keys.imgKey), "imgKey not 32 hex chars");
    assert(/^[0-9a-f]{32}$/.test(keys.subKey), "subKey not 32 hex chars");
    const signed = await wbi.signWbi({ bvid: MULTI_VIDEO, cid: String(cid) });
    assert(/^\d+$/.test(signed.wts), "wts missing");
    assert(/^[0-9a-f]{32}$/.test(signed.w_rid), "w_rid not md5 hex");
    return { wts: signed.wts };
  });

  await check("player API anonymous: subtitle tracks are login-gated", async () => {
    const data = await api.getPlayerData(MULTI_VIDEO, String(cid));
    const tracks = api.normalizeTracks(data.subtitle?.subtitles);
    assert(data.need_login_subtitle === true, "expected need_login_subtitle=true for anonymous request");
    assert(tracks.length === 0, `expected zero anonymous tracks, got ${tracks.length}`);
    return { needLoginSubtitle: data.need_login_subtitle, asrLanguage: data.asr_language ?? "", tracks: tracks.length };
  });

  await check("normalizeTracks: logged-in payload (8 AI tracks)", async () => {
    const fixture = JSON.parse(await readFile(FIXTURE, "utf8"));
    const raw = fixture.data.subtitle.subtitles;
    const tracks = api.normalizeTracks(raw);
    assert(tracks.length === 8, `expected 8 tracks, got ${tracks.length}`);
    assert(tracks[0].lan === "ai-zh", `zh track not first: ${tracks[0].lan}`);
    assert(tracks.every((track) => track.type === "ai"), "all subtitles should classify as ai");
    assert(tracks.every((track) => track.url.startsWith("https://aisubtitle.hdslb.com/")), "url not normalized to https");
    assert(tracks.every((track) => track.url.includes("auth_key=REDACTED")), "url query not preserved");
    assert(tracks[0].id === "2142267835404456448", `track id not preserved: ${tracks[0].id}`);
    return { count: tracks.length, order: tracks.map((track) => track.lan), first: tracks[0].lanDoc };
  });

  await check("normalizeTracks: filtering / dedupe / type classification", async () => {
    const tracks = api.normalizeTracks([
      { lan: "zh-CN", lan_doc: "中文（人工）", subtitle_url: "https://example.com/blocked.json" },
      { lan: "zh-CN", lan_doc: "中文（人工）", subtitle_url: "https://aisubtitle.hdslb.com/human.json" },
      { lan: "zh-CN", lan_doc: "中文（人工）", subtitle_url: "https://aisubtitle.hdslb.com/human.json" },
      { lan: "", lan_doc: "", subtitle_url: "https://aisubtitle.hdslb.com/unknown.json" },
      { lan: "en", lan_doc: "no url" },
      { lan: "ai-en", lan_doc: "AI English", ai_type: 1, subtitle_url: "http://aisubtitle.hdslb.com/insecure.json" },
    ]);
    assert(tracks.length === 2, `expected 2 tracks after filtering, got ${tracks.length}`);
    assert(tracks[0].type === "human", `expected human first, got ${tracks[0].type}`);
    assert(tracks[1].type === "unknown", `expected unknown second, got ${tracks[1].type}`);
    return tracks.map((track) => ({ lan: track.lan, type: track.type, url: track.url }));
  });

  let audioData = null;
  await check("independent audio track (playurl)", async () => {
    audioData = await api.getAudioTrack(MULTI_VIDEO, String(cid));
    assert(audioData.url.startsWith("https://"), "audio url not https");
    assert(audioData.bandwidth > 0, "bandwidth missing");
    assert(/audio\//.test(audioData.mimeType), `unexpected mimeType ${audioData.mimeType}`);
    assert(audioData.durationMs > 0, "duration missing");
    assert(Number.isFinite(audioData.estimatedBytes) && audioData.estimatedBytes > 0, "estimatedBytes missing");
    return { id: audioData.id, bandwidth: audioData.bandwidth, mimeType: audioData.mimeType, durationMs: audioData.durationMs, sizeMb: Math.round(audioData.estimatedBytes / 1048576) };
  });

  await check("audio CDN requires Referer (DNR is load-bearing)", async () => {
    assert(audioData, "audio track unavailable");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let withoutReferer;
    let withReferer;
    try {
      const bare = await fetch(audioData.url, { headers: { Range: "bytes=0-1023" }, signal: controller.signal });
      await bare.arrayBuffer().catch(() => undefined);
      withoutReferer = bare.status;
      const referred = await fetch(audioData.url, {
        headers: { Range: "bytes=0-1023", Referer: "https://www.bilibili.com/", "User-Agent": "Mozilla/5.0" },
        signal: controller.signal,
      });
      await referred.arrayBuffer().catch(() => undefined);
      withReferer = {
        status: referred.status,
        contentRange: referred.headers.get("content-range"),
        contentType: referred.headers.get("content-type"),
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    assert(withReferer.status === 206 || withReferer.status === 200, `audio CDN rejected referenced request: ${withReferer.status}`);
    return { withoutReferer, withReferer };
  });

  if (SUBTITLE_URL) {
    await check("subtitle body -> normalized segments", async () => {
      const items = await api.getSubtitleSegments(SUBTITLE_URL);
      assert(items.length > 0, "no subtitle segments");
      let previous = -1;
      for (const item of items) {
        assert(Number.isFinite(item.from) && Number.isFinite(item.to), "non-numeric time");
        assert(item.to >= item.from, "to < from");
        assert(item.content.length > 0, "empty content");
        assert(item.from >= previous, "non-monotonic start time");
        previous = item.from;
      }
      return { count: items.length, first: items[0], last: items[items.length - 1] };
    });
  } else {
    record("subtitle body -> normalized segments", "skip", {
      reason: "set BTA_SUBTITLE_URL to a live subtitle JSON address to run this check",
    });
  }

  await check("subtitle URL domain whitelist", async () => {
    let blocked = null;
    try {
      await api.getSubtitleSegments("https://evil.example.com/captions.json");
    } catch (error) {
      blocked = { name: error.name, kind: error.kind, code: error.code, message: error.message };
    }
    assert(blocked && blocked.kind === "invalid_url", "non-allowlisted subtitle host was not rejected");
    return blocked;
  });

  summary.finishedAt = new Date().toISOString();
  summary.ok = results.every((item) => item.status !== "fail");
} catch (error) {
  record("adapter check bootstrap", "fail", undefined, error);
  summary.ok = false;
} finally {
  if (bundle?.outdir) await rm(bundle.outdir, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((item) => item.status === "fail").length;
const skipped = results.filter((item) => item.status === "skip").length;
summary.finishedAt = new Date().toISOString();
summary.ok = failed === 0;
if (process.env.BTA_REPORT) {
  await writeFile(process.env.BTA_REPORT, JSON.stringify(summary, null, 2), "utf8").catch(() => undefined);
}
console.log(`\n${results.length - failed - skipped}/${results.length - skipped} checks passed` + (skipped ? ` (${skipped} skipped)` : ""));
process.exitCode = failed ? 1 : 0;
