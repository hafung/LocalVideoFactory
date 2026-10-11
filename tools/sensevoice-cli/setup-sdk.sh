#!/usr/bin/env bash
set -euo pipefail
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SDK="$PROJECT/.windows-smoke/sensevoice-native-sdk"
URL='https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-no-tts.tar.bz2'
HASH='4b0a94f7b5c606b1b64a19a831c2127559e4b3d34e195465ebc7be73d9ed4783'
mkdir -p "$SDK"
if [[ ! -f "$SDK/sdk.tar.bz2" ]] || ! printf '%s  %s\n' "$HASH" "$SDK/sdk.tar.bz2" | sha256sum -c - >/dev/null 2>&1; then
  curl -sS -L --fail --retry 5 --retry-all-errors --max-time 300 "$URL" -o "$SDK/sdk.tar.bz2.download"
  printf '%s  %s\n' "$HASH" "$SDK/sdk.tar.bz2.download" | sha256sum -c -
  mv "$SDK/sdk.tar.bz2.download" "$SDK/sdk.tar.bz2"
fi
mkdir -p "$SDK/sdk"
tar -xjf "$SDK/sdk.tar.bz2" --strip-components=1 -C "$SDK/sdk"
ORT_URL='https://github.com/microsoft/onnxruntime/releases/download/v1.28.2/onnxruntime-win-x64-1.28.2.zip'
ORT_HASH='c4eedd29489d5feca21866d054638416f3655bf6b18851b3b6b85c8313e95c35'
mkdir -p "$SDK/ort"
if [[ ! -f "$SDK/ort/runtime.zip" ]] || ! printf '%s  %s\n' "$ORT_HASH" "$SDK/ort/runtime.zip" | sha256sum -c - >/dev/null 2>&1; then
  curl -sS -L --fail --retry 5 --retry-all-errors --max-time 300 "$ORT_URL" -o "$SDK/ort/runtime.zip.download"
  printf '%s  %s\n' "$ORT_HASH" "$SDK/ort/runtime.zip.download" | sha256sum -c -
  mv "$SDK/ort/runtime.zip.download" "$SDK/ort/runtime.zip"
fi
unzip -q -o "$SDK/ort/runtime.zip" -d "$SDK/ort"
printf 'Verified standalone CPU SDK: %s\n' "$SDK/sdk"
