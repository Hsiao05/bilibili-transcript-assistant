# 完整链路验收记录（运行化 + 阶段 B/C/D）

- 日期：2026-11-05
- 版本：**0.2.0**
- 范围：任务服务可用性、真实扩展 ↔ 真实服务端到端、本机 ASR、OpenAI 兼容云 ASR、**阿里云百炼 Filetrans 真实云转写**、登录态真实字幕链路、**真实 DeepSeek 清洗/总结质量**、**0.2.0 手动清洗 / 视频内时间戳跳转 / AI 修改建议三选一**
- 结论：**8 组自动化检查全部通过**（35 + 10 + 18 + 9 + 15 + 13 + 10 + 14 项），本轮共修复 12 个真实缺陷；产品已可按 README 启动并完成"字幕/音频 → 原始稿 → 手动清洗 → 总结 → 修订 → 导出"全流程（含真实登录态字幕、真实百炼云转写与真实 DeepSeek 清洗/总结）。

## 1. 验收结果总览

| 层级 | 命令 | 结果 | 证据 |
|---|---|---|---|
| 服务端单元/集成 | `cd services/task-api; .\.venv\Scripts\python.exe -m pytest` | **35 passed** | pytest 输出 |
| B站适配器（Node） | `node scripts/bilibili-adapter-check.mjs` | **10/10**（含真实字幕正文） | [adapter-check.json](./adapter-check.json) |
| 服务级 E2E | `node scripts/taskapi-e2e.mjs` | **18/18**（11.4s，含手动修改） | [taskapi-e2e.log](./taskapi-e2e.log) |
| 音频/ASR 链路 | `node scripts/asr-check.mjs` | **9/9**（14.6s；含真实百炼） | [asr-check-2026-11-05T05-19-57.json](./asr-check-2026-11-05T05-19-57.json) |
| 真实扩展冒烟 | `node scripts/extension-smoke.mjs` | **15/15**（13.6s；含真实字幕正文） | [extension-smoke-2026-11-05T11-29-58.json](./extension-smoke-2026-11-05T11-29-58.json) |
| 浏览器端到端 | `node scripts/extension-e2e.mjs` | **13/13**（含时间戳跳转） | [extension-e2e-2026-11-05T11-23-49.json](./extension-e2e-2026-11-05T11-23-49.json) |
| 登录态端到端 | `node scripts/extension-login-acceptance.mjs` | **10/10**（含手动清洗） | [login-e2e-2026-11-05T11-11-41.json](./login-e2e-2026-11-05T11-11-41.json) |
| **真实 LLM 清洗/总结质量** | `node scripts/llm-quality-check.mjs` | **14/14**（AI 建议 + 标点/分段） | [llm-quality-2026-11-05T11-20-47.json](./llm-quality-2026-11-05T11-20-47.json) |

环境：Windows 11、Node 24.19、Python 3.12.6、Edge 156.0.4314.58、FFmpeg/ffprobe 已安装、faster-whisper 1.2.1（本机）+ PyAV 13.1.0、阿里云百炼 `qwen-audio-3.1-asr-flash-filetrans`（真实 Key，仅 ASR）、独立官方 DeepSeek `deepseek-chat`（真实 Key，仅文本处理）。

## 2. 覆盖的端到端路径

服务级 E2E（真实进程：uvicorn API + worker + SQLite）：

1. `.env` 文件生效且进程环境优先；启动横幅打印数据目录/地址/token/LLM/ASR/FFmpeg，且不泄漏任何 API Key。
2. 令牌鉴权：`/health` 公开；无 token / 错误 token → 401；正确 token → capabilities。
3. 文稿：用 30 段字幕 fixture 创建文稿并可按 `bvid+cid+page` 找回。
4. 清洗（HeuristicLLM 规则路径）：幂等键、SUCCEEDED、块/时间戳单调、片段归属、`appliedEdits` 可回指父版本 block 且能精确匹配原文。
5. 总结（提取式）：overview、章节引用真实 `segmentIds`、markdown 时间链接。
6. 导出：Markdown（文件名头、章节链接、时间戳开关）+ JSON（document/revision/summary/terms）。
7. 人工修订：`POST /v1/documents/{id}/revisions` 生成 edited 最新版本；`corrections/apply` 支持 `acceptedIds` / `keptIds` / **`manualEdits`（手动修改文本）**，Word 词表 PUT/GET。
8. 上传：分块 + `X-Chunk-SHA256` 校验、错误 SHA/totalBytes 拒绝、重放幂等；无 ASR 时 transcribe → `NEEDS_INPUT + asr_not_configured`。
9. Mock LLM 阶段：真实 OpenAI 兼容客户端走术语发现/逐块清洗/一致性检查/**修改建议生成**/总结，验证 corrections 均带 replacement 与补丁契约。

浏览器 E2E（真实 Edge + 真实扩展 + 真实服务）：

1. 扩展加载、设置写入 `chrome.storage`。
2. 侧栏识别当前 B 站分 P，并从服务端加载预置文稿（整理稿版本可见、无"未连接"）。
3. **点击文字稿时间戳 → 内容脚本把当前 B 站 `<video>` 跳到对应秒数**，不开新标签页；断言 `video.currentTime` 与目标相差 <2.5s。
4. 点击"总结视频"→ 服务端 summarize job → 侧栏渲染总结（内容概览/核心观点/章节要点/结论）。
5. 设置页显示"已连接"与服务端版本。
6. 点击导出 → 浏览器下载 Markdown，内容含标题、来源、时间戳；文件名为服务端生成的 `原标题-P02-整理稿.md`。
7. 真实侧栏无 console 错误；clean + summarize 任务在服务端均为 SUCCEEDED。
8. 截图：[文字稿](../screenshots/sidepanel-e2e-transcript.png)、[总结](../screenshots/sidepanel-e2e-summary.png)、[设置](../screenshots/sidepanel-e2e-settings.png)。

音频/ASR 链路：

1. Windows SAPI 合成中文语音（约 10s WAV）。
2. 本机 faster-whisper（tiny，CPU）真实转写 → 上传分块 → transcribe job → 生成 `asr_local` 文稿（0.2.0 起 `autoClean=false`，只产出原始转写，需手动点击清洗）；导出的 Markdown 含来源标识。识别结果示例：`大家好,這里是文字稿助手的語音識別測試 我們今天驗證音頻上床和專寫的完整流程`（tiny 模型质量有限，仅用于链路验收；默认使用 `small`）。
3. 云 ASR 适配器：本地 mock 的 OpenAI 兼容 `/audio/transcriptions`，验证请求构造、`verbose_json` 解析、`asr_cloud` 文稿与原始转写。
4. **阿里云百炼 Filetrans（真实 API）**：先向百炼申请临时上传凭证并上传 10s WAV（`oss://` URL，48h 有效），再提交异步转写（`qwen-audio-3.1-asr-flash-filetrans`）、轮询任务、下载结果 JSON，得到 **2 个句级时间戳片段**：
   - `大家好，这里是文字稿助手的语音识别测试。` 00:00.200–00:04.320
   - `我们今天验证音频上传和转写的完整流程。` 00:05.200–00:09.320
   - 任务 SUCCEEDED，source=`asr_cloud`，2 个 block，转写耗时约 5.3s；导出的 Markdown 含来源标识。
   - 临时上传无需用户自备 OSS；`qwen3-asr-flash-filetrans` 实测不接受 `oss://`（返回 `A valid file URL is required`），因此默认模型选 `qwen-audio-3.1-asr-flash-filetrans`。

## 2.1 登录态验收（需要人工扫码一次）

匿名态无法枚举字幕轨（B 站接口 `need_login_subtitle=true`），因此新增 `scripts/extension-login-acceptance.mjs`：它使用持久测试 profile `%LOCALAPPDATA%\bta-login-profile` 打开专用 Edge 窗口等待扫码登录一次，随后自动验证：

真实登录 → 扩展发现字幕轨 → 点击"提取文字稿"（只保存原始稿，**不自动清洗**）→ 点击"清洗文字稿"（真实清洗任务）→ 侧栏渲染整理稿 → 点击"总结视频" → 渲染总结 → 导出 Markdown（文件名/内容校验）。

**结果：10/10 通过**（测试视频 `BV1REx46NEc4`）：

- 登录态字幕轨：扩展拿到 **8 条 AI 轨**（ai-zh/en/ja/es/ar/pt/th/id），中文轨优先。
- 点击"提取文字稿"：真实字幕正文 **1503 段** → 文稿 `doc_6686…`（source=`bilibili_ai_subtitle`），校验确认**未自动生成 cleaned 版本**。
- 点击"清洗文字稿"：真实清洗任务产出 **78 个 block** 的整理稿并渲染到侧栏。
- 点击"总结视频"：生成 **9 个章节**的提取式总结并渲染。
- 导出：`【全网最全】DeepSeek Harness超详细教程！…-P01-整理稿.md`，**75,724 字节**，含真实转写文本。
- 控制台仅有提取前 `GET /v1/documents?...` 的 404（设计内的"尚无文稿"探测），已作为预期项记录，无产品错误。
- 专用 profile（`%LOCALAPPDATA%\bta-login-profile`）已保存登录态，后续运行无需再次扫码。

截图：[提取前（本地原始稿与字幕来源）](../screenshots/login-e2e-tracks.png)、[整理稿](../screenshots/login-e2e-transcript.png)、[总结](../screenshots/login-e2e-summary.png)。

## 2.2 真实 LLM 清洗/总结质量（独立 DeepSeek API）

> 配置约定：**阿里云百炼只负责 ASR**；清洗/总结使用单独的文本模型 API（`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`）。
> 本节验收使用官方 DeepSeek `https://api.deepseek.com` + `deepseek-chat`（独立 Key），即生产配置。

- 样本：真实 B 站 AI 字幕前 400 段（约 13 分钟、4,508 字）。
- 清洗：**25 个 block、241 条补丁、93 条待确认（全部带 AI 建议）、11 个术语**；4 次 LLM 调用，28,090 prompt + 9,612 completion tokens，推理 token 0，耗时 39.1s。
- 质量自动检查全过：400/400 源片段覆盖、时间戳单调、补丁精确匹配父版本、数字全保留、否定词 39/40（97.5%）。
- **标点/分段**：25/25 段以句末标点结束，**0 处重复标点**（`，，`/`。。`/`，。`）；由提示词 + 规则兜底双重保证。
- **待核对建议**：93/93 条 pending correction 都有非空 `replacement`；模型两次仍给不出可执行建议的极少数项会被跳过并记录 note，不再出现"仅标记待核对"。
- 术语纠错有效：源字幕中 `DeepSeek`/`Harness` 正确写法出现 0 次，整理后为 **37/31 次**；术语表合并了 36 种 ASR 误写（`DPC honeys`、`deep sick哈尼斯`、`DEPSICK`…）。
- 总结：6 章节 + 8 观点 + 4 关键数字 + 结论，**112 个引用全部指向真实片段**，耗时 18.6s。
- 人工复核样本（edits / corrections / terms / summary / doubledBlocks）见报告 `samples` 字段。

**参考：开发期用百炼托管 DeepSeek 的对比（同一任务）**

| 配置 | 清洗耗时 | 截断/回退 | 真实模型补丁 | 推理 token | 总耗时 |
|---|---|---|---|---|---|
| 官方 DeepSeek `deepseek-chat`（生产，非推理） | 39.1s | 0 | 241 | 0 | **57.7s** |
| 百炼 `deepseek-v4.1-flash`，关闭推理（开发替代） | 55.5s | 0 | 187 | 0 | 81.4s |
| 百炼 `deepseek-v4.1-flash`，开启推理（max_tokens 4096） | 482s | 4 次调用全截断 | 0（仅规则清洗） | 约占输出 86% | 516s |

结论：生产用非推理 `deepseek-chat` 更快、更稳、更便宜；JSON 结构化清洗/总结不需要推理模式。

## 2.3 0.2.0 体验改动验收

- **手动清洗**：提取文字稿只保存原始稿，不再自动清洗；登录态 E2E 断言提取后无 cleaned 版本，点击"清洗文字稿"后才出现整理稿（10/10）。音频转写同样改为 `autoClean=false`。
- **标点/分段**：清洗提示词要求补全中文标点、句末标点、按语义分段；`normalize_punctuation()` 兜底修复半角标点、重复标点、`，。`、尾逗号等；质量脚本断言 25/25 段句末标点、0 处重复标点。
- **视频内跳转**：文字稿/总结/修订的时间戳改为侧栏内按钮，点击通过内容脚本设置当前 B 站 `<video>.currentTime`，不再开新标签页；浏览器 E2E 实测跳转误差 <2.5s（13/13）。
- **AI 修改建议三选一**：每条待核对项都带非空 AI 建议；修订页提供"保留原文 / 接受 AI 建议 / 手动修改（可编辑后保存）"。服务级 E2E 新增 `manualEdits` 契约检查（18/18），质量脚本断言 93/93 条建议非空（14/14）。

## 3. 本轮修复的缺陷

| # | 问题 | 影响 | 修复 |
|---|---|---|---|
| 1 | 服务端 CORS 未暴露 `X-Export-Filename` | 扩展拿不到服务端文件名，导出总是 `文字稿.md` | `CORSMiddleware(expose_headers=["X-Export-Filename","Content-Disposition"])`；浏览器 E2E 断言文件名含 `P02`+`整理稿` |
| 2 | 云 ASR 适配器用 `data=[(k,v),...]` 调用 httpx | httpx 0.28 会把列表当字节流处理，请求体损坏并抛 `sequence item 1: expected a bytes-like object, tuple found`，**云 ASR 实际不可用** | 改为 dict 传表单字段；新增 `tests/test_asr.py` 回归测试 |
| 3 | faster-whisper 1.2.1 与 PyAV 19 不兼容 | 首次真实转写直接 `av.open() got an unexpected keyword argument 'metadata_errors'` | `pyproject.toml` 的 `[asr]` 固定 `av>=13,<14`；本机装 13.1.0 验证通过 |
| 4 | 测试依赖"未安装 faster-whisper"的环境 | 装上 ASR 后 3 个离线断言 + 服务 E2E 的 NEEDS_INPUT 阶段失效 | 新增 `TASKAPI_ASR_DISABLED` 运维开关；`conftest` 固定 `asr_disabled=True`；`taskapi-e2e` 在离线阶段固定该开关、在云 ASR 阶段显式 `ASR_PROVIDER=openai-compatible` |
| 5 | （服务端）`appliedEdits.blockId` 指向 segment 且 offset 为旧坐标；一致性建议 `suggestion=null` 时丢失 consistency 分类 | 修订补丁无法精确回指父版本/回滚；前端分组错误 | 由服务端 E2E 阶段修复：runner 传入父版本 block 信息，流水线用 base→final diff 生成 block 级补丁；仅显式 `type=note` 才归 note（详见 [taskapi-e2e.log](./taskapi-e2e.log) 与 `tests/test_api.py`） |
| 6 | 扩展固定传 `asrProvider: "auto"`，覆盖了服务端 `ASR_PROVIDER` | 配置了云 ASR 也无法被服务端配置选中 | `select_asr` 将 `auto/default` 视为“未指定”；扩展设置页新增“语音识别服务”选择（自动 / 本机 / 百炼 Filetrans / OpenAI 兼容） |
| 7 | 缺少阿里云百炼适配器；`qwen3-asr-flash-filetrans` 不接受临时上传的 `oss://` URL | 用户只有百炼 API 时无法使用云转写；Qwen3 报 `A valid file URL is required` | 新增 `dashscope-filetrans` provider：临时上传（48h/≤1GB）→ 异步提交 → 轮询 → 下载 JSON → 句级时间戳映射；默认 `qwen-audio-3.1-asr-flash-filetrans`，Qwen3 模型给出可操作错误提示；新增 2 个单测与真实 API 验收阶段 |
| 8 | 百炼托管 DeepSeek 默认开推理，推理 token 占满 `max_tokens`，清洗 JSON 全部截断并回退规则清洗；且百炼 Key 不应默认当作 LLM | 真实 LLM 清洗极慢且不生效；ASR 与 LLM 配置耦合 | **ASR/LLM 分离**：百炼仅用于 ASR，LLM 只认 `LLM_API_KEY`；百炼复用改为显式 `LLM_USE_BAILIAN=1`。新增 `LLM_ENABLE_THINKING`（百炼默认关闭）与 `LLM_MAX_TOKENS`（默认 8192）；新增 `tests/test_llm.py` 与 `scripts/llm-quality-check.mjs` |
| 9 | 提取文字稿后自动开始清洗，用户无法先检查原始标点/分段 | 长视频一提取就消耗模型调用，且失败后难回退 | 提取只保存原始稿；新增"清洗文字稿 / 重新清洗"按钮与 `startClean` 状态机；音频任务 `autoClean` 改为 false；总结前要求先清洗 |
| 10 | 时间戳是外链，点击会打开新标签页并跳到 B 站分享链接 | 阅读/校对时频繁切页，打断当前视频 | 新增内容脚本 `player:seek` 消息；文字稿/总结/修订统一用 `TimeLink` 按钮，设置当前页 `<video>.currentTime`；E2E 断言跳转成功 |
| 11 | 一致性/术语待核对项常只有"仅标记待核对"，`replacement=null` | 用户只能自己找错、自己改，无法一键处理 | 提示词要求每条 issue 给非空 suggestion；新增 `_fill_missing_suggestions` 二次请求；两次仍无法生成建议的条目跳过并记录 note，UI 保证每条都有"接受 AI 建议/手动修改" |
| 12 | 模型输出标点不稳定：`，，`、`。。`、`，。`、半角标点、段落以逗号结尾 | 整理稿可读性差，导出不专业 | 新增 `normalize_punctuation()`：统一全角标点、折叠重复标点、尾逗号改句号、保证每段句末标点；清洗提示词同步要求；质量脚本新增标点/分段断言 |

## 4. 运行化交付

- 根目录 [README.md](../../README.md)：架构、快速开始（服务 + 扩展 + 配对）、配置表、验收命令、FAQ、安全说明。
- [services/task-api/.env.example](../../services/task-api/.env.example)：全部环境变量与默认值。
- [scripts/start-task-service.ps1](../../scripts/start-task-service.ps1)：一键启动 API + worker（Ctrl+C 一起退出；UTF-8 BOM，兼容 Windows PowerShell 5.1）。
- `serve.py` / `worker.py` 启动横幅：数据目录、令牌文件、配对提示、LLM/ASR/FFmpeg 状态；`--print-token` 可单独打印令牌。
- 新增验收脚本：`scripts/extension-e2e.mjs`、`scripts/extension-login-acceptance.mjs`、`scripts/asr-check.mjs`；`scripts/lib/browser.mjs` 抽取共享浏览器/CDP 工具，`extension-smoke.mjs` 已复用。
- 新增 ASR provider：`dashscope-filetrans`（阿里云百炼 Filetrans，临时上传 + 异步任务 + 句级时间戳）；扩展设置页增加语音识别服务选择。
- **发布打包**：`scripts/package-release.mjs` 生成 `release/bili-transcript-assistant-<version>-<日期>.zip` 与同名 `.sha256`。包根目录含 **`extension/`（可直接“加载已解压”的扩展，manifest 在根）** 与 `LOAD-EXTENSION.txt`，另含扩展源码/`dist`、服务源码/测试/配置示例、脚本、文档与验收记录、`BUILD_INFO.json`；不含 `.env`/密钥、`.venv`、`node_modules`、本地 data 与 source map。
- `.gitignore`：依赖、构建产物、`.venv`、`data/`、`.env`、token 文件、`release/` 等。

## 5. 已知限制与建议

1. **真实 LLM 质量**：已用**独立官方 DeepSeek `deepseek-chat`** 在真实字幕上验收（§2.2，14/14）；质量抽查为单样本，尚未建立人工标注基准集；百炼托管 DeepSeek 的对比数据仅作开发参考，不是生产配置。
2. **待核对建议的边界**：AI 建议由模型生成，接受前仍建议快速扫一眼；极少数两次都生成不出可执行建议的条目会从待核对列表跳过（note 记录），不会显示"只标记不修改"的空条目。
3. **时间戳跳转依赖内容脚本**：要求当前活动标签页是同一个 B 站视频页；切换标签页或视频页被刷新后点击可能失败并给出提示。
4. **OpenAI 兼容云 ASR 仍仅 mock**：硅基流动等需要 Key 与计费验证；**阿里云百炼 Filetrans 已用真实 API 跑通**（§2 音频/ASR 第 4 条）。
5. **本机 ASR 质量**：验收用 `tiny`；正式使用建议 `small`/`medium`，按机器算力调整 `WHISPER_DEVICE`。
6. **字幕轨发现需要登录 B 站**（`need_login_subtitle`）：匿名态为空；已在专用 Edge profile 中完成真实登录态验收（§2.1）。换机器或删除该 profile 后需再扫码一次。
7. **Chrome 137+ 命令行不能加载扩展**：扩展验收用 Edge；Chrome 需手动"加载已解压的扩展程序"后复验。
8. `TASKAPI_RETENTION_HOURS` 目前只在 capabilities 中暴露，尚无自动清理任务。
9. 验收脚本含 Windows 专用分支（SAPI 合成、`taskkill`、`.venv` 路径）；macOS/Linux 需调整后再跑。

## 6. 复现

```powershell
cd <项目目录>

# 服务端测试
cd services/task-api; .\.venv\Scripts\python.exe -m pytest; cd ../..

# 八组验收（可按需单独运行）
node scripts/bilibili-adapter-check.mjs
node scripts/taskapi-e2e.mjs
node scripts/asr-check.mjs          # services/task-api/.env 里有 DASHSCOPE_API_KEY 时会跑真实百炼
npm --prefix apps/extension run build
node scripts/extension-smoke.mjs
node scripts/extension-e2e.mjs
node scripts/extension-login-acceptance.mjs   # 首次需在弹出的 Edge 窗口扫码登录
node scripts/llm-quality-check.mjs  # 真实 LLM 清洗/总结质量（读取 .env 的 LLM Key）
```

> 带时效的真实字幕 URL 通过 `BTA_SUBTITLE_URL` 传入；不传时对应检查标记为跳过。真实百炼验收读取 `services/task-api/.env` 中的 `DASHSCOPE_API_KEY`，可用 `BTA_DASHSCOPE_MODEL` 覆盖模型名。
