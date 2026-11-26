# 帧舟成片演示

下载仓库后，打开 [样片播放器](index.html) 即可播放两条有声竖屏样片。每条附带应用发布包生成的封面和可复制文案。

| 样片 | 输出 | 输入与实际操作 |
| --- | --- | --- |
| 文案成片 | [MP4 · 39 秒](frameskiff-script.mp4?raw=true) · [封面](frameskiff-script.jpg) · [文案](frameskiff-script-post.txt) | 用[演示文案](frameskiff-script.txt)在本机生成旁白和字幕，以帧舟界面截图为分镜素材，其中一处换成字幕编辑画面。 |
| 口播精剪前后对照 | [MP4 · 18 秒](frameskiff-talk.mp4?raw=true) · [封面](frameskiff-talk.jpg) · [文案](frameskiff-talk-post.txt) | 用[同一段演示原片](frameskiff-talk-source.mp4?raw=true)对比剪辑前后。原声使用本地合成语音，句间加入长停顿以展示处理效果。从 10.10 秒缩短到约 8.12 秒，并添加了字幕和人工设置的提示卡。 |

在桌面应用中可以分别粘贴演示文案和导入口播原片，体验两个工作流。要复现发布包和样片，先准备仓库的 Windows 本地模型与渲染资源，在 Windows 安装依赖并运行 `pnpm build`，再执行 `node scripts/build-publishing-demos.mjs`。脚本使用 `.windows-smoke/publishing-demos` 作为工作目录，把两套发布产物写到本目录。 [构建和模型准备](../building.md)

早期项目介绍中的[品牌宣传片](LocalVideoFactory_BrandFilm_16x9.mp4?raw=true)与[搞笑短片](funny-demo.mp4?raw=true)仍可下载。 [早期短片动图](funny-demo.gif)
