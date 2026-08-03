import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../tools/transcode-worker.ps1", import.meta.url), "utf8");

test("the local worker fails closed on manifest kind, authorization and remote upload", () => {
  assert.match(worker, /qianchuan-owned-master-transcode-v1/u);
  assert.match(worker, /qianchuan-local-material-analysis-v1/u);
  assert.match(worker, /authorization\.confirmed -ne \$true/u);
  assert.match(worker, /processing\.remoteUpload -ne \$false/u);
  assert.match(worker, /Unsupported material workflow kind/u);
});

test("audio extraction must match the exact fixed PCM template", () => {
  assert.match(worker, /Assert-ExactArguments \$arguments \$expectedArguments "Audio extraction"/u);
  for (const literal of ["0:a:0", "16000", "pcm_s16le", ".wav"]) assert.match(worker, new RegExp(literal.replace(".", "\\.")));
  assert.match(worker, /Audio extraction contains a blocked video or metadata-writing flag/u);
});

test("the worker preserves source provenance and never overwrites output", () => {
  assert.match(worker, /-map_metadata/u);
  assert.match(worker, /-map_chapters/u);
  assert.match(worker, /requires no-overwrite mode/u);
  assert.match(worker, /Output already exists; the worker will not overwrite it/u);
  assert.match(worker, /sourcePath -eq \$outputPath/u);
});

test("the worker never downloads, evals or launches an arbitrary shell", () => {
  assert.doesNotMatch(worker, /Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|Invoke-Expression|\biex\b|Start-Process|cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?\s+-Command/iu);
  assert.match(worker, /ffmpegLeaf -ne "ffmpeg"/u);
  assert.match(worker, /Unsupported task argument/u);
  assert.match(worker, /Unsupported task operation/u);
});
