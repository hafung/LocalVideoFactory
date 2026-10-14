# VoxWeave · Private, local AI voice creation

<p align="center">
  <strong>Turn scripts into expressive, production-ready speech—on your own computer.</strong><br>
  No cloud upload. No subscription. No discrete GPU required.
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="https://github.com/hafung/VoxWeave/releases/latest">Download for Windows</a> ·
  <a href="#command-line">CLI</a>
</p>

VoxWeave (声织) is a local-first voice studio for video makers, podcasters, educators, and developers. It combines a focused desktop editor with a scriptable CLI and a native C inference engine powered by Qwen3-TTS 1.7B CustomVoice on CPU.

Your drafts, reference voices, and generated audio stay on your machine. The Windows installer bundles native runtimes and automatically downloads models on first launch. Once the models are ready, creation works offline.

> **Current release:** v0.2.1 for Windows x64. macOS and Linux packages are on the roadmap; the application layer is already built on cross-platform Electron, React, TypeScript, and C.

## Why creators use VoxWeave

- **Keep unreleased content private.** Scripts and voice samples are processed locally instead of being sent to a third-party API.
- **Create on ordinary hardware.** CPU inference and INT8/INT4 modes make local voice production possible without a discrete GPU.
- **Spend time editing, not configuring.** The Windows installer includes the native engine, FFmpeg, and rendering runtime; model downloads happen automatically with progress, resume, and hash verification.
- **Narrate plain text.** The app groups nearby sentences, lets TTS adapt expression and pace to their meaning, and fills paragraph pauses without requiring markup.
- **Fit it into a real workflow.** Export WAV, FLAC, MP3, Ogg/Opus, or M4A/AAC from the GUI or automate batches with the CLI.
- **Stay responsive on long jobs.** Inference runs in an isolated native process, so loading a model or cancelling a task does not freeze the editor.

## What it can do today

- Text-to-speech in the 10 languages supported by Qwen3-TTS, including Chinese, English, and Japanese
- Voice cloning with 1.7B Base from reference audio; 1.7B CustomVoice reads the saved profile with narration instructions through the native engine
- Reusable `.qvoice` voice profiles
- Automatic narration with 1.7B CustomVoice, counting existing silence toward paragraph pauses
- Captions and scene boundaries aligned after audio synthesis, with per-paragraph estimates excluding inserted silence when alignment is unavailable
- BF16, INT8, and INT4 inference controls
- Automatic normalization of common reference-audio formats to 24 kHz mono PCM
- Shared parsing, inference settings, audio assembly, and transcoding behavior across GUI and CLI

## Download, install, and prepare models

Download the latest Windows build from [GitHub Releases](https://github.com/hafung/VoxWeave/releases/latest).

- **GitHub Setup EXE:** install and launch. The first launch downloads approximately 9 GB of Qwen3-TTS CustomVoice/Base, their shared speech tokenizer, SenseVoice/Silero VAD, and the semantic retrieval model from official sources. Keep internet access and sufficient free disk space during setup. The app displays progress and a retry button if downloads fail; restarting resumes partial downloads. Models stay under `%APPDATA%\voxweave\model-resources` and are reused across app upgrades.
- **Local offline portable ZIP:** developers can still build the complete offline directory package with `pnpm package:win`. GitHub CI publishes the installer; multi-gigabyte model weights are excluded from its artifacts.

For a local build, extract the ZIP and launch `VoxWeave.exe`; do not run it from inside the archive.

Customers do not need Node.js, an account, API key, Python, or WSL. After automatic model preparation, creation works offline. An engine/model override remains available in Settings for developers testing custom builds. Clean-machine installer and full-download acceptance still require a Windows release test.

## Command line

The complete Windows installation includes a CLI and does not require Node.js:

```powershell
& 'C:\Users\you\AppData\Local\Programs\voxweave\声织 VoxWeave.exe' --cli `
  -t 'Hello from VoxWeave. Start with an ordinary script.' -o .\hello.mp3 -f mp3 -l English

& 'C:\Users\you\AppData\Local\Programs\voxweave\声织 VoxWeave.exe' --cli --help
```

You can also call `resources\cli\voxweave.cmd` from the installation directory. Output formats are `wav`, `flac`, `mp3`, `opus`, and `m4a`; reference audio may be WAV, FLAC, MP3, Ogg/Opus, or M4A/AAC.

## Develop from source

The desktop application requires Node.js 22+ and pnpm:

```bash
pnpm install
pnpm dev
```

Quality checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```

On an online Windows build machine, populate the external resources once and build the directory package:

```powershell
.\scripts\download-model.ps1 -Variant custom-1.7b
.\scripts\download-model.ps1 -Variant base-1.7b
.\scripts\setup-sensevoice.ps1
.\scripts\setup-ffmpeg.ps1
pnpm verify:resources
pnpm package:win
```

`package:win` creates the complete offline `release\VoxWeave-Portable-<version>-<arch>.zip`. `package:win:installer` creates `release\VoxWeave-Setup-<version>-x64.exe` and its SHA-256 file, includes only native runtimes and a validated model download catalog, and does not require model weights on the build machine. Prepare the native engine, FFmpeg, browser, and semantic runtime first (`scripts/setup-semantic.ps1 -RuntimeOnly` skips the embedding weight). `package:win:offline-installer` retains the previous full offline NSIS option, subject to installer size limits.

GitHub Actions checks the app on Linux and Windows, cross-compiles the Windows Qwen engine on Linux, and builds the model-free NSIS installer on Windows for `main`, version tags, and manual runs. The installer is available as the `VoxWeave-Windows-Setup` Actions artifact. Pushing a `v<package.json version>` tag also publishes the installer and checksum to GitHub Releases.

For CLI development, point VoxWeave to a compatible engine, model, and FFmpeg binary:

```powershell
$env:VOXWEAVE_ENGINE='C:\path\to\qwen_tts.exe'
$env:VOXWEAVE_MODEL='D:\models\qwen3-tts-1.7b-customvoice'
$env:VOXWEAVE_FFMPEG='C:\path\to\ffmpeg.exe'
pnpm cli --text 'Hello from VoxWeave.' --output .\hello.wav --language English
```

Multi-gigabyte model weights and redistributable binaries are kept out of Git. The setup scripts place them under `resources`, and the strict packager refuses to produce an offline deliverable while a required runtime file is missing.

## Architecture and platform direction

```text
src/       React creation studio
electron/  Desktop process, preload bridge, and native-engine adapter
shared/    Markup parser, types, and WAV assembly shared by GUI and CLI
cli/       Scriptable command-line entry point
engine/    Pinned native C inference engine source
scripts/   Model and engine setup helpers
```

Electron, React, TypeScript, and the native C backend are portable foundations. The current release pipeline, bundled DLL closure, and installer are Windows-specific. Releasing on macOS and Linux still requires platform-native engine builds, resource packaging, CI, and end-to-end validation.

VoxWeave is intended to grow beyond speech generation into a private creator toolkit: batch narration, timeline-aware audio, subtitle alignment, media assembly, and eventually local-first remixing and content production.

## Responsible use

Only clone a voice when you have the speaker's permission. Do not use VoxWeave for impersonation, fraud, harassment, or deceptive media. You are responsible for complying with applicable laws and platform disclosure rules.

## License and acknowledgements

VoxWeave application code is released under the [MIT License](LICENSE). The model, native engine, FFmpeg, OpenBLAS, fonts, and other dependencies retain their respective licenses; see [LICENSES.md](LICENSES.md) for details.
