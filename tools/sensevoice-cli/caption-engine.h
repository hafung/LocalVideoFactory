#pragma once
#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <memory>
#include <regex>
#include <sstream>
#include "caption-types.h"
#include "cppjieba/MixSegment.hpp"

struct CaptionToken { std::string text, endSource; int64_t start, end; bool lexical; };

inline bool captionSeparator(const std::string &text) {
  static const std::vector<std::string> marks = {u8"，",u8"。",u8"！",u8"？",u8"；",u8"：",u8"、",",",".","!","?",";",":","\n"};
  return std::any_of(marks.begin(), marks.end(), [&](const auto &mark) { return text.find(mark) != std::string::npos; });
}

inline bool captionLexical(const std::string &text) {
  for (const auto &character : utf8Characters(text)) {
    const auto first = static_cast<unsigned char>(character[0]);
    if (first < 128) { if (std::isalnum(first)) return true; continue; }
    uint32_t point = first & (character.size() == 2 ? 0x1f : character.size() == 3 ? 0x0f : 0x07);
    for (size_t i = 1; i < character.size(); ++i) point = (point << 6) | (static_cast<unsigned char>(character[i]) & 0x3f);
    if ((point >= 0x2000 && point <= 0x2bff) || (point >= 0x3000 && point <= 0x303f) ||
        (point >= 0xff01 && point <= 0xff0f) || (point >= 0xff1a && point <= 0xff20) ||
        (point >= 0xff3b && point <= 0xff40) || (point >= 0xff5b && point <= 0xff65) ||
        (point >= 0x1f000 && point <= 0x1faff) || point == 0x00a0 || point == 0xfe0f) continue;
    return true;
  }
  return false;
}

class CaptionSegmenter {
  cppjieba::DictTrie dictionary_;
  cppjieba::HMMModel model_;
  cppjieba::MixSegment segmenter_;
 public:
  CaptionSegmenter(const std::string &dict, const std::string &model, const std::filesystem::path &user = {})
      : dictionary_(dict), model_(model), segmenter_(&dictionary_, &model_) {
    dictionary_.InsertUserWord(u8"高级感", 100000, "n");
    dictionary_.InsertUserWord(u8"无理由退货", 100000, "v");
    if (!user.empty()) loadUserDictionary(user);
  }
  void loadUserDictionary(const std::filesystem::path &file) {
    std::ifstream input(file);
    if (!input) throw std::runtime_error("Cannot open user dictionary");
    std::string line; int lineNumber = 0;
    while (std::getline(input, line)) {
      ++lineNumber;
      if (lineNumber == 1 && line.rfind("\xef\xbb\xbf", 0) == 0) line.erase(0, 3);
      utf8Characters(line);
      std::istringstream stream(line);
      std::vector<std::string> fields; std::string field;
      while (stream >> field) fields.push_back(field);
      if (fields.empty()) continue;
      if (fields.size() > 3) throw std::runtime_error("Invalid user dictionary line " + std::to_string(lineNumber));
      int frequency = 100000;
      std::string tag = fields.size() == 2 ? fields[1] : fields.size() == 3 ? fields[2] : "n";
      if (fields.size() == 3) {
        size_t used = 0;
        try { frequency = std::stoi(fields[1], &used); } catch (...) { used = 0; }
        if (used != fields[1].size() || frequency <= 0) throw std::runtime_error("Invalid dictionary frequency at line " + std::to_string(lineNumber));
      }
      if (!dictionary_.InsertUserWord(fields[0], frequency, tag)) throw std::runtime_error("Invalid dictionary word at line " + std::to_string(lineNumber));
    }
  }
  std::vector<CaptionWord> cut(const std::string &text) const {
    static const std::regex protectedText(u8"[0-9]+(?:[.,][0-9]+)*(?:万元|亿元|小时|分钟|秒钟|毫秒|公斤|厘米|毫米|公里|千米|元|块|天|年|月|日|秒|米|克|岁|个|%|％)|[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*");
    std::vector<CaptionWord> words;
    size_t offset = 0;
    auto append = [&](const std::string &value, const std::string &tag) {
      const auto length = utf8Characters(value).size();
      if (captionLexical(value)) words.push_back({value, tag, offset, offset + length});
      offset += length;
    };
    auto cutPart = [&](const std::string &part) {
      std::vector<std::pair<std::string,std::string>> tagged;
      segmenter_.Tag(part, tagged);
      std::string reconstructed;
      for (const auto &word : tagged) { append(word.first, word.second); reconstructed += word.first; }
      if (reconstructed != part) throw std::runtime_error("Segmenter did not preserve caption text");
    };
    size_t cursor = 0;
    for (std::sregex_iterator it(text.begin(), text.end(), protectedText), end; it != end; ++it) {
      const auto position = static_cast<size_t>(it->position());
      cutPart(text.substr(cursor, position - cursor));
      append(it->str(), std::isdigit(static_cast<unsigned char>(it->str()[0])) ? "m" : "eng");
      cursor = position + it->length();
    }
    cutPart(text.substr(cursor));
    return words;
  }
};

inline std::vector<HighlightUnit> groupCaptionWords(const std::string &text, const std::vector<CaptionWord> &words, const std::string &mode) {
  if (mode == "none") return {};
  const auto chars = utf8Characters(text);
  const std::vector<std::string> particles = {u8"的",u8"了",u8"着",u8"过",u8"呢",u8"吧",u8"啊"};
  std::vector<HighlightUnit> groups;
  const CaptionWord *previous = nullptr;
  for (const auto &word : words) {
    const auto *last = groups.empty() ? nullptr : &groups.back();
    const auto size = last ? last->endChar - last->startChar : 0;
    const bool particle = std::find(particles.begin(), particles.end(), word.text) != particles.end();
    const bool predicate = previous && !previous->tag.empty() && !word.tag.empty() &&
      (previous->tag[0] == 'n' || previous->tag[0] == 'r') && std::string("vdp").find(word.tag[0]) != std::string::npos && size >= 2;
    const bool completesModifier = previous && !word.tag.empty() &&
        ((previous->text == u8"的" && (word.tag[0] == 'n' || word.tag[0] == 'a')) ||
          (previous->tag == "m" && word.tag[0] == 'n' && size <= 3));
    const bool shouldBreak = mode == "word" || !last ||
      captionSeparator(characterSlice(chars, previous->endChar, word.startChar)) || word.start - previous->end >= 300 ||
      size + word.endChar - word.startChar > 8 ||
      (!particle && !completesModifier && (size >= 4 || word.end - last->start > 1500 || predicate || previous->tag == "c"));
    if (shouldBreak) groups.push_back({word.text, word.startChar, word.endChar, word.start, word.end, word.estimated});
    else {
      auto &group = groups.back(); group.endChar = word.endChar; group.end = word.end;
      group.estimated = group.estimated || word.estimated;
      group.text = characterSlice(chars, group.startChar, group.endChar);
    }
    previous = &word;
  }
  return groups;
}

inline std::vector<Cue> enhanceCaption(const Cue &cue, const std::vector<CaptionToken> &tokens,
    const CaptionSegmenter &segmenter, const std::string &mode) {
  struct CharacterTime { std::string text; int64_t start, end; bool estimated; };
  std::vector<CharacterTime> times;
  for (const auto &token : tokens) {
    if (!token.lexical || token.start < cue.start || token.start >= cue.end) continue;
    const auto all = utf8Characters(token.text);
    std::vector<std::string> lexical;
    for (const auto &character : all) if (captionLexical(character)) lexical.push_back(character);
    for (size_t i = 0; i < lexical.size(); ++i) {
      const auto start = token.start + (token.end - token.start) * static_cast<int64_t>(i) / static_cast<int64_t>(lexical.size());
      const auto end = token.start + (token.end - token.start) * static_cast<int64_t>(i + 1) / static_cast<int64_t>(lexical.size());
      times.push_back({lexical[i], start, std::max(start + 1, end), lexical.size() > 1});
    }
  }
  auto words = segmenter.cut(cue.text);
  size_t cursor = 0;
  for (auto &word : words) {
    const auto begin = cursor;
    for (const auto &character : utf8Characters(word.text)) {
      if (!captionLexical(character)) continue;
      if (cursor >= times.size() || times[cursor].text != character) throw std::runtime_error("Caption/token character mapping mismatch");
      word.estimated = word.estimated || times[cursor].estimated; ++cursor;
    }
    if (cursor == begin) throw std::runtime_error("Caption word has no timing evidence");
    word.start = times[begin].start; word.end = std::min(cue.end, times[cursor - 1].end);
    if (word.end <= word.start) throw std::runtime_error("Caption word has invalid timing evidence");
  }
  if (cursor != times.size()) throw std::runtime_error("Unmapped acoustic characters");
  if (mode == "none") { auto result = cue; result.words = words; return {result}; }
  const auto chars = utf8Characters(cue.text);
  const auto phrases = groupCaptionWords(cue.text, words, "phrase");
  std::vector<std::vector<HighlightUnit>> batches;
  for (const auto &phrase : phrases) {
    if (batches.empty() || phrase.endChar - batches.back().front().startChar > 12 ||
        phrase.start - batches.back().back().end >= 300 ||
        captionSeparator(characterSlice(chars, batches.back().back().endChar, phrase.startChar))) batches.push_back({phrase});
    else batches.back().push_back(phrase);
  }
  std::vector<Cue> result;
  for (size_t index = 0; index < batches.size(); ++index) {
    const auto &first = batches[index].front(), &last = batches[index].back();
    const auto from = index == 0 ? 0 : first.startChar;
    const auto to = index + 1 < batches.size() ? batches[index + 1].front().startChar : chars.size();
    Cue item{characterSlice(chars, from, to), first.start, last.end, {}, {}};
    for (auto word : words) if (word.startChar >= first.startChar && word.endChar <= last.endChar) {
      word.startChar -= from; word.endChar -= from; item.words.push_back(word);
    }
    item.highlights = groupCaptionWords(item.text, item.words, mode);
    result.push_back(std::move(item));
  }
  return result;
}
