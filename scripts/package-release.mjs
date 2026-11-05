// Build a distributable release zip of the whole project.
//
// Included: extension source + built dist, task-api source/tests/config example, scripts,
// docs and README. Excluded: secrets (.env), virtualenvs, node_modules, local data/caches,
// source maps and previous release artifacts.
//
// Usage: node scripts/package-release.mjs
// Output: release/bili-transcript-assistant-<version>-<date>.zip (+ .sha256)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const releaseDir = path.join(root, "release");
const packageName = "bili-transcript-assistant";

const extensionPackage = JSON.parse(await readFile(path.join(root, "apps", "extension", "package.json"), "utf8"));
const version = extensionPackage.version || "0.1.0";
const stamp = new Date();
const dateTag = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, "0")}${String(stamp.getDate()).padStart(2, "0")}`;
const zipName = `${packageName}-${version}-${dateTag}.zip`;

const EXCLUDE_DIRS = new Set(["node_modules", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", "data", ".git", "release"]);
const EXCLUDE_FILES = new Set([".env", ".DS_Store", "Thumbs.db"]);
function shouldCopy(source) {
  const name = path.basename(source);
  if (EXCLUDE_DIRS.has(name)) return false;
  if (EXCLUDE_FILES.has(name)) return false;
  if (name.endsWith(".map")) return false;
  return true;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
    child.on("error", reject);
  });
}

async function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        files += 1;
        bytes += (await stat(full)).size;
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

async function verifyRequired(staging) {
  const required = [
    "README.md",
    "使用说明.md",
    "启动任务服务.bat",
    "LOAD-EXTENSION.txt",
    "extension/manifest.json",
    "extension/index.html",
    "extension/icons/icon128.png",
    "apps/extension/dist/manifest.json",
    "apps/extension/dist/index.html",
    "services/task-api/pyproject.toml",
    "services/task-api/taskapi/main.py",
    "services/task-api/.env.example",
    "scripts/start-task-service.ps1",
    "docs/acceptance/end-to-end-acceptance.md",
  ];
  const missing = required.filter((item) => !existsSync(path.join(staging, item)));
  if (missing.length) throw new Error("release is missing required files:\n" + missing.join("\n"));
  return required;
}

const workDir = await mkdtemp(path.join(os.tmpdir(), "bta-release-"));
const staging = path.join(workDir, packageName);
try {
  if (!existsSync(path.join(root, "apps", "extension", "dist", "manifest.json"))) {
    throw new Error("extension is not built: run `npm --prefix apps/extension run build` first");
  }
  await mkdir(staging, { recursive: true });
  for (const entry of ["README.md", "使用说明.md", "启动任务服务.bat", ".gitignore", "apps", "services", "scripts", "docs"]) {
    const source = path.join(root, entry);
    if (!existsSync(source)) continue;
    await cp(source, path.join(staging, entry), { recursive: true, filter: shouldCopy });
  }
  // Chrome's "Load unpacked" needs a folder whose ROOT contains manifest.json. Expose a
  // ready-to-load copy at the package root so users do not have to dig into apps/extension/dist.
  await cp(path.join(root, "apps", "extension", "dist"), path.join(staging, "extension"), {
    recursive: true,
    filter: shouldCopy,
  });
  await writeFile(
    path.join(staging, "LOAD-EXTENSION.txt"),
    [
      "B站文字稿助手 · 加载扩展",
      "",
      "1. Chrome 打开 chrome://extensions（Edge 为 edge://extensions）",
      "2. 打开右上角“开发者模式”",
      "3. 点击“加载已解压的扩展程序”",
      "4. 选择【本文件所在目录】下的 extension 文件夹（其根目录包含 manifest.json）",
      "",
      "注意：不要选择本文件所在目录本身，也不要选择 apps/extension/dist（那是开发树路径，",
      "发布包里请用 extension 文件夹）。",
      "",
    ].join("\n"),
    "utf8",
  );
  // The extension dist source maps are huge and not needed at runtime.
  const requiredFiles = await verifyRequired(staging);

  const python = path.join(root, "services", "task-api", ".venv", "Scripts", "python.exe");
  const pythonVersion = await new Promise((resolve) => {
    if (!existsSync(python)) return resolve("unknown");
    spawn(python, ["--version"], { stdio: ["ignore", "pipe", "ignore"] })
      .stdout.on("data", (data) => resolve(data.toString().trim()))
      .on("error", () => resolve("unknown"));
  });
  const buildInfo = {
    name: packageName,
    version,
    builtAt: stamp.toISOString(),
    node: process.version,
    python: pythonVersion,
    includes: ["extension/ (ready-to-load unpacked extension)", "extension source + dist", "task-api source/tests/config example", "scripts", "docs", "README"],
    excludes: [".env/secrets", ".venv", "node_modules", "data", "caches", "source maps"],
    checks: requiredFiles,
  };
  await writeFile(path.join(staging, "BUILD_INFO.json"), JSON.stringify(buildInfo, null, 2), "utf8");

  const stats = await dirStats(staging);
  await mkdir(releaseDir, { recursive: true });
  const zipPath = path.join(releaseDir, zipName);
  await run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Compress-Archive -Path '${staging}' -DestinationPath '${zipPath}' -Force`,
  ]);

  const zipBytes = await readFile(zipPath);
  const sha256 = createHash("sha256").update(zipBytes).digest("hex");
  await writeFile(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`, "utf8");
  const zipStat = await stat(zipPath);

  console.log(JSON.stringify({
    zip: zipPath,
    bytes: zipStat.size,
    sha256,
    files: stats.files,
    uncompressedBytes: stats.bytes,
    buildInfo,
  }, null, 2));
} finally {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
}
