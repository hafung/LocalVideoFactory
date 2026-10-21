# 声织 VoxWeave 自动成片开发文档

> 本文描述目标架构、模块边界、数据流、里程碑和工程约束。实现状态以“当前进度”一节为准。

## 1. 技术决策

| 领域 | 选择 | 说明 |
| --- | --- | --- |
| 桌面端 | Electron 44 + React 19 + TypeScript | 延续现有工程；只支持当前受维护 Electron 主版本 |
| 业务协议 | Zod 校验的 EditPlan v1 | 不绑定具体渲染器 |
| TTS | 现有 Qwen3-TTS C 引擎 | 旁白分段生成，结果缓存 |
| 中文分词 | `@node-rs/jieba` | Node-API 预编译包，自定义词典 |
| ASR/对齐 | `sherpa-onnx-node` + SenseVoiceSmall INT8 | C++/ONNX Runtime，本地 CPU，提供 token 起始时间 |
| VAD | sherpa-onnx + Silero VAD | 长音频切段和末词边界 |
| 预览 | `@hyperframes/player` | 在隔离 iframe 中播放可 seek composition |
| 渲染 | HyperFrames Producer，保留适配层 | 已精确锁定 Producer/Puppeteer；浏览器资源仍需闭包验证 |
| 媒体处理 | FFmpeg + ffprobe | 探测、代理、混音和最终编码 |
| 素材索引 | SQLite + FTS5 | 媒体文件不写入数据库 |
| 打包 | electron-builder | Windows x64 优先 |

## 2. 模块边界

建议逐步形成以下目录：

```text
shared/
  edit-plan.ts          EditPlan schema、类型和通用校验
  captions.ts           与运行时无关的字幕数据结构

electron/
  composition/          自动成片编排服务
    planner.ts          文案到 draft plan
    resolver.ts         TTS 后解析时间并选择素材
  alignment/
    sensevoice.ts       sherpa-onnx 适配器
    align-text.ts       ASR token 与原文对齐
  library/
    database.ts         SQLite 与迁移
    importer.ts         素材导入
    search.ts           标签/FTS 检索和排序
  media/
    ffmpeg.ts           安全参数化调用
    probe.ts            ffprobe 数据归一化
    proxy.ts            缩略图、关键帧和代理
  renderers/
    renderer.ts         Renderer 接口
    hyperframes.ts      EditPlan 到 composition 的编译和渲染
  jobs/
    queue.ts            可持久化后台任务

src/
  features/create/      极简创建页
  features/preview/     预览与单分镜换素材
  features/library/     素材库维护
```

Renderer 接口不得泄露 HyperFrames 类型：

```ts
interface VideoRenderer {
  prepare(plan: ResolvedEditPlan, workspace: string): Promise<PreparedComposition>;
  render(input: RenderRequest, onProgress: RenderProgressHandler): Promise<RenderResult>;
  cancel(jobId: string): Promise<void>;
}
```

## 3. EditPlan 数据约束

- 所有时间统一使用整数毫秒；只在渲染适配器中换算为帧或秒。
- `schemaVersion` 必填；读取旧工程时先迁移再校验。
- `draft` 允许素材未解析，`resolved` 必须有旁白文件、真实时长和确定素材。
- 分镜按 `startMs` 排序，不得重叠，必须覆盖旁白时长；允许显式标记的空白转场。
- caption token 必须落在对应 cue 内，cue 必须落在旁白时长内。
- 素材路径不直接进入 renderer；先通过 `assetId` 解析并验证。
- 每次重新选择素材产生新的 plan revision，避免原地破坏已渲染版本。

## 4. 自动成片流水线

```text
createDraftPlan
  → synthesizeNarration
  → probeNarration
  → alignCaptions
  → analyzeOptionalSource
  → resolveVisualSlots
  → resolveBgm
  → validateResolvedPlan
  → compileComposition
  → render
  → verifyOutput
```

每一步都应：

- 接收结构化输入并返回结构化输出；
- 支持取消；
- 写入任务进度；
- 使用输入 hash 缓存；
- 失败后保留上一步产物；
- 不从 renderer 进程接受任意 shell 命令。

## 5. TTS 与字幕对齐

### 5.1 旁白生成

默认使用 Qwen3-TTS 1.7B CustomVoice + INT8。普通文案通过 `shared/prosody.ts` 按段落组织为至多 160 字符的朗读片段，同段短句尽量合并以保留上下文。程序传入自然朗读指令，让模型根据文意处理情绪、重音、语速和句内停顿；段落间目标停顿为 420 ms，长度限制导致的片段边界为 220 ms。模型已有的前后静音计入目标间隔，不裁切原始语音。用户无需输入标签。

朗读片段与视觉分镜解耦：每个片段保留所属分镜 ID、最终音频偏移和实际语音区间。音频全部完成后，由 SenseVoice 对齐，再解析分镜。对齐失败仅回退对应片段，估算字幕只覆盖语音区间。

克隆使用 1.7B Base 提取 2048 维 `.qvoice`，由 1.7B CustomVoice 加载并接受朗读指令。这是项目原生 C 引擎的跨模型音色功能，官方 CustomVoice API 本身仅提供预设音色。应用仅支持这两个 1.7B 模型；首次切换到本资源版本会清空原音色库、旁白缓存和旧模型路径设置，后续启动保留新建音色。过时或维度不符的音色文件直接拒绝，不降级。

在 Windows Node 环境运行 `pnpm smoke:prosody`，生成 1.7B 无指令对照和自动朗读样片，以及 CPU 耗时、音频时长、字幕和分镜报告。每次使用独立缓存目录，避免缓存命中污染耗时。主推理仍为每个朗读片段一个进程，合并短句减少重复加载；尚未增加 Windows 常驻服务。

`pnpm smoke:clone` 验证 1.7B Base 提取、CustomVoice 自动朗读和字幕对齐。默认生成男声参考音频，也可用 `--reference-audio` 指定素材；报告中的同编码器余弦相似度仅作该样片的音色诊断，不代表所有输入的克隆质量。

2026-09-30 实测（i5-14600K、Windows 原生 CPU、4 线程、INT8、seed 42）：1.7B 无指令耗时 40.9 秒、音频 17.36 秒；自动朗读耗时 41.7 秒、音频 17.96 秒。耗时包含模型加载，仅代表该样片。自动朗读样片的全部 22 个字幕词块对齐成功；桌面生成、预览和 MP4 导出也通过实测。SenseVoice 的读音频与 VAD 接口显式关闭外部缓冲区，以兼容 Electron 的内存限制。

同日 1.7B 克隆实测：以生成的 Uncle Fu 男声作为参考，Base 提取 2048 维音色耗时 6.3 秒，CustomVoice 自动朗读耗时 33.2 秒、成品音频 13.05 秒，40/40 字符通过声学对齐。同编码器声纹余弦相似度为 0.990，仅是这份合成参考的诊断值。独立桌面流程生成 13.77 秒旁白，22/22 字幕词块对齐，4 个分镜与 2 个朗读片段完成预览和 1080×1920 H.264/AAC 导出；首次启动清除旧音色与旁白缓存的断言通过。

缓存键至少包含：

```text
normalizedText + voiceId/voiceHash + language + temperature +
topK + topP + seed + precision + engineVersion + modelPath/revision + instruct + prosodyVersion
```

### 5.2 SenseVoice 适配器

模型资源不通过 npm 包隐式下载，放入 `resources/models/sensevoice-small/`，并在构建清单中记录：

- ONNX 模型；
- `tokens.txt`；
- Silero VAD 模型；
- 模型许可证和来源；
- 模型 hash 与版本。

适配器输出统一为：

```ts
interface AcousticToken {
  text: string;
  startMs: number;
  endMs?: number;
  confidence?: number;
}
```

SenseVoice 的识别 token 与原文使用规范化、编辑距离/动态规划对齐。首选原文文字，不用识别文本覆盖用户文案。词结束时间优先使用下一 token 起点；段落最后一词使用 VAD 段落终点。

### 5.3 jieba 聚合

先对原文分词，再把已对齐字符时间聚合到自然词。字幕词组按以下规则继续合并：

- 遇标点强制断组；
- 单组建议 4–10 个汉字；
- 单组建议持续 0.8–2.2 秒；
- 专有词不得拆分；
- 超过两行或安全区宽度时提前断组。

## 6. B-roll 规划

每个语义段生成 `VisualIntent`：

```ts
interface VisualIntent {
  keywords: string[];
  mood?: string[];
  preferredTypes: Array<'source' | 'video' | 'image' | 'kinetic-text'>;
  avoidAssetIds: string[];
  minDurationMs: number;
  orientation: 'portrait' | 'landscape' | 'square';
}
```

首版排序函数由可解释分数组成：

```text
tagScore + fullTextScore + orientationScore + qualityScore
- reusePenalty - licensePenalty - cropPenalty
```

原始视频导入后作为高优先级素材集合参与同一排序。单镜头连续使用超过模板阈值时，规划器主动创建新的 B-roll 插槽。

## 7. HyperFrames 集成

### 7.1 原则

- EditPlan 是 source of truth；HyperFrames composition 是可删除的编译产物。
- 只使用固定模板和允许列表中的 CSS/动画参数。
- 不执行模型或用户生成的任意 JavaScript。
- 预览 composition 与最终渲染 composition 使用相同模板版本和字体资源。
- 模板版本写入 EditPlan，避免升级模板后旧工程视觉漂移。

### 7.2 依赖闭包与剩余验证

截至 2026-09-14，`@hyperframes/producer@0.8.38` 的 Puppeteer 范围会尝试解析尚未发布的 `puppeteer-core@25.11.0`。当前工程通过精确锁定 `puppeteer` 和 `puppeteer-core` 为 `25.10.0`，已完成可复现安装和 Producer API 导入验证；升级三者时必须一起验证，不能只放宽单个版本。

pnpm 默认忽略 Puppeteer 的浏览器下载脚本，因此当前依赖安装不包含可供 Producer 使用的 Chrome。进入默认生产路径前仍需：

1. 将通过校验的 Chrome for Testing/Headless Shell 作为显式构建资源，并配置 `chromePath`；
2. 验证 electron-builder 正确包含浏览器、字体和 Producer 资源；
3. 完成 60 秒竖屏压力样片；
4. 记录临时磁盘、峰值内存、渲染耗时和取消清理行为；
5. 验证 Windows 安装版在无系统 Chrome 的机器上可以离线渲染。

Player 可以先行用于 composition 预览；浏览器资源闭包和黄金样片通过前，Producer adapter 不进入默认生产路径。

## 8. 安全边界

- Renderer、FFmpeg、ASR 和 TTS 都运行在 Electron 主进程控制的子进程/worker 中。
- Renderer IPC 的每个入口使用 Zod 验证，不接受 renderer 传入的任意输出路径或命令参数。
- 用户素材通过内部 asset ID 访问；预览 composition 使用受控本地协议，不直接暴露任意 `file://`。
- HyperFrames Player 使用不透明 sandbox origin，除非某项已审核功能明确需要同源 DOM 访问。
- 临时目录使用每任务独立目录；取消、失败和退出时可回收。

## 9. 测试策略

### 单元测试

- EditPlan schema 与跨字段约束；
- 文案分段、jieba、自定义词典；
- token/原文对齐；
- 素材排序和重复惩罚；
- 时间到帧换算；
- renderer 模板转义。

### 集成测试

- TTS → WAV → 对齐 → caption tokens；
- ffprobe → 媒体元数据；
- resolved plan → composition；
- composition → 短 MP4；
- 取消任务和恢复任务。

### 黄金样片

至少维护：纯图片、纯 B-roll、有原始视频、中英混合、长停顿、无 BGM、竖屏裁切七类样片。除了视觉快照，使用 ffprobe 校验时长、尺寸、帧率、音视频轨和编码。

## 10. 里程碑

### M0：基础协议与依赖

- [x] 产品方案和开发文档；
- [x] Electron 44；
- [x] HyperFrames Player/Producer、jieba、sherpa-onnx 依赖；
- [x] EditPlan v1 schema 与测试；
- [x] EditPlan 原子持久化与不可变修订；
- [x] Renderer 接口；
- [x] HyperFrames Producer/Puppeteer 可复现安装与 API 兼容性 spike；
- [x] Producer 浏览器资源闭包与 Windows 原生短样片渲染；
- [x] 0.2.2 Portable 打包后 EXE 的素材管理入口、TTS 预览与 MP4 导出回归；
- [ ] 0.2.2 安装包与客户干净机验收。

### M1：文案到可预览 composition

- [x] 极简创建页；
- [x] TTS 分段产物和真实时长；
- [x] draft → resolved plan；
- [x] jieba 初始字幕分组；
- [x] 静态图片/动态图形模板；
- [x] HyperFrames Player 预览集成；
- [x] Windows x64 Electron 44 实机启动冒烟。

### M2：SenseVoice 与素材库

- [x] SenseVoice INT8 + Silero VAD 资源闭包（固定模型、完整许可证、SHA-256 manifest 与 Windows 原生推理冒烟）；
- [x] token/原文对齐；
- [x] SQLite/FTS5；
- [x] 素材导入、缩略图和标签；
- [x] B-roll 自动选择和单分镜替换。

### R1：Windows 离线发行闭包

- [x] 原生 `qwen_tts.exe`、OpenBLAS/winpthreads DLL、许可证与可复现构建信息；
- [x] Windows `--self-test`、`--caps`、UTF-8 中文最短旁白；
- [x] 打包后 TTS → SenseVoice/Silero → HyperFrames Player 实机样片；
- [x] 模型独立存放的目录 Portable 包与 ZIP/SHA-256。

### M3：稳定渲染

- [x] Producer renderer 与桌面 MP4 导出入口；
- [x] BGM 循环、淡入淡出、人声闪避与响度处理；
- [x] 导出取消、失败保留可预览修订、重启恢复中断导出；
- [ ] 硬件编码探测；
- [ ] 黄金样片和 Windows 安装包验证。

## 11. 当前进度

### 2026-09-20：成品导出、素材管理与可选联网搜索

- `HyperframesPreviewRenderer` 已实现 Producer 隔离进程导出；预览与导出使用同一模板及预混音轨。输出先写同目录临时 MP4，经 ffprobe 检查 H.264/AAC 和时长后替换目标文件；取消和失败清理临时文件，保留已有目标。
- BGM 可从本地音频素材选择，调整音量、开启/关闭旁白闪避，应用后直接在 Player 试听；使用 FFmpeg 循环补齐、淡入淡出和 `loudnorm`，目标 -16 LUFS / -1.5 dBTP（单遍动态处理，并非双遍广播级响度验收）。
- 素材库有本地浏览、类型筛选、关键词搜索、音视频预览、批量导入及逐文件错误、批量追加人工标签、单个标签替换、自动标签重建和索引移除。移除不会删除原文件；仍被旧工程引用的素材需保留。
- SQLite v2 保存自动/人工标签来源，兼容旧索引；初版自动标签使用文件名、目录、媒体属性、已有文字描述与中英文词库。**没有接入视觉模型识别物体/动作，也没有实现镜头级语义标签**，不要将规则标签描述为视觉 AI 分析。
- Pexels 图片/视频搜索、画幅筛选、分页、中英文词库映射、按需下载入库、作者/来源/许可记录已经接通。密钥通过 Electron safeStorage 保存，亦支持 `PEXELS_API_KEY`。搜索带缓存，下载有超时、大小限制、来源白名单与临时文件清理；用户未提供 Key，本轮仅验证模拟 API，未宣称真实 Pexels 联网验收。
- 原生验证：3 秒 640×360/30fps，覆盖视频→图片→动态文字及字幕；无 BGM/有 BGM 两条 H.264/AAC 成品均通过。频域检测确认停顿时 BGM 恢复，实测恢复/说话时振幅比约 2.83；取消不覆盖旧目标。另有桌面/375px 界面回归。
- Windows Electron 整链路已通过：真实 Qwen 中文 TTS → 字幕对齐 → Player → 1080×1920 H.264/AAC MP4（1.366667 秒）；测试使用隔离 userData。自动测试 46 项、类型检查、生产构建和 346 个离线资源文件校验通过。
- 浏览器固定为 Headless Shell 152.0.7977.75，安装脚本锁定下载 URL 和 SHA-256，完整运行资源及许可证纳入 verifier。FFmpeg 改用同版本 **GPL** 包以提供 libx264；来源、许可证和固定哈希均已更新，不能继续将新包描述为 LGPL-only。

复现命令：`pnpm typecheck`、`pnpm test`、`pnpm build`；Windows 构建完成后执行 `pnpm smoke:export:win`；界面模拟测试设置 `VOXWEAVE_CHROME` 和可选 `VOXWEAVE_UI_URL` 后运行 `pnpm smoke:library:ui`。测试输出在测试 AppDir 的 `export-check`，界面截图在 `.windows-smoke/ui-check`。

后续未验收项：60 秒 1080p 黄金样片矩阵、硬件编码、0.2.2 安装包与客户干净机、视觉 AI 标签及真实 Pexels Key 集成测试。0.2.2 Portable 目录和 ZIP 已生成，打包后 EXE 已验证素材管理入口、真实 TTS 预览与 H.264/AAC MP4 导出。

### 历史：2026-09-16

截至 2026-09-16，M1 的代码纵向切片已经完成：极简创建页可提交文案和可选原视频，composition job 会保存 draft、按分镜生成带稳定缓存键的 WAV、探测真实时长、生成连续覆盖旁白的 resolved 新修订，并编译只引用本地 GSAP/HyperFrames runtime 的固定模板。预览通过受控 `voxweave-preview://` 协议和 sandboxed HyperFrames Player 加载，支持播放、暂停、seek、阶段进度、取消、错误后重新生成、重启恢复和分镜卡片换画面。动态图形与字幕使用独立 composition/GSAP 时间线，Windows 冒烟同时断言 Player ready、scene 数、播放后时间和预览区域非黑像素比例。启动恢复与新任务并发时的旧预览覆盖竞态也已消除。原视频短于旁白时会在精确出点后切换为 kinetic-text 兜底。

M2 已完成：SenseVoiceSmall INT8、Silero VAD 和 FFmpeg/ffprobe 已下载到外部 `resources` 目录，下载脚本锁定来源版本并校验 SHA-256；SenseVoice 的发行包许可证指针、固定 revision 的 FunASR Model Open Source License Agreement v1.1 和 Silero MIT 文本均随资源保存并参与哈希校验。适配器、16 kHz VAD、识别 token 到已知原文的动态规划对齐、jieba 词组回聚合、Node SQLite/FTS5 索引、SHA-256 去重、ffprobe 元数据、FFmpeg 缩略图、文件名/人工标签、可解释检索评分、授权和重复惩罚、自动 B-roll 与不可变单分镜替换均已接入。资源缺失时流水线仍明确降级到 TTS 估时字幕，不丢失 resolved 工程。

兼容性记录：`@hyperframes/core`、`@hyperframes/player`、`@hyperframes/producer` 固定为 `0.8.38`，`gsap` 固定为 `3.14.2`，`puppeteer`/`puppeteer-core` 固定为 `25.10.0`。composition 编译时从已安装包复制 runtime 和 GSAP，不依赖 CDN；Manrope 与 Noto Sans SC 字体已进入 Vite 构建产物。Player 0.8.38 的跨源 iframe 会出现 ready/load 先后竞态，冒烟必须等待目标 `src` 对应的新 Player；模板不能给框架管理的 clip 写死 `opacity:0`。Windows 宿主使用 `C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`（Node v24.19.0）完成原生生产构建和 Electron 启动；Electron 44.3.0 / Chromium 152.0.7977.78 / x64 冒烟通过。`sherpa-onnx-node` 1.13.8 在同一 Windows x64 环境加载真实 SenseVoice/Silero 资源成功；为规避 Electron 退出时第三方原生 addon 崩溃，对齐改在 `ELECTRON_RUN_AS_NODE` 隔离子进程中执行。固定的 FFmpeg `n8.1.2-52-g5a03dfa0f6` 与 ffprobe 也已在 Windows 运行。

验证边界必须继续区分：原生 Qwen 引擎使用 LLVM-MinGW 20260908 / LLVM 23.1.1、OpenBLAS 0.3.34、LZ4 1.10.0 构建为 UCRT x64/AVX2+FMA 目标，`--self-test`、`--caps` 和 UTF-8 `你好。` 实际合成均已在 Windows 通过；该 1.36 秒、24 kHz 单声道 WAV 随后由 SenseVoice/Silero 对齐并进入 Player。Qwen CustomVoice revision `85e237c12c027371202489a0ec509ded67b5e4b5` 是默认预设音色模型，Base 模型用于克隆，两者仍是目录内的外部文件，不进入 Git 或单个 EXE。开发态和打包后 EXE 的完整 TTS → SenseVoice → Player 样片都已通过；Producer 最终 MP4 渲染仍未走通，也未进入默认路径。

离线交付采用目录 Portable ZIP：应用、`resources/models`、`resources/engine`、`resources/ffmpeg` 并列保存。2026-09-30 升级后的严格资源校验通过，共 402 个文件、10,650,578,917 字节；TTS 资源仅包含 1.7B Base 与 CustomVoice，引擎 manifest 同时锁定源码 commit/diff/tree hash、导入 DLL 和各许可证。包含旧 TTS 的 0.2.1 / 0.2.2 Portable 目录、ZIP 与校验文件已删除；本轮尚未重新打包发行物。顶层入口固定为 `VoxWeave.exe`。Producer 所需的 Chrome for Testing 属于 M0/M3 最终渲染闭包，与 Electron 自带 Chromium 的预览启动分别校验。

每次实现应同时更新里程碑勾选项和关键兼容性记录，避免文档成为一次性设计稿。

## 12. 历史执行计划（2026-09-16；当前进度以第 11 节为准）

### 12.1 目标

完成 M0 最后一个未完成项：为 HyperFrames Producer 建立固定版本、可校验、可随 Windows 离线包分发的浏览器资源闭包，并从现有 `PreparedComposition` 渲染一条最短 MP4。此批只证明 renderer 边界和短样片可工作，不同时扩展 BGM、硬件编码或完整黄金样片矩阵。

### 12.2 实施顺序

1. **冻结浏览器资源**
   - 选择与 Puppeteer 25.10.0 兼容的 Chrome for Testing/Headless Shell x64 版本；
   - 固定官方下载 URL、版本、SHA-256、许可证和目录布局，不依赖 Puppeteer 安装脚本隐式下载。
2. **实现 Producer adapter**
   - 在 `VideoRenderer` 边界内接入 `@hyperframes/producer@0.8.38`；
   - 只接受已验证的 `PreparedComposition`、目标文件和渲染参数，显式传入 `chromePath`；
   - 把进度、取消、子进程退出和错误统一映射回现有 composition job。
3. **最短 MP4 样片**
   - 使用现有本地 kinetic-text、旁白和字幕 composition 渲染 1–3 秒 MP4；
   - 用 ffprobe 断言时长、尺寸、视频轨、音频轨和编码，不只检查文件存在。
4. **离线打包闭包**
   - 将浏览器资源加入严格 verifier、分项 manifest、许可证和 electron-builder `extraResources`；
   - 从打包后 EXE 触发一次短渲染，确认没有回退到系统 Chrome 或联网下载。
5. **测试与文档**
   - 增加 adapter 参数校验、取消和错误路径测试；
   - 运行 `pnpm typecheck`、`pnpm test`、`pnpm build`，更新第 10–12 节。

### 12.3 完成标准

- 浏览器二进制、许可证和 SHA-256 都有固定 manifest，断网机器不触发下载；
- Producer adapter 不绕过 `VideoRenderer`，也不接受任意 shell 参数；
- 1–3 秒样片在开发态和打包后 EXE 中均能完成，ffprobe 结构断言通过；
- 取消和失败不会遗留 Chrome/FFmpeg 子进程或半成品目标文件；
- 此批完成后只勾选 M0 浏览器资源闭包，不提前宣称 M3 稳定渲染完成；
- 类型检查、自动测试和生产构建全部通过。

### 12.4 推荐拆分

为了让每次变更可审查，按以下连续开发批次推进：

1. **M1-A（已完成）：** TTS composition service、真实时长、resolver 与单元测试；
2. **M1-B（已完成）：** 固定模板编译器、HyperFrames Player 与预览集成；
3. **M1-C（已完成）：** 极简创建页、进度/取消/恢复已完成；Linux Xvfb 与 Windows x64 Electron 44 启动冒烟均已通过。
4. **M2 离线资源闭包（已完成）：** SenseVoiceSmall INT8、Silero VAD、FFmpeg/ffprobe、字体、版本清单和许可证已落盘；Windows 原生 ASR/VAD 与媒体探测已用真实资源验证。
5. **R1-A Windows 离线发行闭包（已完成）：** 原生 `qwen_tts.exe`、依赖 DLL、许可证和可复现构建信息已闭包；`--self-test`、`--caps`、UTF-8 中文旁白、TTS → SenseVoice → Player、打包后 EXE 和目录 Portable ZIP 均已在 Windows 实机通过。Qwen CustomVoice 是默认预设音色模型，Base 模型用于克隆，两者均为独立资源文件。

第一个未完成批次现在是 M0 的 Producer 浏览器资源闭包与短样片渲染；完成后继续 M3 的最终 MP4 稳定化。

下一批只处理 Producer 浏览器闭包与最短 MP4；BGM、硬件编码和完整黄金样片留在 M3，避免范围失控。

## 13. AI 接棒约定

新的开发会话开始时，AI 应先阅读：

1. `docs/product-spec.zh-CN.md`；
2. 本开发文档，尤其是第 10–11 节和第 14 节；第 12 节仅是历史记录；
3. `shared/edit-plan.ts`、`electron/composition/` 和 `electron/renderers/renderer.ts`；
4. 当前 `git status`、相关测试和最近变更，不覆盖用户已有修改。

下一次用户要求实施时，从第 14 节第一个未完成批次继续；本次用户只要求将后续工作记录为计划，不提前实现或启用外部 AI。完成一批后必须：

- 更新第 10 节里程碑和第 11 节当前进度；
- 记录新增的版本锁定、资源闭包或兼容性问题；
- 执行并汇报 `pnpm typecheck`、`pnpm test`、`pnpm build`；
- 清楚区分“依赖已安装”“预览已走通”和“最终渲染已走通”。

可直接把下面这段交给下一次 AI：

> 继续开发 VoxWeave。先阅读 `docs/product-spec.zh-CN.md`、`docs/development.zh-CN.md` 第 10–11、13–14 节，检查当前代码、测试和 `git status`，保留已有未提交变更。核心 MP4/BGM、本地素材管理和 Pexels 模拟集成已完成，不要重复旧的浏览器接入任务。从第 14 节 A 批次“统一设置中心”开始，随后按 B→C→D 接入外部 LLM、文案闭环和视觉素材分析；E 是发布验收，不能遗漏。不要把规则标签称为视觉 AI，也不要把模拟 API 通过称为真实服务验收。完成后更新计划勾选项，运行适用的类型检查、测试、构建及真实流程验收，并汇报剩余项。

## 14. 下一阶段计划：统一设置中心、外部 AI 与文案闭环

> 2026-09-20 用户确认记录，留待下一次实施。以下均为待开发/待验收项，不代表当前应用已有这些入口或能力。

### 14.1 当前基线与边界

- 已实现：文案与可选原视频 → 本地 TTS → 字幕对齐 → 本地规则选片及可选 Qwen GGUF 文案分镜规划 → Pexels 补齐本地缺失画面 → 预览 → MP4；BGM 混音、本地素材管理、规则自动/人工标签。
- 当前右上角设置包含本地 TTS、Embedding 检索和 GGUF 文案分镜模型；Pexels Key 配置位于素材库 Pexels 页，已使用系统加密存储。
- 当前没有统一服务配置或通用远程 LLM API 配置；离线便携包自动发现内置 Qwen3.5-4B Q4_K_M，允许显式覆盖或关闭；缺失或调用失败时使用关键词规则并保留提示。没有文案优化或视觉内容识别。
- 素材库自动标签来自文件名、目录、媒体属性与词库；用户提供的原视频现有本地视觉/语音内容分析与旁白匹配流程，详见末尾更新。BGM 已接通，独立音效轨/自动音效编排不在本轮已完成功能内。
- 发布未完成：60 秒 1080p 样片与资源压力测试、新 Portable/安装包及干净机验收、真实 Pexels Key 联调；硬件编码探测仍待开发。核心短片可用不等于所有功能和发行验收完成。

### 14.2 A：统一设置中心（下一次首先实施）

- [ ] 将右上角现有设置扩展为统一入口，按“AI 服务、素材来源、本地引擎、生成与存储”组织；素材库保留进入 Pexels 设置的快捷链接，不维护两份配置。
- [ ] AI 服务支持多个连接配置：显示名称、供应商/协议适配器、`base_url`、API Key、模型 ID、启用状态；分别选择文案任务默认模型和视觉任务默认模型，允许使用不同供应商。
- [ ] 接入范围包含用户指定的第三方文本 LLM 与多模态 LLM，避免绑定单一平台；协议兼容能力由适配器和连接测试确认，不仅凭模型名称猜测。
- [ ] 连接操作支持保存、修改、删除、测试连接；可选拉取模型列表，但始终保留手填模型 ID。分别检测文本/图片能力，清楚区分地址错误、鉴权失败、模型不存在、能力不支持与限流。
- [ ] 迁移现有 Pexels 加密 Key，保留 `PEXELS_API_KEY` 环境变量兼容；显示当前配置来源，避免环境变量生效时误报“已清除所有凭据”。Pexels 使用固定官方端点，不需要暴露任意地址设置。
- [ ] API Key 仅由主进程加密保存和使用，界面只显示已配置/掩码状态；不进入工程、导出配置、日志或错误堆栈。跨域重定向不转发凭据；测试/删除配置不删除用户素材。
- [ ] 其他设置分层开放：本地 TTS/模型路径、默认音色/语言、默认画幅/字幕/BGM 音量与闪避、默认输出目录、素材下载目录、缓存管理；FFmpeg/浏览器路径、超时、重试次数、并发上限放高级项。沿用现有默认值，不强迫用户填满。
- [ ] 配置提供版本化 schema、输入校验、旧配置迁移和保存失败反馈。迁移目录不得隐式移动/删除旧媒体；缓存清理显示范围，排除原素材和成品。

验收：重启后配置可用，原 Pexels Key 不丢失；无 AI Key 时原有本地成片仍能工作；界面和日志不回显密钥；错误连接测试不影响其他服务；文本模型不会被错误用于视觉任务。

### 14.3 B：外部 LLM 调用层

- [ ] 建立主进程服务适配层，分离“文本生成”“多模态分析”能力；界面只提交受控任务与配置 ID，不直接携带密钥发请求。
- [ ] 支持取消、超时、有限重试、限流反馈与并发控制；有服务端用量数据时展示用量，不虚构价格或成本。
- [ ] 模型输出采用结构化 schema 校验，处理空响应、截断、不合法 JSON、拒绝回答和不支持能力等情况；AI 不可用时保留人工输入和规则检索流程。
- [ ] 外部 AI 默认由用户主动调用；首次发送说明具体服务和数据范围，分别区分文案、图片/视频抽帧及语音转写。保存 Key、打开工程和导入素材不会自动上传全部媒体。
- [ ] 模拟接口覆盖成功、401/403、429、超时、取消、坏 JSON 和能力不匹配；用户有凭据后再做真实供应商联调，验收记录区分模拟与真实。

### 14.4 C：视频文案闭环（先用纯文本模型完成）

- [ ] 输入支持现有原稿，以及主题/产品要点、目标受众、用途、风格、目标时长等可选约束；提供“优化现有文案”和“根据要点生成文案”。
- [ ] 展示原稿与候选稿，支持再次调整、手动修改、采用和撤回；未经用户采用不覆盖原稿，也不立即启动 TTS。
- [ ] 保存文案版本、使用的模型/配置 ID及生成约束，排除密钥；“采用文案 → TTS → 字幕 → 选画面 → 预览 → 导出”复用已有流程。
- [ ] 区分最终口播文本与镜头建议/标签，不把模型解释、JSON 或镜头指令直接送去朗读；保留用户关键事实、专有名词与产品参数，对模型新增主张标记待核实。
- [ ] 目标时长先作为估计约束，TTS 后以真实音频时长为准；偏差过大时提供缩写/扩写建议，再由用户采用，避免无限自动重写和反复计费。
- [ ] 已有成片修改文案后创建新修订并重新生成受影响旁白、字幕和时间轴，保留旧稿与旧成品。

验收：纯文本模型即可完成原稿优化并导出新视频；用户能恢复旧稿；无 Key、失败或取消不会丢失原文；实际时长和字幕仍服从已有旁白主时钟。

### 14.5 D：多模态素材分析与语义选片

- [ ] 图片分析和视频代表帧/镜头抽帧；只在用户选择分析时发送选中媒体的必要内容，纯文本模型仅处理文字描述和转写，不宣称它能直接看视频。
- [ ] 保存主体、场景、动作、情绪、用途、描述和视频时间段；区分规则标签、AI 标签和人工标签，记录模型/版本与素材指纹，支持缓存与重新分析。
- [ ] AI 标签可由用户更正、隐藏或删除，重新分析不覆盖人工修订；缺乏证据的标签保留为建议，不当成确定事实。
- [ ] 文案分段生成镜头意图、扩展中英文检索词；在标签、画幅、时长、重复惩罚和授权约束内选择已有素材/片段。AI 只能引用可验证的素材 ID 和有效时间区间。
- [ ] 语义选片结果进入现有 EditPlan 新修订，用户仍可换画面；无匹配、无网络或模型失败时回退到规则检索/动态文字。联网搜索与下载仍是可选行为。
- [ ] 用人工标注样例验收分析和选片质量，尤其验证“原视频短于旁白”“无原视频”“跨镜头取片”“人工纠错保留”，不只验证接口返回成功。

### 14.6 E：发布与稳定性验收（不是 AI 接入的替代项）

- [ ] 60 秒 1080p 与三种画幅的黄金样片；覆盖纯图片、视频补画面、原视频不足、长停顿、中英混合、无 BGM/有 BGM，检查字幕与音画一致性。
- [ ] 大批量素材、重复导入、坏文件、原文件丢失、低磁盘空间、重复导出、取消、异常退出和重启恢复；记录内存、临时磁盘和耗时。
- [ ] 配置真实 Pexels Key 后实测搜索、图片/视频下载、入库和后续导出；目前用户没有 Key，不以此阻塞其他开发，也不将模拟测试勾成真实验收。
- [ ] 重打包含新浏览器和 GPL FFmpeg 的 Portable/安装包，检查许可证/来源清单及资源哈希，在打包后 EXE 和干净 Windows 环境验证离线成片。
- [ ] 硬件编码作为后续性能增强单独验证；软件 H.264 是现有基线，不把硬件加速称为已实现。

建议实施顺序：A 统一设置 → B 调用层 → C 文案闭环 → D 多模态分析/语义选片；E 可穿插进行，发布前必须完成相关验收。独立音效编排等扩展功能另列迭代，不混入“仅差 AI 接入”的判断。

### 2026-10-21：文案分镜、原片时长适配与离线模型

- 本地 Qwen3.5-4B Q4_K_M 使用现有 llama.cpp b11039 CPU 运行器；按批次读取文案，关闭思考，校验分镜 ID，输出中文关键词与英文 Pexels 检索词。查询保存在 EditPlan，原片不足导致分镜拆分后仍保留。模型进程在规划结束后释放，避免与 TTS 同时占用模型内存。
- 固定 Unsloth GGUF revision `e87f176479d0855a907a41277aca2f8ee7a09523`，大小 2,740,937,888 字节，原始 SHA-256 `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`。资源和许可位于 `resources/scene-planner/`。`pnpm setup:scene-model` 下载并校验；便携包打包脚本强制检查模型闭包，启动按包内相对目录定位，失效的开发机绝对路径不会遮蔽内置模型。
- 原片先检测镜头切换及近全黑画面；旁白是最终时钟，长句拆成不超过约 5 秒的画面段。长原片从全片按时序分布取段；短原片使用一次，不循环、不拉长，剩余区间自动补素材。原声通过明确裁剪和顺序拼接同步到所选原片区间，原片结束后补静音，换画面不会破坏这条音轨。
- 自动补片先选本地视频，再尝试 Pexels 视频；多条短视频可拼接覆盖一个旁白段，图片每张最多 2 秒。素材或模型服务失败会保留可见提示，动态文字是最后兜底。人工换画面仍允许明确选择长时间图片。
- 选原片目前依据镜头边界、黑场和时间分布；尚未读取原片转写或视觉描述，不能宣称语义匹配或精彩片段识别。原片若是口播，也不能保证剪点都位于完整语句边界。
- 已执行：110 项自动测试、TypeScript 检查、生产构建、408 文件/13,391,583,166 字节资源闭包校验。Windows 真实 Qwen 文案样例 3 分镜首次 17.5 秒、2 分镜热调用 8.8 秒；全部返回有效中英文搜索词。Windows FFmpeg 样例验证黑场排除、4 秒成片保留原片首尾、12 秒成片原片耗尽后补画面、原声对应 200/800 Hz 原片段与尾部静音。报告分别在 `.windows-smoke/scene-planner/` 和 `.windows-smoke/source-edits/`。`pnpm smoke:scene-planner` 与 `pnpm smoke:source-edits` 使用 Windows Node。

### 2026-10-21：原片内容选段（替代上述时间分布策略）

- `source-content.ts` 在生成旁白前执行本地内容索引：镜头/黑场检测后，按约 12 秒、重叠 4 秒的窗口抽取 12 张独立帧图，标注帧索引后按时间顺序输入模型；Qwen3.5 视觉描述进一步拆成带帧索引的内容段，代码将合法帧索引映射回原片时间。模型不能提供任意文件路径或直接指定剪辑时间。
- 有音轨时先转 16 kHz 单声道，按 30 秒、重叠 1 秒分块，使用隔离进程里的 Silero VAD + SenseVoice 转写实际语音；由标点、语音区间和停顿形成需保护的语句。静音和音乐不会直接作为整段语音送入 ASR。音频临时文件用完即删。
- 模型结合原片描述、转写与每句旁白输出候选 ID、相关性类别和依据（类别由代码映射为相关度分值）；选段还考虑画面质量、重复惩罚与源片顺序。低于相关度阈值的原片不强行使用。确定的原片区间不重复，不循环、不拉伸；已识别的动作/语句区间不允许从内部切入切出；已识别为未看到完整开始/结束的动作候选会跳过，连续长动作可以跨越原有 5 秒画面槽。
- 无匹配或完整动作/语句放不下的时长交给现有本地/Pexels 补片流程。原声轨继续按实际剪点生成。内容分析失败会显示提示并补充素材，生成流程不会悄悄使用时间均匀抽片。视觉失败但有明确语音证据时允许仅按转写匹配，并标明证据类型。
- 分析缓存键含原片路径、大小、修改时间、镜头范围、模型/投影文件属性、资源清单和分析版本；失败结果不作为成功缓存复用。项目 `artifacts/source-content.json` 保留内容索引和匹配依据，分镜卡片显示选段原因，人工换画面会清除该画面的旧依据。原始帧和临时音频不写入 EditPlan。
- 视觉投影文件 `mmproj-F16.gguf` 同一固定 revision，672,423,616 字节，SHA-256 `cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864`，已下载并核对。安装脚本、资源校验和离线包检查均要求语言模型与投影文件同时齐全。
- 画面分析基于抽帧，动作边界存在采样误差；快速动作、严重遮挡、噪声口播等仍需要实际原片验收，不能保证所有动作或语句都正确识别。通用素材库文件仍按已有标签检索，本轮的视觉/语音分析范围是用户提供的原视频。

### 提交前 review 修复

- 语句保护区间在句间共享安全边界，取消重复 padding 导致的重叠；原片分析使用独立临时目录与原子缓存写入，避免并发任务互相删除抽帧。
- 原片画面改为带索引的 12 张独立图片输入，避免把接触表网格误读成同一镜头中的多个主体；技术缺陷与相关性使用类别判断，由代码计算分值，避免小模型数值评分不稳定。
- 选片顺序明确为本地视频（含短片拼接）→ Pexels 视频 → 本地短时图片 → Pexels 短时图片 → 动态文字；近期已使用素材有惩罚。
- Windows 本地启动脚本在 `.windows-stage-local` 安装独立依赖并构建，复用原 `resources`，不打便携包。识别 worker 使用 Koffi 按绝对路径预加载 Sherpa 自带的 ORT DLL，避免 Windows System32 的旧 ORT 抢先加载；识别仍在隔离进程执行。

- 本次 review 验证：122 项自动测试通过，TypeScript 检查、Linux/Windows 生产构建与 409 个资源文件校验通过。Windows 本地多图视觉输入正确识别单个红/蓝方块，按蓝色旁白选中原片后段；真实 ASR 返回“你好。”与语音区间。桌面完整流程生成 3,120 ms 旁白，选中原片 4,000–7,120 ms，7/7 字幕词块对齐，Player ready，无回退警告，MP4 导出成功；报告和样片在 `.windows-smoke/source-content/desktop.json`、`desktop.mp4`。
- 桌面联调修复了内容分析后复用已保存修订号导致的工程保存冲突；分析成功和失败分支均产生新修订。
