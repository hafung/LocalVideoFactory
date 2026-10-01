#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/engine/qwen3-tts-c"
STAGE="$ROOT/.windows-engine-build"
BUNDLE="$STAGE/bundle"
CACHE="${TMPDIR:-/tmp}/voxweave-qwen-windows-cache"

LLVM_VERSION=20260908
LLVM_ARCHIVE="llvm-mingw-${LLVM_VERSION}-ucrt-ubuntu-22.04-x86_64.tar.xz"
LLVM_SHA256=2258c745e3155870c80793f3e8c80b28fbde11b9ff73c4c78783635b3440b092
LLVM_URL="https://github.com/mstorsjo/llvm-mingw/releases/download/${LLVM_VERSION}/${LLVM_ARCHIVE}"
OPENBLAS_VERSION=0.3.34
OPENBLAS_ARCHIVE="OpenBLAS-${OPENBLAS_VERSION}-x64.zip"
OPENBLAS_SHA256=e9cb6134541f36c27346d5fc5995652f060fba227cebbbabcbda5a5a44d7c76b
OPENBLAS_URL="https://github.com/OpenMathLib/OpenBLAS/releases/download/v${OPENBLAS_VERSION}/${OPENBLAS_ARCHIVE}"
OPENBLAS_LICENSE_SHA256=190b5a9c8d9723fe958ad33916bd7346d96fab3c5ea90832bb02d854f620fcff
LZ4_VERSION=1.10.0
LZ4_LICENSE_SHA256=8b58c446121a109ccf32edc094bba3010a3d85e4ee3702950db55e4d3e87736c

download() {
  local url="$1" output="$2" expected="$3"
  if [[ -f "$output" ]] && echo "$expected  $output" | sha256sum -c - >/dev/null 2>&1; then
    return
  fi
  curl --location --fail --retry 3 --output "$output" "$url"
  echo "$expected  $output" | sha256sum -c -
}

mkdir -p "$CACHE" "$STAGE"
download "$LLVM_URL" "$CACHE/$LLVM_ARCHIVE" "$LLVM_SHA256"
download "$OPENBLAS_URL" "$CACHE/$OPENBLAS_ARCHIVE" "$OPENBLAS_SHA256"
download "https://raw.githubusercontent.com/OpenMathLib/OpenBLAS/v${OPENBLAS_VERSION}/LICENSE" "$CACHE/OPENBLAS-LICENSE" "$OPENBLAS_LICENSE_SHA256"
download "https://raw.githubusercontent.com/lz4/lz4/v${LZ4_VERSION}/lib/LICENSE" "$CACHE/LZ4-LICENSE" "$LZ4_LICENSE_SHA256"

LLVM_DIR="$CACHE/llvm-mingw-${LLVM_VERSION}-ucrt-ubuntu-22.04-x86_64"
OPENBLAS_DIR="$CACHE/openblas-${OPENBLAS_VERSION}"
[[ -d "$LLVM_DIR" ]] || tar -xJf "$CACHE/$LLVM_ARCHIVE" -C "$CACHE"
if [[ ! -d "$OPENBLAS_DIR" ]]; then
  mkdir -p "$OPENBLAS_DIR"
  unzip -q "$CACHE/$OPENBLAS_ARCHIVE" -d "$OPENBLAS_DIR"
fi

CC="$LLVM_DIR/bin/x86_64-w64-mingw32-clang"
WINDRES="$LLVM_DIR/bin/x86_64-w64-mingw32-windres"
OBJDUMP="$LLVM_DIR/bin/llvm-objdump"
[[ -x "$CC" && -x "$WINDRES" && -x "$OBJDUMP" ]] || { echo "LLVM-MinGW extraction is incomplete" >&2; exit 1; }

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE" "$STAGE/obj"
(cd "$SOURCE/windows" && "$WINDRES" -O coff qwen_tts.rc -o "$STAGE/obj/qwen_tts-manifest.o")

sources=(
  main.c qwen_tts.c qwen_tts_talker.c qwen_tts_code_predictor.c
  qwen_tts_speech_decoder.c qwen_tts_kernels.c qwen_tts_thread.c
  qwen_tts_kernels_generic.c qwen_tts_kernels_neon.c qwen_tts_kernels_avx.c
  qwen_tts_audio.c qwen_tts_emotion.c qwen_tts_compose.c qwen_tts_sampling.c
  qwen_tts_tokenizer.c qwen_tts_server_win_stub.c qwen_tts_voice_clone.c
  qwen_tts_speech_encoder.c vendor/lz4.c
  third_party/ingot/src/dtype.c third_party/ingot/src/gguf.c
  third_party/ingot/src/safetensors.c third_party/ingot/src/wfile.c
  third_party/ingot/src/write.c third_party/ingot/src/cpu.c
  third_party/ingot/src/dequant.c third_party/ingot/src/dequant_iq.c
  third_party/ingot/src/kernels.c third_party/ingot/src/generic.c
  third_party/ingot/src/quantize.c
)
source_paths=()
for source in "${sources[@]}"; do source_paths+=("$SOURCE/$source"); done

"$CC" -std=gnu11 -O3 -Wall -Wextra -mavx2 -mfma -ffast-math \
  -D_WIN32_WINNT=0x0A00 -DUSE_BLAS -DUSE_OPENBLAS \
  -I"$SOURCE" -I"$SOURCE/vendor" -I"$SOURCE/third_party/ingot/include" \
  -I"$OPENBLAS_DIR/include" "${source_paths[@]}" "$STAGE/obj/qwen_tts-manifest.o" \
  -L"$OPENBLAS_DIR/lib" -lopenblas -lwinpthread -lm -municode \
  -o "$BUNDLE/qwen_tts.exe"

cp "$OPENBLAS_DIR/bin/libopenblas.dll" "$BUNDLE/libopenblas.dll"
cp "$LLVM_DIR/x86_64-w64-mingw32/bin/libwinpthread-1.dll" "$BUNDLE/libwinpthread-1.dll"
cp "$SOURCE/LICENSE" "$BUNDLE/QWEN3-TTS-C-LICENSE"
cp "$SOURCE/third_party/ingot/LICENSE" "$BUNDLE/INGOT-LICENSE"
cp "$CACHE/OPENBLAS-LICENSE" "$BUNDLE/OPENBLAS-LICENSE"
cp "$CACHE/LZ4-LICENSE" "$BUNDLE/LZ4-LICENSE"
cp "$LLVM_DIR/x86_64-w64-mingw32/share/mingw32/COPYING.winpthreads.txt" "$BUNDLE/WINPTHREADS-LICENSE"
cp "$ROOT/resources/engine/THIRD-PARTY-NOTICES.txt" "$BUNDLE/THIRD-PARTY-NOTICES.txt"

mapfile -t imports < <("$OBJDUMP" -p "$BUNDLE/qwen_tts.exe" | sed -n 's/^[[:space:]]*DLL Name: //p')
for import in "${imports[@]}"; do
  case "${import,,}" in
    libopenblas.dll|libwinpthread-1.dll|kernel32.dll|api-ms-win-crt-*.dll) ;;
    *) echo "Unexpected runtime dependency: $import" >&2; exit 1 ;;
  esac
done

SOURCE_COMMIT="$(git -C "$ROOT" log -1 --format=%H -- engine/qwen3-tts-c)"
SOURCE_DIFF_SHA256="$(git -C "$ROOT" diff -- engine/qwen3-tts-c | sha256sum | cut -d' ' -f1)"
SOURCE_TREE_SHA256="$(
  find "$SOURCE" -type f \( -name '*.c' -o -name '*.h' -o -name 'Makefile' -o -path '*/windows/*' \) -print0 \
    | sort -z \
    | while IFS= read -r -d '' file; do
        printf '%s\0' "${file#"$SOURCE/"}"
        sha256sum "$file" | cut -d' ' -f1
      done \
    | sha256sum | cut -d' ' -f1
)"
cat > "$BUNDLE/build-info.json" <<EOF
{
  "engineVersion": "qwen3-tts-c-v0.2.1",
  "sharedSpeechTokenizer": true,
  "sourceCommit": "$SOURCE_COMMIT",
  "sourceDiffSha256": "$SOURCE_DIFF_SHA256",
  "sourceTreeSha256": "$SOURCE_TREE_SHA256",
  "target": "x86_64-w64-windows-gnu-ucrt",
  "cpuBaseline": "AVX2+FMA",
  "compiler": "LLVM-MinGW $LLVM_VERSION / LLVM 23.1.1",
  "openblas": "$OPENBLAS_VERSION",
  "lz4": "$LZ4_VERSION",
  "imports": $(printf '%s\n' "${imports[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.trim().split(/\r?\n/u).filter(Boolean))))')
}
EOF

if command -v powershell.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$ROOT/scripts/import-qwen-engine.ps1")" \
    -SourceDir "$(wslpath -w "$BUNDLE")"
else
  echo "Windows bundle built at $BUNDLE; import it with scripts/import-qwen-engine.ps1"
fi
