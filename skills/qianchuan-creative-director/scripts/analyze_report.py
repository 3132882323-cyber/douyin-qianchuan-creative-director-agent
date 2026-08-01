#!/usr/bin/env python3
"""Analyze a Qianchuan-style CSV without network access or third-party packages."""

from __future__ import annotations

import argparse
import csv
import json
import statistics
from collections import defaultdict
from pathlib import Path


ALIASES = {
    "creative_name": ["creative_name", "素材名称", "创意名称", "素材", "creative"],
    "spend": ["spend", "消耗", "花费", "cost"],
    "impressions": ["impressions", "展示", "展示量"],
    "clicks": ["clicks", "点击", "点击量"],
    "conversions": ["conversions", "转化", "转化数", "成交订单", "orders"],
    "gmv": ["gmv", "GMV", "成交金额", "支付金额"],
    "roi": ["roi", "ROI", "支付ROI", "roas", "ROAS"],
    "hook": ["hook", "钩子", "前三秒"],
    "audience": ["audience", "人群", "目标人群"],
    "selling_point": ["selling_point", "卖点", "核心卖点", "angle"],
    "scene": ["scene", "场景", "拍摄场景"],
}


def parse_number(value: object) -> float:
    text = str(value or "").strip().replace(",", "").replace("¥", "").replace("￥", "")
    if not text or text in {"-", "--", "N/A", "n/a"}:
        return 0.0
    percent = text.endswith("%")
    if percent:
        text = text[:-1]
    try:
        number = float(text)
    except ValueError:
        return 0.0
    return number / 100 if percent else number


def resolve_columns(fieldnames: list[str]) -> dict[str, str]:
    normalized = {name.strip(): name for name in fieldnames if name}
    result: dict[str, str] = {}
    for standard, aliases in ALIASES.items():
        for alias in aliases:
            if alias in normalized:
                result[standard] = normalized[alias]
                break
    missing = [name for name in ("creative_name", "spend") if name not in result]
    if missing:
        raise ValueError(f"缺少必需字段: {', '.join(missing)}")
    return result


def load_report(path: Path) -> tuple[list[dict], dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise ValueError("CSV 没有表头")
        mapping = resolve_columns(reader.fieldnames)
        rows = []
        for raw in reader:
            row = {key: str(raw.get(column, "") or "").strip() for key, column in mapping.items()}
            for key in ("spend", "impressions", "clicks", "conversions", "gmv", "roi"):
                row[key] = parse_number(row.get(key))
            if not row.get("roi") and row.get("spend"):
                row["roi"] = row.get("gmv", 0.0) / row["spend"]
            row["ctr"] = row.get("clicks", 0.0) / row.get("impressions", 1.0) if row.get("impressions") else 0.0
            row["cpa"] = row.get("spend", 0.0) / row.get("conversions", 1.0) if row.get("conversions") else None
            rows.append(row)
    return rows, mapping


def aggregate_tag(rows: list[dict], field: str) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        value = str(row.get(field, "")).strip()
        if value:
            groups[value].append(row)
    output = []
    for value, items in groups.items():
        spend = sum(float(item["spend"]) for item in items)
        gmv = sum(float(item.get("gmv", 0)) for item in items)
        weighted_roi = sum(float(item.get("roi", 0)) * float(item["spend"]) for item in items) / spend if spend else 0
        output.append({
            "value": value,
            "creative_count": len(items),
            "spend": round(spend, 2),
            "roi": round(gmv / spend if gmv and spend else weighted_roi, 3),
        })
    return sorted(output, key=lambda item: (item["spend"], item["roi"]), reverse=True)


def analyze(rows: list[dict], target_roi: float) -> dict:
    if not rows:
        raise ValueError("CSV 没有数据行")
    positive_spend = [float(row["spend"]) for row in rows if float(row["spend"]) > 0]
    spend_floor = statistics.median(positive_spend) if positive_spend else 0
    total_spend = sum(float(row["spend"]) for row in rows)
    total_gmv = sum(float(row.get("gmv", 0)) for row in rows)
    for row in rows:
        spend = float(row["spend"])
        roi = float(row.get("roi", 0))
        if spend >= spend_floor and roi >= target_roi:
            row["segment"] = "高消耗且达标"
        elif spend >= spend_floor:
            row["segment"] = "起量但不达标"
        else:
            row["segment"] = "低曝光待验证"
    segment_rank = {"高消耗且达标": 2, "起量但不达标": 1, "低曝光待验证": 0}
    ranked = sorted(rows, key=lambda row: (segment_rank[row["segment"]], float(row["spend"]), float(row.get("roi", 0))), reverse=True)
    best = ranked[0]
    baseline = {key: best.get(key, "") for key in ("creative_name", "audience", "hook", "selling_point", "scene")}
    variable = next((key for key in ("hook", "selling_point", "scene", "audience") if baseline.get(key)), "hook")
    matrix = []
    for index, label in enumerate(("基线复拍", "直接痛点", "反常识", "结果展示"), start=1):
        item = dict(baseline)
        item.update({"id": f"T{index}", "type": "baseline" if index == 1 else "variant", "single_variable": variable, "variant": baseline.get(variable, "历史基线") if index == 1 else label})
        matrix.append(item)
    return {
        "summary": {
            "creative_count": len(rows),
            "total_spend": round(total_spend, 2),
            "total_gmv": round(total_gmv, 2),
            "blended_roi": round(total_gmv / total_spend, 3) if total_spend else 0,
            "target_roi": target_roi,
            "spend_floor": round(spend_floor, 2),
        },
        "segments": {name: sum(1 for row in rows if row["segment"] == name) for name in segment_rank},
        "top_creatives": ranked[:10],
        "tag_insights": {field: aggregate_tag(rows, field) for field in ("audience", "hook", "selling_point", "scene")},
        "test_matrix": matrix,
        "caveats": ["低消耗素材不能直接判定为创意失败。", "标签聚合是相关性观察，不代表因果关系。", "缺少 GMV 时，混合 ROI 可能无法计算。"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="分析千川素材 CSV 并生成测试矩阵")
    parser.add_argument("report", type=Path)
    parser.add_argument("--target-roi", type=float, default=1.0)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    rows, mapping = load_report(args.report)
    result = analyze(rows, args.target_roi)
    result["column_mapping"] = mapping
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)


if __name__ == "__main__":
    main()
