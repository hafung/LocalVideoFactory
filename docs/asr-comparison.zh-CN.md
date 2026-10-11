# Qwen3-ASR 1.7B 与 SenseVoice 本机对照

本次对照检查项目现有中文旁白上的转写、CPU 耗时、内存占用及字幕时间戳能力。测试结果保存在 `.windows-smoke/asr-compare/report.json`，原始转写、stderr、SenseVoice SRT 和采样音频也保存在同一目录。模型与运行产物不进入 Git。

## 2026-10-11 基础实测结果

六类样片、两套引擎、各三轮，共 36 次运行。两套引擎每次 CER 都是 0%，各自三轮原始转写稳定。这里的 0% 忽略标点，不表示问号、逗号等原样保留。

| 样片 | 音频时长 | SenseVoice 耗时中位数 | Qwen 1.7B 耗时中位数 |
| --- | ---: | ---: | ---: |
| 预设音色旁白 | 17.96 s | 3.58 s | 20.54 s |
| 克隆音色旁白 | 13.05 s | 3.30 s | 20.55 s |
| “你好”短句 | 1.36 s | 3.21 s | 16.19 s |
| 预设音色 + 10 dB 白噪声 | 17.96 s | 3.86 s | 20.85 s |
| 克隆音色 + 10 dB 白噪声 | 13.05 s | 3.65 s | 20.43 s |
| 官方中文语音示例 | 4.20 s | 3.12 s | 16.71 s |

各样片的峰值 RSS 中位数：SenseVoice 约 620–661 MiB，Qwen 约 6,596–6,675 MiB。SenseVoice 的全部原文字符获得匹配锚点，token 未出现越出音频范围等基本时间戳问题，已生成 SRT；这不等于人工验证过时间精度。

本次基础样片没有体现 Qwen 1.7B 的文字识别收益。现有 CPU 旁白字幕路径使用 SenseVoice 更节省资源，并已具备所需的时间信息。这个结论限定于上述样片、精度设置和 WSL 实现，不能作为两种模型的一般识别质量排名，也不能直接套用到 Windows 原生运行器或常驻服务。

追加的两类 0 dB 白噪声压力样片也各运行三轮，共 12 次。两者每次 CER 仍为 0%，各自三轮转写稳定。预设音色压力样片的耗时中位数为 SenseVoice 3.47 s、Qwen 20.45 s；克隆音色为 3.27 s、19.70 s。峰值 RSS 中位数分别约 644–661 MiB 和 6,658–6,674 MiB。压力报告位于 `.windows-smoke/asr-compare-stress/report.json`，它不代表真实背景噪声评测。

基础与压力测试总计 48 次，均未测得这批文字的识别差异；SenseVoice 字幕字词的匹配锚点覆盖率为 100%，基本时间戳检查通过。没有运行 Qwen ForcedAligner，因此字幕时间精度没有两套方案的实测对照。

## 固定的测试环境

- Intel Core i5-14600K，WSL/Linux；两套引擎均使用 CPU，识别线程数为 4。
- Qwen：官方 `Qwen/Qwen3-ASR-1.7B`，revision `7278e1e70fe206f11671096ffdd38061171dd6e5`。两份权重合计 4,698,521,512 字节，下载后按官方 LFS SHA-256 校验。
- Qwen 运行器：[antirez/qwen-asr](https://github.com/antirez/qwen-asr/tree/924694251d9e0f18e5d86bbd06aa3ab5f870002d)，commit `924694251d9e0f18e5d86bbd06aa3ab5f870002d`；GCC 13.3.0，AVX2/FMA，OpenBLAS 0.3.26。CPU 路径为 FP32 编码器及 BF16 解码权重，未使用 GPU 或热词提示。
- SenseVoice：项目既有的 `sherpa-onnx-node` 1.13.8、SenseVoiceSmall INT8 2024-07-17、Silero VAD 和原文对齐逻辑，固定中文。
- 两套实现采用不同的权重精度。本测试比较这两套具体实现，不能把耗时差异全部归因于模型参数量。

## 样片和计量方式

使用已有的 1.7B CustomVoice 自动旁白、克隆音色旁白、“你好”短句，两个以 seed 42 加入 10 dB 高斯白噪声的旁白，以及[官方中文示例](https://github.com/QwenLM/Qwen3-ASR#forcedaligner-usage)。噪声的 SNR 以整个 WAV 的均方能量计算，裁幅数量记录在样片清单中。

每个样片、每套引擎运行三轮，每轮启动新进程，按轮次交替运行顺序。报告记录完整子进程耗时和 `/usr/bin/time` 的峰值 RSS；后续轮次会受益于操作系统文件缓存，不代表清空磁盘缓存后的启动。SenseVoice 子进程耗时包含资源哈希校验、模型加载、识别及 VAD；Qwen 包含进程启动、模型加载和识别。字幕词组聚合与 SRT 写入在计时之后进行。

字符错误率（CER）以原 TTS 文案或官方示例的参考文字计算，先做 NFKC 规范化、忽略标点、符号、空白及大小写。报告保留替换、删除、插入的具体字符。合成旁白可能本身有读错，因此这个指标是“转写与原文的差异”，不能自动归因于 ASR。该小样本也不能代表长录音、方言、多人对话和真实环境噪声。

## 字幕依赖与验证边界

上述固定版本的 C 运行器只输出转写文字，没有词/字时间戳或 ForcedAligner 接口；本次不把估时字幕伪装成 Qwen 的声学时间轴。

[官方 Qwen3-ASR 接口](https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/qwen3_asr.py) 在要求 `return_time_stamps=True` 时必须配置额外的 `Qwen3-ForcedAligner-0.6B`。使用官方 Python 实现，还需其 PyTorch/Transformers 等运行环境；本次 C 运行器没有接入这个对齐模型。

旁白原文已知时，可以[单独运行 ForcedAligner](https://github.com/QwenLM/Qwen3-ASR#forcedaligner-usage)，直接输入原文和音频，无需先做 Qwen-ASR 转写。若要比较字幕时间精度，应另测这个对齐流程，并准备人工标注的字词时间轴。

SenseVoice 的报告记录 token 时间、原文对齐覆盖率与可生成的 SRT。没有人工时间标注，本次只检查时间戳存在及基本有效性，不声称测得时间轴误差，也不能据此认定 Qwen ForcedAligner 更好或更差。

## 复跑

本机下载的模型、运行器、上游源码归档及官方中文样片位于 `.windows-smoke/asr-compare/`。在 WSL 的项目根目录运行：

```bash
node scripts/compare-asr.mjs --output .windows-smoke/asr-compare-rerun
```

脚本依赖本项目已有的 `.windows-smoke/prosody-check/`、`.windows-smoke/clone-check/` 样片、`dist-electron` 编译产物和 Linux 的 `/usr/bin/time`。可以用 `--qwen-bin`、`--qwen-model` 指定其他资源位置，或用 `--repetitions` 调整轮数。这不是 Windows 原生 Qwen-ASR EXE 的发行验证。

追加的 0 dB 白噪声压力对照使用 `node scripts/compare-asr.mjs --stress`，结果单独保存在 `.windows-smoke/asr-compare-stress/report.json`。

## 独立 Windows SenseVoice CLI 补充验证

同日新增独立的 Windows 原生 CLI，源码与说明位于 [tools/sensevoice-cli](../tools/sensevoice-cli/README.md)，未修改应用识别流程。它使用项目原有 SenseVoiceSmall INT8 模型的副本、sherpa-onnx C API 1.13.8 和独立 ONNX Runtime CPU 1.28.2。Windows 模型加载、JSON/文字/SRT、中文路径、项目外搬移调用、错误处理及原项目哈希检查通过。

六份基础样片的转写与参考文字一致（忽略标点）。两份 0 dB 白噪声压力样片中，预设音色出现一次“开始”→“天始”的替换，CER 为 1/40，即 2.5%；克隆音色仍一致。原始输出与验证报告位于 `.windows-smoke/sensevoice-standalone/`。这说明前面的 WSL 0% CER 不能直接套用到不同系统和运行库；Windows 这一轮没有重新运行 Qwen，不构成新的双引擎对照。

本工具使用识别文字和模型 token 起点制作字幕，终点推算来源在 JSON 中标明；不等同于应用内部的已知原文对齐。使用说明记录验证边界，原应用与原模型文件保持不变。

独立工具 0.1.1 已增加 ASS 输出：`--format ass` 或 `--ass-output captions.ass`。八份样片的 ASS 与 JSON 分句文字、时间对照通过，项目外中文目录调用及 FFmpeg/libass 渲染通过；没有新增模型或运行依赖，也未改动项目内部的字幕导出功能。
