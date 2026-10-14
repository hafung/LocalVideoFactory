# 声织 VoxWeave · 私密、本地的 AI 语音创作台

<p align="center">
  <strong>把文案变成可直接用于作品的自然语音，一切都在你自己的电脑上完成。</strong><br>
  不上传云端 · 不按月付费 · 不需要独立显卡
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://github.com/hafung/VoxWeave/releases/latest">下载 Windows 版</a> ·
  <a href="#命令行">命令行</a>
</p>

声织 VoxWeave 是为视频博主、播客、知识区作者、教育工作者和开发者打造的本地语音工作台。它把专注好用的桌面创作界面、可自动化的 CLI 与 Qwen3-TTS 1.7B CustomVoice 原生 CPU 推理引擎组合在一起。

未发布的选题、口播文案、参考音色和生成结果都留在你的电脑里。Windows 安装包内置原生运行时，首次启动自动下载模型，完成后即可离线创作；无需 Python、WSL 或 NVIDIA 显卡。

> **当前版本：** v0.2.1，支持 Windows x64。macOS 与 Linux 安装包在路线图中；应用层已经采用可跨平台的 Electron、React、TypeScript 与 C 技术栈。

## 它解决哪些创作者痛点

- **敏感文案不出本机。** 未发布脚本和真人音色无需交给第三方云服务，降低内容泄露与素材滥用风险。
- **普通电脑也能做 AI 配音。** 支持 CPU 推理与 INT8/INT4 模式，没有独立显卡也能建立自己的本地语音工作流。
- **自动准备创作环境。** 安装包带齐原生引擎、FFmpeg 和渲染运行时；首次启动自动下载模型，显示进度并支持断点续传、哈希校验和失败重试。
- **普通文案直接配音。** 系统自动合并同段短句，由 TTS 根据文意调整语气和节奏，并补齐段落停顿；用户无需填写朗读标签。
- **真正进入生产流程。** GUI 可快速试听与导出，CLI 可做批量旁白；支持 WAV、FLAC、MP3、Ogg/Opus、M4A/AAC。
- **长任务也不拖死界面。** 推理运行在隔离的原生子进程中，模型加载、任务取消与异常不会把编辑器一起卡住。

## 目前已经能做什么

- 文本转语音，覆盖 Qwen3-TTS 支持的 10 种语言，包括中文、英文和日文
- 使用 1.7B Base 从参考音频提取音色，再通过原生引擎由 1.7B CustomVoice 加载并接受朗读指令
- 保存并复用 `.qvoice` 音色文件
- 默认 1.7B CustomVoice 自动朗读；段间停顿计入模型已有静音，避免重复叠加
- 在最终音频生成后对齐字幕和分镜；对齐失败时仅对该段估时，并排除段间静音
- BF16 / INT8 / INT4、温度、Top-k、Top-p、随机种子与线程数控制
- 常见参考音频自动标准化为 24 kHz 单声道 PCM
- GUI 与 CLI 共用文本解析、推理参数、音频拼接和转码逻辑
- 成片倍速同时用于预览、MP4、MP3 与字幕导出，变速保留音高
- 原声、旁白和配乐统一通过“生成视频”更新；只改音轨时复用已有旁白与分镜，完整重新生成也保留音轨选择
- 单独导出旁白 MP3、混合音轨 MP3、SRT 和带逐词强调的 ASS 字幕

## 下载安装并准备模型

前往 [GitHub Releases](https://github.com/hafung/VoxWeave/releases/latest) 下载最新版：

- **GitHub Setup 安装版：** 安装后启动，应用会从官方来源自动下载约 9 GB 模型，包括 Qwen3-TTS CustomVoice/Base、共享语音 tokenizer、SenseVoice/Silero VAD 和语义检索模型。首次准备需要联网并预留足够磁盘空间；界面显示进度，失败后可重试，关闭后再启动会续传。模型保存到 `%APPDATA%\voxweave\model-resources`，升级应用时复用。
- **本地完整离线 Portable 包：** 开发者仍可通过 `pnpm package:win` 构建带齐模型的目录 ZIP。GitHub 构建改为安装包，不再把数 GB 模型放入构建附件。

本地构建产物可直接双击解压目录中的 `VoxWeave.exe`；不要在 ZIP 内直接运行。

客户侧不需要 Node.js、账号、API Key、Python 或 WSL。模型自动准备完成后即可离线创作。设置页仍提供引擎和模型覆盖入口，方便开发者测试自定义版本；正式发布前仍需完成 Windows 干净机安装和完整下载验收。

## 命令行

Windows 完整版自带 CLI，不需要 Node.js：

```powershell
& 'C:\Users\你\AppData\Local\Programs\voxweave\声织 VoxWeave.exe' --cli `
  -t '你好，欢迎使用声织。输入普通文案，就能开始配音。' -o .\hello.mp3 -f mp3 -l Chinese

& 'C:\Users\你\AppData\Local\Programs\voxweave\声织 VoxWeave.exe' --cli --help
```

也可以直接调用安装目录内的 `resources\cli\voxweave.cmd`。输出格式支持 `wav`、`flac`、`mp3`、`opus` 和 `m4a`；参考音频支持 WAV、FLAC、MP3、Ogg/Opus 与 M4A/AAC。

## 从源码开发

桌面应用需要 Node.js 22+ 与 pnpm：

```bash
pnpm install
pnpm dev
```

质量检查：

```bash
pnpm typecheck
pnpm test
pnpm build
```

在可联网的 Windows 构建机上先一次性准备外部资源，再生成目录便携包：

```powershell
.\scripts\download-model.ps1 -Variant custom-1.7b
.\scripts\download-model.ps1 -Variant base-1.7b
.\scripts\setup-sensevoice.ps1
.\scripts\setup-ffmpeg.ps1
.\scripts\setup-render-browser.ps1
pnpm verify:resources
pnpm package:win
```

`package:win` 仍生成完整离线 Portable 目录、ZIP 和 SHA-256 文件，严格校验全部资源。`package:win:installer` 改为生成不含模型的 `release\VoxWeave-Setup-<version>-x64.exe` 和 SHA-256 文件，只打包运行时与经过验证的下载清单，构建机不需要下载模型。先准备原生 Qwen 引擎、FFmpeg、渲染浏览器和语义运行时；`scripts/setup-semantic.ps1 -RuntimeOnly` 可跳过 embedding 权重。原有完整离线 NSIS 模式保留为 `package:win:offline-installer`，受安装包体积上限约束。两种布局都共用一份语音 tokenizer，减少约 651 MiB 磁盘占用；在线安装版也减少同等下载量。

GitHub Actions 在 Linux 和 Windows 检查应用，在 Linux 交叉编译 Windows Qwen 引擎，再在 Windows 构建安装包。`main` 推送、版本标签和手动运行会生成 `VoxWeave-Windows-Setup` 构建附件；推送与 `package.json` 版本一致的 `v<version>` 标签时，自动把安装包和校验文件发布到 GitHub Releases。

当前开发发行物为 `release\VoxWeave-Portable-0.2.2-x64` 和同名 ZIP。0.2.1 是旧界面包，顶部“素材库”会直接打开文件选择框；0.2.2 会打开完整素材管理界面。

同名发行目录或 ZIP 已存在时脚本会停止，保留旧包。新版本先更新 `package.json` 版本；同版本临时测试可指定其他输出目录：

```powershell
pnpm package:win -ReleaseDir .\release-test
pnpm smoke:package:win -PackageDir .\release-test\VoxWeave-Portable-0.2.2-x64 -WithExport
```

打包请使用 Windows Node/pnpm 和 Windows 安装的依赖，不要复用 WSL 的 `node_modules`。开发环境若同时使用两者，可用独立 Windows staging 目录，并通过打包脚本的 `-ProjectDir`、`-ResourceDir`、`-ReleaseDir` 指定输入与输出；`-SkipBuild` 仅适用于已同步最新构建产物的目录。

本机 Windows PowerShell 没有全局 `pnpm` 命令时，可直接运行已有 Node/pnpm CLI 的引导脚本。它会在独立 staging 目录安装 Windows 依赖、构建并生成 `release-dev` 中的便携目录和 ZIP，不会覆盖现有 `release`：

```powershell
.\scripts\build-portable-windows.ps1
```

此脚本默认使用 `C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node` 下的运行时；换机器时通过 `-NodePath` 与 `-PnpmCliPath` 指定其他路径。已存在同版本包时，会在同一输出目录中自动递增补丁版本号（如 `0.2.2` → `0.2.3`），不覆盖旧包。版本号仅写入临时 staging 中的 `package.json`，不修改源码版本；手动指定 `-ReleaseDir` 时也适用。

打包时会优先复用当前 Windows 用户 `%LOCALAPPDATA%\electron\Cache` 中与依赖版本匹配的 Electron x64 ZIP，避免重复下载；缓存中没有时仍会正常下载。

开发 CLI 时，需要指定兼容的引擎、模型和 FFmpeg：

```powershell
$env:VOXWEAVE_ENGINE='C:\path\to\qwen_tts.exe'
$env:VOXWEAVE_MODEL='D:\models\qwen3-tts-1.7b-customvoice'
$env:VOXWEAVE_FFMPEG='C:\path\to\ffmpeg.exe'
pnpm cli --text '你好，欢迎使用声织。' --output .\hello.wav --language Chinese
```

数 GB 的模型权重与可再发行二进制不会进入 Git。准备发行资源时由仓库脚本下载到 `resources`，严格打包脚本会在任何必需运行时缺失时拒绝生成离线包。

## 架构与跨平台方向

```text
src/       React 创作台界面
electron/  桌面主进程、预加载桥和原生引擎适配器
shared/    GUI/CLI 共用标记解析、类型与 WAV 拼接
cli/       可脚本化命令行入口
engine/    固定版本的原生 C 推理引擎源码
scripts/   模型和引擎准备工具
```

Electron、React、TypeScript 和原生 C 后端都具备跨平台基础。目前的发行流水线、DLL 资源闭包和安装程序仍是 Windows 专用；真正发布 macOS/Linux 版本还需要对应平台的引擎构建、资源打包、CI 和端到端验证。

当前开发版本已支持“文案 + 可选原视频 → TTS → 字幕对齐 → 本地素材补画面 → 预览 → MP4 导出”。预览生成后在“更多设置 → 音轨”中可选择保留原视频声音，分别调整旁白、原声和本地 BGM 的音量，并设置旁白出现时是否压低原声或配乐；应用试听后再导出 H.264/AAC 视频。旧工程默认关闭原声。原声从视频开头连续播放，到原视频结束为止；替换画面期间也会继续，且不会在原视频结束后循环。

顶部“素材库”支持多选导入视频、图片和音频、检索、预览、批量人工标签及规则自动标签。Pexels 页可配置 API Key，使用中英文关键词搜索并选择下载免费图片/视频；下载素材保留作者和许可来源。没有 Key 也可以完整使用本地流程。自动标签目前基于可读名称、搜索词和媒体属性等规则，不代表视觉 AI 内容识别；Pexels 下载 ID、UUID 和存储目录不会成为标签，已有 Pexels 素材会在启动时清理旧自动标签。

分镜“换画面”同时展示本地视频/图片和 Pexels 视频/图片候选（配置了 API Key 且有检索词时）；在线候选只有用户选择后才下载入库。视频按原始时间选取足够长的片段，不循环；成片倍速统一作用于画面、音轨和字幕，分镜卡片与覆盖范围显示变速后的成片时间，原素材时间保持原值。候选视频也按成片倍速试听。画幅影响排序，但不是硬性门槛。当前视频允许选择其他时间段，候选会标注关键词相关、文字语义排序或填充画面。

提供原始视频时，旁白时间 0 秒起优先连续使用原视频同一时间位置；原视频时长内不会自动插入额外 B-roll。原视频结束后剩余的旁白时间才进入本地补画面/动态文字。对原视频分镜点“换画面”只替换选中的时间段，其他原视频片段保持原样；已被其他分镜占用的原视频时间段不再作为可替换候选，原视频用尽后也不会自动重播开头。当前替换粒度是按旁白分镜时间段，可合并相邻几句，还没有任意单帧编辑。

现在可在文案下方另填“画面方向”，用于搜索和挑选视频/图片素材，不会读成旁白、不参与 TTS，也不会自动调色或添加特效。Qwen3-TTS 根据文案本身的语义决定旁白的情绪、重音、语速和停顿。生成工程时会从整篇文案提取主题词，结合可选的画面方向保存到工程；每条分镜的关键词会带入全篇主题。短句如“你好”会继承全篇主题；相邻、主题相近的短句会尽量共用一个连续画面。“换画面”可选覆盖这一句或后面几句，字幕仍逐句显示；一个长视频也可在不同镜头使用不同时间段。视频镜头切点检测使用本机 FFmpeg，失败时回退到均匀时间段。

本地 CPU 语义检索使用 Qwen3 Embedding 0.6B Q8_0 与 llama.cpp。Windows 开发/打包前运行 `scripts/setup-semantic.ps1`，脚本会从官方 Hugging Face 与 GitHub 下载、校验 SHA-256 并放进 `resources/semantic/`；也可传 `-ModelPath`、`-ArchivePath` 使用已有文件。应用会自动发现资源包，设置页仍可指定其他路径或关闭。候选检索会把整篇文案和当前分镜一起编码，仅对素材库中已有的名称、标签和文字描述做语义排序；首次检索按需启动子进程，模型不可用时回退到规则检索。此功能不会分析视频像素，也不会把文案或媒体发送到服务端。

新构建机需要先运行 `scripts/setup-render-browser.ps1` 与 `scripts/setup-ffmpeg.ps1`。导出使用固定的离线浏览器和包含 libx264 的 FFmpeg **GPL** 包；详细许可证见 `LICENSES.md`。此开发版本已验证短样片导出，更新后的安装包与长视频压力验收尚未完成。

自动成片方向已经明确为“文案 + 可选原始视频 → TTS → 逐词字幕 → 自动 B-roll → 成品视频”，而不是通用剪辑器。详细决策见：

- [自动成片产品方案](docs/product-spec.zh-CN.md)
- [自动成片开发文档](docs/development.zh-CN.md)

## 负责任地使用

请只在获得说话人许可时克隆其声音。不得将声织用于冒充、诈骗、骚扰或制作欺骗性内容。使用者有责任遵守所在地法律及内容平台的 AI 标注规则。

## 开源协议与致谢

声织应用代码采用 [MIT License](LICENSE)。模型、原生引擎、FFmpeg、OpenBLAS、字体和其他依赖保留各自协议，详情见 [LICENSES.md](LICENSES.md)。
