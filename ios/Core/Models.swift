import Foundation

public enum Recurrence: String, Codable, CaseIterable, Identifiable, Sendable {
    case once, daily, weekly

    public var id: Self { self }

    public var title: String {
        switch self {
        case .once: "单次"
        case .daily: "每天"
        case .weekly: "每周"
        }
    }

    var intervalInDays: Int? {
        switch self {
        case .once: nil
        case .daily: 1
        case .weekly: 7
        }
    }
}

public enum BeijingTime {
    public static let zone = TimeZone(identifier: "Asia/Shanghai") ?? TimeZone(secondsFromGMT: 28800)!

    public static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }

    public static func date(from milliseconds: Double) -> Date {
        Date(timeIntervalSince1970: milliseconds / 1000)
    }

    public static func day(_ date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    public static func parseDay(_ day: String) -> Date? {
        let fields = day.split(separator: "-").compactMap { Int($0) }
        guard fields.count == 3, let date = calendar.date(from: DateComponents(
            year: fields[0], month: fields[1], day: fields[2]
        )), self.day(date) == day else { return nil }
        return date
    }

    public static func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = zone
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
}

public struct ReminderTask: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let dueAt: Double?
    public let dual: Int
    public let completed: Int
    public let version: Int
    public let recurrence: Recurrence
    public let repeatUntil: String?
    public let archivedAt: Double?

    private enum CodingKeys: String, CodingKey {
        case id, title, dueAt, dual, completed, version, repeatUntil, archivedAt
        case recurrence = "repeat"
    }

    public var dueDate: Date? { dueAt.map(BeijingTime.date(from:)) }
    public var isCompleted: Bool { completed != 0 }
    public var isImportant: Bool { dual != 0 }
    public var isArchived: Bool { archivedAt != nil }
}

public struct TaskChange: Encodable, Sendable {
    public var title: String?
    public var dueDate: Date?
    public var includesDueDate = false
    public var recurrence: Recurrence?
    public var repeatUntil: String?
    public var includesRepeatUntil = false
    public var dual: Bool?
    public var completed: Bool?
    public var archived: Bool?

    public init() {}

    private enum CodingKeys: String, CodingKey {
        case title, dueAt, repeatUntil, dual, completed, archived
        case recurrence = "repeat"
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(title, forKey: .title)
        if includesDueDate { try values.encode(dueDate.map(BeijingTime.iso8601), forKey: .dueAt) }
        try values.encodeIfPresent(recurrence, forKey: .recurrence)
        if includesRepeatUntil { try values.encode(repeatUntil, forKey: .repeatUntil) }
        try values.encodeIfPresent(dual, forKey: .dual)
        try values.encodeIfPresent(completed, forKey: .completed)
        try values.encodeIfPresent(archived, forKey: .archived)
    }
}

public struct InboxItem: Codable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let body: String
    public let createdAt: Double
    public let read: Int

    public var isRead: Bool { read != 0 }
    public var date: Date { BeijingTime.date(from: createdAt) }
}

public enum InboxAction: String, Encodable, Sendable {
    case read, unread, archive, restore
}

public enum Channel: String, CaseIterable, Codable, Identifiable, Sendable {
    case wechat, qq, push

    public var id: Self { self }

    public var title: String {
        switch self {
        case .wechat: "微信"
        case .qq: "QQ"
        case .push: "网页通知"
        }
    }
}

public enum FallbackMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case unaccepted, rejected

    public var id: Self { self }
    public var title: String { self == .unaccepted ? "全部未获受理" : "仅明确失败" }
}

public struct DeliveryPolicy: Codable, Equatable, Sendable {
    public var levels: [[Channel]]
    public var fallback: FallbackMode

    public init(levels: [[Channel]], fallback: FallbackMode) {
        self.levels = levels
        self.fallback = fallback
    }
}

public struct DeskSettings: Codable, Sendable {
    public let daily: String?
    public let dual: Int
    public let policy: DeliveryPolicy
}

public struct Badge: Codable, Sendable {
    public let count: Int
    public let revision: Int
}

public struct DeliveryRecord: Codable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let preview: String?
    public let dueAt: Double
    public let wechat: String?
    public let qq: String?
    public let push: String?
    public let detail: String?
    public let qqDetail: String?
}

public struct DeskSnapshot: Codable, Sendable {
    public let tasks: [ReminderTask]
    public let archivedTasks: [ReminderTask]
    public let inbox: [InboxItem]
    public let archivedInbox: [InboxItem]
    public let history: [DeliveryRecord]
    public let badge: Badge
    public let settings: DeskSettings
    public let wechatConfigured: Bool
    public let wechatActivity: WeChatActivity?
    public let qqConfigured: Bool
    public let subscriptions: Int
}

public struct WeChatActivity: Codable, Equatable, Sendable {
    public let lastInboundAt: Double?
    public let lastOutboundAt: Double?
    public let silentForMs: Double?
    public let accepted: Int?
    public let deferred: Bool?

    public func silence(at now: Date) -> String? {
        let elapsed = lastInboundAt.map { now.timeIntervalSince(BeijingTime.date(from: $0)) }
            ?? silentForMs.map { $0 / 1000 }
        guard let elapsed, elapsed.isFinite else { return nil }
        let minutes = Int(max(0, elapsed) / 60)
        if minutes < 1 { return "不到 1 分钟" }
        let days = minutes / 1_440
        let hours = minutes % 1_440 / 60
        if days > 0 { return "\(days) 天 \(hours) 小时" }
        if hours > 0 { return "\(hours) 小时 \(minutes % 60) 分钟" }
        return "\(minutes) 分钟"
    }
}

public struct ConversationSession: Codable, Equatable, Sendable {
    public let label: String
    public let agentId: String
    public let sessionKey: String
    public let sessionId: String
    public let model: String?
    public let modelSource: String?
    public let lastUsed: String?
    public let startedAt: Double?
    public let lastInteractionAt: Double?
    public let contextTokens: Int?
    public let lastContextTokens: Int?
}

public enum TimelineID: Codable, Hashable, Sendable {
    case message(Int64)
    case reminder(String)

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let number = try? value.decode(Int64.self) { self = .message(number) }
        else { self = .reminder(try value.decode(String.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case let .message(number): try value.encode(number)
        case let .reminder(id): try value.encode(id)
        }
    }
}

public struct ConversationStep: Codable, Equatable, Sendable {
    public let label: String
    public let state: String
    public let at: Double
    public let updatedAt: Double
    public let details: ConversationStepDetails?

    public var elapsedMilliseconds: Int? {
        guard state != "running", updatedAt >= at else { return nil }
        return Int(updatedAt - at)
    }
}

public struct ConversationStepDetails: Codable, Equatable, Sendable {
    public struct Tokens: Codable, Equatable, Sendable {
        public let input: Int?
        public let output: Int?
        public let cacheRead: Int?
        public let cacheWrite: Int?
        public let total: Int?
    }

    public let kind: String
    public let provider: String?
    public let model: String?
    public let durationMs: Int?
    public let errorCategory: String?
    public let usage: Tokens?
}

public enum ConversationOrigin: Sendable {
    case program, ai, mixed, unknown

    public var title: String {
        switch self {
        case .program: "程序发送"
        case .ai: "AI 生成"
        case .mixed: "AI 生成 · 含程序补报"
        case .unknown: "来源未记录"
        }
    }
}

public struct TimelineItem: Codable, Equatable, Identifiable, Sendable {
    public let id: TimelineID
    public let kind: String?
    public let body: String
    public let at: Double
    public let direction: String?
    public let contentOrigin: String?
    public let channel: Channel?
    public let state: String?
    public let title: String?
    public let wechat: String?
    public let qq: String?
    public let push: String?
    public let detail: String?
    public let qqDetail: String?
    public let inbox: Int?
    public let quoteState: String?
    public let quoteBody: String?
    public let replyStage: String?
    public let replyReceivedAt: Double?
    public let replyFinishedAt: Double?
    public let replySteps: [ConversationStep]?
    public let hasMedia: Int
    public let mediaMime: String?
    public let mediaName: String?

    public var isReminder: Bool { kind == "reminder" }
    public var date: Date { BeijingTime.date(from: at) }
    public var origin: ConversationOrigin? {
        if isReminder { return .program }
        guard direction == "outbound" else { return nil }
        switch contentOrigin {
        case "program": return .program
        case "ai": return .ai
        case "mixed": return .mixed
        default: return .unknown
        }
    }
}

public struct Conversation: Codable, Equatable, Sendable {
    public let messages: [TimelineItem]
    public let before: String?
    public let session: ConversationSession?

    public init(messages: [TimelineItem], before: String?, session: ConversationSession?) {
        self.messages = messages
        self.before = before
        self.session = session
    }

    public func merging(with page: Conversation, older: Bool) -> Conversation {
        let retained: [TimelineItem]
        if older {
            retained = messages
        } else if let first = page.messages.first {
            retained = messages.filter { Self.precedes($0, first) }
        } else {
            retained = []
        }
        var byID = Dictionary(retained.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        for message in page.messages { byID[message.id] = message }
        return Conversation(messages: byID.values.sorted(by: Self.precedes),
            before: older || retained.isEmpty ? page.before : before, session: page.session)
    }

    private static func precedes(_ left: TimelineItem, _ right: TimelineItem) -> Bool {
        if left.at != right.at { return left.at < right.at }
        switch (left.id, right.id) {
        case let (.message(a), .message(b)): return a < b
        case (.message, .reminder): return true
        case (.reminder, .message): return false
        case let (.reminder(a), .reminder(b)): return a < b
        }
    }
}
