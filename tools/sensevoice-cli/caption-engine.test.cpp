#include "caption-engine.h"
#include "ass-export.h"
#include <cassert>
#include <iostream>

int main(int argc, char **argv) {
  assert(argc == 3);
  const std::filesystem::path root(argv[1]);
  CaptionSegmenter segmenter((root / "dict/jieba.dict.utf8").string(), (root / "dict/hmm_model.utf8").string());
  std::ifstream fixtures(argv[2]); assert(fixtures);
  std::string line;
  while (std::getline(fixtures, line)) {
    const auto tab = line.find('\t'); assert(tab != std::string::npos);
    const auto text = line.substr(0, tab), expected = line.substr(tab + 1);
    auto words = segmenter.cut(text);
    for (auto &word : words) { word.start = static_cast<int64_t>(word.startChar) * 100; word.end = static_cast<int64_t>(word.endChar) * 100; }
    const auto groups = groupCaptionWords(text, words, "phrase");
    std::string actual;
    for (const auto &group : groups) { if (!actual.empty()) actual += '|'; actual += group.text; }
    if (actual != expected) { std::cerr << text << "\nexpected: " << expected << "\nactual: " << actual << '\n'; return 1; }
  }
  // A multi-character model token must retain inferred timing provenance.
  const auto modifier = groupCaptionWords(u8"真正的转机", {{u8"真正","a",0,2,0,660,false},
    {u8"的","uj",2,3,660,960,false}, {u8"转机","n",3,5,960,1806,false}}, "phrase");
  assert(modifier.size() == 1 && modifier[0].text == u8"真正的转机");
  const Cue cue{u8"😀你好，你好。",100,1300,{}, {}};
  const std::vector<CaptionToken> tokens = {{u8"你好","model-duration",100,400,true},{u8"你好","model-duration",1000,1300,true}};
  const auto enhanced = enhanceCaption(cue, tokens, segmenter, "phrase");
  assert(enhanced.size() == 2);
  assert(enhanced[0].text + enhanced[1].text == cue.text);
  assert(enhanced[0].highlights[0].startChar == 1);
  assert(enhanced[0].highlights[0].estimated);
  assert(enhanced[0].end == 400 && enhanced[1].start == 1000);
  // Keeping one cue across silence must show plain text between active groups.
  Cue held{u8"你好世界",0,1500,{}, {{u8"你好",0,2,100,400,false},{u8"世界",2,4,1000,1300,false}}};
  const auto ass = exportAss({held}, true);
  assert(ass.find(u8"0:00:00.40,0:00:01.00,Default,,0,0,0,,你好世界") != std::string::npos);
  assert(ass.find(u8"{\\c&H006DE2FF&}你好{\\r}世界") != std::string::npos);
  // Quantized event boundaries share the same tick without extending into the next event.
  held.highlights = {{u8"你好",0,2,0,995,false},{u8"世界",2,4,995,1500,false}};
  const auto adjacent = exportAss({held}, true);
  assert(adjacent.find("0:00:00.00,0:00:01.00") != std::string::npos);
  assert(adjacent.find("0:00:01.00,0:00:01.50") != std::string::npos);
  bool rejected = false;
  try { utf8Characters(std::string("\xf0\x80\x80\x80",4)); } catch (...) { rejected = true; }
  assert(rejected);
  std::cout << "Native phrase fixtures, Unicode offsets, timing provenance, silence and ASS boundaries passed.\n";
}
