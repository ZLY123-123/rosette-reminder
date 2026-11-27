import SwiftUI
import UIKit
import ReminderCore

struct SettingsView: View {
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var model: DeskModel
    let isSelected: Bool
    @State private var confirmLogout = false
    @State private var togglingAlerts = false
    @State private var usageRange = ModelUsageRange.month

    private var isActive: Bool { isSelected && scenePhase == .active }
    private var activeUsageRange: ModelUsageRange? { isActive && model.openClaw?.isDeepSeek == true ? usageRange : nil }

    var body: some View {
        Form {
            OpenClawSettingsSection(model: model)
            if model.openClaw?.isDeepSeek == true { DeepSeekSettingsSections(model: model, range: $usageRange) }
            if let snapshot = model.snapshot, snapshot.wechatConfigured {
                WeChatActivitySection(activity: snapshot.wechatActivity)
            }
            Section {
                Toggle(isOn: Binding(get: { model.localAlerts }, set: updateLocalAlerts)) {
                    Label("本机定时通知", systemImage: "bell.badge")
                }
                .disabled(togglingAlerts || model.busy)
                if let count = model.scheduledCount {
                    LabeledContent("已排入 iOS", value: "\(count) 条")
                }
                if model.badgesAllowed {
                    LabeledContent("App 图标角标", value: "已授权")
                } else {
                    Button("启用 App 图标角标", systemImage: "app.badge") {
                        togglingAlerts = true
                        Task {
                            await model.enableIconBadge()
                            togglingAlerts = false
                        }
                    }
                    .disabled(togglingAlerts || model.busy)
                }
                if !model.alertsAllowed || !model.badgesAllowed {
                    Button("打开 iOS 通知设置", systemImage: "gearshape") {
                        if let settings = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(settings) }
                    }
                }
            } header: {
                Text("iPhone")
            } footer: {
                Text("授权后，App 图标角标随同步更新。本机定时通知可单独开启，覆盖同步后的 14 天，最多 60 条。微信新建待办由服务器实时处理，App 下次打开时同步到本机。")
            }
            .listRowBackground(RosettePalette.panel)
            Section("服务器") {
                if let snapshot = model.snapshot {
                    NavigationLink {
                        DailySettings(model: model, settings: snapshot.settings)
                    } label: {
                        LabeledContent("每日待办总结", value: snapshot.settings.daily ?? "关闭")
                    }
                    NavigationLink {
                        RoutingSettings(model: model, snapshot: snapshot)
                    } label: {
                        Label("投递优先级", systemImage: "arrow.triangle.branch")
                    }
                }
                NavigationLink {
                    DeliveryHistory(model: model)
                } label: {
                    Label("投递记录", systemImage: "list.bullet.rectangle")
                }
            }
            .listRowBackground(RosettePalette.panel)
            Section("工作台") {
                Link(destination: ReminderAPI.productionURL) {
                    Label("打开网页版", systemImage: "safari")
                }
                NavigationLink {
                    FontLicensesView()
                } label: {
                    Label("字体版权与许可", systemImage: "textformat")
                }
                if let synced = model.syncedAt {
                    LabeledContent("上次同步", value: deskDate(synced))
                }
                Button("立即同步", systemImage: "arrow.clockwise") {
                    Task { await refreshSettings() }
                }
                .disabled(model.busy)
                Button("退出登录", role: .destructive) { confirmLogout = true }
                    .disabled(model.busy)
            }
            .listRowBackground(RosettePalette.panel)
        }
        .rosetteList()
        .navigationTitle("设置")
        .task(id: isActive) { if isActive { await model.loadOpenClaw() } }
        .task(id: activeUsageRange) { if let range = activeUsageRange { await model.loadDeepSeekUsage(range) } }
        .refreshable { await refreshSettings() }
        .confirmationDialog("退出 ROSETTE？", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("退出登录", role: .destructive) { Task { await model.logout() } }
        } message: {
            Text("本机缓存、角标与已排程通知将随退出清除。")
        }
    }

    private func refreshSettings() async {
        let hadDeepSeek = model.openClaw?.isDeepSeek == true
        await model.refresh()
        await model.loadOpenClaw(refresh: true)
        if hadDeepSeek, model.openClaw?.isDeepSeek == true {
            await model.loadDeepSeekUsage(usageRange, refresh: true)
        }
    }

    private func updateLocalAlerts(_ enabled: Bool) {
        togglingAlerts = true
        Task {
            await model.setLocalAlerts(enabled)
            togglingAlerts = false
        }
    }
}

private struct FontLicensesView: View {
    var body: some View {
        List {
            license("Cabin Sketch", resource: "CabinSketch-OFL")
            license("Italianno", resource: "Italianno-OFL")
        }
        .rosetteList()
        .navigationTitle("字体版权与许可")
    }

    private func license(_ name: String, resource: String) -> some View {
        DisclosureGroup(name) {
            if let url = Bundle.main.url(forResource: resource, withExtension: "txt"),
                let notice = try? String(contentsOf: url, encoding: .utf8) {
                Text(verbatim: notice)
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
            } else {
                Text("许可文本暂不可用。").foregroundStyle(.secondary)
            }
        }
        .listRowBackground(RosettePalette.panel)
    }
}

private struct DailySettings: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: DeskModel
    @State private var enabled: Bool
    @State private var time: Date
    @State private var important: Bool

    init(model: DeskModel, settings: DeskSettings) {
        self.model = model
        _enabled = State(initialValue: settings.daily != nil)
        let parts = settings.daily?.split(separator: ":").compactMap { Int($0) } ?? [21, 0]
        _time = State(initialValue: BeijingTime.calendar.date(
            bySettingHour: parts.first ?? 21, minute: parts.last ?? 0, second: 0, of: .now
        ) ?? .now)
        _important = State(initialValue: settings.dual != 0)
    }

    var body: some View {
        Form {
            Section {
                Toggle("发送每日总结", isOn: $enabled)
                if enabled {
                    DatePicker("发送时间 · 北京时间", selection: $time, displayedComponents: .hourAndMinute)
                    Toggle("按重要提醒发送", isOn: $important)
                }
            }
            .listRowBackground(RosettePalette.panel)
        }
        .rosetteList()
        .environment(\.calendar, BeijingTime.calendar)
        .navigationTitle("每日待办总结")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("保存") {
                let value = enabled ? deskDate(time, includeDay: false) : nil
                Task { if await model.saveDaily(value, dual: important) { dismiss() } }
            }
            .disabled(!model.canEdit)
        }
    }
}

private struct RoutingSettings: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: DeskModel
    private let snapshot: DeskSnapshot
    @State private var levels: [Channel: Int]
    @State private var fallback: FallbackMode

    init(model: DeskModel, snapshot: DeskSnapshot) {
        self.model = model
        self.snapshot = snapshot
        let ordered = snapshot.settings.policy.levels.enumerated().flatMap { index, group in
            group.map { ($0, index + 1) }
        }
        _levels = State(initialValue: Dictionary(ordered, uniquingKeysWith: { first, _ in first }))
        _fallback = State(initialValue: snapshot.settings.policy.fallback)
    }

    private var groups: [[Channel]] {
        (1...3).map { rank in Channel.allCases.filter { levels[$0] == rank } }.filter { !$0.isEmpty }
    }

    var body: some View {
        Form {
            Section {
                ForEach(Channel.allCases) { channel in
                    Picker(channel.title, selection: Binding(
                        get: { levels[channel] ?? 0 }, set: { levels[channel] = $0 }
                    )) {
                        Text("关闭").tag(0)
                        Text("第一顺位").tag(1)
                        Text("第二顺位").tag(2)
                        Text("第三顺位").tag(3)
                    }
                }
            } header: {
                Text("渠道顺位")
            } footer: {
                Text("同一顺位同时投递。需要启用备用渠道时，服务器按顺位继续投递。")
            }
            .listRowBackground(RosettePalette.panel)
            Section("启用备用渠道") {
                Picker("触发条件", selection: $fallback) {
                    ForEach(FallbackMode.allCases) { Text($0.title).tag($0) }
                }
            }
            .listRowBackground(RosettePalette.panel)
            Section("连接状态") {
                LabeledContent("微信", value: snapshot.wechatConfigured ? "已配置" : "等待配置")
                LabeledContent("QQ", value: snapshot.qqConfigured ? "已配置" : "等待配置")
                LabeledContent("网页通知", value: "\(snapshot.subscriptions) 个订阅")
            }
            .listRowBackground(RosettePalette.panel)
            Section("测试") {
                Button("测试备用链路", systemImage: "point.topleft.down.to.point.bottomright.curvepath") {
                    Task { await model.sendTest(fallback: true) }
                }
                Button("测试网页通知", systemImage: "paperplane") {
                    Task { await model.sendTest(fallback: false) }
                }
                .disabled(!model.canEdit || snapshot.subscriptions == 0)
            }
            .listRowBackground(RosettePalette.panel)
            .disabled(!model.canEdit)
        }
        .rosetteList()
        .navigationTitle("投递优先级")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("保存") {
                let policy = DeliveryPolicy(levels: groups, fallback: fallback)
                Task { if await model.savePolicy(policy) { dismiss() } }
            }
            .disabled(!model.canEdit || groups.isEmpty)
        }
    }
}

private struct DeliveryHistory: View {
    @ObservedObject var model: DeskModel

    var body: some View {
        List {
            let history = model.snapshot?.history ?? []
            ForEach(history) { record in
                VStack(alignment: .leading, spacing: 8) {
                    Text(record.title).font(.headline)
                    Text(deskDate(BeijingTime.date(from: record.dueAt)))
                        .font(.caption).foregroundStyle(.secondary)
                    if let preview = record.preview { Text(preview).font(.subheadline) }
                    DeliveryLines(wechat: record.wechat, qq: record.qq, push: record.push)
                    if let detail = record.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                    if let detail = record.qqDetail {
                        Text("QQ · " + detail).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 5)
                .listRowBackground(RosettePalette.panel)
            }
            if history.isEmpty {
                ContentUnavailableView("投递记录暂空", systemImage: "paperplane")
                    .listRowBackground(RosettePalette.panel)
            }
        }
        .rosetteList()
        .navigationTitle("投递记录")
        .refreshable { await model.refresh() }
    }
}
