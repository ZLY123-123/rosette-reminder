# ROSETTE iOS

**简体中文** · [English](./README.en.md)

iOS 客户端支持 iOS 17+。使用工作台口令登录，查看和管理待办，读取对话和提醒投递记录。前台同步后可离线查看最近的快照。开启「本机定时通知」后，客户端为已同步的待办安排接下来 14 天内最多 60 条通知。服务端另行处理微信、QQ 和 PWA 投递。

## 配置自己的工作台

将 [`ReminderAPI.productionURL`](./Core/ReminderAPI.swift) 改为有效的 HTTPS 工作台完整地址，带上子路径和结尾斜杠。例如 `https://example.com/reminder/`。首次构建前完成此项配置，源码中的默认值为示例地址。

如需自定义 Bundle ID，请同步更新 [`project.yml`](./project.yml) 和 [打包脚本的校验项](./scripts/build-ipa.sh)。服务器与手机通知配置见[部署手册](../deploy/README.md)。

## 构建和测试

在装有 Xcode 和 XcodeGen 的 Mac 上，从仓库根目录执行：

```bash
swift test --package-path ios
bash ios/scripts/build-ipa.sh
```

也可从 GitHub Actions 手动运行 [iOS 构建流程](../.github/workflows/ios.yml)。构建产物为未签名 IPA，真机安装需要为你的设备或分发方式完成签名。

要运行 HTTP 集成测试，先在一个终端启动 `node ios/scripts/api-fixture.mjs`，再在另一个终端执行 `REMINDER_TEST_ORIGIN=http://127.0.0.1:28657 swift test --package-path ios`。测试桩使用本机端口和内存数据。
