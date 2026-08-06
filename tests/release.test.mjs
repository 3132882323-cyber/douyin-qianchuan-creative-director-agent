import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const paths = {
  manifest: "../manifest.json",
  package: "../package.json",
  sidepanelHtml: "../sidepanel.html",
  workbenchHtml: "../workbench.html",
  sidepanelJs: "../sidepanel.js",
  workbenchJs: "../workbench.js",
  serviceWorker: "../service-worker.js",
  core: "../src/core.js",
  update: "../src/update.js",
  transcode: "../src/transcode.js",
  localImageRepair: "../src/local-image-repair.js",
  localFileGuard: "../src/local-file-guard.js",
  materialAnalysis: "../src/material-analysis.js",
  releaseSafety: "../src/release-safety.js",
  workspaceRecovery: "../src/workspace-recovery.js",
  workbenchOverview: "../src/workbench-overview.js",
  recentWork: "../src/recent-work.js",
  analysisHandoff: "../src/analysis-handoff.js",
  readme: "../README.md",
  privacy: "../PRIVACY.md",
  changelog: "../CHANGELOG.md",
  checklist: "../docs/RELEASE_CHECKLIST.md",
  license: "../LICENSE"
};

const entries = await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(new URL(path, import.meta.url), "utf8")]));
const files = Object.fromEntries(entries);

test("keeps every user-visible V1 source version aligned", () => {
  const manifest = JSON.parse(files.manifest);
  const packageJson = JSON.parse(files.package);
  assert.equal(manifest.version, "1.0.3");
  assert.equal(packageJson.version, "1.0.3");
  assert.match(files.sidepanelHtml, /V1\.0\.3/u);
  assert.match(files.workbenchHtml, /V1\.0\.3/u);
  assert.match(files.core, /version: "1\.0\.3"/u);
  assert.match(files.transcode, /creatorVersion \|\| "1\.0\.3"/u);
  assert.match(files.readme, /V1\.0\.3/u);
  assert.match(files.changelog, /## \[1\.0\.3\]/u);
});

test("pins a strict MV3 extension CSP without expanding permissions", () => {
  const manifest = JSON.parse(files.manifest);
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["sidePanel", "storage"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://api.github.com/*"]);
  assert.deepEqual(manifest.content_security_policy, { extension_pages: "script-src 'self'; object-src 'none';" });
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.update_url, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.doesNotMatch(JSON.stringify(manifest), /nativeMessaging|downloads|webRequest|scripting|tabs|declarativeNetRequest/iu);
});

test("checks every shipped JavaScript entry and safety module", () => {
  const packageJson = JSON.parse(files.package);
  const checkedFiles = [...packageJson.scripts.check.matchAll(/node --check ([^&]+?\.js)/gu)].map((match) => match[1].trim());
  assert.ok(checkedFiles.length >= 14);
  for (const required of ["service-worker.js", "sidepanel.js", "workbench.js", "src/release-safety.js", "src/workspace-recovery.js", "src/workbench-overview.js", "src/recent-work.js", "src/analysis-handoff.js"]) {
    assert.ok(checkedFiles.includes(required), `${required} must be syntax checked`);
  }
});

test("does not introduce remote runtime code or unsafe HTML execution sinks", () => {
  const html = `${files.sidepanelHtml}\n${files.workbenchHtml}`;
  const executableSource = [
    files.sidepanelJs,
    files.workbenchJs,
    files.serviceWorker,
    files.core,
    files.update,
    files.transcode,
    files.localImageRepair,
    files.localFileGuard,
    files.materialAnalysis,
    files.releaseSafety,
    files.workspaceRecovery,
    files.workbenchOverview,
    files.recentWork,
    files.analysisHandoff
  ].join("\n");
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/iu);
  assert.doesNotMatch(html, /https?:\/\/[^"']+\.(?:js|mjs|wasm)(?:[?"'])/iu);
  assert.doesNotMatch(executableSource, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|\beval\s*\(|new Function\s*\(|document\.write\s*\(/u);
});

test("keeps shipped HTML ids unique and workbench buttons explicit", () => {
  for (const [name, html] of [["sidepanel", files.sidepanelHtml], ["workbench", files.workbenchHtml]]) {
    const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${name} contains duplicate ids`);
  }
  const workbenchButtons = [...files.workbenchHtml.matchAll(/<button\b([^>]*)>/giu)].map((match) => match[1]);
  assert.ok(workbenchButtons.length > 0);
  assert.ok(workbenchButtons.every((attributes) => /\btype="button"/iu.test(attributes)), "every workbench button must declare type=button");
});

test("ships the open-source release, privacy and rollback handoff", () => {
  assert.match(files.license, /MIT License/u);
  assert.match(files.privacy, /所有图片和报表均在本地处理|本地处理/u);
  assert.match(files.readme, /加载已解压/u);
  assert.match(files.readme, /回退|回滚/u);
  assert.match(files.checklist, /Chrome 人工验收/u);
  assert.match(files.checklist, /回退/u);
  assert.match(files.checklist, /npm test/u);
  assert.match(files.checklist, /npm run check/u);
});
