# ROSETTE

[简体中文](./README.md) · **English**

ROSETTE is a self-hosted task and scheduled reminder service. Manage tasks on the web or use natural language in WeChat and QQ direct messages through OpenClaw. The server schedules reminders and delivers them through WeChat, QQ, or mobile Web Push according to your delivery policy.

## Features

- One-time, daily, and weekly reminders, with inclusive end dates and date-range scheduling.
- Manage tasks, archives, and the reminder inbox from chat. Quote a WeChat message to identify a task.
- Parallel and sequential fallback delivery, with per-channel receipts and processing traces.
- Daily task summaries, PWA lock-screen notifications, and unread badges.
- Optional short-context mode for OpenClaw, plus balance and CNY cost estimates when DeepSeek is the active provider.
- [iOS client source](./ios/README.en.md) with workbench sync and on-device scheduling.

## Local preview

With Node.js 24 installed, run:

```bash
npm ci
npm run preview
```

Open `http://localhost:3176/` and sign in with the temporary password printed in the terminal. The preview uses an in-memory database that resets when the process exits. Run `npm test` for the automated checks.

## Self-hosted deployment

The [bilingual deployment guide](./deploy/README.md) covers Linux services, HTTPS reverse proxies, OpenClaw, and WeChat. Public deployments use a valid HTTPS certificate. Model authorization, WeChat QR sign-in, and iPhone notification permission are completed by the account or device owner.

### Prompt for a coding agent

```text
Deploy ROSETTE on my behalf from preflight through verification and handoff. Use the current source directory or clone the repository specified below. Read deploy/README.md, .env.example, and package.json first.
- Source directory or Git clone URL:
- Deployment target (this Linux host or an SSH alias):
- Public HTTPS workbench URL (including the path and trailing slash):
- OpenClaw model provider and model:
- Optional scope (QQ fallback or a native iOS build):

1. Check SSH access, sudo, Linux/systemd, available ports, and the reverse proxy. For upgrades, back up the database, configuration, and dedicated OpenClaw state and record rollback steps. Ask for any remaining required inputs together.
2. Install Node.js 24 and run npm ci and npm test. Use the guide to configure the service account, loopback listeners, and HTTPS reverse proxy. Generate missing credentials and VAPID keys and write them to restricted configuration. Preserve valid existing secrets. Handle provider credentials through a secure terminal.
3. Configure the dedicated OpenClaw instance, task plugin, and authorized sender. For model authorization, WeChat QR sign-in, DNS, and phone permissions, show me the exact action and success indicator, then resume after I confirm. Continue independent work while waiting. Configure QQ and the native iOS build only if requested.
4. Verify web sign-in and task creation, boot enablement for both services, public isolation of the agent API, and a natural-language WeChat reminder that reaches the phone when due. For PWA, have me open the app from the iPhone Home Screen and check Test Mobile on the lock screen and icon badge. Report each check as passed, pending my verification, or blocked. Clean up the test tasks you created.
5. Give me the workbench URL, a command to retrieve the password locally, first-use steps for WeChat and phone notifications, and where to find delivery records, plus copyable commands for service status, logs, restart, backups, and rollback. Keep reports and logs to configuration paths and status.
```

## License

Project source code is available under the [MIT License](./LICENSE). Bundled fonts retain their respective SIL Open Font Licenses in the [web font directory](./public/fonts/) and [iOS font directory](./ios/Resources/Fonts/).
