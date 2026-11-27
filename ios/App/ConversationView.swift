import AVKit
import ImageIO
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import ReminderCore

struct ConversationView: View {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var model: DeskModel
    let isSelected: Bool
    @State private var attachment: TimelineItem?

    private var monitorsConversation: Bool { isSelected && scenePhase == .active }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if let error = model.chatError {
                        Label(error, systemImage: "exclamationmark.circle")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if model.before != nil {
                        Button("加载更早的消息", systemImage: "clock.arrow.circlepath") {
                            Task { await model.loadConversation(older: true) }
                        }
                        .disabled(model.chatBusy)
                        .frame(maxWidth: .infinity)
                    }
                    if model.messages.isEmpty {
                        if model.chatBusy { ProgressView().frame(maxWidth: .infinity) }
                        else {
                            ContentUnavailableView("对话记录暂空", systemImage: "bubble.left.and.bubble.right",
                                description: Text("从微信和 QQ 发来的消息，以及提醒投递记录，会出现在这里。"))
                        }
                    }
                    ForEach(model.messages) { item in
                        if item.isReminder { ReminderEntry(item: item) }
                        else { message(item) }
                    }
                }
                .padding()
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .safeAreaInset(edge: .top, spacing: 0) {
                if let session = model.conversationSession {
                    SessionDetails(session: session)
                        .frame(maxWidth: 690)
                        .padding(.horizontal)
                        .padding(.vertical, 5)
                        .frame(maxWidth: .infinity)
                        .background(RosettePalette.canvas.opacity(0.94))
                }
            }
            .navigationTitle("对话")
            .background { RosetteBackdrop() }
            .task(id: monitorsConversation) {
                guard monitorsConversation else { return }
                while !Task.isCancelled {
                    await model.loadConversation()
                    do { try await Task.sleep(for: .seconds(3)) }
                    catch { return }
                }
            }
            .refreshable { await model.loadConversation() }
            .onChange(of: model.messages.last?.id) { _, latest in
                if let latest { proxy.scrollTo(latest, anchor: .bottom) }
            }
            .toolbar {
                Button("同步对话", systemImage: "arrow.clockwise") {
                    Task { await model.loadConversation() }
                }
                .disabled(model.chatBusy)
            }
        }
        .sheet(item: $attachment) {
            AttachmentView(api: model.api, item: $0)
                .presentationBackground(RosettePalette.canvas)
        }
    }

    private func message(_ item: TimelineItem) -> some View {
        let inbound = item.direction == "inbound"
        return VStack(alignment: .leading, spacing: 7) {
            Text([item.channel?.title ?? "会话", inbound ? "你" : "ROSETTE", deskDate(item.date)]
                .joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
            if let origin = item.origin { OriginChip(origin: origin) }
            if !item.body.isEmpty { Text(item.body).textSelection(.enabled) }
            if let quoteState = item.quoteState {
                VStack(alignment: .leading, spacing: 3) {
                    Label("微信引用", systemImage: "quote.opening")
                        .font(.caption.weight(.medium))
                    Text(quoteState == "available" ? item.quoteBody ?? "引用原文暂缺" : "引用原文暂缺")
                        .font(.caption)
                        .textSelection(.enabled)
                }
                .foregroundStyle(.secondary)
                .padding(8)
                .background(Color.secondary.opacity(0.09), in: RoundedRectangle(cornerRadius: 8))
            }
            if item.hasMedia != 0 {
                if item.mediaMime?.hasPrefix("image/") == true, case let .message(id) = item.id {
                    ConversationPhoto(api: model.api, id: id, name: item.mediaName) { attachment = item }
                } else {
                    Button(item.mediaName ?? "查看附件", systemImage: "paperclip") { attachment = item }
                        .font(.subheadline)
                }
            }
            if !inbound, let state = item.state, state != "accepted" {
                Text(DeliveryState(state).label).font(.caption).foregroundStyle(DeliveryState(state).color)
            }
            if let stage = item.replyStage {
                ReplyDetails(item: item, stage: stage)
            }
        }
        .padding(13)
        .rosetteSurface(bubbleFill(item, inbound: inbound))
        .padding(inbound ? .leading : .trailing, 22)
        .frame(maxWidth: .infinity, alignment: inbound ? .trailing : .leading)
    }

    private func bubbleFill(_ item: TimelineItem, inbound: Bool) -> Color {
        if inbound { return RosettePalette.roseWash }
        switch item.origin {
        case .program?: return RosettePalette.amberWash
        case .ai?, .mixed?: return RosettePalette.orchidWash
        default: return RosettePalette.panel
        }
    }
}

private struct ConversationPhoto: View {
    let api: ReminderAPI
    let id: Int64
    let name: String?
    let open: () -> Void
    @State private var thumbnail: UIImage?

    var body: some View {
        Button(action: open) {
            if let thumbnail {
                Image(uiImage: thumbnail).resizable().scaledToFit()
                    .frame(maxWidth: 280, maxHeight: 240)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            } else {
                Label("查看图片", systemImage: "photo").font(.subheadline)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name ?? "查看图片")
        .task(id: id) {
            guard thumbnail == nil, let data = try? await api.attachment(id), !Task.isCancelled,
                  let source = CGImageSourceCreateWithData(data as CFData, nil) else { return }
            let options = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 600] as CFDictionary
            if let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) { thumbnail = UIImage(cgImage: image) }
        }
    }
}

private struct OriginChip: View {
    let origin: ConversationOrigin

    private var appearance: (icon: String, color: Color) {
        switch origin {
        case .program: ("gearshape", RosettePalette.amber)
        case .ai, .mixed: ("sparkles", RosettePalette.orchid)
        case .unknown: ("questionmark.circle", .secondary)
        }
    }

    var body: some View {
        Label(origin.title, systemImage: appearance.icon)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(appearance.color)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(appearance.color.opacity(0.09), in: Capsule())
    }
}

private struct ReplyDetails: View {
    let item: TimelineItem
    let stage: String

    private var summary: (label: String, color: Color) {
        switch stage {
        case "received": ("网关已收到", .secondary)
        case "processing": ("处理中", .accentColor)
        case "sending": ("发送回复中", .accentColor)
        case "accepted": ("回复已受理", .green)
        case "acknowledged": ("已发异常回执", .orange)
        case "clarified": ("已发追问", .secondary)
        case "rejected": ("微信拒收", .red)
        case "unknown": ("结果待核对", .orange)
        case "finished": ("处理结束", .secondary)
        default: (stage, .secondary)
        }
    }

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 9) {
                step("OpenClaw 网关收到微信消息", result: "已收到", at: item.replyReceivedAt ?? item.at)
                if let quoteState = item.quoteState {
                    step("核对引用", result: quoteState == "available" ? "已读取正文" : "原文暂缺")
                }
                ForEach(Array((item.replySteps ?? []).enumerated()), id: \.offset) { _, event in
                    step(event.label, result: stepState(event.state), at: event.at,
                        elapsed: event.details?.durationMs ?? event.elapsedMilliseconds,
                        color: event.state == "failed" ? RosettePalette.amber : .secondary, details: event.details)
                }
                if let finishedAt = item.replyFinishedAt {
                    step("回复结果", result: summary.label, at: finishedAt, color: summary.color)
                }
                if item.inbox == 1 { step("保存到网页收件箱", result: "已保存") }
                fallback(.qq, state: item.qq)
                fallback(.push, state: item.push)
            }
            .padding(.top, 8)
        } label: {
            Label("处理详情 · " + summary.label, systemImage: "list.bullet.rectangle")
                .font(.caption.weight(.medium))
                .foregroundStyle(summary.color)
        }
        .padding(.top, 3)
    }

    private func stepState(_ state: String) -> String {
        switch state {
        case "running": "进行中"
        case "done": "已完成"
        case "failed": "异常"
        default: state
        }
    }

    @ViewBuilder
    private func fallback(_ channel: Channel, state: String?) -> some View {
        if let state, !["skipped", "inbox_only"].contains(state) {
            let result = DeliveryState(state)
            step(channel.title + "备用投递", result: result.label, color: result.color)
        }
    }

    private func step(
        _ title: String, result: String, at: Double? = nil, elapsed: Int? = nil, color: Color = .secondary,
        details: ConversationStepDetails? = nil
    ) -> some View {
        let timestamp = at.map {
            BeijingTime.date(from: $0).formatted(
                Date.FormatStyle(date: .omitted, time: .standard, locale: Locale(identifier: "zh_CN"),
                    timeZone: BeijingTime.zone))
        }
        let duration = elapsed.map {
            $0 < 1000 ? "\($0) ms" : (Double($0) / 1000).formatted(.number.precision(.fractionLength(1))) + " 秒"
        }
        return VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption.weight(.medium))
            Text([timestamp, result, duration].compactMap { $0 }.joined(separator: " · "))
                .font(.caption2)
                .foregroundStyle(color)
            if let details {
                if let provider = details.provider, let model = details.model {
                    Text("\(RosettePalette.providerName(provider)) · \(model)")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if let usage = details.usage {
                    let parts = [tokens("输入", usage.input), tokens("输出", usage.output),
                        tokens("缓存读取", usage.cacheRead), tokens("缓存写入", usage.cacheWrite), tokens("合计", usage.total)]
                    Text(parts.compactMap { $0 }.joined(separator: " · "))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if let issue = details.errorCategory {
                    Text(issue).font(.caption2).foregroundStyle(RosettePalette.amber)
                }
            }
        }
        .textSelection(.enabled)
    }

    private func tokens(_ name: String, _ value: Int?) -> String? {
        value.map { name + " " + $0.formatted() }
    }
}

private struct SessionDetails: View {
    let session: ConversationSession

    var body: some View {
        DisclosureGroup {
            VStack(spacing: 10) {
                LabeledContent("智能体", value: session.agentId)
                LabeledContent("会话键", value: session.sessionKey)
                if !session.sessionId.isEmpty { LabeledContent("会话 ID", value: session.sessionId) }
                if let lastUsed = session.lastUsed, lastUsed != session.model {
                    LabeledContent("最近实际使用", value: lastUsed)
                }
                if let start = session.startedAt {
                    LabeledContent("会话开始", value: deskDate(BeijingTime.date(from: start)))
                }
                if let last = session.lastInteractionAt {
                    LabeledContent("最近活动", value: deskDate(BeijingTime.date(from: last)))
                }
                if let total = session.contextTokens {
                    let tokens = session.lastContextTokens.map { $0.formatted() + " / " } ?? ""
                    LabeledContent("上下文", value: tokens + total.formatted() + " tokens")
                }
            }
            .font(.footnote)
            .textSelection(.enabled)
            .padding(.top, 7)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Label(session.label, systemImage: "person.crop.circle")
                    .font(.subheadline.weight(.semibold))
                Text(session.model ?? "等待同步模型").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .rosetteSurface(radius: 14)
    }
}

struct DeliveryState {
    let label: String
    let color: Color

    init(_ raw: String?) {
        switch raw {
        case "accepted", "sent": (label, color) = ("已受理", .green)
        case "rejected": (label, color) = ("已拒收", .red)
        case "failed": (label, color) = ("发送失败", .red)
        case "unknown", "uncertain": (label, color) = ("结果待确认", .orange)
        case "retry": (label, color) = ("等待重试", .orange)
        case "requested", "sending": (label, color) = ("投递中", .secondary)
        case "pending": (label, color) = ("等待投递", .secondary)
        case "expired": (label, color) = ("已超时", .orange)
        case "unavailable", "disabled", "unconfigured": (label, color) = ("渠道暂不可用", .secondary)
        case "cancelled": (label, color) = ("已取消", .secondary)
        case "inbox_only": (label, color) = ("已存网页", .secondary)
        case "partial": (label, color) = ("部分受理", .green)
        case "skipped", nil: (label, color) = ("已跳过", .secondary)
        default: (label, color) = (raw ?? "", .secondary)
        }
    }
}

struct DeliveryLines: View {
    let wechat: String?
    let qq: String?
    let push: String?

    var body: some View {
        VStack(spacing: 5) {
            line(.wechat, state: wechat)
            line(.qq, state: qq)
            line(.push, state: push)
        }
        .font(.caption)
    }

    private func line(_ channel: Channel, state: String?) -> some View {
        let status = DeliveryState(state)
        return LabeledContent(channel.title) {
            Text(status.label).foregroundStyle(status.color)
        }
    }
}

private struct ReminderEntry: View {
    let item: TimelineItem

    private var hasFailure: Bool {
        let statuses: [String?] = [item.wechat, item.qq, item.push]
        return statuses.contains("rejected") || statuses.contains("failed")
    }

    var body: some View {
        let accent = hasFailure ? RosettePalette.amber : RosettePalette.roseAccent
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Label("定时提醒", systemImage: hasFailure ? "bell.badge" : "bell")
                    .font(.caption.weight(.semibold)).foregroundStyle(accent)
                OriginChip(origin: .program)
            }
            Text(deskDate(item.date)).font(.caption).foregroundStyle(.secondary)
            if let title = item.title, !title.isEmpty { Text(title).font(.headline) }
            if item.body != item.title {
                Text(item.body).font(.subheadline).textSelection(.enabled)
            }
            Divider()
            DeliveryLines(wechat: item.wechat, qq: item.qq, push: item.push)
            if item.inbox == 1 && item.push != "inbox_only" {
                Label("已存网页收件箱", systemImage: "tray")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let detail = item.detail, !detail.isEmpty {
                Text(detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if let detail = item.qqDetail, !detail.isEmpty {
                Text("QQ · " + detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(15)
        .rosetteSurface(hasFailure ? RosettePalette.amberWash : RosettePalette.panel, radius: 15)
    }
}

private struct AttachmentView: View {
    @Environment(\.dismiss) private var dismiss
    let api: ReminderAPI
    let item: TimelineItem
    @State private var file: URL?
    @State private var image: UIImage?
    @State private var player: AVPlayer?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let image {
                    ScrollView { Image(uiImage: image).resizable().scaledToFit().padding() }
                } else if let player, item.mediaMime?.hasPrefix("video/") == true {
                    VideoPlayer(player: player)
                } else if let player {
                    Button("播放音频", systemImage: "play.circle") { player.seek(to: .zero); player.play() }
                } else if let file {
                    ShareLink(item: file) { Label("打开或分享附件", systemImage: "square.and.arrow.up") }
                } else if let error {
                    ContentUnavailableView("附件暂不可用", systemImage: "paperclip",
                        description: Text(error))
                } else {
                    ProgressView("正在读取附件")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background { RosetteBackdrop() }
            .navigationTitle(item.mediaName ?? "附件")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
                if let file { ToolbarItem(placement: .primaryAction) { ShareLink(item: file) } }
            }
        }
        .task { await load() }
        .onDisappear {
            player?.pause()
            if let file { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        }
    }

    private func load() async {
        guard case let .message(id) = item.id else { return }
        do {
            let data = try await api.attachment(id)
            try Task.checkCancellation()
            if item.mediaMime?.hasPrefix("image/") == true, let parsed = UIImage(data: data) {
                image = parsed
                return
            }
            let name = URL(fileURLWithPath: item.mediaName ?? "附件").lastPathComponent
            let ext = item.mediaMime.flatMap { UTType(mimeType: $0)?.preferredFilenameExtension }
            let safeName = name.isEmpty || [".", "..", "/"].contains(name) ? "附件" : name
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var url = directory.appendingPathComponent(safeName)
            if url.pathExtension.isEmpty, let ext { url.appendPathExtension(ext) }
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            file = url
            if let mime = item.mediaMime, mime.hasPrefix("audio/") || mime.hasPrefix("video/") {
                player = AVPlayer(url: url)
            }
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }
}
