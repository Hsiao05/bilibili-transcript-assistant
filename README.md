# B站文字稿助手

在 Chrome / Edge 侧栏里，把当前 B 站视频（含分 P）的字幕或音频变成**可校对、可引用、可导出**的 Markdown 文字稿，并生成带时间点的总结。

产品与技术设计见交接文稿《B站文字稿助手-产品与技术交接文稿》；本仓库是它的实现。

> **第一次使用、不熟悉电脑操作？** 直接看 [使用说明.md](使用说明.md)：从安装 Python、双击启动服务到加载扩展、填 Token，按步骤点就行。

## 功能

- **字幕提取**：读取当前视频/分 P 的 B 站字幕轨（人工优先，AI 轨其次），保存原始稿。
- **音频转写**：无字幕时下载独立音轨，分块上传任务服务，由 faster-whisper（本机）或云 ASR 转写。
- **文本整理**：规则清洗 + 术语发现/统一 + 逐块模型清洗 + 全局一致性检查，所有修改留补丁记录。
- **人工修订**：待确认项可逐条接受/保留/批量应用，生成独立修订版本。
- **总结**：概览、核心观点、章节要点、结论、材料覆盖，事实要点可回链到原始片段。
- **导出**：整洁稿 / 原始稿 / 含总结的完整包，UTF-8 Markdown，带时间链接。
- **本机优先**：任务服务默认只监听 `127.0.0.1`，音频和文本留在本机；密钥只存在服务端。

## 架构

```text
Chrome/Edge 扩展（apps/extension）          任务服务（services/task-api）
  ├─ 侧栏 UI（React + Tailwind）               ├─ FastAPI /v1 协议
  ├─ background service worker                ├─ SQLite 持久化队列
  │   ├─ B站适配器（view/player/playurl/WBI）  ├─ worker 进程（租约 + 心跳 + 恢复）
  │   ├─ 内容脚本消息 / 侧栏联动               ├─ 媒体探测/转码（ffprobe/FFmpeg）
  │   └─ DNR：给扩展请求补 Referer             ├─ ASR：faster-whisper / OpenAI 兼容云 ASR
  └─ IndexedDB 本地原始稿 / 上传检查点          └─ LLM：DeepSeek 等 OpenAI 兼容接口
```

长任务（转写/清洗/总结）在服务端 worker 执行，关闭侧栏不影响；扩展只负责浏览、上传、展示和编辑。

## 目录

```text
apps/extension/          # MV3 扩展（React + Vite + Tailwind）
  src/background/        # service worker：B站接口、消息路由、DNR
  src/content/           # 视频页内容脚本
  src/sidepanel/         # 侧栏 UI 与状态机
  src/bilibili/          # B站适配器（WBI 签名、字幕、音轨）
  src/lib/               # 服务 API、音频上传、IndexedDB、设置
services/task-api/       # FastAPI 任务服务 + worker
  taskapi/               # main / runner / store / providers / pipeline
scripts/                 # 验收与冒烟脚本（见下）
docs/acceptance/         # 验收记录与机器可读报告
```

## 快速开始

### 0. 前置条件

- Node.js ≥ 20（开发用 24）、pnpm/npm
- Python ≥ 3.11（仓库内已带 `.venv`，可直接用；也可按下面重建）
- Chrome / Edge ≥ 116（MV3 + Side Panel）
- FFmpeg / ffprobe 在 `PATH`（音频转码需要；纯字幕流程可不装）
- 可选：`faster-whisper`（本机转写）或云 ASR / LLM API Key

### 1. 启动任务服务

```powershell
cd services/task-api

# 可选：复制配置模板后按需修改（LLM/ASR/端口/数据目录）
Copy-Item .env.example .env

# 已有 .venv：
.\.venv\Scripts\python.exe -m taskapi.serve     # 终端 1：API
.\.venv\Scripts\python.exe -m taskapi.worker    # 终端 2：worker

# 或者一条命令同时起两个进程：
cd ../..
powershell -ExecutionPolicy Bypass -File scripts\start-task-service.ps1
```

启动横幅会打印数据目录、监听地址和**配对 token**（也保存在 `<数据目录>/token.txt`）。不要把它贴到公开地方。

需要重建环境时（推荐 uv，也可用 pip）：

```powershell
cd services/task-api
uv venv .venv
uv pip install --python .\.venv\Scripts\python.exe -e ".[dev]"
# 需要本机转写再加：uv pip install --python .\.venv\Scripts\python.exe -e ".[asr]"
```

### 2. 构建并加载扩展

```powershell
cd apps/extension
npm install
npm run build          # 产物在 apps/extension/dist
```

打开 `chrome://extensions`（Edge 为 `edge://extensions`）→ 打开“开发者模式”→ “加载已解压的扩展程序”→ 选择 `apps/extension/dist`。

> **使用发布包（release zip）时**：解压后进入 `bili-transcript-assistant` 文件夹，加载其中的 **`extension`** 文件夹（该文件夹根目录有 `manifest.json`）。包根目录的 `LOAD-EXTENSION.txt` 写了同样的步骤；不要直接选包根目录。

> Chrome 137+ 已忽略命令行的 `--load-extension`，必须用上面的手动加载方式；自动化验收因此使用 Edge。

### 3. 配对与使用

1. 打开 B 站视频页，点击扩展图标打开侧栏。
2. 右上角“设置”：任务服务地址填 `http://127.0.0.1:8765`，粘贴启动横幅里的 token，点“测试连接”。
3. 有字幕的视频：选字幕轨 → “提取文字稿” → 自动创建文稿并清洗 → 在“文字稿/总结/修订/任务”页签查看。
4. 无字幕的视频：选“转写音频” → 确认上传大小与处理地址 → 上传后由服务端转写并清洗。
5. “导出”可下载当前版本、原始稿或含总结的完整 Markdown。

字幕轨需要登录 B 站才能枚举（接口返回 `need_login_subtitle=true` 时匿名态为空）；没有登录或没有字幕时走音频转写。

## 配置

全部环境变量与默认值见 [`services/task-api/.env.example`](services/task-api/.env.example)，核心几项：

| 变量 | 作用 | 默认 |
|---|---|---|
| `TASKAPI_HOST` / `TASKAPI_PORT` | 监听地址/端口 | `127.0.0.1:8765` |
| `TASKAPI_DATA_DIR` | SQLite、上传、媒体、token.txt 的目录 | `./data` |
| `TASKAPI_TOKEN` | 固定访问令牌（不填则首次生成） | 自动生成 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | **单独的文本模型 API**（OpenAI 兼容，默认官方 DeepSeek；百炼只做 ASR） | 未配置=离线规则模式 |
| `LLM_USE_BAILIAN` | 开发便利：无独立 LLM Key 时复用百炼 Key 走百炼兼容模式（默认关） | `0` |
| `LLM_DISABLED` | 设为 `1` 强制离线规则模式（即使有 Key） | `0` |
| `ASR_PROVIDER` / `ASR_BASE_URL` / `ASR_API_KEY` / `ASR_MODEL` | OpenAI 兼容云 ASR（如硅基流动） | 未配置 |
| `DASHSCOPE_API_KEY` / `DASHSCOPE_ASR_MODEL` | 阿里云百炼 Filetrans（异步、句子级时间戳） | 未配置 / `qwen-audio-3.1-asr-flash-filetrans` |
| `DASHSCOPE_BASE_URL` | 百炼 API 地址（工作空间专属 MaaS 域名时修改） | `https://dashscope.aliyuncs.com` |
| `TASKAPI_ASR_DISABLED` | 设为 `1` 可整体关闭音频转写（转写任务返回 `NEEDS_INPUT`） | `0` |
| `WHISPER_MODEL` / `WHISPER_DEVICE` | 本机 faster-whisper | `small` / `auto` |

不配置 LLM 时服务仍可用：清洗退化为确定性规则，总结退化为提取式摘要（会明确标注 `local-heuristic` / `extractive-v1`）。不配置任何 ASR 时，音频转写任务会以 `NEEDS_INPUT + asr_not_configured` 结束，并在侧栏提示。

LLM 配置（与百炼 ASR 分离）：

- 文本清洗/总结使用**单独的** OpenAI 兼容文本模型 API：配置 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（默认官方 DeepSeek `https://api.deepseek.com` + `deepseek-chat`）。阿里云百炼 Key 默认**只用于 ASR**。
- 未配置 `LLM_API_KEY` 时清洗退化为确定性规则、总结退化为提取式摘要（标注 `local-heuristic` / `extractive-v1`）。
- 开发便利：设置 `LLM_USE_BAILIAN=1` 可复用百炼 Key 走百炼兼容模式（默认模型 `deepseek-v4.1-flash`，默认关闭推理）。注意百炼账号没有 `deepseek-chat`（404）。
- 需要更强推理时设 `LLM_ENABLE_THINKING=1` 并调大 `LLM_MAX_TOKENS`（默认 8192，推理建议 12288+）；`LLM_DISABLED=1` 强制离线规则模式。

云转写说明（推荐阿里云百炼 Filetrans）：

- 配置 `DASHSCOPE_API_KEY` 后把 `ASR_PROVIDER` 设为 `dashscope-filetrans`（或在扩展设置里选“阿里云百炼 Filetrans”）。
- 音频会先上传到百炼**免费临时存储**（48 小时有效、单文件 ≤1GB），无需自备 OSS；单文件转写上限 2GB / 12 小时，异步任务返回**句子级时间戳**（可开字级）。
- 价格约 0.00022 元/秒（≈0.79 元/小时）；模型名以百炼控制台实际开通的为准，可通过 `DASHSCOPE_ASR_MODEL` 修改。默认 `qwen-audio-3.1-asr-flash-filetrans`；实测它支持临时上传并返回句子级时间戳。`qwen3-asr-flash-filetrans` 目前只接受公网 HTTP(S) 音频 URL（不接受临时上传的 `oss://`），本项目的免 OSS 模式暂不支持它；`paraformer-v2` 也可用但通常只返回整段一个句子。
- 临时存储官方标注**不建议用于生产/高并发**；高流量部署请改用阿里云 OSS 托管音频。

本机转写说明：

- 安装：`uv pip install --python .\.venv\Scripts\python.exe -e ".[asr]"`（已把 PyAV 固定在 `>=13,<14`，PyAV 19 与 faster-whisper 1.2.x 不兼容）。
- 首次转写会自动下载模型（`tiny`≈75MB，`small`≈460MB）；`tiny` 只建议用于冒烟/验收，正式使用推荐 `small` 或更大。
- 验收脚本 `node scripts/asr-check.mjs` 会用 Windows 自带中文语音合成一段测试音频，跑真实 faster-whisper 转写；设置 `DASHSCOPE_API_KEY` 时会额外跑一次**真实百炼 Filetrans** 验收，并始终用本地 mock 验证 OpenAI 兼容云 ASR 适配器。

## 验收与测试

| 命令（仓库根目录） | 覆盖 |
|---|---|
| `node scripts/bilibili-adapter-check.mjs` | B站适配器真实接口：view/分 P/WBI/字幕归一化/音轨/域名白名单 |
| `node scripts/extension-smoke.mjs` | 真实 Edge 加载扩展：侧栏渲染、identity、内容脚本、站内跳转、字幕/音轨、DNR |
| `cd services/task-api; .\.venv\Scripts\python.exe -m pytest` | 服务端单元 + API 集成测试（28 个） |
| `node scripts/taskapi-e2e.mjs` | 服务级端到端：建文稿→清洗→总结→导出→修订→上传/错误路径（含 mock LLM） |
| `node scripts/extension-e2e.mjs` | 浏览器级端到端：真实扩展 + 真实服务 → 加载文稿 → 总结 → 导出 |
| `node scripts/extension-login-acceptance.mjs` | 登录态端到端：真实字幕轨→提取→清洗→总结→导出（首次需在弹出的专用 Edge 窗口扫码登录一次） |
| `node scripts/asr-check.mjs` | 音频链路：本机 faster-whisper 真实转写 + 云 ASR 适配器（mock）；设置 `DASHSCOPE_API_KEY` 时含真实百炼 Filetrans |
| `node scripts/llm-quality-check.mjs` | 真实 LLM 质量：清洗/总结在真实字幕上的覆盖、时间戳、补丁、术语、引用与人工复核样本 |

说明：

- `extension-smoke.mjs` 会优先用 Edge（Chrome 137+ 命令行加载失效），自动选择空闲调试端口并清理 `bta-smoke-*` 残留进程；设置 `BTA_SUBTITLE_URL` 可额外验证真实字幕正文解析。
- `extension-e2e.mjs` 会自建临时数据目录和 token 启动服务，不会污染 `services/task-api/data`。
- `extension-login-acceptance.mjs` 使用持久测试 profile `%LOCALAPPDATA%\bta-login-profile`：首次运行会打开 Edge 等你扫码登录 B 站（最多 15 分钟），登录后自动完成字幕轨发现、提取、清洗、总结与导出；之后复用登录态。
- 最近的验收结果与证据在 [`docs/acceptance/`](docs/acceptance/)：[阶段 A 浏览器链路](docs/acceptance/browser-chain-acceptance.md)、[完整链路（任务服务 + ASR + 浏览器端到端）](docs/acceptance/end-to-end-acceptance.md)。

## 常见问题

| 现象 | 处理 |
|---|---|
| 设置页“连接失败 / 401” | token 与服务端 `token.txt`（或 `--print-token`）不一致；地址端口是否一致 |
| 侧栏提示“任务服务未连接” | 服务未启动，或设置里地址/token 未保存；先点“测试连接” |
| 字幕轨为空 | 未登录 B 站，或该视频确实没有字幕；登录后重试或走音频转写 |
| 音频转写 `NEEDS_INPUT` | 未安装 faster-whisper 且未配置云 ASR；见 `.env.example`（或检查是否误设 `TASKAPI_ASR_DISABLED=1`） |
| faster-whisper 安装后报 `av.open() ... metadata_errors` | PyAV 版本过新；按 `.[asr]` 重新安装（已固定 `av>=13,<14`），或 `uv pip install "av==13.1.0"` |
| 首次转写卡在下载模型 | 需要访问 HuggingFace；可先单独运行一次 `scripts/asr-check.mjs` 预热模型缓存，或改用云 ASR |
| 上传/转码失败 | 检查 FFmpeg 是否在 `PATH`；音频大小/时长是否超上限 |
| 模型输出为空/截断 | 调大 `max_tokens` 或减小清洗块；查看“任务”页错误码 |
| Chrome 无法命令行加载扩展 | 官方策略限制，改为手动“加载已解压的扩展程序”，或用 Edge |

安全与隐私：任务服务保存音频/文本与模型密钥；默认只绑定回环地址；扩展只保存服务地址与令牌。`.env`、`data/`、`token.txt` 不要提交或分享。

## 发布打包

```powershell
node scripts/package-release.mjs
# 输出：release/bili-transcript-assistant-<version>-<日期>.zip 与同名 .sha256
```

包内含：`extension/`（**可直接加载的已构建扩展，根目录含 manifest.json**）+ 扩展源码/`dist/`、任务服务源码/测试/`.env.example`、全部脚本、文档与验收记录、`BUILD_INFO.json`、`LOAD-EXTENSION.txt`、`使用说明.md`、`启动任务服务.bat`。不包含：`.env`/密钥、`.venv`、`node_modules`、本地 `data/`、缓存与 source map。

## 开发

```powershell
# 扩展
cd apps/extension
npm run typecheck
npm run build

# 服务端
cd services/task-api
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\ruff.exe check taskapi tests
```
