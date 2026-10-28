# LocalVideoFactory 构建与运行指南

[中文首页](../README.md) · [English overview](../README.en.md)

当前源码版本为 `package.json` 中的 v0.2.8。GitHub 最新历史安装包为 v0.2.1，仍偏重语音创作；首页截图中的自动成片与在线音乐能力请使用当前源码构建。

应用内名称、数据目录、CLI 命令及安装包文件名仍保留 `声织 VoxWeave` / `voxweave`，以兼容已有工程和脚本。GitHub 仓库已更名为 `hafung/LocalVideoFactory`。

## 环境

- 当前桌面启动与打包脚本面向 Windows x64。
- 开发需要 Node.js 22+ 和 pnpm（版本见 `package.json` 的 `packageManager`）。
- 推理使用 CPU；运行时长和内存需求随模型和输入增长。模型与本地素材准备后，核心流程可离线运行。
- WSL 与 Windows 应分别安装依赖，避免混用原生模块。

```bash
git clone https://github.com/hafung/LocalVideoFactory.git
cd LocalVideoFactory
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## 本地模型与运行时

在 Windows PowerShell 中准备资源。以下脚本会下载模型或运行时并校验对应清单；初次准备需要网络与充足磁盘空间。

```powershell
# 配音、音色克隆与字幕对齐
.\scripts\download-model.ps1 -Variant custom-1.7b
.\scripts\download-model.ps1 -Variant base-1.7b
.\scripts\setup-sensevoice.ps1

# 视频、渲染浏览器和本地语义检索
.\scripts\setup-ffmpeg.ps1
.\scripts\setup-render-browser.ps1
.\scripts\setup-semantic.ps1

# AI 分镜及原片抽帧理解：语言模型 + 匹配的视觉投影
pnpm setup:scene-model
```

还需要兼容的原生 Qwen3-TTS 引擎，见[引擎资源说明](../resources/engine/README.md)；已有构建产物可通过 `scripts/import-qwen-engine.ps1 -SourceDir <目录>` 导入。开发环境可通过设置界面或环境变量指定引擎与模型。

普通安装包内置原生运行时，首次启动下载约 9 GB 的语音与检索模型，支持进度、断点续传、哈希校验和失败重试。**Qwen3.5-4B 和视觉投影不在当前安装包的首启下载清单中**，需要单独准备：运行 `pnpm setup:scene-model`，或在设置中选择已下载的语言模型，匹配的 `mmproj-F16.gguf` 放在同目录。完整离线便携包会校验并携带分镜资源。

[分镜模型说明](../resources/scene-planner/README.md) · [语义模型说明](../resources/semantic/README.md) · [FFmpeg](../resources/ffmpeg/README.md) · [渲染浏览器](../resources/browser/README.md)

## 在 Windows 启动

资源准备好后，从项目目录执行：

```powershell
.\scripts\run-local-windows.ps1
```

此脚本在 `.windows-stage-local` 中准备 Windows 依赖和构建产物，复用项目的 `resources`，然后启动应用。也可加 `-PrepareOnly` 只构建；机器没有全局 Node/pnpm 时，传入 `-NodePath <node.exe>` 和 `-PnpmCliPath <pnpm.cjs>`。

源码修改后关闭窗口并重新运行脚本。已经在 Windows 项目目录安装好依赖时，也可使用：

```powershell
pnpm dev
# 或构建后运行
pnpm build
pnpm start
```

UI 开发与单元测试可在 Linux/WSL 进行；当前仓库尚未提供完整的 macOS/Linux 桌面发行闭包。

## 素材和音轨

- **本地素材：** 素材库支持导入视频、图片和音频，检索、预览及批量标签。导入本地素材时保留原文件路径，请保留原文件。
- **在线画面：** 在素材库的 Pexels 页配置 API Key。自动成片和换画面可按需检索视频/图片。
- **在线音乐：** “导入 BGM → 免费音乐”使用 Openverse，无需填写 Key。默认 CC0，可选包含 CC BY。作者、来源、许可及署名文本会保存在素材库。
- **保留原声：** 添加原片并生成预览后，在“更多设置 → 音轨”勾选“保留原视频声音”。默认关闭。原声按选中的片段编排，结束后不循环。
- **应用设置：** 选定 BGM 或调整音量后点击“生成视频”。只修改音轨时会复用旁白和分镜；再导出 MP4。

## CLI 配音

CLI 保留 `voxweave` 命令名，支持脚本化配音。源码开发可指定引擎、模型和 FFmpeg：

```powershell
$env:VOXWEAVE_ENGINE='C:\path\to\qwen_tts.exe'
$env:VOXWEAVE_MODEL='D:\models\qwen3-tts-1.7b-customvoice'
$env:VOXWEAVE_FFMPEG='C:\path\to\ffmpeg.exe'
pnpm cli --text '一段文案，自动成为一条片。' --output .\hello.mp3 --format mp3 --language Chinese
pnpm cli --help
```

安装包中的应用可通过 `--cli` 进入同一入口，也可用安装目录下的 `resources\cli\voxweave.cmd`。音频输出支持 WAV、FLAC、MP3、Ogg/Opus 和 M4A/AAC；CLI 暂以配音为主。

## 验证与打包

```bash
pnpm typecheck
pnpm test
pnpm build
```

界面回归脚本使用 `VOXWEAVE_UI_URL` 指定已启动的 Vite 地址，默认 `http://127.0.0.1:5178`；`VOXWEAVE_CHROME` 可指定本机 Chrome：

```bash
pnpm exec vite --host 127.0.0.1 --port 5178
# 在另一终端中运行；API 使用可重复的测试数据
pnpm smoke:library:ui
pnpm smoke:music:ui
```

Windows 打包使用 Windows Node/pnpm：

```powershell
pnpm verify:resources
pnpm package:win                    # 完整离线目录、ZIP、SHA-256
pnpm package:win:installer          # 首启下载模型的安装包
pnpm package:win:offline-installer  # 完整离线 NSIS 安装包，受体积上限约束
```

安装包命名保留 `VoxWeave-Setup-<version>-x64.exe`。模型下载版构建机无需语音权重，但需要原生引擎、FFmpeg、浏览器和语义运行时；`scripts/setup-semantic.ps1 -RuntimeOnly` 可跳过 embedding 权重。同版本产物已存在时，脚本会停止以保留旧文件。

CI 在 Linux/Windows 运行检查，交叉构建 Windows 原生引擎，并生成安装包。Actions 附件名为 `LocalVideoFactory-Windows-Setup`；与 `package.json` 匹配的 `v<version>` 标签会发布到 Releases。更新 README 或推送 main 不会自动把源码版本发布成新的 Release。

模型权重和可再发行二进制不提交到 Git。依赖及再发行许可见 [LICENSES.md](../LICENSES.md)。
