# Local scene and source-content planner

Qwen3.5-4B Q4_K_M and its matching `mmproj-F16.gguf` vision projector are external resources in portable/offline packages. Both are found relative to the application resources directory after relocation. The existing `semantic/runtime/llama-server.exe` runs CPU inference. Text-only projects load the language model alone; source-video analysis enables the projector and reads sampled frames locally. Source speech uses the bundled SenseVoice/Silero VAD models. Media is never uploaded for analysis.

Run `pnpm setup:scene-model` on Windows to download both pinned Unsloth GGUF resources for [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B). The revision, SHA-256 and size are recorded in `manifest.json`. To import an existing language model, pass `-ModelPath <file>`; the projector is still required. Custom model overrides look for `mmproj-F16.gguf` beside that model; it must match the selected model.

`pnpm package:win` verifies this model before packaging. The model is ignored by Git; its manifest and Apache 2.0 license are tracked. An explicit model selected in settings overrides the bundled model while that file exists. A stale path from another machine falls back to the bundled copy.
