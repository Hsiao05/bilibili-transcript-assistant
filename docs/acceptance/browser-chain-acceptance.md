# 阶段 A 浏览器链路验收记录

> 0.2.0 起：提取文字稿只保存原始稿，清洗需手动点击"清洗文字稿"；时间戳改为视频内跳转；待核对项均带 AI 建议。本文件记录的是 0.1.0 阶段的基线数据，完整最新结果见 [end-to-end-acceptance.md](./end-to-end-acceptance.md)。

- 日期：2026-11-04
- 范围：真实浏览器加载扩展 + B 站接口冒烟（交接文稿 §5、§6、§18 阶段 A）
- 结论：**自动化检查 15/15 通过（1 项按设计跳过）**；过程中发现并修复 4 个真实缺陷；仍有 3 项需要人工在登录态浏览器中复验。

## 1. 环境

| 项目 | 值 |
|---|---|
| 操作系统 | Windows 11 Pro 10.0.22631 |
| Node | v24.19.0 |
| 自动化主引擎 | Edge 156.0.4314.58（`--load-extension` 仍可用） |
| 对照引擎 | Chrome 156.0.8078.80（已忽略 `--load-extension`） |
| 扩展 | MV3，0.1.0，unpacked id `akodendgnfmjmijnhepplkmojdedlnfn` |
| 测试样本 | `BV1XwxU6xEnL`（6 分 P，取 P2 `cid=43307110047`）；`BV1REx46NEc4`（登录态抓取样本，8 条 AI 字幕轨） |

## 2. 检查结果与证据

证据文件：[extension-smoke-2026-11-04T15-23-20.json](./extension-smoke-2026-11-04T15-23-20.json)、[adapter-check.json](./adapter-check.json)、[侧栏截图](../screenshots/sidepanel-demo.png)。

| # | 检查项 | 结果 | 关键证据 |
|---|---|---|---|
| 1 | service worker 注册 | 通过 | `chrome-extension://…/background.js` |
| 2 | manifest 配置 | 通过 | sidePanel/storage/activeTab/scripting/DNR；side_panel=`index.html`；content script 匹配视频页 |
| 3 | `chrome.sidePanel` + DNR 会话规则 | 通过 | 9101–9103 三条 Referer 规则，`excludedInitiatorDomains=["bilibili.com"]` |
| 4 | 侧栏 UI 渲染（demo） | 通过 | 四个页签、正文可渲染、0 条 console 错误、截图已存档 |
| 5 | `identity:current`（当前分 P） | 通过 | 活动标签页解析出 `BV1XwxU6xEnL` / page 1 |
| 6 | 内容脚本 `content:getIdentity` | 通过 | 返回同一 BVID 与分 P |
| 7 | 站内跳转 `p1 → p2` | 通过 | identity 与内容脚本都变为 page 2，`page:changed` 广播到达扩展页 |
| 8 | 正常播放不受 DNR 影响 | 通过 | B 站页自身 CDN 请求 176 条全部 2xx（XHR 16、Fetch 18、Image 38、Font 53、Script 41、CSS 8），未被改写 |
| 9 | `bili:view`（元数据 + 分 P） | 通过 | 6 个分 P，P2 `cid=43307110047`，标题/UP 主正确 |
| 10 | `bili:player` 匿名态 | 通过 | WBI 签名请求成功；`rawTrackCount=0`、`allowSubmit=false` |
| 11 | `bili:player` 重放登录态载荷 | 通过 | 8 条 AI 轨，中文优先，全部 `type=ai`，URL 归一化为 https，`id_str` 精确保留 |
| 12 | `bili:subtitle`（真实字幕正文） | 通过 | 1503 段，`seg_00001` 0–2.88s，`seg_01503` 3039.34–3040.48s |
| 13 | `bili:playurl`（独立音轨） | 通过 | id 30216，129.7 kbps，`audio/mp4`/`mp4a.40.2`，时长 3,822,000 ms |
| 14 | 音频 CDN（service worker） | 通过 | Range 206，总长 61,945,254 字节 |
| 15 | 音频 CDN（扩展页面 / 侧栏路径） | 通过 | Range 206，与后台路径一致 |
| — | Chrome `--load-extension` 策略 | 跳过 | Chrome 156 静默忽略该开关（预期行为，见 F5） |

## 3. 关键发现

### F1 字幕轨发现必须登录（产品影响）

- 匿名请求 `/x/player/wbi/v2` 返回 `code:0`，但 `need_login_subtitle=true`、`subtitles:[]`；同一个接口在登录态返回 `need_login_subtitle=false` 与 8 条 AI 字幕轨（ai-zh/en/ja/es/ar/pt/th/id）。
- 影响：侧栏必须按交接文稿 §5.3 处理“需登录：登录后可能取得字幕”，并保留音频回退；不能把空轨误判为“视频无语音”。
- 自动化冒烟因此改为：匿名验证真实接口路径，登录态载荷通过 CDP Fetch 拦截重放，仍然走扩展自己的 `getPlayerData → normalizeTracks` 代码。
- 抓取的登录态响应已脱敏保存为 [fixtures/bilibili-player-logged-in.json](../../scripts/fixtures/bilibili-player-logged-in.json)（`auth_key` 置为 `REDACTED`）。

### F2 DNR Referer 规则漏掉侧栏请求（已修复，高风险）

- 原规则用 `tabIds: [TAB_ID_NONE]` 限定，只命中 service worker 等“无标签页”请求。音频 CDN 在无 Referer 时返回 403、带 Referer 时返回 206（见 adapter check）。`lib/audio.ts` 的下载运行在侧栏页面（与标签页关联），因此生产环境音频下载会 403。
- 修复：去掉 `tabIds`，改为 `excludedInitiatorDomains: ["bilibili.com"]`。B 站页面自己发起的 CDN 请求保持原样，扩展两个上下文都会补 Referer。
- 回归：修复前扩展页面探测 403、service worker 206；修复后两者均 206，且 B 站页面 176 条 CDN 请求全部正常。

### F3 字幕轨 ID 精度丢失（已修复）

- B 站 `id` 是大于 `Number.MAX_SAFE_INTEGER` 的整数，`JSON.parse` 后 `String(id)` 得到四舍五入值；响应同时提供精确的 `id_str`。
- 修复：`normalizeTracks` 优先使用 `id_str`；`BiliSubtitleRaw` 补充 `id_str` / `subtitle_url_v2`。

### F4 域名白名单后缀匹配缺陷（已修复）

- `host.endsWith("hdslb.com")` 会错误放行 `evilhdslb.com` 一类域名；`parseBiliIdentity` 的 `bilibili.com` 判断同理。
- 修复：改为点边界匹配（`host === domain || host.endsWith("." + domain)`）；同时给 manifest 补上 `https://*.bilivideo.cn/*` 主机权限（DNR 规则已覆盖该 CDN）。

### F5 环境限制：Chrome 156 无法用命令行加载扩展

- 复现：`chrome.exe --load-extension=dist --disable-extensions-except=dist` 启动 12 秒内没有 service worker 目标；同一命令换 Edge 156 正常。
- 影响：Chrome 侧验收只能手动“加载已解压的扩展程序”；本次自动化以 Edge 为引擎。Chrome 156 的 `--load-extension` 失效属于官方策略变化，不是本项目配置问题。

## 4. 改动文件

| 文件 | 改动 |
|---|---|
| `apps/extension/src/background/index.ts` | DNR 规则改为按 initiator 排除 B 站页面 |
| `apps/extension/src/bilibili/api.ts` | `id_str` 优先；域名点边界白名单 |
| `apps/extension/src/bilibili/types.ts` | 补充 `id_str`、`subtitle_url_v2`、`need_login_subtitle`、`asr_language` |
| `apps/extension/src/bilibili/identity.ts` | 域名点边界判断 |
| `apps/extension/public/manifest.json` | 增加 `https://*.bilivideo.cn/*` |
| `scripts/extension-smoke.mjs` | 重写为 15 项浏览器冒烟，自动发现端口、清理残留进程、CDP 拦截重放、生成 JSON 报告 |
| `scripts/bilibili-adapter-check.mjs` | 新增：用 esbuild 打包扩展真实适配器，在 Node 侧跑 10 项接口检查 |
| `scripts/fixtures/bilibili-player-logged-in.json` | 新增：脱敏的登录态播放器响应 |

## 5. 尚未覆盖 / 需要人工复验

1. **登录态真实字幕轨**：现由 [`extension-login-acceptance.mjs`](../../scripts/extension-login-acceptance.mjs) 覆盖（真实登录 → 8 条字幕轨 → 1503 段字幕 → 整理稿 → 总结 → 导出，9/9 通过，见 [end-to-end-acceptance.md](./end-to-end-acceptance.md) §2.1）。Chrome 手动加载后的同链路复验仍建议保留。
2. **点击图标打开侧栏**：`sidePanel.setPanelBehavior({openPanelOnActionClick:true})` 已注册且 API 可用，但自动化无法点击浏览器工具栏，需要手动确认。
3. **Chrome 手动加载后的同链路复验**：本次 Chrome 只验证了“命令行加载失效”，未在 Chrome 中跑内容链路。
4. 阶段 B–E（任务服务、ASR、清洗、总结、导出）的端到端验收已另行完成，见 [end-to-end-acceptance.md](./end-to-end-acceptance.md)。

## 6. 复现方式

```powershell
cd apps/extension
npm run build

cd ../..
# 接口层（无需浏览器，约 10 秒）
node scripts/bilibili-adapter-check.mjs

# 浏览器链路（自动启动/清理 Edge，约 30 秒）
node scripts/extension-smoke.mjs

# 可选：实时字幕正文检查。URL 有时效，需从已登录浏览器的
# /x/player/wbi/v2 响应里取 subtitle_url；不提供时该项标记为跳过。
$env:BTA_SUBTITLE_URL = "https://aisubtitle.hdslb.com/..."
node scripts/extension-smoke.mjs

# 复现 Chrome 忽略 --load-extension
$env:BTA_PROBE_CHROME = "1"
node scripts/extension-smoke.mjs
```

说明：`extension-smoke.mjs` 会为每次运行选择空闲调试端口、按 `bta-smoke-*` 标记清理残留浏览器进程，并在 `docs/acceptance/` 下生成带时间戳的 JSON 报告；报告与仓库中不保存任何登录 Cookie 或带 `auth_key` 的真实字幕地址。
