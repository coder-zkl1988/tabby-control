# 手机 Agent 模型链路耗时对比

## 测试结论

在同一 APK、同一技能包、同一任务和同两台手机下，桌面默认
`tabby-phone` 链路可以稳定完成任务，但耗时明显高于 StepFun 直连：

| 指标 | StepFun 直连 | `tabby-phone` | 默认链路/直连 |
|---|---:|---:|---:|
| 端到端 P50 | 60.510 秒 | 125.804 秒 | 2.08 倍 |
| 端到端 P95 | 75.568 秒 | 154.480 秒 | 2.04 倍 |
| 首动作 P50 | 3.698 秒 | 8.345 秒 | 2.26 倍 |
| VLM 单步响应 P50 | 5.047 秒 | 13.109 秒 | 2.60 倍 |
| 动作间隔 P50 | 7.847 秒 | 16.448 秒 | 2.10 倍 |

两条链路均通过稳定性门槛：

- StepFun 直连：40/40 通过，禁止 App 观察为 0，残留 busy 为 0。
- `tabby-phone`：20/20 通过，禁止 App 观察为 0，残留 busy 为 0。
- 两条链路的 idle P95 均为 2 毫秒。

当前耗时差异主要来自模型请求阶段，不是截图、ADB 准备或动作执行。默认
链路的 VLM 单步 P50 比直连高约 8.1 秒，并会累积到每个多步骤任务中。

## 测试条件

- APK：`1.0.15(15)`，release 构建。
- 技能包：bundle 13，摘要
  `4139c0177ecc13ea5a570e31a97af737ac653ad67cce7a717418d53d5143fdc2`。
- 手机：两台 Xiaomi 24094RAD4C，Android 16。
- 任务：小红书冷启动，从相册只选一张彩条测试图，进入正式发帖页后结束。
- 每轮通过 ADB 仅做前置强停、启动 iTabby 和页面断言；任务操作均由手机 Agent 完成。
- StepFun 直连测试期间暂停桌面 controller，避免每 60 秒的默认凭证同步覆盖测试模型。
- `tabby-phone` 测试前恢复 controller，并确认默认模型服务已从此前的 503 恢复。

## 样本与证据

StepFun 直连稳定性报告：

`~/.tabby/release-gates/2026-07-25T05-25-38-915Z-xhs-media-picker-draft-wireless.json`

`tabby-phone` 稳定性报告：

`~/.tabby/release-gates/2026-07-25T05-54-28-673Z-xhs-media-picker-draft-wireless.json`

`tabby-phone` 分步时序覆盖完整 20 个任务。StepFun 直连的 40 个任务端到端时序
来自发版门槛报告；由于测试时手机日志仍使用较小环形缓冲，分步时序只保留最后
6 个任务，因此直连的首动作、VLM 单步和动作间隔只作为方向性数据，不能视为
40 个任务的完整分布。

分步分析文件：

- `~/.tabby/release-gates/benchmarks/final-bundle13/stepfun-direct.json`
- `~/.tabby/release-gates/benchmarks/final-bundle13/tabby-phone.json`

## 后续优化方向

1. 在默认模型网关记录排队、路由、上游首 token 和完整响应耗时，分离网关排队与上游模型耗时。
2. 保持 `reasoningEffort=low`，对相同截图和提示做网关直连压测，确认是否存在额外重试或串行路由。
3. 发版门槛继续同时记录成功率和耗时；不能用更快但失败率更高的链路替代稳定链路。
