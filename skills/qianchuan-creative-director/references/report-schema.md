# 千川报表字段

脚本接受 UTF-8/UTF-8 BOM CSV，并自动识别以下中文或英文字段。

| 标准字段 | 常见列名 | 必需 |
|---|---|---|
| creative_name | 素材名称、创意名称、creative | 是 |
| spend | 消耗、花费、cost | 是 |
| impressions | 展示、展示量、impressions | 否 |
| clicks | 点击、点击量、clicks | 否 |
| conversions | 转化、成交订单、orders | 否 |
| gmv | GMV、成交金额、支付金额 | 否 |
| roi | 支付ROI、ROI、roas | 否，可由 GMV/消耗计算 |
| hook | 钩子、前三秒、hook | 否 |
| audience | 人群、目标人群、audience | 否 |
| selling_point | 卖点、核心卖点、angle | 否 |
| scene | 场景、拍摄场景、scene | 否 |

百分号、货币符号和千分位会被清理。至少提供素材名称和消耗；缺少创意标签时，脚本仍能进行素材级分组，但不能可靠归因创意元素。
