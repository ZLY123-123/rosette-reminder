# Deploy ROSETTE · 部署 ROSETTE

## 1. Application · 应用服务

The templates target Linux with systemd and Node.js 24. Run `npm ci` and `npm test` in the release source. The templates use `/opt/reminder` for the code, `/var/lib/reminder` for application data, and a dedicated `reminder` service account. Check the Node executable path in both unit files.

模板以 Linux、systemd 和 Node.js 24 为基础。先在发布源码中运行 `npm ci` 与 `npm test`。模板使用 `/opt/reminder` 存放代码、`/var/lib/reminder` 存放数据，服务以专用 `reminder` 账户运行。检查两个服务文件里的 Node 路径。

- Create the service account and data directory. Give the account read access to the application and write access to the data directory. Copy [`.env.example`](../.env.example) to `/opt/reminder/.env` and restrict it to the administrator. Use `HOST=127.0.0.1` and `DATABASE_PATH=/var/lib/reminder/reminder.sqlite`.
- 创建服务账户和数据目录，为服务账户赋予代码读取权限及数据目录写入权限。复制 [`.env.example`](../.env.example) 到 `/opt/reminder/.env`，将其限制为管理员可读写。设置 `HOST=127.0.0.1` 和 `DATABASE_PATH=/var/lib/reminder/reminder.sqlite`。
- Set `APP_ORIGIN` to the public HTTPS scheme and host, plus a port when applicable. Use a strong `APP_PASSWORD` of at least 12 characters and separate random values of at least 32 characters for `SESSION_SECRET` and `AGENT_TOKEN`. For Web Push, run `npm run keys` and set both VAPID keys and `VAPID_SUBJECT`. Retain existing credentials and VAPID keys on upgrades.
- `APP_ORIGIN` 填公网 HTTPS 的协议与主机，有自定义端口时一并填写。设置至少 12 个字符的高强度 `APP_PASSWORD`，为 `SESSION_SECRET` 和 `AGENT_TOKEN` 分别生成至少 32 个字符的随机值。启用 Web Push 时运行 `npm run keys` 并设置两个 VAPID 密钥及 `VAPID_SUBJECT`。升级沿用现有凭据和 VAPID 密钥。
- Install [`reminder.service`](./reminder.service) under `/etc/systemd/system/`, then run `sudo systemctl daemon-reload` and `sudo systemctl enable --now reminder.service`. Use [Caddy at a domain root](./Caddyfile) or [Nginx at a subpath](./nginx-subpath.conf) with a valid TLS certificate. Verify cookie and service worker scope on subpath deployments. The public proxy should return 404 for `/api/agent/*` at the public mount path.
- 把 [`reminder.service`](./reminder.service) 安装到 `/etc/systemd/system/`，再执行 `sudo systemctl daemon-reload` 与 `sudo systemctl enable --now reminder.service`。可用 [Caddy 域名根路径模板](./Caddyfile) 或 [Nginx 子路径模板](./nginx-subpath.conf) 配置有效的 HTTPS 证书。子路径部署时核对 Cookie 和 Service Worker 的范围。公网反代对部署路径下的 `/api/agent/*` 返回 404。

## 2. OpenClaw and WeChat · OpenClaw 与微信

Use a dedicated OpenClaw installation and state directory. The project was tested with OpenClaw 2026.11.5, the WeChat plugin 2.4.10, and the optional QQ plugin 2.0.4. The [gateway unit](./reminder-openclaw.service) expects a Node installation of OpenClaw at `/opt/reminder/openclaw` and writable state at `/var/lib/reminder/openclaw`. Install any runtime and plugin versions explicitly. For example, run `npm install --prefix /opt/reminder/openclaw --save-exact openclaw@2026.11.5` after preparing the target directory.

使用专用 OpenClaw 安装和状态目录。项目验证基线为 OpenClaw 2026.11.5、微信插件 2.4.10、可选 QQ 插件 2.0.4。[网关服务模板](./reminder-openclaw.service)使用安装在 `/opt/reminder/openclaw` 的 OpenClaw 与可写的 `/var/lib/reminder/openclaw` 状态目录。准备安装目录后可运行 `npm install --prefix /opt/reminder/openclaw --save-exact openclaw@2026.11.5`。

1. Create the administrator-only `/etc/reminder/openclaw.env` with a random `OPENCLAW_GATEWAY_TOKEN` and a `REMINDER_AGENT_TOKEN` that matches the app's `AGENT_TOKEN`. Set `OPENCLAW_STATE_DIR=/var/lib/reminder/openclaw`, `OPENCLAW_JS_ENTRY=/opt/reminder/openclaw/node_modules/openclaw/openclaw.mjs`, and `OPENCLAW_SEND_VIA_GATEWAY=true` in the app's `.env`.
   创建仅管理员可读写的 `/etc/reminder/openclaw.env`，写入随机的 `OPENCLAW_GATEWAY_TOKEN` 和与应用 `AGENT_TOKEN` 相同的 `REMINDER_AGENT_TOKEN`。在应用的 `.env` 设置 `OPENCLAW_STATE_DIR=/var/lib/reminder/openclaw`、`OPENCLAW_JS_ENTRY=/opt/reminder/openclaw/node_modules/openclaw/openclaw.mjs` 和 `OPENCLAW_SEND_VIA_GATEWAY=true`。
2. Run OpenClaw management commands with the same service user, state directory, and environment. Create the state and workspace directories with permissions for the service account. One Linux/systemd option is the shell function below. Copy [`AGENTS.md`](./openclaw/agent-workspace/AGENTS.md) and [`IDENTITY.md`](./openclaw/agent-workspace/IDENTITY.md) to the dedicated workspace with read access for the service user.
   用与服务一致的用户、状态目录和环境运行 OpenClaw 管理命令，先创建专用状态和工作区目录，赋予服务账户读写权限。可使用下面的 shell 函数。将 [`AGENTS.md`](./openclaw/agent-workspace/AGENTS.md) 和 [`IDENTITY.md`](./openclaw/agent-workspace/IDENTITY.md) 复制到专用工作区，赋予服务账户读取权限。

```bash
claw() {
  sudo systemd-run --wait --collect --pty     --uid=reminder --gid=reminder --working-directory=/var/lib/reminder     -p EnvironmentFile=/etc/reminder/openclaw.env     --setenv=HOME=/var/lib/reminder     --setenv=OPENCLAW_STATE_DIR=/var/lib/reminder/openclaw     /usr/bin/node /opt/reminder/openclaw/node_modules/openclaw/openclaw.mjs "$@"
}

claw config set gateway.mode local
claw config set gateway.bind loopback
claw config set gateway.auth.mode token
claw config set agents.defaults.workspace /var/lib/reminder/openclaw/workspace
claw config set agents.defaults.skipBootstrap true --strict-json
claw config set agents.defaults.userTimezone Asia/Shanghai
claw config set cron.enabled false --strict-json
claw config set agents.defaults.blockStreamingDefault off
claw config set session.reset.mode none
claw config set tools.allow '["reminder_tasks"]' --strict-json
claw plugins install --link /opt/reminder/openclaw-plugin --force --accept-capabilities
claw config set plugins.slots.contextEngine reminder-desk
claw config set plugins.entries.reminder-desk.hooks.allowConversationAccess true --strict-json
claw plugins install npm:@tencent-weixin/openclaw-weixin@2.4.10 --accept-capabilities
sudo -u reminder /usr/bin/node /opt/reminder/deploy/openclaw/weixin-sender-compat.mjs /var/lib/reminder/openclaw
claw config set channels.openclaw-weixin.replyProgressMessages false --strict-json
claw config validate
```

3. Install `reminder-openclaw.service` under `/etc/systemd/system/`, then run `sudo systemctl daemon-reload` and `sudo systemctl enable --now reminder-openclaw.service`. Run `claw configure --section model` to authorize and select a model in the dedicated gateway. Run `claw channels login --channel openclaw-weixin` and scan the QR code in WeChat.
   把 `reminder-openclaw.service` 安装到 `/etc/systemd/system/`，执行 `sudo systemctl daemon-reload` 与 `sudo systemctl enable --now reminder-openclaw.service`。运行 `claw configure --section model` 在专用网关授权并选择模型，再通过 `claw channels login --channel openclaw-weixin` 扫码绑定微信。
4. From the dedicated state's `openclaw-weixin/accounts/` directory, read the authorized account's `userId` and account ID (the account file name without `.json`). Set `WECHAT_TARGET` and `WECHAT_ACCOUNT` in the app's `.env`, and set `plugins.entries.reminder-desk.config.wechatSender` and `wechatAccount` in the gateway config. Add `openclaw-weixin:<userId>` to `commands.ownerAllowFrom`. Read only the binding fields, since the account records also contain credentials. These examples use application port 3100. If changing it, update the plugin's `apiBase` and the loopback target in the WeChat feedback adapter before applying the adapter.
   从专用状态目录的 `openclaw-weixin/accounts/` 读取授权账号的 `userId` 和账号 ID（去掉 `.json` 的账号文件名）。在应用 `.env` 设置 `WECHAT_TARGET` 和 `WECHAT_ACCOUNT`，在网关设置 `plugins.entries.reminder-desk.config.wechatSender` 和 `wechatAccount`，并将 `openclaw-weixin:<userId>` 加入 `commands.ownerAllowFrom`。账号记录同时保存凭据，操作时仅读取绑定字段。示例应用端口为 3100，改用其他端口时同时调整插件的 `apiBase`，在应用微信适配前同步修改反馈模块的回环地址。
5. Optional QQ setup uses the [QQ Bot guide](https://docs.openclaw.ai/channels/qqbot). Bind your own private chat OpenID in `QQ_TARGET`, mirror it to `plugins.entries.reminder-desk.config.qqSender`, and allow only the intended sender in the channel and gateway.
   可选的 QQ 接入见 [QQ Bot 指南](https://docs.openclaw.ai/channels/qqbot)。将本人私聊 OpenID 写入 `QQ_TARGET` 和 `plugins.entries.reminder-desk.config.qqSender`，在渠道和网关限制授权发送者。

## 3. Verification and maintenance · 验收与运维

- Run `sudo systemctl restart reminder.service reminder-openclaw.service`. Verify both units with `systemctl is-active` and `systemctl is-enabled`. Check `claw channels status --probe`, the local `/healthz`, browser sign-in at the public URL, and the public agent API block.
- 执行 `sudo systemctl restart reminder.service reminder-openclaw.service`。用 `systemctl is-active` 和 `systemctl is-enabled` 检查两项服务。核对 `claw channels status --probe`、本机 `/healthz`、公网网页登录及内部接口访问限制。
- Create a two-minute test reminder in WeChat. Confirm the web task, the model response, and actual delivery. On an iPhone with iOS 16.4 or later, open the HTTPS workbench in Safari, add it to the Home Screen, reopen it from the icon, and enable notifications in Settings. Run the mobile test and confirm the lock-screen alert and badge.
- 在微信创建一条两分钟后的测试提醒，确认网页待办、模型回复及实际送达。iOS 16.4 或更新版本可通过 Safari 将 HTTPS 工作台添加到主屏幕，从图标打开并在设置中启用通知，再测试锁屏通知及角标。
- View logs with `sudo journalctl -u reminder.service -u reminder-openclaw.service -n 80`. Before an upgrade, retain the previous source revision, take a consistent database backup, and back up the dedicated gateway state and configuration. Review compatibility before reapplying the WeChat adapter after a plugin update.
- 用 `sudo journalctl -u reminder.service -u reminder-openclaw.service -n 80` 查看日志。升级前保留原源码版本、创建一致的数据库备份，并备份专用网关状态和配置。插件升级后，先核对兼容性再应用微信适配。
