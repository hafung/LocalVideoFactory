#!/usr/bin/env bash
set -euo pipefail
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$SOURCE/../.." && pwd)"
CACHE="$PROJECT/.windows-smoke/sensevoice-segmentation"
mkdir -p "$CACHE"
# Normal builds use vendored, verified sources and never download anything.
# This script restores those exact sources using WSL curl and the host-mounted workspace.
download() {
  local dependency_url="$1" dependency_hash="$2" dependency_archive="$3"
  if [[ ! -f "$dependency_archive" ]] || ! printf '%s  %s\n' "$dependency_hash" "$dependency_archive" | sha256sum -c - >/dev/null 2>&1; then
    curl -fLsS --retry 3 --retry-all-errors --connect-timeout 15 --max-time 300 "$dependency_url" -o "$dependency_archive.download"
    printf '%s  %s\n' "$dependency_hash" "$dependency_archive.download" | sha256sum -c -
    mv "$dependency_archive.download" "$dependency_archive"
  fi
}
download 'https://codeload.github.com/yanyiwu/cppjieba/tar.gz/refs/tags/v5.6.4' \
  '011918a6f069b0051830a5e5ca1d1500576cb8a44858d17497d0b820c119ef3f' "$CACHE/cppjieba.tar.gz"
download 'https://codeload.github.com/yanyiwu/limonp/tar.gz/5c82a3f17e4e0adc6a5decfe245054b0ed533d1a' \
  '6d5450260f6fbe6c22af7be519627b9606d0d73ef67c07f95df7f27aa43b94cd' "$CACHE/limonp.tar.gz"
mkdir -p "$SOURCE/third_party/cppjieba" "$SOURCE/third_party/limonp"
tar -xzf "$CACHE/cppjieba.tar.gz" --strip-components=1 -C "$SOURCE/third_party/cppjieba" \
  cppjieba-5.6.4/include cppjieba-5.6.4/LICENSE cppjieba-5.6.4/dict/jieba.dict.utf8 \
  cppjieba-5.6.4/dict/hmm_model.utf8 cppjieba-5.6.4/dict/user.dict.utf8
tar -xzf "$CACHE/limonp.tar.gz" --strip-components=1 -C "$SOURCE/third_party/limonp" \
  limonp-5c82a3f17e4e0adc6a5decfe245054b0ed533d1a/include limonp-5c82a3f17e4e0adc6a5decfe245054b0ed533d1a/LICENSE
