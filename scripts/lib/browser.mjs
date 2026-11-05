// Shared Chromium/CDP helpers for the project's acceptance scripts.
//
// The scripts need a real browser with the unpacked extension loaded, a helper to talk to
// extension pages/service workers over the DevTools protocol, and reliable cleanup on Windows
// (launcher processes exit early, so PID-based kills are not enough).
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function requireEngine(enginePath) {
  if (!enginePath) throw new Error("Chrome or Edge not found; set CHROME_PATH");
}

/** Pick a DevTools port that is actually free (a refused connection means free). */
export async function pickPort() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const candidate = 9300 + Math.floor(Math.random() * 600);
    try {
      await fetch(`http://127.0.0.1:${candidate}/json/version`, { signal: AbortSignal.timeout(300) });
    } catch {
      return candidate;
    }
  }
  throw new Error("no free DevTools port found");
}

export async function waitFor(fn, timeout = 20000, interval = 400) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
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

/** Minimal CDP websocket client with command correlation and event capture. */
export class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.onEvent = null;
    this.ws = new WebSocket(url);
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
        if (this.onEvent) this.onEvent(message);
      }
    };
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

export async function evaluate(cdp, expression, timeout = 90000) {
  const result = await Promise.race([
    cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }),
    sleep(timeout).then(() => {
      throw new Error("evaluate timeout");
    }),
  ]);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

export async function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("exit", resolve);
      killer.on("error", resolve);
      setTimeout(resolve, 5000);
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
}

/**
 * Browser launchers often exit after handing off to the real browser process, so a PID-based
 * kill can leave an orphaned profile behind on Windows. Kill by the test profile marker instead.
 */
export async function cleanupStaleProcesses() {
  if (process.platform !== "win32") return;
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' or Name='chrome.exe'\"",
    "| Where-Object { $_.CommandLine -like '*bta-smoke-*' -or $_.CommandLine -like '*bta-e2e-*' -or $_.CommandLine -like '*bta-login-*' }",
    "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join(" ");
  await new Promise((resolve) => {
    const cleaner = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore" });
    cleaner.on("exit", resolve);
    cleaner.on("error", resolve);
    setTimeout(resolve, 15000);
  });
}

/**
 * Launch a Chromium-family browser with the unpacked extension loaded.
 * Returns the child process, the chosen DevTools port, the temporary profile and the version.
 */
export async function launchBrowser({
  enginePath,
  dist,
  prefix = "bta-smoke-",
  width = 1150,
  height = 920,
  extraArgs = [],
  profileDir = "",
}) {
  requireEngine(enginePath);
  await cleanupStaleProcesses();
  const port = await pickPort();
  const keepProfile = Boolean(profileDir);
  const profile = keepProfile ? profileDir : await mkdtemp(path.join(os.tmpdir(), prefix));
  if (keepProfile) await mkdir(profile, { recursive: true });
  const engine = spawn(
    enginePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--load-extension=${dist}`,
      `--disable-extensions-except=${dist}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-component-update",
      `--window-size=${width},${height}`,
      ...extraArgs,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  engine.stdout.on("data", (data) => {
    log += data.toString();
  });
  engine.stderr.on("data", (data) => {
    log += data.toString();
  });
  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok ? response.json() : null;
  }, 20000);
  if (!version) throw new Error("DevTools endpoint did not start:\n" + log.slice(-2000));
  return { engine, port, profile, keepProfile, version, log: () => log };
}

export async function closeBrowser(launched) {
  if (!launched) return;
  await killTree(launched.engine?.pid);
  await cleanupStaleProcesses();
  await sleep(500);
  // A caller-supplied profile persists the login/extension state for the next run.
  if (!launched.keepProfile) {
    await rm(launched.profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function openTab(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`cannot open tab: HTTP ${response.status}`);
  return response.json();
}

export async function activateTab(port, id) {
  await fetch(`http://127.0.0.1:${port}/json/activate/${id}`).catch(() => undefined);
}

export async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

/** Attach to the extension service worker, tolerating MV3 worker startup/idle races. */
export async function attachWorker(port) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const list = await listTargets(port);
      const target = list.find((item) => item.type === "service_worker" && item.url.includes("/background.js"));
      if (!target) {
        await sleep(600);
        continue;
      }
      const cdp = new Cdp(target.webSocketDebuggerUrl);
      await cdp.open();
      await cdp.send("Runtime.enable");
      const id = await evaluate(cdp, `(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) || null`, 15000).catch(() => null);
      if (id) return { cdp, target, extensionId: id };
      cdp.close();
    } catch (error) {
      lastError = error;
    }
    await sleep(700);
  }
  throw new Error(
    "Extension service worker not found/attachable. This browser may reject --load-extension." +
      (lastError ? ` Last error: ${lastError.message}` : ""),
  );
}

export async function attachPage(target) {
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  return cdp;
}

/** Send a background message from an extension page (returns the {ok,data|error} envelope). */
export function sendMessageScript(payload) {
  return `(() => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(${JSON.stringify(payload)}, (response) => {
        resolve(response ?? { ok: false, error: { message: String(chrome.runtime.lastError?.message || "no response") } });
      });
    } catch (error) { resolve({ ok: false, error: { message: error.message } }); }
  }))()`;
}

/** Connect to the browser-level target (for Browser.setDownloadBehavior etc.). */
export async function attachBrowser(port) {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.open();
  return cdp;
}

/**
 * Read the unpacked extension id from a Chromium profile. With a persistent profile the
 * extension is already installed, so its MV3 worker may be dormant and absent from /json/list
 * until an extension page wakes it; the profile metadata gives us the id to open that page.
 */
export async function findUnpackedExtensionId(profileDir, distPath) {
  const target = path.resolve(distPath).toLowerCase();
  for (const file of ["Secure Preferences", "Preferences"]) {
    try {
      const json = JSON.parse(await readFile(path.join(profileDir, "Default", file), "utf8"));
      const settings = json?.extensions?.settings ?? {};
      for (const [id, value] of Object.entries(settings)) {
        const valuePath = String(value?.path ?? "").toLowerCase();
        if (valuePath && (valuePath === target || valuePath.endsWith(target))) return id;
      }
    } catch {
      // file missing or unreadable; try the next one
    }
  }
  return null;
}
