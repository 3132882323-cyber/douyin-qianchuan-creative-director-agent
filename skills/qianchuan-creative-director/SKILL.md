---
name: qianchuan-creative-director
description: Analyze Douyin Qianchuan creative-performance exports, identify reusable creative patterns, design controlled-variable test matrices, draft production-ready briefs, and match downloaded assets to merchant-owned source masters. Use for CSV-based Qianchuan reviews, creative retrospectives, next-round material planning, script or storyboard direction, and compliant source-provenance workflows. Never remove, decode, obscure, or bypass platform watermarks or provenance controls.
---

# 千川素材编导

把历史投放表现转成下一轮可拍摄、可归因的素材方案。始终区分数据事实、推断和创意建议。

## 工作流

1. 确认投放目标、目标 ROI/成本、产品、人群、卖点、制作条件和合规限制。
2. 收到 CSV 时，先阅读 [report-schema.md](references/report-schema.md)，再运行：

```powershell
python scripts/analyze_report.py <report.csv> --output <analysis.json>
```

3. 检查字段映射、缺失值和样本量。没有消耗或曝光的素材不得直接判定为创意失败。
4. 按“高消耗且达标”“起量但不达标”“低曝光待验证”分组；不要只按 ROI 排名。
5. 提取人群、钩子、卖点、场景等标签的表现，但小样本结论必须标注为假设。
6. 每轮测试只改变一个关键变量，输出基线组与 3 个以上变体。
7. 按 [output-contract.md](references/output-contract.md) 输出策略单、测试矩阵和拍摄 Brief。

## 自有母版匹配

用户提供平台素材目录和商家自有母版目录后运行：

```powershell
python scripts/match_owned_masters.py <platform-assets> <owned-masters> --output <matches.json>
```

只把 `exact_hash` 视为确定匹配；`name_and_size` 和 `name_candidate` 必须人工确认。找不到母版时，要求用户补充原始工程或授权文件。

## 安全边界

- 不移除、破解、定位或验证暗水印清除效果。
- 不绕过抖音下载、登录、反爬、版权或风控机制。
- 不把平台下载版本伪装成原始母版。
- 可以检测来源风险、建立文件指纹、匹配自有母版，并从自有原片重新生产。
- 对医疗、功效、金融、绝对化承诺等表达必须给出风险提示。

## 输出原则

- 用绝对数字和样本量支撑结论。
- 把观察、推断、建议分别标注。
- 给出下一轮唯一变量、基线和验收指标。
- 脚本必须能直接交给编导、摄影和剪辑执行。
