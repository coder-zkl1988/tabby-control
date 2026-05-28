---
name: xiaohongshu
app: com.xingin.xhs
version: 1.0.0
description: 小红书操作技能
---

# 小红书技能

## 风险信号

| 信号 | 处理 |
|------|------|
| 频繁操作提示 | 停止当前操作，等待30秒 |
| 登录过期弹窗 | 上报 blocked |
| 内容审核提示 | 停止发布操作，上报 |
| 网络异常 | 等待5秒重试，最多2次 |

## 全局弹窗处理

| 弹窗 | 识别 | 策略 |
|------|------|------|
| 登录弹窗 | 发现登录界面 | 上报 blocked |
| 更新弹窗 | "立即更新"文字 | 关闭（1. accessibility:`id/iv_close` 2. visual:"关闭按钮"） |
| 通知权限 | "开启通知"文字 | 拒绝（1. accessibility:`id/btn_deny` 2. visual:"拒绝按钮"） |
| 广告弹窗 | 全屏广告覆盖 | 关闭（1. accessibility:`id/iv_close` 2. visual:"右上角关闭"） |

## 意图路由

| 用户意图 | 操作 | 典型说法 |
|---------|------|---------|
| 搜索 | search | 搜索、找、查 |
| 浏览 | browse | 看看、推荐、首页 |
| 发布 | post | 发笔记、发图文、发视频 |
| 互动 | interact | 点赞、收藏、评论、关注 |
| 个人页 | profile | 我的主页、博主主页 |

## 操作定义

### search

**参数**: keyword (string, 必需)

**步骤**:

**Step 1: 点击搜索入口**

- 类型：deterministic
- 策略：
  1. accessibility: `com.xingin.xhs:id/search_btn`
  2. visual: "点击搜索框（屏幕顶部的放大镜图标）"
- 验证：搜索输入框出现

**Step 2: 输入搜索词**

- 类型：deterministic
- 策略：
  1. accessibility: `com.xingin.xhs:id/search_input`
  2. visual: "点击搜索输入框，输入关键词"
- 动作：Type(keyword)
- 验证：输入框显示搜索词

**Step 3: 提交搜索**

- 类型：deterministic
- 策略：
  1. accessibility: `com.xingin.xhs:id/search_btn` (键盘搜索键)
  2. visual: "点击键盘上的搜索按钮"
- 验证：搜索结果列表出现

**失败处理**:

| 场景 | 处理 |
|------|------|
| 搜索入口未找到 | 退回首页重试（最多1次） |
| 搜索词输入失败 | 清空输入框重新输入 |
| 搜索结果未加载 | 等待3秒后检查 |

---

### post

**参数**: title (string, 必需), content (string, 必需), tags (string[], 可选), images (string[], 可选)

**需要确认**: true

**步骤**:

**Step 1: 进入发布页面**

- 类型：deterministic
- 策略：
  1. accessibility: `com.xingin.xhs:id/iv_publish`
  2. visual: "点击底部中间的红色+号发布按钮"
- 验证：发布页面打开

**Step 2: 选择图片**

- 类型：flexible
- 提示：从相册选择用户指定的图片，数量与参数一致
- maxSteps: 2
- 验证：图片已添加到编辑区

**Step 3: 填写标题和正文**

- 类型：deterministic
- 策略：
  1. accessibility: `com.xingin.xhs:id/title_edittext` → Type(title)
  2. accessibility: `com.xingin.xhs:id/content_edittext` → Type(content)
  3. visual: "填写标题和正文"
- 验证：标题和正文已填写

**Step 4: 上报桌面确认**

- 类型：deterministic
- 动作：上报当前截图和填写内容给桌面端
- 等待桌面端确认指令

**Step 5: 点击发布**

- 类型：deterministic
- 策略：
  1. accessibility: `com.xingin.xhs:id/publish_btn`
  2. visual: "点击发布按钮"
- 验证：发布成功提示出现

**失败处理**:

| 场景 | 处理 |
|------|------|
| 相册权限未授予 | 上报 blocked |
| 标题超长(>20字) | 截断标题并警告 |
| 发布失败 | 保存草稿，上报失败原因 |
| 内容审核拦截 | 停止操作，上报 |

---

### interact

**参数**: action (like|collect|comment|follow), target (string, 可选)

**需要确认**: true (仅 comment 动作)

**步骤**:

**Step 1: 定位目标笔记**

- 类型：flexible
- 提示：在当前页面找到目标笔记并点击进入详情
- maxSteps: 2
- 验证：笔记详情页打开

**Step 2: 执行互动操作**

- 类型：deterministic（like/collect/follow）/ flexible（comment）
- 策略（like）：
  1. accessibility: `com.xingin.xhs:id/like_btn`
  2. visual: "点击爱心图标点赞"
- 策略（comment）：
  - 提示：找到评论输入框，输入评论内容并发送
  - maxSteps: 3
  - 注意两次评论间隔 ≥ 8 秒
- 验证：操作生效

**失败处理**:

| 场景 | 处理 |
|------|------|
| 未找到目标笔记 | 上报 failed |
| 评论发送失败 | 重试1次 |
| 频繁操作提示 | 停止，等待30秒 |
