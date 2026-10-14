#pragma once
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

struct CaptionWord {
  std::string text, tag;
  size_t startChar = 0, endChar = 0;
  int64_t start = 0, end = 0;
  bool estimated = false;
};
struct HighlightUnit {
  std::string text;
  size_t startChar = 0, endChar = 0;
  int64_t start = 0, end = 0;
  bool estimated = false;
};
struct Cue {
  std::string text;
  int64_t start, end;
  std::vector<CaptionWord> words;
  std::vector<HighlightUnit> highlights;
};

inline std::vector<std::string> utf8Characters(const std::string &text) {
  std::vector<std::string> chars;
  for (size_t i = 0; i < text.size();) {
    const auto first = static_cast<unsigned char>(text[i]);
    const size_t size = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 :
        first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
    if (!size || i + size > text.size()) throw std::runtime_error("Invalid UTF-8 caption text");
    uint32_t point = first & (size == 1 ? 0x7f : size == 2 ? 0x1f : size == 3 ? 0x0f : 0x07);
    for (size_t j = 1; j < size; ++j) {
      const auto byte = static_cast<unsigned char>(text[i + j]);
      if ((byte & 0xc0) != 0x80) throw std::runtime_error("Invalid UTF-8 caption text");
      point = (point << 6) | (byte & 0x3f);
    }
    if ((size == 2 && point < 0x80) || (size == 3 && point < 0x800) ||
        (size == 4 && point < 0x10000) || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
      throw std::runtime_error("Invalid UTF-8 caption text");
    chars.push_back(text.substr(i, size)); i += size;
  }
  return chars;
}
inline std::string characterSlice(const std::vector<std::string> &chars, size_t from, size_t to) {
  std::string result;
  for (size_t i = from; i < to && i < chars.size(); ++i) result += chars[i];
  return result;
}
