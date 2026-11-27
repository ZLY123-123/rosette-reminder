import Foundation

public struct OpenClawModelChoice: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let recommended: Bool?

    public var provider: String { id.split(separator: "/", maxSplits: 1).first.map { $0.lowercased() } ?? "" }
}

public struct OpenClawModelSelection: Codable, Equatable, Sendable {
    public let current: String?
    public let provider: String?
    public let configuredModel: String?
    public let pinned: Bool?
    public let sessionPending: Bool?
    public let status: String
    public let choices: [OpenClawModelChoice]

    public var isDeepSeek: Bool { provider?.lowercased() == "deepseek" }
    public var currentName: String? { choices.first { $0.id == current }?.name ?? current }
    public var providers: [String] { Set(choices.map(\.provider).filter { !$0.isEmpty }).sorted() }
}

public enum ModelUsageRange: Int, CaseIterable, Hashable, Identifiable, Sendable {
    case today = 1, week = 7, month = 30, quarter = 90

    public var id: Int { rawValue }
    public var title: String { self == .today ? "今天" : "近 \(rawValue) 天" }
}

public struct DeepSeekAlerts: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var cny: Double
    public var usd: Double

    enum CodingKeys: String, CodingKey { case enabled, cny = "CNY", usd = "USD" }

    public init(enabled: Bool, cny: Double, usd: Double) {
        self.enabled = enabled
        self.cny = cny
        self.usd = usd
    }
}

public struct DeepSeekAccount: Decodable, Identifiable, Sendable {
    public let currency: String
    public let total: Double
    public let granted: Double?
    public let toppedUp: Double?
    public let low: Bool

    public var id: String { currency }
}

public struct DeepSeekBalance: Decodable, Sendable {
    public let status: String
    public let updatedAt: Double?
    public let accounts: [DeepSeekAccount]
}

public struct ModelTokenTotals: Decodable, Sendable {
    public let input: Int
    public let output: Int
    public let cacheRead: Int
    public let cacheWrite: Int
    public let totalTokens: Int
}

public struct DailyModelUsage: Decodable, Identifiable, Sendable {
    public let date: String
    public let totalTokens: Int?

    public var id: String { date }
}

public struct ModelUsageByModel: Decodable, Identifiable, Sendable {
    public let provider: String
    public let model: String
    public let totalTokens: Int
    public let costCny: Double?
    public let partialCost: Bool?

    public var id: String { "\(provider)/\(model)" }
}

public struct ModelUsageByChannel: Decodable, Identifiable, Sendable {
    public let channel: String
    public let totalTokens: Int

    public var id: String { channel }
}

public struct DeepSeekUsageReport: Decodable, Sendable {
    public struct Range: Decodable, Sendable {
        public let startDate: String
        public let endDate: String
        public let days: Int
    }

    public let status: String
    public let updatedAt: Double?
    public let range: Range
    public let daily: [DailyModelUsage]
    public let totals: ModelTokenTotals
    public let costCny: Double?
    public let partialCost: Bool?
    public let models: [ModelUsageByModel]
    public let channels: [ModelUsageByChannel]

    public var hasStatistics: Bool { updatedAt != nil && daily.contains { $0.totalTokens != nil } }
}

public struct DeepSeekUsageSnapshot: Decodable, Sendable {
    public let balance: DeepSeekBalance
    public let usage: DeepSeekUsageReport
    public var alerts: DeepSeekAlerts
}
