# lobster-device-control

> OpenClaw 插件，通过 WebSocket 远程控制 Android 手机

通过 LobsterAgent Android App 将手机连接到 OpenClaw，AI Agent 即可通过自然语言指令控制手机执行自动化任务。

## 功能特性

- **多设备管理** — 同时连接多台手机，独立并行执行任务
- **视觉自主 Agent** — 手机端截图 → VLM 分析 → 执行动作 → 循环，直到任务完成
- **实时镜像** — PC 端可实时查看手机屏幕（截图推送）
- **跨设备任务** — 一条指令同时控制多台手机执行不同任务

## 系统要求

- OpenClaw 桌面客户端
- Android 7.0+ 手机
- 手机与 PC 同网络（WiFi 或 USB 网络共享）

## 安装

### 1. 安装 OpenClaw 插件

```bash
npm install @youngclaw/lobster-device-control@beta
```

插件会被 OpenClaw 自动发现并加载。

### 2. 安装 LobsterAgent Android App

下载最新 APK 安装到 Android 手机：
- [下载 APK](https://example.com/lobster-agent.apk) （替换为实际下载链接）
- 或自行编译：`cd LobsterAgentAndroid && ./gradlew assembleDebug`

### 3. 连接手机到 OpenClaw

1. 打开 LobsterAgent App
2. 在"服务器地址"填入 OpenClaw 所在 PC 的 IP 和端口：
   ```
   ws://192.168.1.100:18800
   ```
3. 点击"连接"
4. 连接成功后状态显示"已连接"

![连接示意](docs/connection.png)

## 使用方式

### 在 OpenClaw 中发送指令

连接成功后，直接用自然语言让 OpenClaw 控制手机：

```
打开小红书，浏览首页第一屏内容
```

```
在小米手机上打开微信，给张三发消息：今晚吃什么
```

```
同时控制两台手机：小米打开淘宝，荣耀打开京东
```

### 可用工具

| 工具 | 说明 |
|------|------|
| `device:list` | 查看已连接的手机列表 |
| `device:execute_task` | 向指定手机发送任务 |
| `device:execute_task_all` | 向所有手机广播同一任务 |
| `device:execute_batch` | 向多台手机分别发送不同任务 |
| `device:cancel_task` | 取消正在执行的任务 |
| `device:get_status` | 查看指定手机的详细状态 |

### 查询已连接设备

```
列出已连接的手机
```

返回示例：
```
📱 Connected devices (2):
  - [24094RAD4C-abc123] Xiaomi | (24094RAD4C) | status=idle | app=com.lobster.agent | screen=1080x2400 | Android 14 | 🔋85% | ⚡ | 📶 MyWiFi
  - [PTP-AN10-def456] HONOR | (PTP-AN10) | status=idle | app=com.lobster.agent | screen=1280x2800 | Android 15 | 🔋92% | 📶 HonorWiFi
```

## 架构说明

```
┌─────────────────────────────────────────────────────────┐
│                    OpenClaw (PC)                         │
│                                                          │
│  OpenClaw Agent                                          │
│       ↓                                                  │
│  lobster-device-control 插件                               │
│       ├── WsServer (port 18800) ←── 手机 WebSocket 连接   │
│       ├── TaskCoordinator (任务分发与结果收集)              │
│       └── HTTP RPC (port 18801)                          │
└─────────────────────────────────────────────────────────┘
                    ↑ WebSocket
                    ↓
┌─────────────────────────────────────────────────────────┐
│              LobsterAgent Android App                     │
│                                                          │
│  PhoneAgentRunner (视觉自主 Agent)                       │
│       ├── 截图 → VLM API → 解析动作 → 执行 → 循环       │
│       ├── AccessibilityDeviceController (无障碍控制)      │
│       └── LadbDeviceController (ADB fallback)            │
└─────────────────────────────────────────────────────────┘
```

### 手机端控制方式

| 方式 | 说明 |
|------|------|
| AccessibilityService | 系统无障碍 API，可执行点击/滑动/输入，需用户授权 |
| LADB | Local ADB，通过 USB 或网络执行命令（Shizuku 不再必需） |

## 配置说明

### 插件配置

插件默认配置（一般无需修改）：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| wsPort | 18800 | WebSocket 服务端口 |
| httpPort | 18801 | HTTP RPC 端口 |

### VLM 配置（App 内设置）

在 LobsterAgent App 的设置页面配置：

| 配置项 | 说明 |
|--------|------|
| API 地址 | VLM 服务端点，默认使用 autoglm-phone |
| API Key | VLM 服务密钥 |
| 模型名称 | 如 autoglm-phone |

## 常见问题

### 手机连接后显示"空闲"但 OpenClaw 找不到设备

1. 确认手机和 PC 在同一网络
2. 检查服务器地址格式：`ws://PC_IP:18800`
3. 检查防火墙是否放行了 18800 端口

### 任务执行时被系统冻结

在 App 设置中关闭电池优化：
- 设置 → 应用 → LobsterAgent → 电池 → 关闭优化
- 或在 App 内点击"关闭电池优化"按钮

### 截图发到 OpenClaw 后是黑色/空白

1. 确保系统截屏权限已开启
2. 部分设备需要在无障碍设置中开启"获取窗口内容"权限
3. 更新到最新版本的 App 和插件

### 华为/Honor 设备连接不上

1. 确保开启了"允许后台弹出界面"权限
2. 在电池 → 启动管理中允许自启动和后台运行
3. 检查是否限制了特定应用的权限

## 开发

### 插件开发

```bash
# 克隆仓库
git clone https://gitlab.sy.soyoung.com/fe/openclaw-device-control.git
cd openclaw-device-control

# 安装依赖
npm install

# 开发模式（监听文件变化自动编译）
npm run build:watch

# 构建发布版本
npm run build

# 发布到 npm
npm publish --tag beta
```

### App 开发

```bash
# 克隆仓库
git clone https://gitlab.sy.soyoung.com/fe/LobsterAgentAndroid.git
cd LobsterAgentAndroid

# 构建 debug APK
./gradlew assembleDebug

# 安装到已连接的手机
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## 协议

消息协议定义在 `src/protocol.ts`，使用 Zod 进行schema校验。

## License

MIT
