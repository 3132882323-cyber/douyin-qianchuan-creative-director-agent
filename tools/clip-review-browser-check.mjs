// Optional browser regression. Uses local developer tools only; no dependency is
// bundled with or loaded by the extension. Pass a Playwright module path and an
// existing FFmpeg executable, or use the locally installed commands.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : "playwright");
const temporary = await mkdtemp(join(tmpdir(), "qianchuan-clip-review-"));
const videoPath = join(temporary, "synthetic-owned-video.mp4");
const boardPath = join(temporary, "shot-board.png");
execFileSync(process.argv[3] || "ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=10",
  "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", videoPath
]);

const shim = `globalThis.chrome = {
  runtime: { id: 'local-browser-test', getManifest: () => ({version:'1.4.0'}), getURL: (path) => new URL(path, location.origin).href },
  storage: { onChanged: { addListener() {} } }
};`;
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname === "/__test_chrome.js") { response.setHeader("Content-Type", "text/javascript"); response.end(shim); return; }
  const target = resolve(root, `.${decodeURIComponent(pathname)}`);
  if (!target.startsWith(root + sep) || pathname.includes("/.git/")) { response.writeHead(403); response.end(); return; }
  try {
    let data = await readFile(target);
    if (pathname === "/workbench.html") data = Buffer.from(data.toString("utf8").replace('<script type="module" src="workbench.js">', '<script src="__test_chrome.js"></script><script type="module" src="workbench.js">'));
    const types = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css" };
    response.setHeader("Content-Type", `${types[extname(target)] || "application/octet-stream"}; charset=utf-8`);
    response.setHeader("Content-Security-Policy", "script-src 'self'; object-src 'none'");
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  const errors = [];
  const remoteRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (!request.url().startsWith(origin) && !request.url().startsWith("blob:")) remoteRequests.push(request.url()); });
  await page.goto(`${origin}/workbench.html`);
  assert.equal(await page.locator("#whisper-config").isVisible(), false);
  assert.equal(await page.locator("#transcript-metadata").isVisible(), false);
  await page.locator("#workbench-entry-transcript").check();
  assert.equal(await page.locator("#source").isVisible(), false);
  assert.equal(await page.locator("#processing").isVisible(), false);
  await page.locator("#transcript-file").setInputFiles({
    name: "owned-copy.srt", mimeType: "text/plain",
    buffer: Buffer.from("1\n00:00:01,000 --> 00:00:03,000\n先看完整过程\n\n2\n00:00:04,000 --> 00:00:06,000\n固定机位拍证据")
  });
  await page.locator("#clip-review-panel > summary").click();
  await page.locator("#clip-review-file").setInputFiles(videoPath);
  await page.waitForFunction(() => document.querySelector("#clip-review-media-label").textContent.includes("360 × 640"));
  assert.equal(await page.locator("#clip-review-cues button").count(), 2);
  await page.locator("#analyze-transcript").click();
  await page.locator("#structure-segments button").first().click();
  assert.match(await page.locator("#clip-review-selection").textContent(), /已定位第 1 句/u);
  await page.locator("#clip-review-cues button").first().click();
  await page.waitForFunction(() => !document.querySelector("#clip-review-video").seeking);
  assert.ok(Math.abs(await page.locator("#clip-review-video").evaluate((video) => video.currentTime) - 1) < 0.1);
  await page.locator("#clip-review-loop").click();
  assert.equal(await page.locator("#clip-review-loop").getAttribute("aria-pressed"), "true");
  await page.locator("#clip-review-loop").click();
  await page.locator("#clip-review-capture").click();
  await page.waitForFunction(() => document.querySelectorAll("#clip-review-captures article").length === 1);
  await page.locator("[data-clip-note]").fill("前三秒展示完整使用过程；补一个自然反应镜头。");
  const download = page.waitForEvent("download");
  await page.locator("#clip-review-export").click();
  const image = await download;
  await image.saveAs(boardPath);
  const signature = (await readFile(boardPath)).subarray(0, 8).toString("hex");
  assert.equal(signature, "89504e470d0a1a0a");
  assert.match(await page.locator("#clip-review-count").textContent(), /已导出分镜图/u);
  await page.locator("#clip-review-panel").screenshot({ path: join(temporary, "clip-review-1440.png") });
  await page.locator("[data-clip-note]").fill("导出后改过的备注");
  assert.match(await page.locator("#clip-review-count").textContent(), /尚未导出/u);
  await page.locator("#transcript-text").fill("正文编辑后，原时间码应失效");
  assert.equal(await page.locator("#clip-review-cues button").count(), 0);
  assert.equal(await page.locator("#clip-review-loop").isDisabled(), true);
  assert.equal(await page.locator("#transcript-metadata").isVisible(), false);
  for (const width of [1440, 760, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await page.locator("#clip-review-panel").scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}px`);
  }
  await page.locator("#clip-review-panel").screenshot({ path: join(temporary, "clip-review-390.png") });
  assert.deepEqual(errors, []);
  assert.deepEqual(remoteRequests, []);
  console.log(JSON.stringify({ result: "passed", checks: ["local decoding", "analysis-to-video navigation", "cue seek", "loop controls", "portrait snapshot", "PNG export", "edited notes dirty", "edited transcript timing invalidation", "hidden source/configuration/metadata", "1440/760/390px layout", "no remote requests", "no page errors"], artifacts: temporary }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  // Remove only the generated video. Keep the PNG outputs for visual QA.
  await rm(videoPath, { force: true });
}
