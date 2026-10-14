# SenseVoice CLI — Windows 原生命令行程序

独立使用 SenseVoiceSmall INT8、Silero VAD 和 cppjieba，提供转写、token/词/短语时间信息、JSON、文字、SRT 和 ASS 高亮字幕。Windows 10 1903 及以上 / Windows 11 x64，CPU 离线运行，不需要 Node、Python、Electron、显卡或联网。

将整个 `SenseVoice-CLI-0.2.0-win-x64` 文件夹复制到任意目录即可使用。EXE 会从自身目录加载 DLL、`models/sensevoice-small/` 和 `dictionary/`，与调用者的工作目录无关。只复制 EXE 不足以识别音频。

```powershell
.\sensevoice-cli.exe --version
.\sensevoice-cli.exe --check
.\sensevoice-cli.exe -i "D:\音频\旁白.wav"
.\sensevoice-cli.exe -i "D:\音频\旁白.wav" -o result.json --srt-output captions.srt --ass-output captions.ass --text-output transcript.txt
.\sensevoice-cli.exe -i audio.wav --format text
.\sensevoice-cli.exe -i audio.wav --format srt -o captions.srt
.\sensevoice-cli.exe -i audio.wav --format ass -o captions.ass
.\sensevoice-cli.exe -i audio.wav --highlight phrase -o result.json --ass-output highlighted.ass
.\sensevoice-cli.exe -i audio.wav --highlight word --user-dict terms.txt --ass-output words.ass
```

输入为**单声道、16 位 PCM WAV**，支持 16 kHz、24 kHz 等采样率，识别时内部重采样。MP3、AAC、立体声等格式需要调用者先转换为这种 WAV；转换器不随包分发。支持中文路径和空格，输出文件为 UTF-8 无 BOM。

默认中文、4 个识别线程、启用逆文本规范化。可用 `--language zh|en|ja|ko|yue|auto`、`--threads 1..64`、`--no-itn` 修改，用 `--model-dir` 指定独立模型目录。`--check` 实际加载识别与 VAD 模型；`--help` 可在没有模型或 DLL 时查看参数。

默认将 JSON 写到 stdout。指定 `-o` 后，所选格式写入文件；`--srt-output`、`--ass-output` 和 `--text-output` 可在同一次识别中额外输出文件。`--format ass` 不加 `-o` 时将 ASS 写到 stdout。识别库日志及错误写到 stderr，调用程序应分别捕获 stdout 和 stderr，并检查退出码：0 成功，1 运行/输入/输出错误，2 参数错误。

Python 外部调用示例（Python 只属于调用者，不是 EXE 的运行依赖）：

```python
import json, subprocess
result = subprocess.run(
    [r"D:\tools\SenseVoice-CLI-0.2.0-win-x64\sensevoice-cli.exe",
     "-i", r"D:\音频\旁白.wav"],
    capture_output=True, encoding="utf-8", check=True,
)
data = json.loads(result.stdout)
print(data["text"], data["tokens"])
```

JSON 的时间单位均为毫秒，包含 `text`、`tokens`、`speechSegments`、`subtitles`、`audio`、`language`、`emotion`、`event` 和分阶段 `timings`。token 起点来自模型；终点优先使用模型时长，否则使用下一 token 起点、VAD 边界或音频结束，每项以 `endSource` 标明。`lexical` 区分文字 token 与标点/控制 token。情绪和事件是识别模型的输出标签。

默认 `--highlight none` 保留原有整句字幕：按标点、停顿和最多 24 个字符分行。`--highlight word|phrase` 开启按词或短语高亮，并将完整短语组打包成约 12 字的短字幕；单个受保护的长名称可以超过该软限制。SRT 使用同一模式的分句文字，但不携带动态高亮。结束时间包含推算；尚无人工时间精度评测。

ASS 使用同一批分句文字和时间轴，导出标准 `v4.00+` 文件，带 1920×1080 画布、微软雅黑 52 号字、白字黑边、底部居中样式，可在 Aegisub 等字幕编辑器中修改。每句一条 Dialogue，时间按 ASS 的百分之一秒精度舍入，极短字幕至少保留一个时间单位。识别文字中的反斜杠和花括号转为全角字符，避免被播放器当成 ASS 控制指令，换行使用 `\N`。导出 ASS 无需新增模型或运行依赖。

### 分词、短语与高亮

`--highlight none|word|phrase` 的默认值为 `none`，保持旧的普通 ASS 效果。开启后每个高亮状态写一条完整文字 Dialogue：当前词或短语变黄，其他部分保持白色；组间静音保留文字并取消高亮。ASS 相邻时间使用同一舍入边界，不逐条延长造成重叠。

所有模式的 JSON 均附加 `segmenter: "cppjieba-5.6.4"`、`captionHighlight`，以及每条 `subtitles[].words`。开启高亮时还填充 `subtitles[].highlightUnits`。原有 `schemaVersion: 1`、`text`、原始 `tokens`、VAD 和字幕基本字段保留；这是附加字段扩展，严格拒绝未知字段的调用方需更新解析器。普通模式的 `highlightUnits` 是空数组。

```json
{
  "text": "三个步骤",
  "startChar": 0,
  "endChar": 4,
  "startMs": 100,
  "endMs": 900,
  "timingSource": "acoustic-derived",
  "groupingSource": "rule"
}
```

上例仅说明字段。`startChar/endChar` 是所属字幕 `text` 内的 Unicode 码点范围，起点包含、终点不包含；不是 UTF-8 字节或 UTF-16 索引。每个词另带 `tag` 词性。时间来自覆盖 token 的边界；多字符模型 token 内部需要均分时标为 `estimated`，原始 token 的 `endSource` 仍保留。`acoustic-derived` 表示由声学 token 派生，不能理解成人工验证准确。

先保护金额、数字单位和英文名称，再分词、按标点/停顿/词性/长度/时长合组。例如“只要三个步骤，就能做出高级感”可分成“只要 / 三个步骤 / 就能做出 / 高级感”。分组是轻量规则，复杂句式可能需要调用方编辑 JSON。词典可以帮助“高级感”、品牌名等保持完整，但不是 ASR 热词，不会修复识别错字。

`--user-dict` 接收 UTF-8（可带 BOM）词典，支持以下格式，每行一项；第三列词频必须为正整数：

```text
声织自动成片
SenseVoice n
高级感 100000 n
```

缺少词频时使用 100000，缺少词性时使用 `n`。空行忽略，格式错误返回运行错误；禁止用输出覆盖输入音频、模型、运行库或用户/基础词典。基础分词仅打包主词典和 HMM，无 TF-IDF/关键词模型资源。

本版本暂未提供读取旧 JSON 的重分组命令或已知文案输入。VoxWeave 主应用已支持通过保存的词时间直接修改高亮粒度与手动分组，更新预览不重跑旁白或识别。

## 目录与构建

```text
sensevoice-cli.exe
sherpa-onnx-c-api.dll
onnxruntime.dll
onnxruntime_providers_shared.dll
MSVCP140*.dll / VCRUNTIME140*.dll  应用本地 C++ 运行库
models/sensevoice-small/        模型、tokens、VAD、原许可证和 manifest
dictionary/                    jieba 主词典、HMM、依赖版本与哈希
licenses/                      运行库与静态 C++ 运行时许可证
build-info.json                来源、文件 SHA-256、DLL 依赖、原应用文件快照
```

源代码位于 `tools/sensevoice-cli/`。在 WSL 中运行：

```bash
bash tools/sensevoice-cli/setup-sdk.sh
bash tools/sensevoice-cli/build-windows.sh
```

默认产物位于 `release-dev/SenseVoice-CLI-0.2.0-win-x64/`。SDK 准备脚本下载并校验固定版本的官方归档；构建本身离线。构建使用 LLVM-MinGW UCRT 20260908、独立的 sherpa-onnx 1.13.8 C API、Microsoft ONNX Runtime CPU 1.28.2、Visual Studio REDIST 的 x64 C++ 运行库，以及经过哈希验证的项目模型。分词代码和词典随源码保存，固定 cppjieba 5.6.4 与 limonp `5c82a3f17e4e0adc6a5decfe245054b0ed533d1a`，构建前逐文件校验。需要恢复分词依赖时运行 `bash tools/sensevoice-cli/setup-segmentation.sh`，脚本使用 WSL curl 下载到宿主机工作区并校验固定归档哈希。程序显式加载自身目录中的 ONNX Runtime，避免混入旧版 DLL。

编译器和 Visual Studio REDIST 需预先准备。本机默认编译器位于 `/tmp/voxweave-qwen-windows-cache/llvm-mingw-20260908-ucrt-ubuntu-22.04-x86_64`。可通过 `SENSEVOICE_CLI_LLVM`、`SENSEVOICE_CLI_RUNTIME_DIR`、`SENSEVOICE_CLI_ORT_DIR`、`SENSEVOICE_CLI_CRT_DIR`、`SENSEVOICE_CLI_OUTPUT` 指定路径；其中 CRT 路径为包含四个 DLL 的 `Microsoft.VC*.CRT` 目录。编译器、SDK、REDIST、项目模型均只读，产物与当前应用的构建资源分开。

## 已完成的验证

2026-10-11 在本机 Windows x64 实测：模型加载、八份音频的结构化输出和字幕时间范围检查通过；六份基础音频文字与参考一致（忽略标点）。两份 0 dB 白噪声压力样片中，预设音色把“开始”识别成“天始”，克隆音色文字一致。这个差异已保留，不把功能通过等同于识别无误。

0.1.1 完整目录复制到项目外的中文、空格路径后，从 Windows 目录调用，JSON、SRT、ASS、文字文件及 stdout 输出正常。八份样片的 ASS 分句文字和时间与 JSON 对照通过，已有 FFmpeg/libass 成功解析并渲染 ASS；FFmpeg 只用于验证，不是工具的运行依赖。另已验证 ASS 控制字符转义、时间跨秒/分/小时、极短字幕和空字幕。

错误参数、缺失输入、缺失运行库、禁止覆盖输入（含 `--ass-output`）的检查通过；原应用文件和模型哈希保持一致。这是本机验证，尚未在一台全新 Windows 系统上复测。

原始结果位于 `.windows-smoke/sensevoice-standalone/report.json` 及同目录的逐样片 JSON。仓库内可从 Windows PowerShell 复跑：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\sensevoice-cli\smoke-windows.ps1
```

复跑需要此前保留的 ASR 对照样片、报告和项目已有 FFmpeg。ASS 格式边界检查可在 WSL 编译运行：

```bash
g++ -std=c++17 -O2 tools/sensevoice-cli/ass-export.test.cpp -o /tmp/voxweave-sensevoice-ass-test
/tmp/voxweave-sensevoice-ass-test
```

上述测试资源均不属于外部调用的运行依赖。

0.2.0 的验证输出位于 `.windows-smoke/sensevoice-phrases/`：八份音频分别跑普通、按词、按短语模式；验证词组原文/Unicode 范围/时间来源、ASS 事件不重叠、项目外中文目录、自定义词典、错误参数与 libass 渲染。另有原生纯文本测试和与主应用共用的固定分组样例 `shared/fixtures/caption-groups.tsv`。0 dB 压力样片仍保留识别差异，不把分词功能通过当成转写无误。

```bash
g++ -std=c++17 -O2 -I tools/sensevoice-cli/third_party/cppjieba/include \
  -I tools/sensevoice-cli/third_party/limonp/include \
  tools/sensevoice-cli/caption-engine.test.cpp -o /tmp/voxweave-caption-test
/tmp/voxweave-caption-test tools/sensevoice-cli/third_party/cppjieba shared/fixtures/caption-groups.tsv
```

独立包保留 SenseVoiceSmall 的原始模型协议、归属和 Silero MIT 许可证，完整许可证见 `models/sensevoice-small/`、`licenses/` 和 `THIRD-PARTY-NOTICES.txt`。
