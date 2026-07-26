# 手机技能

本目录是手机端 App 操作技能的唯一可编辑源。`TabbyApp` 中的
`app/src/main/assets/skills` 仅作为离线冷启动基线，由这里生成，不再手工维护。

## 修改流程

1. 修改 `apps/<app>/skill.json`、`instructions.md` 或 `references/*.md`。
2. 提升 `manifest.json` 中的 `bundleVersion`。
3. 执行 `npm run phone-skills:build`，生成确定性的 bundle 和 SHA-256 摘要。
4. 执行下面的命令同步 Android 内置基线：

```bash
node scripts/build-phone-skills.mjs \
  --android-assets ../TabbyApp/app/src/main/assets/skills
```

5. 提交前执行 `npm run phone-skills:check`。跨仓库发版还应执行：

```bash
node scripts/build-phone-skills.mjs \
  --check \
  --check-android-assets ../TabbyApp/app/src/main/assets/skills
```

运行时由 `tabby-control` 在手机连接后处理 `skill.hello`。本地摘要与当前
bundle 不一致时，桌面端下发完整 bundle；手机校验摘要和最低版本后原子替换，
失败则保留上一个可用版本并返回 `skill.nack`。
