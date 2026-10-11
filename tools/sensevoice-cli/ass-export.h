#pragma once
#include <algorithm>
#include <cstdint>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

struct Cue { std::string text; int64_t start, end; };

// ASS override syntax must never be interpreted from recognized speech.
inline std::string assText(const std::string &text) {
  std::string output;
  for (size_t i = 0; i < text.size(); ++i) {
    switch (text[i]) {
      case '\\': output += u8"＼"; break;
      case '{': output += u8"｛"; break;
      case '}': output += u8"｝"; break;
      case '\r':
        if (i + 1 < text.size() && text[i + 1] == '\n') ++i;
        output += "\\N";
        break;
      case '\n': output += "\\N"; break;
      default:
        if (static_cast<unsigned char>(text[i]) >= 32) output += text[i];
    }
  }
  return output;
}

inline std::string assTimestamp(int64_t centiseconds) {
  const auto value = std::max<int64_t>(0, centiseconds);
  std::ostringstream output;
  output << value / 360000 << ':' << std::setfill('0') << std::setw(2) << value / 6000 % 60
         << ':' << std::setw(2) << value / 100 % 60 << '.' << std::setw(2) << value % 100;
  return output.str();
}

inline std::string exportAss(const std::vector<Cue> &cues) {
  std::ostringstream output;
  output << "[Script Info]\n"
         << "ScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n"
         << "WrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n"
         << "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
            "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, "
            "Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
         << "Style: Default,Microsoft YaHei,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,"
            "0,0,0,0,100,100,0,0,1,2,1,2,80,80,60,1\n\n[Events]\n"
         << "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
  for (const auto &cue : cues) {
    // ASS stores centiseconds. Keep even very short cues visible for one tick.
    const auto start = (std::max<int64_t>(0, cue.start) + 5) / 10;
    const auto end = std::max(start + 1, (std::max<int64_t>(0, cue.end) + 5) / 10);
    output << "Dialogue: 0," << assTimestamp(start) << ',' << assTimestamp(end)
           << ",Default,,0,0,0,," << assText(cue.text) << '\n';
  }
  return output.str();
}
