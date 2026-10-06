# 开源功能参考

本轮检查日期：2026-10-06。以下项目通过 GitHub 连接器读取 README 和许可证，并核对官方仓库。只借鉴用户工作流，未复制上游源码、素材、图标或构建产物。

| 项目 | 已读取的许可证 | 可借鉴能力 | 本轮决定 |
| --- | --- | --- | --- |
| [LosslessCut](https://github.com/mifi/lossless-cut) | [GPL-2.0](https://github.com/mifi/lossless-cut/blob/master/LICENSE) | 视频截图、帧时间码、片段标签、快速看片 | 将人工选帧和时间码分镜做进工作台；以 video / Canvas 独立实现 |
| [Subtitle Edit](https://github.com/SubtitleEdit/subtitleedit) | [MIT](https://github.com/SubtitleEdit/subtitleedit/blob/main/LICENSE) | 本地字幕编辑、视频播放与文本对照 | 将现有 SRT / VTT 来源映射接到原片定位，支持循环核对一句文案 |
| [wavesurfer.js](https://github.com/katspaugh/wavesurfer.js) | [BSD-3-Clause](https://github.com/katspaugh/wavesurfer.js/blob/main/LICENSE) | 波形、区间和时间轴 | 留作后续参考；README 指出整段音频解码有大文件内存限制，本轮先交付无需音频解码的看片功能 |

README 文件校验值（GitHub blob SHA）：LosslessCut `f6e053c59dc6280954a0f758d5a9c703971a7dc8`，Subtitle Edit `514e8199139ce12699d92469a2cb1563898d64e3`，wavesurfer.js `8dc9a6c5e0970b3d7871c36382e6936633600259`。这些是调研证据，不是运行时依赖版本。

## 已接入功能

入口位于独立工作台 STEP 03 的“逐句看片与分镜截图”折叠区域。结构分析中具有时间码的段落也可直接进入原片定位。

- 用用户主动选择的视频建立本地 Blob URL；保留原文件，不读取网页或远程媒体。
- 读取现有 Transcript v2 的时间码，不再解析第二份字幕结构。正文变化后清空旧定位；无时间码文本可手动播放截图。
- 支持人工偏移 -600 到 600 秒、0.5–1.5 倍播放和当前句循环。越界时间码提示核对来源，不静默截断或猜测位置。
- 人工选帧、160 字以内画面备注、单图 JPEG 与分镜 PNG 导出；预览帧最长边 960 px。分镜图的原句摘录最多 240 字，备注保留全部文字并归并换行。
- 单个视频最多 2 GB、6 小时、3,400 万像素；最多 12 张、单张缓存最多 2 MB。所有截图与备注只在当前页面，旧 Blob URL 会释放。

这些能力不构成视频剪辑器。浏览器不支持的编码需用已有本机标准化流程转成 H.264 MP4 或 WebM；定位、循环和截图不保证逐帧精度。导出的截图是沟通用预览，原片才是制作素材。

## 代码与许可证

实现文件为 `src/clip-review.js`、`src/clip-review-ui.js`，接入现有 `workbench.html`、`workbench.css`、`workbench.js`。没有引入第三方运行依赖、CDN、远程代码或模型，仓库 MIT 许可证不因这次功能参考而改变。
