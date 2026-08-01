# 抖音千川素材编导 Agent

一个面向千川投手和素材编导的开源 Codex 插件。它把历史投放报表转成素材洞察、控制变量测试矩阵和下一轮拍摄方向，并将平台素材匹配回商家自有母版。

## 当前能力

- 读取千川 CSV 导出表并自动映射常用字段
- 按“高消耗且达标、起量但不达标、低曝光待验证”分组
- 聚合人群、钩子、卖点和场景表现
- 生成单变量测试矩阵
- 建立自有母版指纹并匹配平台素材
- 明确区分确定匹配与需要人工确认的候选

本项目不提供暗水印移除、破解、定位或平台风控规避能力。获得干净版本的合规方式是匹配商家自有母版，并从自有原片重新生产。

## 使用

在 Codex 中安装插件后，可以这样调用：

```text
使用 $qianchuan-creative-director 分析这份千川报表，生成下一轮测试矩阵。
```

也可以直接运行脚本：

```powershell
python skills/qianchuan-creative-director/scripts/analyze_report.py examples/sample-report.csv --target-roi 1.5 --output analysis.json
python skills/qianchuan-creative-director/scripts/match_owned_masters.py platform-assets owned-masters --output matches.json
```

## 开源许可

MIT。投放报表、素材、模型密钥和商家数据不应提交到公开仓库。
