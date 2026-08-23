import test from "node:test";
import assert from "node:assert/strict";
import { CSV_STRUCTURE_LIMITS, parseCsvDocument, planToCsv } from "../src/core.js";
import {
  NON_MEDIA_IMPORT_POLICIES,
  parseJsonDocument,
  spreadsheetSafeText,
  validateNonMediaImport
} from "../src/release-safety.js";

test("applies fixed local-only limits to every non-media import", () => {
  assert.equal(NON_MEDIA_IMPORT_POLICIES.report.maxBytes, 8 * 1024 * 1024);
  assert.equal(NON_MEDIA_IMPORT_POLICIES.backup.maxBytes, 12 * 1024 * 1024);
  assert.equal(NON_MEDIA_IMPORT_POLICIES.experimentResult.maxBytes, 2 * 1024 * 1024);
  assert.equal(NON_MEDIA_IMPORT_POLICIES.executionResult.maxBytes, 2 * 1024 * 1024);
  assert.equal(NON_MEDIA_IMPORT_POLICIES.transcript.maxBytes, 4 * 1024 * 1024);

  assert.deepEqual(validateNonMediaImport({ name: "report.CSV", size: 1024 }, "report"), {
    name: "report.CSV",
    extension: ".csv",
    size: 1024,
    maxBytes: 8 * 1024 * 1024
  });
  assert.throws(() => validateNonMediaImport({ name: "report.xlsx", size: 1024 }, "report"), /CSV|TSV|\.csv/u);
  assert.throws(() => validateNonMediaImport({ name: "backup.json", size: 0 }, "backup"), /为空|大小无效/u);
  assert.throws(() => validateNonMediaImport({ name: "backup.json", size: 12 * 1024 * 1024 + 1 }, "backup"), /12 MB/u);
  assert.throws(() => validateNonMediaImport({ name: "results.xlsx", size: 1024 }, "experimentResult"), /CSV|TSV|\.csv/u);
  assert.throws(() => validateNonMediaImport({ name: "result.json", size: Number.NaN }, "executionResult"), /为空|大小无效/u);
});

test("parses bounded JSON with BOM and reports friendly failures", () => {
  assert.deepEqual(parseJsonDocument("\uFEFF {\"ok\":true}", "工作区备份"), { ok: true });
  assert.throws(() => parseJsonDocument("   ", "工作区备份"), /工作区备份为空/u);
  assert.throws(() => parseJsonDocument("{broken", "工作区备份"), /工作区备份不是有效 JSON/u);
});

test("neutralizes spreadsheet formulas while keeping numeric values numeric", () => {
  assert.equal(spreadsheetSafeText("=HYPERLINK(\"https://example.com\")"), "'=HYPERLINK(\"https://example.com\")");
  assert.equal(spreadsheetSafeText("  +cmd|' /C calc'!A0"), "'  +cmd|' /C calc'!A0");
  assert.equal(spreadsheetSafeText("\t@SUM(A1:A2)"), "'\t@SUM(A1:A2)");
  assert.equal(spreadsheetSafeText(-8), "-8");
  assert.equal(spreadsheetSafeText("普通文本"), "普通文本");

  const csv = planToCsv({
    items: [{
      id: "=FORMULA()",
      type: "基线",
      hypothesis: " +cmd",
      baselineCreative: "正常素材",
      singleVariable: "hook",
      variant: "@SUM(A1:A2)",
      audience: "普通受众",
      hook: "正常钩子",
      coreClaim: "正常主张",
      scene: "室内",
      observationMetrics: "ROI",
      minSpend: -8,
      stopCondition: "正常条件",
      successAction: "正常动作",
      production: {
        spokenScript: "正常口播",
        storyboard: "正常分镜",
        shootingTask: "正常任务",
        editingNotes: "正常剪辑",
        subtitleHighlights: "正常字幕",
        complianceChecklist: "正常检查"
      }
    }]
  });
  assert.match(csv, /'=FORMULA\(\)/u);
  assert.match(csv, /' \+cmd/u);
  assert.match(csv, /'@SUM\(A1:A2\)/u);
  assert.match(csv, /,-8,/u);
});

test("rejects malformed or excessive CSV structures before analysis", () => {
  assert.throws(() => parseCsvDocument('name,value\n"open,1\n'), /未闭合/u);
  assert.throws(() => parseCsvDocument("name,name\na,b\n"), /重复/u);
  assert.throws(() => parseCsvDocument("name,\na,b\n"), /空白/u);

  const tooManyColumns = Array.from({ length: CSV_STRUCTURE_LIMITS.maxColumns + 1 }, (_, index) => `c${index}`).join(",");
  const tooManyValues = Array.from({ length: CSV_STRUCTURE_LIMITS.maxColumns + 1 }, () => "1").join(",");
  assert.throws(() => parseCsvDocument(`${tooManyColumns}\n${tooManyValues}\n`), /200/u);

  const tooManyRows = `name\n${"x\n".repeat(CSV_STRUCTURE_LIMITS.maxRows + 1)}`;
  assert.throws(() => parseCsvDocument(tooManyRows), /50,000/u);
});
