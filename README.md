<div align="center">

<img src="build/icon.png" width="88" alt="LocalVideoFactory 图标">

# LocalVideoFactory · 本地 AI 短视频工厂

### 一段文案，自动成为一条片。

**自动找素材 · 原片智能选段 · 自动剪辑 · 自然配音 · 动态字幕 · 免费配乐**

把零散的创作工具，串成你电脑里的一条短视频生产线。

[简体中文](README.md) · [English](README.en.md) · [下载 Windows 版](https://github.com/hafung/LocalVideoFactory/releases/latest) · [源码运行](docs/building.md) · [反馈建议](https://github.com/hafung/LocalVideoFactory/issues)

[![CI](https://github.com/hafung/LocalVideoFactory/actions/workflows/ci.yml/badge.svg)](https://github.com/hafung/LocalVideoFactory/actions/workflows/ci.yml)
[![Source](https://img.shields.io/badge/source-v0.2.8-d9ff69?labelColor=17181d)](package.json)
[![Windows](https://img.shields.io/badge/desktop-Windows_x64-0078D4)](docs/building.md)
[![Local AI](https://img.shields.io/badge/inference-local_CPU-6d5efc)](#本地-ai-创作栈)
[![License](https://img.shields.io/badge/code-MIT-blue)](LICENSE)

</div>

**LocalVideoFactory** 是一个开源的本地 AI 短视频工厂。输入文案，自动配音、对齐字幕、检索素材并剪辑成片；有原视频，就按内容挑选片段，画面不够则自动找素材补齐。支持声音克隆、动态字幕和免费音乐检索，生成后还能按分镜卡片精修。核心 AI 在本机 CPU 上运行，无需独立显卡。

桌面应用名为 **声织 VoxWeave**。仓库原名 `VoxWeave`，现改为更直观的 `LocalVideoFactory`；已有工程、音色、CLI 和安装包沿用兼容标识。

> **版本说明：** 下文展示 v0.2.8 功能。[安装包与版本说明](https://github.com/hafung/LocalVideoFactory/releases/latest)以已完成发布的版本为准；也可按[源码运行指南](docs/building.md)构建。安装包首次启动需要下载模型，AI 分镜与原片理解模型需单独准备。

## 先看一条真实成片

这条 4.5 秒的搞笑短片由 LocalVideoFactory 制作，可直接播放并听到声音。

https://github.com/user-attachments/assets/1e107cb7-7619-463a-9472-8045865387c5

[下载原始 MP4（4.2 MB）](docs/demos/funny-demo.mp4?raw=true) · [无声动图预览](docs/demos/funny-demo.gif)

成片生成后，可以在工作台预览，并按分镜卡片调整画面和字幕。

![创作工作台：文案、真实成片预览和分镜卡片](docs/screenshots/studio.png)

## 从文案到成片，一条流水线

```text
文案 + 可选原始视频
         ↓
AI 理解文案，规划分镜与素材检索词
         ↓
本地 TTS 配音 → 根据真实声音确定时间轴 → SenseVoice 字幕对齐
         ↓
原片内容选段 / 本地素材匹配 / Pexels 在线补画面 / 动态文字
         ↓
词或短语高亮字幕 + 旁白 / 原声 / BGM 混音
         ↓
成片预览 → 卡片式换画面与字幕精修 → MP4 / MP3 / SRT / ASS
```

## 一个人，也能拥有一条短视频生产线

| 创作环节 | 已有能力 | 帮你省下的工作 |
| --- | --- | --- |
| 🧠 **AI 分镜导演** | 本地 Qwen3.5-4B 理解文案，给分镜生成画面意图与检索词 | 逐句想画面、反复换搜索词 |
| 👁️ **多模态原片选段** | 抽帧视觉理解 + 原声转写 + 语句/镜头边界，按旁白匹配原片内容 | 在长素材里拖动进度条找片段 |
| 🎙️ **自然配音与音色克隆** | Qwen3-TTS 1.7B、本地参考音频提取音色、可复用 `.qvoice` 音色 | 反复录制旁白、调用付费云 TTS |
| ⏱️ **声音驱动时间轴** | 用真实旁白时长编排字幕与画面；对齐不可用时显示估时回退 | 手动对齐口播、字幕和剪点 |
| 🎞️ **自动 B-roll 补画面** | 优先视频素材，本地库 + Pexels 按需补充；图片自动使用短停留 | 下载素材、填补空白画面 |
| ✨ **动态字幕引擎** | 按词/短语高亮、四种字幕风格、手动分组，支持 ASS 和 SRT | 逐字打轴、重做高亮字幕 |
| 🎵 **开放音乐素材库** | Openverse 搜索、试听、下载和用作配乐；默认 CC0，可选 CC BY | 到处找 BGM、遗失授权来源 |
| 🎚️ **三路智能混音** | 旁白、原声、BGM 独立音量；旁白出现时自动压低背景声音 | 来回调整配乐压住人声的问题 |
| 🗂️ **卡片式精修** | 按句或合并相邻几句换画面、试听候选、选择同一视频的其他区间 | 在多轨时间线上做简单替换 |
| 📦 **多格式交付** | H.264/AAC MP4、旁白/混合音轨 MP3、SRT/ASS，画面与字幕同步变速 | 多次转码和分别维护字幕版本 |

AI 分镜与多模态选段需要准备 Qwen3.5-4B 和匹配的视觉投影模型。缺少模型时会回退并显示提示；[配置方式与模型说明](docs/building.md#本地模型与运行时)。

## 看得见，也改得动

### 预览、分镜、换画面，在同一个工作台

先看成片，再按分镜卡片微调。支持 **9:16、16:9、1:1** 画幅；更换某个画面、合并几句共用画面、调整成片倍速，都可以在工作台完成。

### 字幕跟着声音走，重点跟着词语亮

![字幕分组编辑界面](docs/screenshots/captions.png)

从“电商强调”“观点口播”“品牌极简”“信息卡片”中选择风格。生成后可以用 `|` 合并或拆分高亮短语，**更新字幕无需重新合成旁白**。

### 免费音乐，搜到就能试听和入库

![已从 Openverse 入库的 CC0 音乐与许可信息](docs/screenshots/music.png)

在 **更多设置 → 音轨 → 导入 BGM → 免费音乐** 中搜索音乐。默认仅显示 CC0，支持包含需署名 CC BY 曲目的筛选；作者、来源、许可和署名文本随素材保存。点击“用作配乐”，回到工作台后点“生成视频”应用。

### 让人声清楚，让背景有气氛

![音轨音量与配乐自动压低设置](docs/screenshots/audio.png)

分别控制旁白、原声和 BGM。提供原始视频时，可在生成预览后勾选“保留原视频声音”；原声随选中的原片段剪辑，替换画面时仍可保留。只改音轨时，复用已有旁白和分镜。

截图来自真实 Windows 应用与实际生成的演示工程；[截图及示例素材说明](docs/screenshots/README.md)。

## 三步做出第一条短视频

1. **准备应用。** 按[源码运行指南](docs/building.md)启动当前版本；准备所需模型，在素材库导入视频、图片或音频。Pexels 联网素材需要 API Key，Openverse 音乐搜索无需填写 Key。
2. **输入文案，点“生成视频”。** 原始视频可选；没有原片时，从本地素材、在线素材和动态文字中组织画面。
3. **预览、精修、导出。** 换画面、调字幕、选配乐，应用改动后导出 MP4；需要继续剪辑时，另存旁白、混合音轨和字幕。

## 本地 AI 创作栈

**推理在本机，素材按需联网。** 文案理解、原片分析、声音克隆、旁白和字幕对齐在本地运行；在线检索会向相应素材服务发送搜索词。准备好模型和本地素材后，可离线完成核心创作流程。

| 组件 | 职责 |
| --- | --- |
| **Qwen3.5-4B + 视觉投影 / llama.cpp** | 文案分镜、原视频抽帧理解与内容匹配 |
| **Qwen3-TTS 1.7B / 原生 C 引擎** | CPU 本地配音、参考音色提取；支持 INT8、INT4、BF16 |
| **SenseVoice + Silero VAD** | 原声转写、语音分段与字幕对齐 |
| **Qwen3 Embedding 0.6B** | 对素材已有名称、标签和文字描述做语义排序 |
| **HyperFrames + FFmpeg** | 本地预览、时间轴渲染、混音与视频导出 |
| **SQLite + Pexels + Openverse** | 本地素材索引、在线图片/视频、开放授权音乐 |

桌面发行与本地运行脚本面向 **Windows x64**。支持 CPU 推理，无需独立显卡；耗时和内存需求取决于模型、文案与素材长度。模型首次准备需要下载，在线素材功能需要网络。

画面来自原片、素材库、在线素材与动态图形模板。自动标签基于已有文字和规则；视觉理解用于启用多模态模型后的原片分析。

## 开发与构建

```bash
git clone https://github.com/hafung/LocalVideoFactory.git
cd LocalVideoFactory
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

在 Windows PowerShell 中准备运行时并启动：

```powershell
.\scripts\run-local-windows.ps1
```

模型准备、Windows/WSL 开发、便携包、安装包和 CLI 示例见[构建与运行指南](docs/building.md)。CLI 支持脚本化配音与多格式音频输出。

[产品方案](docs/product-spec.zh-CN.md) · [开发文档](docs/development.zh-CN.md) · [SenseVoice CLI](tools/sensevoice-cli/README.md) · [依赖与许可证](LICENSES.md)

## 参与这条生产线

欢迎提交使用反馈、演示作品、字幕模板、素材检索优化和性能改进。请在 Issue 中附上应用/源码版本、操作步骤和可复现的日志；涉及私人素材时，可用替代样例复现。

如果你也想把“写完文案之后的那堆活”交给自己的电脑，欢迎 Star、试用和贡献。

## 协议与致谢

应用代码采用 [MIT License](LICENSE)。模型、原生引擎、FFmpeg、字体和其他依赖遵循各自许可，详见 [LICENSES.md](LICENSES.md)。在线素材以各作品的来源和许可为准；CC BY 内容需要适当署名、附许可链接并注明修改。

声音克隆请取得说话人许可，发布内容时遵守适用法律与平台的 AI 标注要求。
