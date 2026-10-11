#include "ass-export.h"
#include <cassert>
#include <iostream>

int main() {
  // Carry across seconds, minutes and hours; Unicode and literal ASS controls.
  const auto rendered = exportAss({{u8"你好，世界", 995, 2005},
      {"{\\pos(0,0)}\\N\r\nnext, line", 59995, 60005},
      {"short", 3599995, 3599996}});
  assert(rendered.find("ScriptType: v4.00+") != std::string::npos);
  assert(rendered.find("[V4+ Styles]") != std::string::npos);
  assert(rendered.find("[Events]") != std::string::npos);
  assert(rendered.find(u8"Dialogue: 0,0:00:01.00,0:00:02.01,Default,,0,0,0,,你好，世界\n") != std::string::npos);
  assert(rendered.find("Dialogue: 0,0:01:00.00,0:01:00.01,") != std::string::npos);
  assert(rendered.find("Dialogue: 0,1:00:00.00,1:00:00.01,") != std::string::npos);
  assert(rendered.find("{\\pos") == std::string::npos);
  assert(rendered.find(u8"｛＼pos(0,0)｝＼N\\Nnext, line") != std::string::npos);
  assert(assText("a\rb\nc\r\nd\t") == "a\\Nb\\Nc\\Nd");
  assert(exportAss({}).find("Dialogue:") == std::string::npos);
  assert(assTimestamp(-1) == "0:00:00.00");
  std::cout << "ASS export Unicode, escaping, time rollover, short cue and empty output checks passed.\n";
}
