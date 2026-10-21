# Third-party notices

VoxWeave application code is provided under the MIT License.

The optional inference backend is [gabriele-mastrapasqua/qwen3-tts](https://github.com/gabriele-mastrapasqua/qwen3-tts), Copyright (c) 2025 Gabriele Mastrapasqua, licensed under the MIT License.

Qwen3-TTS 1.7B CustomVoice and Base model weights are published by the Qwen team under Apache License 2.0. The offline resource directory keeps both models at pinned revisions with their own manifests and Apache notices. Base extracts cloned voice profiles; CustomVoice reads both preset and cloned voices through the native engine's cross-model voice support.

OpenBLAS is Copyright (c) 2011-2014, The OpenBLAS Project, and is distributed under the BSD 3-Clause License. The reviewed Windows engine bundle includes OpenBLAS 0.3.34, LLVM-MinGW winpthreads, LZ4 notices, the required DLLs, and hash-verified build metadata under `resources/engine/`.

The bundled FFmpeg 8.1 executable is the Windows x64 **GPL v3 or later** build produced by [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), including libx264 for software H.264 rendering. It replaces the earlier LGPL-only executable, which lacked Producer's required encoder. Its license is bundled at `resources/ffmpeg/LICENSE.txt`; exact binary provenance and hashes are recorded in its manifest. Corresponding source/build recipes are linked in `resources/ffmpeg/README.md`. FFmpeg runs as a separate executable; its GPL terms must be retained with redistribution.

[HyperFrames Player and Producer](https://github.com/heygen-com/hyperframes) are distributed under the Apache License 2.0. VoxWeave keeps both behind a renderer-neutral EditPlan boundary. Producer renders the same local composition used by preview.

[Puppeteer](https://github.com/puppeteer/puppeteer) is distributed under the Apache License 2.0. The pinned Chrome for Testing Headless Shell 152.0.7977.75 is bundled under `resources/browser/`; its complete bundled license and third-party credits are in `chrome-headless-shell-win64/LICENSE.headless_shell`.

[`@node-rs/jieba`](https://github.com/napi-rs/node-rs) is distributed under the MIT License and provides local Chinese word segmentation.

The independent SenseVoice CLI additionally embeds [cppjieba 5.6.4](https://github.com/yanyiwu/cppjieba/tree/v5.6.4) and its dictionaries, and [limonp](https://github.com/yanyiwu/limonp/tree/5c82a3f17e4e0adc6a5decfe245054b0ed533d1a), under their MIT licenses. Source/resource hashes and archive provenance are recorded under `tools/sensevoice-cli/third_party/segmentation-manifest.json`; the standalone bundle retains both licenses. The Electron app continues to use its existing jieba binding.

The optional Qwen3 Embedding 0.6B GGUF Q8_0 model is published by Qwen under Apache License 2.0. Its pinned model hash, source, and notice are under `resources/semantic/`. The separate llama.cpp b11039 Windows CPU runtime is MIT-licensed; its LLVM OpenMP dependency includes its own notice. `scripts/setup-semantic.ps1` verifies the original downloads before installation, and the resulting resource files are hash-verified during offline packaging.

The bundled scene planner uses [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B) under Apache License 2.0, in the [Unsloth Q4_K_M GGUF conversion](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF), together with its F16 vision projector for local source-video frame analysis. Both resources' revision, sizes and SHA-256 hashes are pinned in `resources/scene-planner/manifest.json`; the Apache notice is distributed beside the weights. Inference uses the same separate llama.cpp runtime.

[`sherpa-onnx`](https://github.com/k2-fsa/sherpa-onnx) is distributed under the Apache License 2.0 and provides the native ONNX Runtime integration for local alignment. The pinned SenseVoiceSmall weights are redistributed under the bundled FunASR Model Open Source License Agreement v1.1, which requires source/author attribution and retention of the model name. Silero VAD is MIT-licensed. Model files and all three notices are hash-verified under `resources/models/sensevoice-small/`; commercial distribution should still receive a license review because the FunASR model agreement is a custom license.

[Koffi](https://koffi.dev/) is MIT-licensed. On Windows, the isolated speech worker uses it to preload the matching bundled ONNX Runtime DLL by absolute path before loading sherpa-onnx.
