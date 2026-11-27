import Charts
import SwiftUI
import ReminderCore

struct OpenClawSettingsSection: View {
    @ObservedObject var model: DeskModel
    @State private var draft = ""

    private var choices: [OpenClawModelChoice] { model.openClaw?.choices ?? [] }
    private var providers: [String] { model.openClaw?.providers ?? [] }
    private var defaultProvider: String { providers.first { $0 == model.openClaw?.provider } ?? providers.first ?? "" }
    private var selectedProvider: String {
        choices.first { $0.id == draft }?.provider ?? defaultProvider
    }

    var body: some View {
        Section("OpenClaw 模型") {
            if let selection = model.openClaw {
                if let provider = selection.provider {
                    LabeledContent("当前供应商", value: RosettePalette.providerName(provider))
                }
                if let current = selection.currentName { LabeledContent("当前模型", value: current) }
                if selection.status == "unavailable" {
                    Text("可用模型暂未同步。").font(.footnote).foregroundStyle(.secondary)
                } else if choices.contains(where: { $0.id != selection.current || selection.pinned == true }) {
                    if providers.count > 1 {
                        Picker("模型供应商", selection: Binding(get: { selectedProvider }, set: pickProvider)) {
                            ForEach(providers, id: \.self) { Text(RosettePalette.providerName($0)).tag($0) }
                        }
                        .pickerStyle(.menu)
                        .disabled(model.modelsBusy)
                    }
                    Picker("对话模型", selection: $draft) {
                        ForEach(choices.filter { $0.provider == selectedProvider }) { Text($0.name).tag($0.id) }
                    }
                    .pickerStyle(.menu)
                    .disabled(model.modelsBusy)
                    Button("应用模型", systemImage: "checkmark.circle") {
                        let selected = draft
                        Task { await model.loadOpenClaw(selecting: selected) }
                    }
                    .disabled(!model.canEdit || model.modelsBusy || draft.isEmpty ||
                        (draft == selection.current && selection.pinned != true))
                }
                if selection.sessionPending == true {
                    Label("模型已保存，微信会话正在同步。", systemImage: "clock")
                        .font(.footnote).foregroundStyle(RosettePalette.amber)
                }
            } else if model.modelError == nil {
                ProgressView("正在读取 OpenClaw")
            }
            if let error = model.modelError {
                Label(error, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(RosettePalette.amber)
            }
            Button("刷新模型列表", systemImage: "arrow.clockwise") {
                Task { await model.loadOpenClaw(refresh: true) }
            }
            .disabled(model.modelsBusy)
        }
        .listRowBackground(RosettePalette.panel)
        .onChange(of: model.openClaw, initial: true) { old, selection in
            guard let selection else { draft = ""; return }
            if old?.current == selection.current, selection.choices.contains(where: { $0.id == draft }) { return }
            pickProvider(defaultProvider)
        }
    }

    private func pickProvider(_ provider: String) {
        let options = choices.filter { $0.provider == provider }
        let current = [model.openClaw?.current, model.openClaw?.configuredModel].compactMap { $0 }
        draft = current.first(where: { id in options.contains { $0.id == id } })
            ?? options.first(where: { $0.recommended == true })?.id ?? options.first?.id ?? ""
    }
}

struct WeChatActivitySection: View {
    let activity: WeChatActivity?

    var body: some View {
        Section {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                LabeledContent("当前静默", value: activity?.silence(at: context.date) ?? "等待第一条消息")
            }
            if let time = activity?.lastInboundAt {
                LabeledContent("最近入站", value: deskDate(BeijingTime.date(from: time)))
            }
            if let time = activity?.lastOutboundAt {
                LabeledContent("最近投递", value: deskDate(BeijingTime.date(from: time)))
            }
            if let accepted = activity?.accepted { LabeledContent("本轮已受理", value: "\(accepted) 条") }
            if activity?.deferred == true {
                Label("等待你在微信发「继续」", systemImage: "pause.circle.fill")
                    .font(.subheadline).foregroundStyle(RosettePalette.amber)
            }
        } header: {
            Text("微信状态")
        } footer: {
            Text("静默满 12 小时或本轮已发 9 条时，服务器会尝试发一次提示。你在微信手动发「继续」后，程序会直接回复。")
        }
        .listRowBackground(RosettePalette.panel)
    }
}

struct DeepSeekSettingsSections: View {
    @ObservedObject var model: DeskModel
    @Binding var range: ModelUsageRange

    var body: some View {
        Section("DeepSeek 余额") {
            if let data = model.deepSeek {
                ForEach(data.balance.accounts) { account in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(account.currency == "CNY" ? "人民币" : account.currency).font(.caption)
                            if account.low {
                                Label("余额偏低", systemImage: "exclamationmark.circle").font(.caption)
                                    .foregroundStyle(RosettePalette.amber)
                            }
                        }
                        Text(cost(account.total, currency: account.currency, precision: 2))
                            .font(.system(.title2, design: .serif).weight(.semibold))
                            .monospacedDigit().foregroundStyle(RosettePalette.roseAccent)
                        if let granted = account.granted, let toppedUp = account.toppedUp {
                            Text("赠送 \(cost(granted, currency: account.currency, precision: 2)) · 充值 \(cost(toppedUp, currency: account.currency, precision: 2))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 5)
                }
                if let updated = data.balance.updatedAt {
                    Text((data.balance.status == "stale" ? "上次可用余额 · " : "查询于 ") + deskDate(BeijingTime.date(from: updated)))
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("等待 DeepSeek 返回余额。").font(.footnote).foregroundStyle(.secondary)
                }
                DeepSeekAlertEditor(model: model, settings: data.alerts)
            } else if model.usageError == nil {
                ProgressView("正在同步余额")
            }
            if let error = model.usageError {
                Label(error, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(RosettePalette.amber)
            }
        }
        .listRowBackground(RosettePalette.panel)

        Section("ROSETTE 用量") {
            Picker("统计范围", selection: $range) {
                ForEach(ModelUsageRange.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.menu)
            .disabled(model.alertsSaving)
            if let report = model.deepSeek?.usage, report.range.days == range.rawValue {
                if report.hasStatistics { DeepSeekReportView(report: report) }
                else { Text("所选范围的用量暂不可用。").font(.footnote).foregroundStyle(.secondary) }
            } else if model.usageError == nil {
                ProgressView("正在同步用量")
            }
        }
        .listRowBackground(RosettePalette.panel)
    }
}

private struct DeepSeekReportView: View {
    let report: DeepSeekUsageReport

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("估算费用 · 人民币").font(.caption).foregroundStyle(.secondary)
                Text(report.costCny.map { cost($0) } ?? "待计价")
                    .font(.system(.title, design: .serif).weight(.semibold))
                    .monospacedDigit().foregroundStyle(RosettePalette.roseAccent)
                Text(report.partialCost == true ? "部分记录待计价" : "按 DeepSeek 官方人民币单价估算")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(13)
            .rosetteSurface(RosettePalette.roseWash, radius: 14)
            LabeledContent("总 Token", value: report.totals.totalTokens.formatted())
            LabeledContent("直接输入 / 输出", value: "\(report.totals.input.formatted()) / \(report.totals.output.formatted())")
            LabeledContent("缓存读取 / 写入", value: "\(report.totals.cacheRead.formatted()) / \(report.totals.cacheWrite.formatted())")
            if report.daily.count > 1 {
                Chart(report.daily) { day in
                    if let tokens = day.totalTokens {
                        BarMark(x: .value("日期", day.date), y: .value("Token", tokens))
                            .foregroundStyle(RosettePalette.roseAccent.gradient)
                    }
                }
                .chartXAxis(.hidden)
                .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) }
                .frame(height: 106)
                .accessibilityLabel("每日 Token 用量")
            }
            Text("\(report.range.startDate) 至 \(report.range.endDate) · 北京时间")
                .font(.caption).foregroundStyle(.secondary)
            if report.status == "stale" || report.daily.contains(where: { $0.totalTokens == nil }) {
                Text(report.status == "stale" ? "显示上次同步的统计" : "部分日期待统计")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !report.models.isEmpty || !report.channels.isEmpty {
                DisclosureGroup("用量明细") {
                    VStack(alignment: .leading, spacing: 9) {
                        ForEach(report.models) { item in
                            let estimate = item.costCny.map { cost($0) } ?? (item.partialCost == true ? "待计价" : nil)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.id).font(.caption.weight(.medium))
                                Text([item.totalTokens.formatted() + " Token", estimate].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        ForEach(report.channels) { item in
                            LabeledContent(channelTitle(item.channel), value: item.totalTokens.formatted() + " Token")
                                .font(.caption)
                        }
                    }
                    .padding(.top, 9)
                }
            }
        }
        .font(.subheadline)
        .padding(.vertical, 6)
    }

    private func channelTitle(_ channel: String) -> String {
        switch channel {
        case "wechat", "weixin", "openclaw-weixin": "微信"
        case "qq", "qqbot": "QQ"
        case "webchat": "网页对话"
        case "other": "其他"
        default: channel
        }
    }
}

private struct DeepSeekAlertEditor: View {
    @ObservedObject var model: DeskModel
    let settings: DeepSeekAlerts
    @State private var draft: DeepSeekAlerts

    init(model: DeskModel, settings: DeepSeekAlerts) {
        self.model = model
        self.settings = settings
        _draft = State(initialValue: settings)
    }

    private var valid: Bool { [draft.cny, draft.usd].allSatisfy { (0...10_000).contains($0) } }

    var body: some View {
        DisclosureGroup(draft == settings && settings.enabled ? "低余额提醒 · 已开启" : "低余额提醒") {
            VStack(alignment: .leading, spacing: 12) {
                Toggle("达到阈值时存入提醒收件箱", isOn: $draft.enabled)
                if draft.enabled {
                    threshold("人民币阈值", value: $draft.cny)
                    threshold("美元阈值", value: $draft.usd)
                }
                Button("保存阈值") {
                    let value = DeepSeekAlerts(enabled: draft.enabled, cny: (draft.cny * 100).rounded() / 100,
                        usd: (draft.usd * 100).rounded() / 100)
                    Task { await model.saveDeepSeekAlerts(value) }
                }
                .disabled(!valid || draft == settings || !model.canEdit || model.usageLoading || model.alertsSaving)
            }
            .padding(.vertical, 8)
        }
        .onChange(of: settings) { _, next in draft = next }
    }

    private func threshold(_ title: String, value: Binding<Double>) -> some View {
        LabeledContent(title) {
            TextField(title, value: value, format: .number.precision(.fractionLength(0...2)))
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
                .accessibilityLabel(title)
        }
    }
}

private func cost(_ value: Double, currency: String = "CNY", precision: Int = 6) -> String {
    value.formatted(.currency(code: currency).locale(Locale(identifier: "zh_CN"))
        .precision(.fractionLength(2...precision)))
}
