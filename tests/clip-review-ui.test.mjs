import test from "node:test";
import assert from "node:assert/strict";
import { mountClipReview } from "../src/clip-review-ui.js";
import { parseTranscriptDocument } from "../src/timed-transcript.js";

class Node {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.value = "";
    this.textContent = "";
    this.disabled = false;
    this.readyState = 2;
    this.seeking = false;
    this.paused = true;
    this.currentTime = 0;
    this.duration = 10;
    this.videoWidth = 1920;
    this.videoHeight = 1080;
    this.playCalls = 0;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  removeAttribute(key) { delete this.attributes[key]; if (key === "src") this.src = ""; }
  addEventListener(event, handler) { this.listeners.set(event, handler); }
  removeEventListener(event) { this.listeners.delete(event); }
  emit(event, target = this) { return this.listeners.get(event)?.({ target }); }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [...(selector.includes(child.tagName.toLowerCase()) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  closest(selector) {
    const key = selector.includes("clip-cue") ? "clipCue" : "clipAction";
    return this.dataset[key] ? this : null;
  }
  pause() { this.paused = true; }
  play() { this.paused = false; this.playCalls += 1; return Promise.resolve(); }
  load() {}
  focus() { this.focused = true; }
}

function harness({ confirm = true, blobTask } = {}) {
  const ids = ["panel", "video", "file", "choose", "message", "error", "cues", "captures", "offset", "loop", "capture", "export", "clear", "release", "rate", "count", "page", "prev", "next", "media-label", "caption", "clock", "selection"];
  const nodes = Object.fromEntries(ids.map((id) => [id, new Node(id === "video" ? "video" : "div")]));
  nodes.offset.value = "0";
  nodes.rate.value = "1";
  nodes.panel.querySelector = (selector) => nodes[selector.replace("#clip-review-", "")];
  const drawings = [];
  const root = {
    querySelector: (selector) => selector === "#clip-review-panel" ? nodes.panel : null,
    createElement: (tag) => {
      const node = new Node(tag);
      if (tag === "canvas") {
        node.getContext = () => ({ drawImage: (...args) => drawings.push(args) });
        node.toBlob = (callback) => blobTask ? blobTask(callback) : callback(new Blob(["local frame"], { type: "image/jpeg" }));
      }
      return node;
    }
  };
  let nextUrl = 0;
  const revoked = [];
  const downloads = [];
  const controller = mountClipReview({
    root,
    urls: { createObjectURL: () => `blob:local-${++nextUrl}`, revokeObjectURL: (url) => revoked.push(url) },
    downloadBlob: (...args) => downloads.push(args),
    confirmDiscard: () => confirm
  });
  async function load(file = { name: "自有原片.mp4", size: 1000 }) {
    nodes.file.files = [file];
    await nodes.file.emit("change");
    await nodes.video.emit("loadedmetadata");
  }
  return { nodes, controller, revoked, downloads, drawings, load };
}

const subtitle = parseTranscriptDocument("1\n00:00:01,000 --> 00:00:03,000\n核对前三秒\n\n2\n00:00:04,000 --> 00:00:06,000\n核对证据镜头", { name: "owned.srt" });

test("loads only selected local media, seeks on user action and clears stale transcript loops", async () => {
  const h = harness();
  await h.load();
  h.controller.setTranscript(subtitle, subtitle.text);
  assert.equal(h.nodes.video.playCalls, 0);
  assert.match(h.nodes.video.src, /^blob:/u);
  assert.equal(h.controller.openCue(1), true);
  assert.equal(h.nodes.video.currentTime, 1);
  await h.nodes.loop.emit("click");
  assert.equal(h.nodes.loop.attributes["aria-pressed"], "true");
  h.nodes.video.currentTime = 3.2;
  h.nodes.video.emit("timeupdate");
  assert.equal(h.nodes.video.currentTime, 1);
  h.controller.setTranscript(null, "已编辑正文");
  assert.equal(h.nodes.loop.attributes["aria-pressed"], "false");
  assert.equal(h.nodes.cues.children.length, 0);
  assert.equal(h.controller.openCue(1), false);
  h.controller.destroy();
  assert.ok(h.revoked.includes("blob:local-1"));
});

test("rejects an invalid replacement without losing the current preview and captions", async () => {
  const h = harness();
  await h.load();
  h.controller.setTranscript(subtitle, subtitle.text);
  h.nodes.file.files = [{ name: "remote.url", size: 15 }];
  await h.nodes.file.emit("change");
  assert.equal(h.nodes.video.src, "blob:local-1");
  assert.match(h.nodes.error.textContent, /看片只支持/u);
  h.controller.destroy();
});

test("keeps manual frame time and notes local, and preserves screenshots when releasing the video", async () => {
  const h = harness();
  await h.load();
  h.nodes.video.currentTime = 2.25;
  await h.nodes.capture.emit("click");
  assert.equal(h.controller.snapshot().clipCaptureCount, 1);
  assert.equal(h.drawings[0][3], 960);
  assert.equal(h.drawings[0][4], 540);
  assert.equal(h.controller.snapshot().clipCapturesPreserved, false);
  const card = h.nodes.captures.children[0];
  assert.equal(card.children[1].textContent, "00:00:02.250");
  const note = card.children[3].children[0];
  note.value = "加拍一个自然反应";
  h.nodes.captures.emit("input", note);
  await h.nodes.release.emit("click");
  assert.equal(h.controller.snapshot().hasPreviewMedia, false);
  assert.equal(h.controller.snapshot().clipCaptureCount, 1);
  await h.nodes.captures.emit("click", card.children[4].children[0]);
  assert.match(h.downloads[0][0], /00-00-02-250/u);
  h.controller.destroy();
});

test("discards a delayed capture after reset and frees every retained blob URL", async () => {
  let finish;
  const h = harness({ blobTask: (callback) => { finish = callback; } });
  await h.load();
  const capture = h.nodes.capture.emit("click");
  assert.equal(h.nodes.capture.disabled, true);
  h.controller.reset();
  finish(new Blob(["older frame"]));
  await capture;
  assert.equal(h.controller.snapshot().clipCaptureCount, 0);
  assert.equal(h.nodes.export.disabled, true);
  assert.ok(h.revoked.includes("blob:local-1"));
  h.controller.destroy();
});

test("pages all timed cues and refuses a destructive source replacement when cancelled", async () => {
  const many = parseTranscriptDocument(Array.from({ length: 25 }, (_, index) => `${index + 1}\n00:00:${String(index).padStart(2, "0")},000 --> 00:00:${String(index + 1).padStart(2, "0")},000\n第 ${index + 1} 句`).join("\n\n"), { name: "many.srt" });
  const h = harness({ confirm: false });
  h.nodes.video.duration = 30;
  await h.load();
  h.controller.setTranscript(many, many.text);
  assert.equal(h.nodes.cues.children.length, 20);
  await h.nodes.next.emit("click");
  assert.equal(h.nodes.cues.children.length, 5);
  assert.match(h.nodes.page.textContent, /2 \/ 2/u);
  await h.nodes.capture.emit("click");
  h.nodes.file.files = [{ name: "replacement.mp4", size: 100 }];
  await h.nodes.file.emit("change");
  assert.equal(h.nodes.video.src, "blob:local-1");
  assert.equal(h.controller.snapshot().clipCaptureCount, 1);
  h.controller.destroy();
});
