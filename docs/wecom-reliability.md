# 企微逐卡执行与完成校验

## 问题与范围

2026-09-08 实机检查：3台手机、6个实例、10个账号企业组合，原有待办至少仍有5张1v1和1张朋友圈；另有5张执行期间新增1v1，1个组合因截图和结构不可读而未核实完整。点击生效、模型 COMPLETE、账本算术正确，都不能单独证明业务完成。

本轮修复手机任务内的逐卡记录、发送前日期检查、发送后观察、完成门槛，以及桌面结果校验与实例/账号/企业隔离。保留模型对截图的语义识别，程序校验观察记录之间的约束；不宣称程序能独立识别所有自绘企微页面。300台调度容量、自动登录/身份验证、跨进程自动续发不在本轮。

## 执行约定

- 每台手机串行；每个实例、账号、企业、渠道单独建账。渠道为 `mass_send` / `moments`。
- 执行前登记本任务的全部组合；只盘点设备本地当天卡片，旧卡只作为日期分界证据。
- 翻页保持重叠；时间戳归属下方卡片，同一时间戳可对应多张卡片，不能按时间或摘要前10字合并。
- 卡片仍有正文不等于未发。只有状态标记/发送记录可证成功；仅从当前可见屏幕消失不是充分证据。
- 日期或状态读不清，记录 unknown；验证阻断记 blocked。两者都不能算无待办，也不能计入成功。
- 发送状态不明先读回，不盲目再次点击。每张最多两次有明确待发证据的发送尝试。
- 本轮尝试发送后变成unknown的卡片，不能在重新盘点时改成already_sent或重新待发，绕过发送验证；保留未核实。只有从未尝试发送的初始unknown可以通过新盘点澄清状态。
- 发完后重新盘点，纳入执行期间新增的今日卡片。所有组合最终核验均应晚于最后一次发送尝试；持续新增或无法核验时返回部分完成及原因，不能无限重试。
- 跨日后结束本轮并重新盘点，不沿用昨天的发送许可。

## 手机运行时检查点（v1）

不增加动作词表。GELab动作的 `key_process` 可携带 `WECOM_AUDIT {单个JSON对象}`。观察类检查点配合 WAIT；send检查点配合 CLICK。这些不是 INFO / CALL_USER，不等待用户。

每个组合字段固定为 `{instance, account, company, channel}`。`instance` 使用 main / clone1 等真实映射。检查点：

1. plan：`{phase:"plan",date:"YYYY-MM-DD",scopes:[组合...]}`。发送前冻结计划；不能通过后续计划删去未完成组合。
2. inventory：`{phase:"inventory",scope:组合,cards:[{id,date,time,summary,state,evidence}],complete:false,boundary:""}`。逐屏追加；最后一页使用 complete:true 和原文日期分界或列表端点证据。初始 state 仅 pending / already_sent / cancelled / unknown / blocked；禁止初始写 sent。already_sent / cancelled 必须提供明确的已发送、已发表或已取消状态证据。已登记卡不能改成别的正文或日期，重新扫描不能删除旧卡。
3. send：`{phase:"send",scope:组合,cardId:"c1"}`，只能与 CLICK 同步提交，要求盘点完成、卡片为当天pending、没有未核实的上次发送、且在企微前台。运行时记录实际动作是否执行成功及步数。
4. verify：`{phase:"verify",scope:组合,cardId:"c1",state:"sent",evidence:"已发送"}`。必须来自实际点击之后重新采集的观察；sent 仅在看到对应卡片已发送/已发表标记或准确发送/发表记录时使用。仍明确待发可记 pending；看不清记 unknown；身份验证记 blocked。新帧序号证明重新采集，图片内容可以相同；仅图片变化或仅有新帧都不能证明发送成功。
5. final_scan：`{phase:"final_scan",scope:组合,remaining:0,boundary:"昨天 下午3:58",complete:true}`。重进/刷新并扫描今日区间后提交；与卡片剩余状态交叉核对。新增卡先 inventory 追加，再处理。

运行时账本独立于模型历史压缩，并在每轮提示中呈现尚缺的检查。无账本、计划缺渠道、跨日、仍有pending/unknown/blocked、缺最终扫描，均拒绝 COMPLETE；给予有限纠正机会，仍不满足则返回未完成。旧执行入口不支持检查点时，应在发送前明确拒绝该类业务任务，不能绕过核验。

只读盘点、普通消息、非企微任务不要求发送账本。激活条件须结合企微/企业指派渠道和发送/执行意图；不能因引用“不要发送”而触发发送流程。

追加指令不能把原本无账本的只读任务升级成发送任务，也不能为正在执行的账本增加未覆盖的渠道或明确实例；须重新派发完整任务。正常的同范围继续执行不受影响。一键“发送今日全部待群发的消息”始终禁止，不以单个send检查点代替逐卡校验。

## 桌面收据（v1）

手机运行时在结果消息末尾追加一行 `[WECOM_AUDIT_V1]` 加严格JSON。收据由运行时账本生成，不能直接使用模型 COMPLETE 的自由文本；移除自由文本里同名标记避免伪造/重复。结果传输保持现有 TaskResult envelope。

```json
{
  "version": 1,
  "date": "2026-09-09",
  "requiredChannels": ["mass_send", "moments"],
  "expectedScopes": [
    {"instance":"main","account":"example","company":"example","channel":"mass_send"},
    {"instance":"main","account":"example","company":"example","channel":"moments"}
  ],
  "scopes": [
    {
      "instance":"main","account":"example","company":"example","channel":"mass_send",
      "inventoryComplete":true,"boundary":"昨天 下午3:58",
      "finalScanComplete":true,"finalScanStep":20,"remaining":0,
      "cards":[
        {"id":"c1","date":"2026-09-09","time":"11:46","summary":"完整卡片摘要",
         "status":"sent","evidence":"已发送","observedStep":3,"sentStep":8,"verifiedStep":9}
      ]
    }
  ]
}
```

上例仅展示一个渠道的scope结构，并非通过校验的完整收据（moments尚未上报）。空任务也需要对应组合、日期边界、最终核验，不能省略为零。

字段约束：version=1；日期为有效本地日期；requiredChannels为非空去重渠道；expectedScopes和scopes不允许重复或空身份。每个身份必须覆盖requiredChannels。cards.id在组合内唯一；status为pending/sent/already_sent/cancelled/blocked/unknown；步数为非负整数，sent要求observedStep < sentStep < verifiedStep。sent / already_sent 的 evidence 只接受精确状态原文：已发送、发送成功、已发表、发表成功；cancelled 只接受已取消、取消成功、已撤销。定位详情放普通报告，不把“未看到已发送”等描述当成功状态。非sent的sentStep/verifiedStep可省略。finalScanStep必须晚于所有组合最后sentStep，且晚于本组合所有observedStep和verifiedStep；追加卡或更新卡片状态会使旧final_scan失效。remaining非负，成功要求0且无待处理/受阻/未知卡。

桌面端在派发前持久化任务日期、所需渠道及明确指定的实例，重启后继续校验迟到结果；企微执行任务缺收据、收据无效、内容矛盾均将原success=true降为success=false、status=error、errorCode=WECOM_AUDIT_INCOMPLETE。WECOM_AUDIT 是手机模型和运行时之间的自动完整性校验，不是人工确认或发送授权，不会弹确认卡，也不存在需要用户开启的桌面审计开关。带收据但派发记录缺失时明确报告无法确认任务范围，不从收据反推用户要求。既有失败状态保留，不升级成功。接收、同步返回、结果缓存、作业状态必须使用同一校验后结果；警告写在末尾收据行之前，保留收据原文。

去重使用设备＋实例＋账号＋企业＋渠道＋日期＋完整时间/摘要，只有有身份的结构化记录才做跨任务比对；未知身份的旧文本不猜账号。already_sent是原有完成状态，不是本轮新发，不触发重复发送告警。重复的sent记录应阻止声称全成功，不自动补发。

## 实施与验证

1. Android纯逻辑账本与测试先锁住行为，再接入PhoneAgentRunner检查点、实际动作回执和完成分支；关闭legacy/subtask业务发送绕过路径。
2. tabby-control增加严格收据schema/验证和派发要求；修复ReportAuditor空逐卡/多账本/身份去重及告警只追加问题，保留现有无关改动。
3. 更新phone-skills唯一源，增加运行时检查点说明，纠正正文存在、日期不清和汇报分类错误；构建同步Android assets。
4. Android单元测试、lint和debug APK；control测试、typecheck、lint、技能一致性检查。用共享收据fixture验证两端契约。

回归场景：首屏遗漏早段卡、同分钟两卡、相同前10字不同卡、跨实例/企业同文案、正文保留但已发送、无生效点击/无新观察、阻断、黑屏、18:47新增、跨午夜、缺渠道/缺组合、重复COMPLETE、缺收据、非企微/只读任务不受影响。

真机发送涉及客户，单元测试和构建不替代实机业务验收。安装只使用debug版；本轮不自动补发此前已过期的9月8日卡片。

### 2026-09-09 验证结果

- tabby-control：完整108项测试通过；`npm run typecheck`、`npm run lint`、`npm run build:nexu`通过。涵盖结果/RPC/通知/job一致性、重启后迟到结果、重复结果、追加指令扩大范围和只读任务。
- Android：38个测试类、557项测试，失败/错误/跳过均为0；`JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`通过。编译仍有项目既有弃用API提示。
- 共享收据和19条任务意图fixture在两仓库逐字一致。规则包v54、企微skill v13；源/生成产物/Android内置基线一致性检查通过。
- 三台目标手机已于17:31安装debug APK，保留原应用数据。安装后均确认DEBUGGABLE、已安装APK SHA-256与本次构建完全一致、无障碍服务已绑定、连接状态idle且规则包v54/current。
- debug APK SHA-256：`3ebd9a44df228fe527125c8386b16d1c8d0530f54f2b2b523df0cb3720a962a3`。版本名仍为1.0.20，验证本次安装应使用更新时间/哈希，不只看版本名。
- 桌面仍在运行；手机控制插件已重新构建并于17:32通过开发启动器更新、重启加载，设备RPC读取正常。其它在线设备随既有热更新机制同步规则包；本次只替换三台目标手机的APK。
- 未触发客户群发、朋友圈发表或过期卡补发。下一轮实际业务仍需按实例/账号/企业/渠道核对；未测量耗时改善或300台吞吐。企业列表/水印等视觉语义仍依赖可读页面，不能把本轮校验描述成独立识别所有企微自绘控件。
- 本机未找到`agent-digital-cowork/clone`知识库，跨项目文档同步未执行。未提交或推送代码，原有无关工作树改动保留。
