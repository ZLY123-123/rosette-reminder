# ROSETTE iOS

[简体中文](./README.md) · **English**

The iOS client supports iOS 17 and later. Sign in with the workbench password to view and manage tasks, conversations, and delivery history. The client caches the latest snapshot on foreground sync for offline viewing. Its local notification option schedules up to 60 synced reminders over the next 14 days. The server handles WeChat, QQ, and PWA delivery separately.

## Connect your workbench

Set [`ReminderAPI.productionURL`](./Core/ReminderAPI.swift) to your full HTTPS workbench address before building. Include the path and trailing slash, e.g. `https://example.com/reminder/`. The source includes a placeholder address.

When changing the bundle ID, update both [`project.yml`](./project.yml) and the verification in the [packaging script](./scripts/build-ipa.sh). See the [deployment guide](../deploy/README.md) for server and mobile notification setup.

## Build and test

From the repository root on a Mac with Xcode and XcodeGen:

```bash
swift test --package-path ios
bash ios/scripts/build-ipa.sh
```

You can also run the [manual iOS GitHub Actions workflow](../.github/workflows/ios.yml). It produces an unsigned IPA. Sign the app for your device or distribution method before installing it.

For HTTP integration tests, run `node ios/scripts/api-fixture.mjs` in one terminal, then `REMINDER_TEST_ORIGIN=http://127.0.0.1:28657 swift test --package-path ios` in another. The fixture uses a local port and in-memory data.
