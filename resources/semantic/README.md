# Optional CPU semantic retrieval pack

Run `powershell -ExecutionPolicy Bypass -File scripts/setup-semantic.ps1` from the project root on Windows. The script installs Qwen3 Embedding 0.6B Q8_0 and the llama.cpp b11039 Windows x64 CPU runtime, verifies the official model and archive hashes, and writes `manifest.json`. Existing verified downloads can be supplied with `-ModelPath` and `-ArchivePath`.

For the GitHub installer, pass `-RuntimeOnly` to prepare just the runtime and licenses. The application downloads the embedding weight into its user data directory on first launch.

The model is from <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF> (Apache 2.0). The runtime is from <https://github.com/ggml-org/llama.cpp/releases/tag/b11039> (MIT), with the bundled LLVM OpenMP notice. The binary directories are ignored by Git but included in an offline package when installed under `resources/semantic/`.
