import {
  CLIP_REVIEW_LIMITS,
  clipBoardLayout,
  clipCaptureDimensions,
  clipReviewCues,
  clipReviewRange,
  clipReviewTimestamp,
  validateClipNote,
  validateClipReviewFile,
  validateClipReviewMetadata
} from "./clip-review.js";

function canvasBlob(canvas, type = "image/png", quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("画面导出失败，请重试或缩小视频。")), type, quality);
  });
}

function drawWrappedText(context, text, x, y, width, lineHeight, maxLines) {
  let line = "";
  let lines = 0;
  for (const character of String(text)) {
    if (character === "\n" || context.measureText(line + character).width > width) {
      context.fillText(line, x, y + lines * lineHeight);
      lines += 1;
      line = character === "\n" ? "" : character;
      if (lines >= maxLines) return;
    } else line += character;
  }
  if (line && lines < maxLines) context.fillText(line, x, y + lines * lineHeight);
}

export function mountClipReview({ root, downloadBlob, onChange = () => {}, confirmDiscard = () => false, urls = globalThis.URL } = {}) {
  const panel = root?.querySelector?.("#clip-review-panel");
  if (!panel) return { mounted: false, setTranscript() {}, reset() {}, snapshot: () => ({}) };
  const query = (id) => panel.querySelector(`#${id}`);
  const video = query("clip-review-video");
  const fileInput = query("clip-review-file");
  const message = query("clip-review-message");
  const errorNode = query("clip-review-error");
  const list = query("clip-review-cues");
  const capturesNode = query("clip-review-captures");
  const offset = query("clip-review-offset");
  const listeners = [];
  let mediaUrl = "";
  let fileName = "";
  let ready = false;
  let cues = [];
  let page = 0;
  let selection = null;
  let loop = false;
  let captures = [];
  let preserved = false;
  let busy = false;
  let generation = 0;
  let revision = 0;
  let destroyed = false;
  let loadTimer;
  let lastDocument = null;
  let lastText = "";

  function element(tag, text = "", className = "") {
    const node = root.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function listen(node, event, handler) {
    node.addEventListener(event, handler);
    listeners.push(() => node.removeEventListener(event, handler));
  }
  function feedback(status = "", error = "") {
    message.textContent = status;
    errorNode.textContent = error;
  }
  function stopLoop() {
    loop = false;
    query("clip-review-loop").setAttribute("aria-pressed", "false");
    query("clip-review-loop").textContent = "循环本句";
  }
  function changed() {
    revision += 1;
    preserved = false;
    onChange();
  }
  function controls() {
    query("clip-review-capture").disabled = !ready || video.readyState < 2 || video.seeking || busy || captures.length >= CLIP_REVIEW_LIMITS.maxCaptures;
    query("clip-review-loop").disabled = !ready || !selection || busy;
    query("clip-review-export").disabled = !captures.length || busy;
    query("clip-review-clear").disabled = !captures.length || busy;
    query("clip-review-release").disabled = !mediaUrl || busy;
    offset.disabled = busy;
    query("clip-review-rate").disabled = !ready || busy;
    fileInput.disabled = busy;
    query("clip-review-choose").disabled = busy;
    for (const button of list.querySelectorAll("button")) button.disabled = !ready || busy;
    for (const control of capturesNode.querySelectorAll("button, textarea")) control.disabled = busy;
    query("clip-review-count").textContent = `${captures.length} / ${CLIP_REVIEW_LIMITS.maxCaptures} 张${captures.length ? preserved ? " · 已导出分镜图" : " · 尚未导出分镜图" : ""}`;
  }
  function renderCues() {
    list.replaceChildren();
    const start = page * CLIP_REVIEW_LIMITS.pageSize;
    for (const cue of cues.slice(start, start + CLIP_REVIEW_LIMITS.pageSize)) {
      const button = element("button", `${cue.index}. ${clipReviewTimestamp(cue.startMs / 1000)} → ${clipReviewTimestamp(cue.endMs / 1000)}\n${cue.text}`, "clip-review-cue secondary");
      button.type = "button";
      button.dataset.clipCue = cue.id;
      button.setAttribute("aria-pressed", String(selection?.cue.id === cue.id));
      button.disabled = !ready || busy;
      list.append(button);
    }
    const pages = Math.max(1, Math.ceil(cues.length / CLIP_REVIEW_LIMITS.pageSize));
    query("clip-review-page").textContent = cues.length ? `${cues.length} 句 · 第 ${page + 1} / ${pages} 页` : "导入 SRT / VTT 后可按句定位；普通文本仍可手动看片截图。";
    query("clip-review-prev").disabled = page === 0;
    query("clip-review-next").disabled = page + 1 >= pages;
  }
  function renderCaptures() {
    capturesNode.replaceChildren();
    for (const capture of captures) {
      const card = element("article", "", "clip-review-shot");
      const image = element("img");
      image.src = capture.url;
      image.alt = `人工分镜截图 ${clipReviewTimestamp(capture.time)}`;
      image.width = capture.width;
      image.height = capture.height;
      const label = element("label", "画面备注");
      const note = element("textarea");
      note.rows = 3;
      note.maxLength = CLIP_REVIEW_LIMITS.maxNoteLength;
      note.value = capture.note;
      note.dataset.clipNote = capture.id;
      label.append(note);
      const actions = element("div", "", "clip-review-shot-actions");
      for (const [action, title] of [["download", "导出此图"], ["remove", "移除此图"]]) {
        const button = element("button", title, "secondary");
        button.type = "button";
        button.dataset.clipShot = capture.id;
        button.dataset.clipAction = action;
        actions.append(button);
      }
      card.append(image, element("strong", clipReviewTimestamp(capture.time)), element("p", capture.caption || "人工选择的当前画面"), label, actions);
      capturesNode.append(card);
    }
    controls();
  }
  function releaseMedia() {
    clearTimeout(loadTimer);
    generation += 1;
    busy = false;
    ready = false;
    stopLoop();
    selection = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (mediaUrl) urls.revokeObjectURL(mediaUrl);
    mediaUrl = "";
    fileName = "";
    video.hidden = true;
    query("clip-review-media-label").textContent = "尚未选择对照原片";
    query("clip-review-caption").textContent = "";
    query("clip-review-clock").textContent = "00:00:00.000";
    renderCues();
    controls();
  }
  function clearCaptures() {
    for (const capture of captures) urls.revokeObjectURL(capture.url);
    captures = [];
    changed();
    renderCaptures();
  }
  function selectCue(cue) {
    if (!ready || busy) throw new Error("请先选择可播放的本地视频，再定位原片。");
    const range = clipReviewRange(cue, video.duration, offset.value);
    video.pause();
    stopLoop();
    selection = { cue, ...range };
    video.currentTime = range.start;
    query("clip-review-caption").textContent = cue.text;
    query("clip-review-selection").textContent = `已定位第 ${cue.index} 句 · ${clipReviewTimestamp(range.start)} → ${clipReviewTimestamp(range.end)}`;
    panel.open = true;
    renderCues();
    controls();
    feedback("已定位原片；点击播放器播放，或点击“循环本句”反复检查。");
  }
  listen(query("clip-review-choose"), "click", () => { if (!busy) fileInput.click(); });
  listen(fileInput, "change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || destroyed) return;
    try {
      validateClipReviewFile(file);
      if (captures.length && !preserved && !confirmDiscard("更换对照视频会清空当前尚未导出的分镜截图和备注。是否继续？")) return;
      releaseMedia();
      clearCaptures();
      mediaUrl = urls.createObjectURL(file);
      fileName = file.name;
      video.src = mediaUrl;
      video.hidden = false;
      video.playbackRate = Number(query("clip-review-rate").value);
      panel.open = true;
      query("clip-review-media-label").textContent = `${fileName} · 正在读取画面…`;
      feedback("正在本地载入视频…");
      const currentGeneration = generation;
      loadTimer = setTimeout(() => {
        if (destroyed || currentGeneration !== generation || ready) return;
        releaseMedia();
        feedback("", "视频读取超时；请使用浏览器可播放的 H.264 MP4 或 WebM 后重试。");
      }, 15000);
      controls();
      onChange();
    } catch (error) { feedback("", error.message); }
  });
  listen(video, "loadedmetadata", () => {
    if (!mediaUrl || destroyed) return;
    try {
      validateClipReviewMetadata({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
      ready = true;
      clearTimeout(loadTimer);
      query("clip-review-media-label").textContent = `${fileName} · ${video.videoWidth} × ${video.videoHeight} · ${clipReviewTimestamp(video.duration)}`;
      feedback("原片已载入；请核对字幕与视频是否来自同一份素材。");
      controls();
    } catch (error) { releaseMedia(); feedback("", error.message); }
  });
  listen(video, "error", () => {
    if (!mediaUrl || destroyed) return;
    releaseMedia();
    feedback("", "浏览器无法解码这一视频；请使用本机标准化后的 H.264 MP4 或 WebM。");
  });
  for (const event of ["loadeddata", "seeked", "seeking"]) listen(video, event, controls);
  listen(video, "timeupdate", () => {
    if (!ready || destroyed) return;
    query("clip-review-clock").textContent = clipReviewTimestamp(video.currentTime);
    if (loop && selection && !video.paused && (video.currentTime >= selection.end || video.currentTime < selection.start)) {
      video.currentTime = selection.start;
    }
  });
  listen(video, "ended", () => {
    if (!loop || !selection || destroyed) return;
    video.currentTime = selection.start;
    void video.play().catch(() => { stopLoop(); feedback("", "循环播放未能继续；请手动点击播放器播放。"); });
  });
  listen(list, "click", (event) => {
    const id = event.target.closest?.("[data-clip-cue]")?.dataset.clipCue;
    const cue = cues.find((item) => item.id === id);
    if (!cue) return;
    try { selectCue(cue); } catch (error) { feedback("", error.message); }
  });
  listen(query("clip-review-prev"), "click", () => { page = Math.max(0, page - 1); renderCues(); });
  listen(query("clip-review-next"), "click", () => { page = Math.min(Math.ceil(cues.length / CLIP_REVIEW_LIMITS.pageSize) - 1, page + 1); renderCues(); });
  listen(offset, "input", () => {
    stopLoop();
    selection = null;
    query("clip-review-selection").textContent = "偏移已改变，请重新选择句子。";
    query("clip-review-caption").textContent = "";
    renderCues();
    controls();
  });
  listen(query("clip-review-rate"), "change", (event) => { video.playbackRate = Number(event.target.value); });
  listen(panel, "toggle", () => {
    if (!panel.open) { stopLoop(); video.pause(); }
  });
  listen(query("clip-review-loop"), "click", async () => {
    if (!selection || !ready || busy) return;
    if (loop) { stopLoop(); video.pause(); return; }
    const currentGeneration = generation;
    try {
      loop = true;
      query("clip-review-loop").setAttribute("aria-pressed", "true");
      query("clip-review-loop").textContent = "停止循环";
      video.currentTime = selection.start;
      await video.play();
    } catch (error) {
      if (currentGeneration !== generation || destroyed) return;
      stopLoop();
      feedback("", "播放未能开始；请点击播放器重试。");
    }
  });
  listen(query("clip-review-capture"), "click", async () => {
    if (!ready || video.readyState < 2 || video.seeking || busy || captures.length >= CLIP_REVIEW_LIMITS.maxCaptures) return;
    const currentGeneration = generation;
    busy = true;
    stopLoop();
    video.pause();
    controls();
    try {
      const dimensions = clipCaptureDimensions(video.videoWidth, video.videoHeight);
      const canvas = root.createElement("canvas");
      Object.assign(canvas, dimensions);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器无法建立截图画布，请关闭其他重型页面后重试。");
      const time = video.currentTime;
      const caption = selection && time >= selection.start && time <= selection.end ? selection.cue.text : "";
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas, "image/jpeg", 0.9);
      if (destroyed || currentGeneration !== generation) return;
      if (blob.size > CLIP_REVIEW_LIMITS.maxCaptureBytes) throw new Error("截图超过 2 MB；请降低原片分辨率后重试。");
      captures.push({ id: `shot-${++revision}`, time, caption, note: "", blob, url: urls.createObjectURL(blob), ...dimensions });
      changed();
      renderCaptures();
      feedback(`已加入分镜 ${captures.length} · ${clipReviewTimestamp(time)}；可添加画面备注后导出。`);
    } catch (error) {
      if (currentGeneration === generation && !destroyed) feedback("", error.message || "截图失败，请重试。");
    } finally {
      if (currentGeneration === generation && !destroyed) { busy = false; controls(); }
    }
  });
  listen(capturesNode, "input", (event) => {
    const capture = captures.find((item) => item.id === event.target.dataset?.clipNote);
    if (!capture || busy) return;
    try { capture.note = validateClipNote(event.target.value); changed(); controls(); feedback("画面备注已更新；请重新导出分镜图。"); }
    catch (error) { feedback("", error.message); }
  });
  listen(capturesNode, "click", async (event) => {
    const button = event.target.closest?.("[data-clip-action]");
    const capture = captures.find((item) => item.id === button?.dataset.clipShot);
    if (!capture || busy) return;
    if (button.dataset.clipAction === "remove") {
      urls.revokeObjectURL(capture.url);
      captures = captures.filter((item) => item !== capture);
      changed();
      renderCaptures();
      feedback("已移除这一张分镜；如需保留当前版本，请重新导出。");
      return;
    }
    downloadBlob(`qianchuan-shot-${clipReviewTimestamp(capture.time).replace(/[:.]/gu, "-")}.jpg`, capture.blob);
  });
  listen(query("clip-review-clear"), "click", () => {
    if (busy || !captures.length || !confirmDiscard("清空本页的分镜截图与备注？已下载文件和原片会保留。")) return;
    clearCaptures();
    feedback("本页分镜截图已清空。");
  });
  listen(query("clip-review-release"), "click", () => {
    if (busy) return;
    releaseMedia();
    feedback("对照原片已释放；已有分镜截图和备注仍在本页。");
    onChange();
  });
  listen(query("clip-review-export"), "click", async () => {
    if (busy || !captures.length) return;
    busy = true;
    controls();
    const currentGeneration = generation;
    const currentRevision = revision;
    const snapshot = captures.map((item) => ({ ...item }));
    const bitmaps = [];
    try {
      const layout = clipBoardLayout(snapshot.length);
      const canvas = root.createElement("canvas");
      canvas.width = layout.width;
      canvas.height = layout.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("分镜画布无法建立，请减少截图后重试。");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#111111";
      context.font = "bold 24px sans-serif";
      context.fillText("素材分镜 · 人工截图与画面备注", 20, 36);
      context.font = "14px sans-serif";
      context.fillText(`${snapshot.length} 张 · 原片时间码 · 画面最长边 960 px`, 20, 62);
      for (let index = 0; index < snapshot.length; index += 1) {
        const capture = snapshot[index];
        const tile = layout.tiles[index];
        const image = await createImageBitmap(capture.blob);
        bitmaps.push(image);
        if (destroyed || currentGeneration !== generation) return;
        context.strokeStyle = "#999999";
        context.strokeRect(tile.x, tile.y, tile.width, tile.height);
        context.fillStyle = "#111111";
        context.fillRect(tile.x + 10, tile.y + 10, tile.width - 20, 250);
        const scale = Math.min((tile.width - 20) / image.width, 250 / image.height);
        context.drawImage(image, tile.x + (tile.width - image.width * scale) / 2, tile.y + 10 + (250 - image.height * scale) / 2, image.width * scale, image.height * scale);
        context.fillStyle = "#111111";
        context.font = "bold 16px sans-serif";
        context.fillText(`${index + 1}. ${clipReviewTimestamp(capture.time)}`, tile.x + 12, tile.y + 286);
        context.font = "14px sans-serif";
        drawWrappedText(context, capture.caption ? `原句：${capture.caption.slice(0, 240)}${capture.caption.length > 240 ? "…" : ""}` : "原句：人工选帧", tile.x + 12, tile.y + 311, tile.width - 24, 18, 9);
        context.font = "12px sans-serif";
        drawWrappedText(context, `备注：${capture.note.replace(/\s+/gu, " ") || "未填写"}`, tile.x + 12, tile.y + 476, tile.width - 24, 16, 5);
      }
      const blob = await canvasBlob(canvas);
      if (destroyed || currentGeneration !== generation || currentRevision !== revision) return;
      downloadBlob("qianchuan-shot-board.png", blob);
      preserved = true;
      feedback("分镜 PNG 已交给浏览器下载；请确认下载文件已保存。");
      onChange();
    } catch (error) {
      if (!destroyed && currentGeneration === generation) feedback("", error.message || "分镜图导出失败，截图仍保留，可重试。");
    } finally {
      for (const bitmap of bitmaps) bitmap.close();
      if (!destroyed && currentGeneration === generation) { busy = false; controls(); }
    }
  });

  renderCues();
  renderCaptures();
  return {
    mounted: true,
    setTranscript(document, text) {
      if (document === lastDocument && text === lastText) return;
      lastDocument = document;
      lastText = text;
      stopLoop();
      selection = null;
      page = 0;
      try { cues = clipReviewCues(document, text); } catch { cues = []; }
      query("clip-review-caption").textContent = "";
      query("clip-review-selection").textContent = "请选择一句定位原片。";
      renderCues();
      controls();
    },
    openCue(index) {
      const cue = cues.find((item) => item.index === index);
      if (!cue) { feedback("", "这一段没有可用时间码；请重新导入对应的 SRT / VTT。"); return false; }
      try { page = Math.floor((cue.index - 1) / CLIP_REVIEW_LIMITS.pageSize); selectCue(cue); video.focus(); return true; }
      catch (error) { panel.open = true; feedback("", error.message); query("clip-review-choose").focus(); return false; }
    },
    snapshot: () => ({ clipCaptureCount: captures.length, clipCapturesPreserved: preserved, hasPreviewMedia: Boolean(mediaUrl) }),
    reset() {
      releaseMedia();
      busy = false;
      clearCaptures();
      cues = [];
      lastDocument = null;
      lastText = "";
      page = 0;
      offset.value = "0";
      query("clip-review-rate").value = "1";
      video.playbackRate = 1;
      query("clip-review-selection").textContent = "请选择一句定位原片。";
      feedback();
      renderCues();
      panel.open = false;
    },
    destroy() {
      destroyed = true;
      releaseMedia();
      for (const capture of captures) urls.revokeObjectURL(capture.url);
      captures = [];
      for (const remove of listeners) remove();
    }
  };
}
