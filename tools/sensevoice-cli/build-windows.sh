#!/usr/bin/env bash
set -euo pipefail

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$SOURCE/../.." && pwd)"
STAGE="$PROJECT/.windows-smoke/sensevoice-native-build"
BUNDLE="${SENSEVOICE_CLI_OUTPUT:-$PROJECT/release-dev/SenseVoice-CLI-0.2.0-win-x64}"
LLVM="${SENSEVOICE_CLI_LLVM:-/tmp/voxweave-qwen-windows-cache/llvm-mingw-20260908-ucrt-ubuntu-22.04-x86_64}"
RUNTIME="${SENSEVOICE_CLI_RUNTIME_DIR:-}"
MODEL_SOURCE="$PROJECT/resources/models/sensevoice-small"
ORT="${SENSEVOICE_CLI_ORT_DIR:-$PROJECT/.windows-smoke/sensevoice-native-sdk/ort/onnxruntime-win-x64-1.28.2}"
ORT_ARCHIVE="$PROJECT/.windows-smoke/sensevoice-native-sdk/ort/runtime.zip"
[[ -f "$ORT_ARCHIVE" ]] || { echo 'Run bash tools/sensevoice-cli/setup-sdk.sh first.' >&2; exit 1; }
printf '%s  %s\n' 'c4eedd29489d5feca21866d054638416f3655bf6b18851b3b6b85c8313e95c35' "$ORT_ARCHIVE" | sha256sum -c - >/dev/null

if [[ -z "$RUNTIME" ]]; then
  SDK="$PROJECT/.windows-smoke/sensevoice-native-sdk"
  [[ -f "$SDK/sdk.tar.bz2" ]] || { echo 'Run bash tools/sensevoice-cli/setup-sdk.sh first.' >&2; exit 1; }
  printf '%s  %s\n' '4b0a94f7b5c606b1b64a19a831c2127559e4b3d34e195465ebc7be73d9ed4783' "$SDK/sdk.tar.bz2" | sha256sum -c - >/dev/null
  RUNTIME="$SDK/sdk/lib"
fi
[[ -n "$RUNTIME" ]] || { echo 'Set SENSEVOICE_CLI_RUNTIME_DIR to a matching official SDK library directory.' >&2; exit 1; }
for file in sherpa-onnx-c-api.dll; do
  [[ -f "$RUNTIME/$file" ]] || { echo "Missing runtime: $file" >&2; exit 1; }
done
[[ -x "$LLVM/bin/x86_64-w64-mingw32-clang++" ]] || { echo 'Set SENSEVOICE_CLI_LLVM to LLVM-MinGW UCRT 20260908.' >&2; exit 1; }
mkdir -p "$STAGE" "$BUNDLE"

python3 - "$PROJECT" "$MODEL_SOURCE" "$STAGE" <<'PY'
import hashlib, json, sys
from pathlib import Path
project, root, stage = map(Path, sys.argv[1:])
manifest = json.loads((root / 'manifest.json').read_text())
def sha(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        while b:=f.read(1024*1024): h.update(b)
    return h.hexdigest()
for entry in list(manifest['files'].values())+list(manifest.get('notices',{}).values()):
    p=(root/entry['path']).resolve()
    assert p.is_relative_to(root.resolve()), p
    assert sha(p)==entry['sha256'], p
segmentation=project/'tools/sensevoice-cli/third_party'
segment_manifest=json.loads((segmentation/'segmentation-manifest.json').read_text())
for name,expected in segment_manifest['files'].items():
    p=(segmentation/name).resolve()
    assert p.is_relative_to(segmentation.resolve()), p
    assert sha(p)==expected, f'Segmentation dependency changed: {name}'
snapshot={str(p.relative_to(project)):sha(p) for p in [project/'electron/main.ts',
    project/'electron/alignment/sensevoice.ts',project/'package.json',root/'manifest.json']}
(stage/'original-project-hashes.json').write_text(json.dumps(snapshot,indent=2)+'\n')
PY

(cd "$SOURCE/windows" && "$LLVM/bin/x86_64-w64-mingw32-windres" -O coff sensevoice-cli.rc -o "$STAGE/manifest.o")
"$LLVM/bin/x86_64-w64-mingw32-clang++" -std=c++17 -O2 -Wall -Wextra \
  -I "$SOURCE/third_party/cppjieba/include" -I "$SOURCE/third_party/limonp/include" \
  -D_WIN32_WINNT=0x0A00 -static -municode "$SOURCE/main.cpp" "$STAGE/manifest.o" -o "$STAGE/sensevoice-cli.exe"

python3 - "$PROJECT" "$SOURCE" "$STAGE" "$BUNDLE" "$RUNTIME" "$MODEL_SOURCE" "$LLVM" "$ORT" <<'PY'
import hashlib, json, os, shutil, subprocess, sys
from pathlib import Path
project, source, stage, bundle, runtime, models, llvm, ort = map(Path,sys.argv[1:])
def sha(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        while b:=f.read(1024*1024): h.update(b)
    return h.hexdigest()
def copy(p,relative):
    out=bundle/relative;out.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,out)
copy(stage/'sensevoice-cli.exe','sensevoice-cli.exe')
copy(runtime/'sherpa-onnx-c-api.dll','sherpa-onnx-c-api.dll')
for name in ['onnxruntime.dll','onnxruntime_providers_shared.dll']: copy(ort/'lib'/name,name)
copy(ort/'LICENSE','licenses/ONNXRUNTIME-LICENSE.txt')
copy(ort/'ThirdPartyNotices.txt','licenses/ONNXRUNTIME-ThirdPartyNotices.txt')
# App-local copies from the installed Visual Studio REDIST directory; no installer or system write.
crt_names=['MSVCP140.dll','MSVCP140_1.dll','VCRUNTIME140.dll','VCRUNTIME140_1.dll']
crt_candidates=[]
for base in [Path('/mnt/d/DevTools/VisualStudio/2026/BuildTools/VC/Redist/MSVC'),Path('/mnt/d/DevTools/VisualStudio/2022/BuildTools/VC/Redist/MSVC')]:
    if base.exists(): crt_candidates.extend(base.glob('*/x64/Microsoft.VC*.CRT'))
crt_candidates.sort(key=lambda p:tuple(int(n) for n in p.parents[1].name.split('.')),reverse=True)
crt_override=os.environ.get('SENSEVOICE_CLI_CRT_DIR')
crt=Path(crt_override) if crt_override else next((p for p in crt_candidates if all((p/n).exists() for n in crt_names)),None)
if not crt or not all((crt/n).exists() for n in crt_names):
    raise RuntimeError('Set SENSEVOICE_CLI_CRT_DIR to an installed Visual Studio x64 Microsoft.VC*.CRT REDIST directory.')
for name in crt_names: copy(crt/name,name)
model_manifest=json.loads((models/'manifest.json').read_text())
for entry in list(model_manifest['files'].values())+list(model_manifest.get('notices',{}).values()):
    copy(models/entry['path'],Path('models/sensevoice-small')/entry['path'])
copy(models/'manifest.json','models/sensevoice-small/manifest.json')
copy(project/'LICENSE','LICENSE.txt')
copy(source/'README.md','README.md')
for name in ['jieba.dict.utf8','hmm_model.utf8']:
    copy(source/'third_party/cppjieba/dict'/name,Path('dictionary')/name)
copy(source/'third_party/cppjieba/LICENSE','licenses/CPPJIEBA-LICENSE.txt')
copy(source/'third_party/limonp/LICENSE','licenses/LIMONP-LICENSE.txt')
copy(source/'third_party/segmentation-manifest.json','dictionary/manifest.json')
for p in (source/'licenses').glob('*'): copy(p,Path('licenses')/p.name)
copy(llvm/'LICENSE.TXT','licenses/LLVM-MINGW-LICENSE.txt')
for name in ['COPYING.MinGW-w64.txt','COPYING.MinGW-w64-runtime.txt','COPYING.winpthreads.txt']:
    copy(llvm/'x86_64-w64-mingw32/share/mingw32'/name,Path('licenses')/name)
notices='''SenseVoice CLI application: MIT; see LICENSE.txt.
sherpa-onnx C API/runtime 1.13.8: Apache-2.0; https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8
ONNX Runtime: MIT; https://github.com/microsoft/onnxruntime
Microsoft Visual C++ app-local runtime: copied from installed Visual Studio REDIST; see licenses/MICROSOFT-VC-RUNTIME-NOTICE.txt.
SenseVoiceSmall INT8: FunASR Model Open Source License Agreement v1.1; retain SenseVoiceSmall name and original attribution.
https://github.com/FunAudioLLM/SenseVoice ; https://github.com/modelscope/FunASR
Silero VAD: MIT; https://github.com/snakers4/silero-vad
LLVM-MinGW/libc++/MinGW-w64/winpthreads static runtime notices: see licenses/.
cppjieba 5.6.4 and dictionaries: MIT; https://github.com/yanyiwu/cppjieba/tree/v5.6.4
limonp 5c82a3f17e4e0adc6a5decfe245054b0ed533d1a: MIT; https://github.com/yanyiwu/limonp
No Electron, Node.js, Python, FFmpeg or Qwen model is included or required.
'''
(bundle/'THIRD-PARTY-NOTICES.txt').write_text(notices)
(bundle/'licenses/MICROSOFT-VC-RUNTIME-NOTICE.txt').write_text('''Microsoft Visual C++ Runtime libraries, copyright Microsoft Corporation.
Source: installed Visual Studio x64 Microsoft.VC*.CRT REDIST directory.
These Microsoft binaries are separate from the application's MIT license.
Applicable software license terms: https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/
REDIST documentation: https://learn.microsoft.com/cpp/windows/redistributing-visual-cpp-files
Application-local deployment: https://learn.microsoft.com/cpp/windows/choosing-a-deployment-method
''')
imports={}
for name in ['sensevoice-cli.exe','sherpa-onnx-c-api.dll','onnxruntime.dll','onnxruntime_providers_shared.dll']+crt_names:
    output=subprocess.check_output([str(llvm/'bin/llvm-objdump'),'-p',str(bundle/name)],text=True)
    imports[name]=[line.split('DLL Name:',1)[1].strip() for line in output.splitlines() if 'DLL Name:' in line]
    for dep in imports[name]:
        lower=dep.lower()
        system=lower.startswith(('api-ms-','ext-ms-')) or lower in {'kernel32.dll','advapi32.dll','ntdll.dll','user32.dll',
            'msvcrt.dll','ucrtbase.dll','shell32.dll','ole32.dll','dbghelp.dll','setupapi.dll','dxgi.dll','bcrypt.dll'}
        assert system or (bundle/dep).exists(), f'Unbundled dependency: {name} -> {dep}'
snapshot=json.loads((stage/'original-project-hashes.json').read_text())
assert all(sha(project/name)==expected for name,expected in snapshot.items()), 'Existing project files changed'
info={'cliVersion':'0.2.0','target':'Windows x64 UCRT, CPU','compiler':'LLVM-MinGW 20260908 / LLVM 23.1.1',
 'sherpaVersion':'1.13.8','onnxruntimeVersion':'1.28.2','runtimeSource':str(runtime),'ortSource':str(ort),'msvcRedistSource':str(crt),'sourceFiles':{str(p.relative_to(source)):sha(p) for p in [source/'main.cpp',source/'ass-export.h',source/'caption-types.h',source/'caption-engine.h',source/'third_party/c-api.h',source/'third_party/segmentation-manifest.json',source/'windows/sensevoice-cli.exe.manifest',source/'windows/sensevoice-cli.rc',source/'build-windows.sh',source/'setup-sdk.sh']},
 'headerSource':'https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.8/sherpa-onnx/c-api/c-api.h',
 'sdkArchiveSource':'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-no-tts.tar.bz2',
 'sdkArchiveSha256':'4b0a94f7b5c606b1b64a19a831c2127559e4b3d34e195465ebc7be73d9ed4783',
 'ortArchiveSource':'https://github.com/microsoft/onnxruntime/releases/download/v1.28.2/onnxruntime-win-x64-1.28.2.zip',
 'ortArchiveSha256':'c4eedd29489d5feca21866d054638416f3655bf6b18851b3b6b85c8313e95c35',
 'segmentation':json.loads((source/'third_party/segmentation-manifest.json').read_text()),
 'imports':imports,'originalProjectHashes':snapshot,'modelManifest':model_manifest,
 'files':{str(p.relative_to(bundle)):{'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(bundle.rglob('*')) if p.is_file() and p.name!='build-info.json'}}
(bundle/'build-info.json').write_text(json.dumps(info,indent=2)+'\n')
print('Built standalone bundle:',bundle)
print('Payload size:',round(sum(p.stat().st_size for p in bundle.rglob('*') if p.is_file())/1024**2,1),'MiB')
print('Existing application files and source model hashes verified unchanged.')
PY
