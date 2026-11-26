# 帧舟 FrameSkiff 构建与运行指南

[中文首页](../README.md) · [English overview](../README.en.md)

当前源码版本见 `package.json`。Windows 安装包和对应版本说明见 [GitHub Releases](https://github.com/hafung/LocalVideoFactory/releases/latest)；希望自行构建或体验未发布改动时，请按下文准备环境与资源。

帧舟的源码托管在 `hafung/LocalVideoFactory`。本地数据目录和 CLI 命令沿用 `voxweave`，已有工程、模型缓存和脚本可以继续使用。

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

用当前源码打包的普通 Windows 安装包会在首次启动自动准备配音和字幕模型（约占 4.8 GB）。下载支持后台运行、断点续传、校验和重试。「创作设置」可按需下载智能分镜和原片选段（约 3.4 GB）、按意思找本地素材（约 640 MB）和音色克隆（约 3.9 GB）。完整离线便携包会校验并携带这些资源。

[分镜模型说明](../resources/scene-planner/README.md) · [语义模型说明](../resources/semantic/README.md) · [FFmpeg](../resources/ffmpeg/README.md) · [渲染浏览器](../resources/browser/README.md)

从首启窗口或「创作设置」点击「导入已有模型」，选择之前准备模型时使用的 `resources` 文件夹。应用按清单校验并将已找到的文件复制到模型缓存。按需启用其他功能时也会先从这里查找对应模型。完整模型可断网导入。缓存位于 `%APPDATA%\voxweave\model-resources`，请为需要复制的文件预留空间。

## Windows 安装包离线部署（v0.2.9）

「保存并检测旁白引擎」只检查设置里的引擎和旁白模型。主界面的首启检查按安装目录的 **resources\model-downloads.json** 校验 **%APPDATA%\voxweave\model-resources** 里的 27 个文件。两个检查各自运行，所以设置页显示「引擎就绪」时，主界面仍可能报模型准备失败。

1. 在目标 Windows x64 电脑安装 [VoxWeave-Setup-0.2.9-x64.exe](https://github.com/hafung/LocalVideoFactory/releases/tag/v0.2.9)，打开一次后退出。安装包已包含推理、字幕和导出所需的运行时。模型缓存约占 9 GB，请确认 **%APPDATA%** 所在磁盘有足够空间。
2. 已经用脚本下载模型的用户可直接使用现有的 **resources**。如需补齐，在能访问 Hugging Face 和 GitHub 的 Windows 电脑上解压 [v0.2.9 源码](https://github.com/hafung/LocalVideoFactory/archive/refs/tags/v0.2.9.zip)，在解压后的项目根目录打开 PowerShell，运行以下命令。将准备好的 **resources\models** 和 **resources\semantic\model** 随原目录结构复制到目标电脑。下载步骤可以在另一台电脑完成。

   ~~~powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\download-model.ps1 -Variant custom-1.7b
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\download-model.ps1 -Variant base-1.7b
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-sensevoice.ps1
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-semantic.ps1
   ~~~

3. 保持应用关闭，在目标电脑的 PowerShell 中修改前两行路径后运行下列代码。它按安装包的清单校验并复制文件，已经校验通过的缓存文件会直接复用。源码脚本下载的 **speech_tokenizer** 会放到安装包共用的 **models\qwen3-tts-tokenizer**。复制与校验可在断网时完成。

   ~~~powershell
   $installedResources = 'D:\VoxWeave\resources'      # 安装目录下的 resources
   $downloadedResources = 'E:\LocalVideoFactory\resources' # 已下载模型的 resources
   $ErrorActionPreference = 'Stop'
   $cache = Join-Path $env:APPDATA 'voxweave\model-resources'
   $catalog = Get-Content -LiteralPath (Join-Path $installedResources 'model-downloads.json') -Raw -Encoding UTF8 | ConvertFrom-Json
   $files = @($catalog.files)
   foreach ($archive in $catalog.archives) { $files += @($archive.files) }

   function Test-ModelHash($file, $hash) {
       (Test-Path -LiteralPath $file -PathType Leaf) -and
           ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -eq $hash)
   }

   $missing = foreach ($entry in $files) {
       $relative = $entry.path.Replace('/', '\')
       $target = Join-Path $cache $relative
       if (Test-ModelHash $target $entry.sha256) { continue }
       $source = Join-Path $downloadedResources $relative
       if ($relative.StartsWith('models\qwen3-tts-tokenizer\') -and
           !(Test-Path -LiteralPath $source -PathType Leaf)) {
           $leaf = Split-Path -Leaf $relative
           $source = Join-Path $downloadedResources "models\qwen3-tts-1.7b-customvoice\speech_tokenizer\$leaf"
       }
       if (!(Test-ModelHash $source $entry.sha256)) {
           $entry.path
           continue
       }
       New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
       Copy-Item -LiteralPath $source -Destination $target -Force
   }
   if ($missing) {
       $newline = [Environment]::NewLine
       throw ("以下文件缺失或 SHA-256 不符：" + $newline + ($missing -join $newline))
   }
   Write-Host "模型文件齐全，共 $($files.Count) 个：$cache"
   ~~~

4. 断网启动应用。首次启动会读取大文件做 SHA-256 校验，校验完成后提示消失。程序会自动写入对应版本的 **manifest.json**。如果设置里保存过其他模型路径，可以把「旁白模型目录」切换到 **%APPDATA%\voxweave\model-resources\models\qwen3-tts-1.7b-customvoice** 展开后的绝对路径。「引擎路径」指向安装目录的 **resources\engine\qwen_tts.exe**。启用本地语义检索时，使用安装目录的 **resources\semantic\runtime\llama-server.exe** 和缓存里的 **semantic\model\Qwen3-Embedding-0.6B-Q8_0.gguf**。
5. 用一两句文案和预设音色试生成，可先导入本地视频或图片。文案分镜可先用「使用关键词规则」。如需 AI 分镜，另外准备 [Qwen3.5-4B 与匹配的视觉投影](../resources/scene-planner/README.md)，在设置中选择语言模型，把 **mmproj-F16.gguf** 放在同目录。

如果仍显示准备失败，请记录安装包版本、横幅完整报错和已准备的文件数。上面 PowerShell 输出的缺失或校验失败文件列表也有助于定位问题。

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
- **在线画面：** 在「创作设置 → 在线补画面」或素材库的 Pexels 页填写已有 API 密钥。自动成片和换画面可按需检索视频和图片。没有密钥时，可以用同一页的 Pixabay 链接在浏览器找素材，下载后导入。
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

Windows 安装包名为 `FrameSkiff-Setup-<version>-x64.exe`。在线下载版的构建机需要原生引擎、FFmpeg、浏览器和语义运行时。`scripts/setup-semantic.ps1 -RuntimeOnly` 可以只准备运行时。同版本产物已存在时，脚本会停止以保留旧文件。

CI 在 Linux/Windows 运行检查，交叉构建 Windows 原生引擎，并生成安装包。Actions 附件名为 `LocalVideoFactory-Windows-Setup`；与 `package.json` 匹配的 `v<version>` 标签会发布到 Releases。更新 README 或推送 main 不会自动把源码版本发布成新的 Release。

模型权重和可再发行二进制不提交到 Git。依赖及再发行许可见 [LICENSES.md](../LICENSES.md)。
