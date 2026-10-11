// Standalone native wrapper; independent of VoxWeave's Electron/Node adapters.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <limits>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include "third_party/c-api.h"
#include "ass-export.h"

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
constexpr const char *kVersion = "0.1.1";

struct Guard {
  std::function<void()> release;
  ~Guard() { release(); }
};

std::string utf8(const std::wstring &value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (!size) throw std::runtime_error("Invalid Unicode argument");
  std::string output(size, '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), output.data(), size, nullptr, nullptr);
  return output;
}

fs::path executableDirectory() {
  std::vector<wchar_t> buffer(32768);
  const DWORD size = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (!size || size >= buffer.size()) throw std::runtime_error("Cannot locate executable");
  return fs::path(std::wstring(buffer.data(), size)).parent_path();
}

std::string quote(const std::string &text) {
  std::ostringstream out;
  out << '"';
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') out << '\\' << c;
    else if (c < 32) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << int(c) << std::dec;
    else out << c;
  }
  out << '"';
  return out.str();
}

std::vector<uint32_t> codepoints(const std::string &text) {
  std::vector<uint32_t> output;
  for (size_t i = 0; i < text.size();) {
    const uint8_t first = static_cast<uint8_t>(text[i++]);
    int following = first < 0x80 ? 0 : first < 0xe0 ? 1 : first < 0xf0 ? 2 : 3;
    uint32_t c = first & (following == 0 ? 0x7f : following == 1 ? 0x1f : following == 2 ? 0x0f : 0x07);
    while (following-- && i < text.size()) c = (c << 6) | (static_cast<uint8_t>(text[i++]) & 0x3f);
    output.push_back(c);
  }
  return output;
}

bool punctuation(const std::string &text) {
  const auto chars = codepoints(text);
  return !chars.empty() && std::all_of(chars.begin(), chars.end(), [](uint32_t c) {
    return c <= 32 || (c < 128 && std::ispunct(static_cast<unsigned char>(c))) ||
      (c >= 0x2000 && c <= 0x206f) || (c >= 0x3000 && c <= 0x303f) ||
      (c >= 0xff01 && c <= 0xff0f) || (c >= 0xff1a && c <= 0xff20) ||
      (c >= 0xff3b && c <= 0xff40) || (c >= 0xff5b && c <= 0xff65);
  });
}

bool controlToken(const std::string &text) { return text.rfind("<|", 0) == 0; }

class Api {
  HMODULE library_ = nullptr;
  HMODULE ortLibrary_ = nullptr;
  template <typename T> T bind(const char *name) {
    auto function = GetProcAddress(library_, name);
    if (!function) throw std::runtime_error(std::string("Runtime missing export: ") + name);
    return reinterpret_cast<T>(function);
  }
 public:
#define API_FUNCTIONS(X) \
  X(SherpaOnnxGetVersionStr) \
  X(SherpaOnnxCreateOfflineRecognizer) X(SherpaOnnxDestroyOfflineRecognizer) \
  X(SherpaOnnxCreateOfflineStream) X(SherpaOnnxDestroyOfflineStream) \
  X(SherpaOnnxAcceptWaveformOffline) X(SherpaOnnxDecodeOfflineStream) \
  X(SherpaOnnxGetOfflineStreamResult) X(SherpaOnnxDestroyOfflineRecognizerResult) \
  X(SherpaOnnxReadWaveFromBinaryData) X(SherpaOnnxFreeWave) \
  X(SherpaOnnxCreateVoiceActivityDetector) X(SherpaOnnxDestroyVoiceActivityDetector) \
  X(SherpaOnnxVoiceActivityDetectorAcceptWaveform) X(SherpaOnnxVoiceActivityDetectorFlush) \
  X(SherpaOnnxVoiceActivityDetectorEmpty) X(SherpaOnnxVoiceActivityDetectorFront) \
  X(SherpaOnnxVoiceActivityDetectorPop) X(SherpaOnnxDestroySpeechSegment)
#define DECLARE(name) decltype(&::name) name = nullptr;
  API_FUNCTIONS(DECLARE)
#undef DECLARE
  explicit Api(const fs::path &directory) {
    ortLibrary_ = LoadLibraryExW((directory / L"onnxruntime.dll").c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (!ortLibrary_) throw std::runtime_error("Cannot load packaged onnxruntime.dll and its C++ runtime dependencies (Windows error " + std::to_string(GetLastError()) + ")");
    library_ = LoadLibraryExW((directory / L"sherpa-onnx-c-api.dll").c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (!library_) {
      const auto error = GetLastError(); FreeLibrary(ortLibrary_); ortLibrary_ = nullptr;
      throw std::runtime_error("Cannot load sherpa-onnx-c-api.dll (Windows error " + std::to_string(error) + ")");
    }
    try {
#define LOAD(name) name = bind<decltype(name)>(#name);
      API_FUNCTIONS(LOAD)
#undef LOAD
      if (std::string(SherpaOnnxGetVersionStr()).rfind("1.13.8", 0) != 0)
        throw std::runtime_error("This executable requires sherpa-onnx 1.13.8");
    } catch (...) { FreeLibrary(library_); library_ = nullptr; FreeLibrary(ortLibrary_); ortLibrary_ = nullptr; throw; }
  }
  ~Api() { if (library_) FreeLibrary(library_); if (ortLibrary_) FreeLibrary(ortLibrary_); }
  Api(const Api &) = delete;
  Api &operator=(const Api &) = delete;
  void checkOrtApi() const {
    struct OrtApiBase { const void *(__stdcall *getApi)(uint32_t); const char *(__stdcall *getVersion)(); };
    using GetBase = const OrtApiBase *(__stdcall *)();
    auto getBase = reinterpret_cast<GetBase>(GetProcAddress(ortLibrary_, "OrtGetApiBase"));
    if (!getBase || !getBase()->getApi(28))
      throw std::runtime_error("ONNX Runtime API 28 is required by this SDK; restore the compatible CPU DLL from the standalone package");
  }
  std::string ortVersion() const {
    struct OrtApiBase { const void *(__stdcall *getApi)(uint32_t); const char *(__stdcall *getVersion)(); };
    using GetBase = const OrtApiBase *(__stdcall *)();
    auto getBase = reinterpret_cast<GetBase>(GetProcAddress(ortLibrary_, "OrtGetApiBase"));
    return getBase ? getBase()->getVersion() : "unknown";
  }
  std::string ortPath() const {
    wchar_t path[32768];
    const auto size = GetModuleFileNameW(ortLibrary_, path, 32768);
    return utf8(std::wstring(path, size));
  }
};

struct Options {
  fs::path input, modelDirectory, output, srtOutput, assOutput, textOutput;
  std::string language = "zh", format = "json";
  int threads = 4;
  bool itn = true, check = false, version = false, help = false;
};

Options parse(int argc, wchar_t **argv, const fs::path &directory) {
  Options o;
  o.modelDirectory = directory / L"models" / L"sensevoice-small";
  for (int i = 1; i < argc; i++) {
    const std::wstring flag = argv[i];
    auto value = [&]() -> std::wstring {
      if (++i >= argc) throw std::runtime_error("Missing value for " + utf8(flag));
      return argv[i];
    };
    if (flag == L"-i" || flag == L"--input") o.input = value();
    else if (flag == L"-o" || flag == L"--output") o.output = value();
    else if (flag == L"--model-dir") o.modelDirectory = value();
    else if (flag == L"--srt-output") o.srtOutput = value();
    else if (flag == L"--ass-output") o.assOutput = value();
    else if (flag == L"--text-output") o.textOutput = value();
    else if (flag == L"--language") o.language = utf8(value());
    else if (flag == L"--format") o.format = utf8(value());
    else if (flag == L"--threads") {
      const std::string text = utf8(value());
      size_t used = 0;
      o.threads = std::stoi(text, &used);
      if (used != text.size() || o.threads < 1 || o.threads > 64) throw std::runtime_error("threads must be 1..64");
    } else if (flag == L"--no-itn") o.itn = false;
    else if (flag == L"--check") o.check = true;
    else if (flag == L"--version") o.version = true;
    else if (flag == L"-h" || flag == L"--help") o.help = true;
    else throw std::runtime_error("Unknown argument: " + utf8(flag));
  }
  if (argc == 1) o.help = true;
  const std::vector<std::string> languages = {"zh", "en", "ja", "ko", "yue", "auto"};
  if (std::find(languages.begin(), languages.end(), o.language) == languages.end()) throw std::runtime_error("language must be zh, en, ja, ko, yue or auto");
  if (o.format != "json" && o.format != "text" && o.format != "srt" && o.format != "ass") throw std::runtime_error("format must be json, text, srt or ass");
  if (!o.help && !o.check && !o.version && o.input.empty()) throw std::runtime_error("--input is required");
  return o;
}

struct Token { std::string text, endSource; int64_t start, end; bool lexical; };
struct Span { int64_t start, end; };

std::vector<float> resample(const float *samples, int count, int rate) {
  if (rate == 16000) return {samples, samples + count};
  const int size = std::max(1, int(std::lround(double(count) * 16000 / rate)));
  std::vector<float> output(size);
  for (int i = 0; i < size; i++) {
    const double source = double(i) * rate / 16000;
    const int left = std::min(count - 1, int(source)), right = std::min(count - 1, left + 1);
    output[i] = float(samples[left] * (1 - (source - left)) + samples[right] * (source - left));
  }
  return output;
}

std::string timestamp(int64_t ms) {
  std::ostringstream out;
  out << std::setfill('0') << std::setw(2) << ms / 3600000 << ':' << std::setw(2) << ms / 60000 % 60
      << ':' << std::setw(2) << ms / 1000 % 60 << ',' << std::setw(3) << ms % 1000;
  return out.str();
}

std::string joinToken(const std::string &left, const std::string &right) {
  if (!left.empty() && !right.empty() && std::isalnum(static_cast<unsigned char>(left.back())) &&
      std::isalnum(static_cast<unsigned char>(right.front()))) return left + " " + right;
  return left + right;
}

std::vector<Cue> captions(const std::vector<Token> &tokens) {
  std::vector<Cue> output;
  Cue current{};
  bool pendingBreak = false;
  auto flush = [&]() { if (!current.text.empty()) output.push_back(current); current = {}; pendingBreak = false; };
  for (const auto &token : tokens) {
    if (controlToken(token.text)) continue;
    if (!token.lexical) {
      if (!current.text.empty()) current.text += token.text;
      pendingBreak = true;
      continue;
    }
    if (!current.text.empty() && (pendingBreak || token.start - current.end >= 300 ||
        codepoints(current.text).size() + codepoints(token.text).size() > 24)) flush();
    if (current.text.empty()) current.start = token.start;
    current.text = joinToken(current.text, token.text);
    current.end = token.end;
  }
  flush();
  return output;
}

void writeOutput(const fs::path &file, const std::string &content, const Options &o, const fs::path &directory) {
  if (file.empty()) { std::fwrite(content.data(), 1, content.size(), stdout); return; }
  const std::vector<fs::path> protectedFiles = {o.input, o.modelDirectory / L"model.int8.onnx",
    o.modelDirectory / L"tokens.txt", o.modelDirectory / L"silero_vad.onnx", directory / L"sensevoice-cli.exe",
    directory / L"sherpa-onnx-c-api.dll", directory / L"onnxruntime.dll", directory / L"onnxruntime_providers_shared.dll"};
  for (const auto &protectedFile : protectedFiles) {
    std::error_code error;
    if (!protectedFile.empty() && fs::equivalent(file, protectedFile, error) && !error)
      throw std::runtime_error("Output must not overwrite input, model or runtime files");
  }
  if (!file.parent_path().empty()) fs::create_directories(file.parent_path());
  std::ofstream output(file, std::ios::binary);
  if (!output) throw std::runtime_error("Cannot write output: " + utf8(file.wstring()));
  output.write(content.data(), static_cast<std::streamsize>(content.size()));
  if (!output) throw std::runtime_error("Failed writing output");
}

int run(const Options &o, const fs::path &directory) {
  Api api(directory);
  if (o.version) {
    std::printf("{\"cliVersion\":\"%s\",\"sherpaVersion\":%s,\"onnxruntimeVersion\":%s,\"onnxruntimePath\":%s}\n", kVersion,
      quote(api.SherpaOnnxGetVersionStr()).c_str(), quote(api.ortVersion()).c_str(), quote(api.ortPath()).c_str());
    return 0;
  }
  api.checkOrtApi();
  const auto model = o.modelDirectory / L"model.int8.onnx", tokensFile = o.modelDirectory / L"tokens.txt",
      vadFile = o.modelDirectory / L"silero_vad.onnx";
  for (const auto &file : {model, tokensFile, vadFile}) if (!fs::is_regular_file(file) || fs::file_size(file) == 0)
    throw std::runtime_error("Missing model resource: " + utf8(file.wstring()));
  const std::string modelUtf8 = utf8(fs::absolute(model).wstring()), tokensUtf8 = utf8(fs::absolute(tokensFile).wstring()),
      vadUtf8 = utf8(fs::absolute(vadFile).wstring());
  const auto loaded = Clock::now();
  SherpaOnnxOfflineRecognizerConfig config{};
  config.feat_config.sample_rate = 16000;
  config.feat_config.feature_dim = 80;
  config.model_config.sense_voice.model = modelUtf8.c_str();
  config.model_config.sense_voice.language = o.language.c_str();
  config.model_config.sense_voice.use_itn = o.itn;
  config.model_config.tokens = tokensUtf8.c_str();
  config.model_config.num_threads = o.threads;
  config.model_config.provider = "cpu";
  config.decoding_method = "greedy_search";
  const auto *recognizer = api.SherpaOnnxCreateOfflineRecognizer(&config);
  if (!recognizer) throw std::runtime_error("Cannot create SenseVoice recognizer");
  Guard recognizerGuard{[&]() { api.SherpaOnnxDestroyOfflineRecognizer(recognizer); }};
  SherpaOnnxVadModelConfig vadConfig{};
  vadConfig.silero_vad.model = vadUtf8.c_str();
  vadConfig.silero_vad.threshold = 0.5f;
  vadConfig.silero_vad.min_silence_duration = 0.25f;
  vadConfig.silero_vad.min_speech_duration = 0.1f;
  vadConfig.silero_vad.max_speech_duration = 30;
  vadConfig.silero_vad.window_size = 512;
  vadConfig.sample_rate = 16000;
  vadConfig.num_threads = 1;
  vadConfig.provider = "cpu";
  if (o.check) {
    auto *vad = api.SherpaOnnxCreateVoiceActivityDetector(&vadConfig, 10);
    if (!vad) throw std::runtime_error("Cannot create Silero VAD");
    api.SherpaOnnxDestroyVoiceActivityDetector(vad);
    std::printf("{\"ok\":true,\"cliVersion\":\"%s\",\"sherpaVersion\":%s,\"provider\":\"cpu\",\"threads\":%d}\n",
      kVersion, quote(api.SherpaOnnxGetVersionStr()).c_str(), o.threads);
    return 0;
  }
  const double loadMs = std::chrono::duration<double, std::milli>(Clock::now() - loaded).count();
  std::ifstream audio(o.input, std::ios::binary | std::ios::ate);
  if (!audio) throw std::runtime_error("Cannot open input audio: " + utf8(o.input.wstring()));
  const auto size = audio.tellg();
  if (size <= 44 || size > std::numeric_limits<int32_t>::max()) throw std::runtime_error("Invalid or oversized WAV input");
  std::vector<char> bytes(static_cast<size_t>(size));
  audio.seekg(0); audio.read(bytes.data(), static_cast<std::streamsize>(size));
  if (!audio) throw std::runtime_error("Cannot read input audio");
  const auto *wave = api.SherpaOnnxReadWaveFromBinaryData(bytes.data(), static_cast<int32_t>(bytes.size()));
  if (!wave || wave->num_samples <= 0 || wave->sample_rate <= 0) throw std::runtime_error("Input must be a mono 16-bit PCM WAV file");
  Guard waveGuard{[&]() { api.SherpaOnnxFreeWave(wave); }};
  const int64_t duration = std::max<int64_t>(1, std::llround(double(wave->num_samples) * 1000 / wave->sample_rate));
  const auto *stream = api.SherpaOnnxCreateOfflineStream(recognizer);
  if (!stream) throw std::runtime_error("Cannot create recognition stream");
  Guard streamGuard{[&]() { api.SherpaOnnxDestroyOfflineStream(stream); }};
  auto start = Clock::now();
  api.SherpaOnnxAcceptWaveformOffline(stream, wave->sample_rate, wave->samples, wave->num_samples);
  api.SherpaOnnxDecodeOfflineStream(recognizer, stream);
  const double recognitionMs = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
  const auto *result = api.SherpaOnnxGetOfflineStreamResult(stream);
  if (!result) throw std::runtime_error("Recognizer returned no result");
  Guard resultGuard{[&]() { api.SherpaOnnxDestroyOfflineRecognizerResult(result); }};
  if (result->count && (!result->timestamps || !result->tokens_arr)) throw std::runtime_error("SenseVoice result has no token timestamps");
  start = Clock::now();
  const auto samples = resample(wave->samples, wave->num_samples, wave->sample_rate);
  const auto *vad = api.SherpaOnnxCreateVoiceActivityDetector(&vadConfig, float(std::max<int64_t>(10, duration / 1000 + 2)));
  if (!vad) throw std::runtime_error("Cannot create Silero VAD");
  Guard vadGuard{[&]() { api.SherpaOnnxDestroyVoiceActivityDetector(vad); }};
  for (size_t i = 0; i < samples.size(); i += 512)
    api.SherpaOnnxVoiceActivityDetectorAcceptWaveform(vad, samples.data() + i, static_cast<int32_t>(std::min<size_t>(512, samples.size() - i)));
  api.SherpaOnnxVoiceActivityDetectorFlush(vad);
  std::vector<Span> segments;
  while (!api.SherpaOnnxVoiceActivityDetectorEmpty(vad)) {
    const auto *segment = api.SherpaOnnxVoiceActivityDetectorFront(vad);
    if (!segment) throw std::runtime_error("VAD returned invalid segment");
    const int64_t begin = std::clamp<int64_t>(std::llround(double(segment->start) * 1000 / 16000), 0, duration);
    const int64_t end = std::clamp<int64_t>(std::llround(double(segment->start + segment->n) * 1000 / 16000), begin, duration);
    if (end > begin) segments.push_back({begin, end});
    api.SherpaOnnxDestroySpeechSegment(segment);
    api.SherpaOnnxVoiceActivityDetectorPop(vad);
  }
  const double vadMs = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
  std::vector<Token> tokenList;
  for (int i = 0; i < result->count; i++) {
    const std::string text = result->tokens_arr[i] ? result->tokens_arr[i] : "";
    if (text.empty() || !std::isfinite(result->timestamps[i])) continue;
    const int64_t begin = std::clamp<int64_t>(std::llround(result->timestamps[i] * 1000), 0, duration - 1);
    const bool lexical = !punctuation(text) && !controlToken(text);
    int64_t end = duration;
    std::string source = "audio-end";
    for (int j = i + 1; j < result->count; j++) {
      if (result->tokens_arr[j] && !punctuation(result->tokens_arr[j]) && !controlToken(result->tokens_arr[j]) && std::isfinite(result->timestamps[j])) {
        end = std::llround(result->timestamps[j] * 1000); source = "next-token"; break;
      }
    }
    if (result->durations && std::isfinite(result->durations[i]) && result->durations[i] > 0) {
      end = begin + std::llround(result->durations[i] * 1000); source = "model-duration";
    } else for (const auto &segment : segments) {
      if (begin >= segment.start - 60 && begin < segment.end && segment.end < end) { end = segment.end; source = "vad-boundary"; break; }
    }
    end = std::clamp<int64_t>(end, begin + 1, duration);
    tokenList.push_back({text, source, begin, end, lexical});
  }
  const auto cues = captions(tokenList);
  std::ostringstream json, srt;
  json.imbue(std::locale::classic());
  json << "{\"schemaVersion\":1,\"engine\":\"SenseVoiceSmall-INT8\",\"cliVersion\":" << quote(kVersion)
       << ",\"runtimeVersion\":" << quote(api.SherpaOnnxGetVersionStr()) << ",\"provider\":\"cpu\",\"threads\":" << o.threads
       << ",\"audio\":{\"sampleRate\":" << wave->sample_rate << ",\"durationMs\":" << duration << "},\"text\":" << quote(result->text ? result->text : "")
       << ",\"language\":" << quote(result->lang ? result->lang : "") << ",\"emotion\":" << quote(result->emotion ? result->emotion : "")
       << ",\"event\":" << quote(result->event ? result->event : "") << ",\"tokens\":[";
  for (size_t i = 0; i < tokenList.size(); i++) {
    const auto &token = tokenList[i];
    if (i) json << ',';
    json << "{\"text\":" << quote(token.text) << ",\"startMs\":" << token.start << ",\"endMs\":" << token.end
         << ",\"endSource\":" << quote(token.endSource) << ",\"lexical\":" << (token.lexical ? "true" : "false") << '}';
  }
  json << "],\"speechSegments\":[";
  for (size_t i = 0; i < segments.size(); i++) { if (i) json << ','; json << "{\"startMs\":" << segments[i].start << ",\"endMs\":" << segments[i].end << '}'; }
  json << "],\"subtitles\":[";
  for (size_t i = 0; i < cues.size(); i++) {
    if (i) json << ',';
    json << "{\"text\":" << quote(cues[i].text) << ",\"startMs\":" << cues[i].start << ",\"endMs\":" << cues[i].end << '}';
    srt << i + 1 << '\n' << timestamp(cues[i].start) << " --> " << timestamp(cues[i].end) << '\n' << cues[i].text << "\n\n";
  }
  json << "],\"timings\":{\"loadMs\":" << loadMs << ",\"recognitionMs\":" << recognitionMs << ",\"vadMs\":" << vadMs << "}}\n";
  const std::string text = std::string(result->text ? result->text : "") + "\n";
  const std::string ass = (o.format == "ass" || !o.assOutput.empty()) ? exportAss(cues) : "";
  if (!o.srtOutput.empty()) writeOutput(o.srtOutput, srt.str(), o, directory);
  if (!o.assOutput.empty()) writeOutput(o.assOutput, ass, o, directory);
  if (!o.textOutput.empty()) writeOutput(o.textOutput, text, o, directory);
  writeOutput(o.output, o.format == "text" ? text : o.format == "srt" ? srt.str() : o.format == "ass" ? ass : json.str(), o, directory);
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  SetConsoleOutputCP(CP_UTF8);
  _setmode(_fileno(stdout), _O_BINARY);
  try {
    const auto directory = executableDirectory();
    const auto options = parse(argc, argv, directory);
    if (options.help) {
      std::puts("SenseVoice CLI 0.1.1 (Windows x64, native CPU, offline)\n"
        "Usage: sensevoice-cli.exe -i audio.wav [options]\n"
        "  -i, --input PATH       Mono PCM16 WAV (any sample rate)\n"
        "  -o, --output PATH      Write selected format to a UTF-8 file\n"
        "  --format FORMAT       json|text|srt|ass (default: json to stdout)\n"
        "  --srt-output PATH      Additionally write SRT in the same run\n"
        "  --ass-output PATH      Additionally write styled ASS in the same run\n"
        "  --text-output PATH     Additionally write transcript text\n"
        "  --model-dir PATH       Default: EXE-directory/models/sensevoice-small\n"
        "  --language CODE        zh|en|ja|ko|yue|auto (default: zh)\n"
        "  --threads N            ASR CPU threads, 1..64 (default: 4)\n"
        "  --no-itn               Disable inverse text normalization\n"
        "  --check                Load and validate ASR/VAD resources\n"
        "  --version              Print runtime version JSON\n"
        "  -h, --help             Show help\n"
        "Exit codes: 0 success; 1 runtime/input/output failure; 2 argument error.\n"
        "Token starts come from ASR; inferred ends are labelled by endSource.");
      return 0;
    }
    try { return run(options, directory); }
    catch (const std::exception &error) { std::fprintf(stderr, "{\"error\":%s}\n", quote(error.what()).c_str()); return 1; }
  } catch (const std::exception &error) {
    std::fprintf(stderr, "{\"error\":%s}\n", quote(error.what()).c_str());
    return 2;
  }
}
