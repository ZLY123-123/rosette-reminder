import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum APIError: LocalizedError, Sendable {
    case invalidAddress
    case sessionExpired
    case unexpectedResponse
    case server(String)

    public var errorDescription: String? {
        switch self {
        case .invalidAddress: "服务地址有误。"
        case .sessionExpired: "登录已过期，请重新登录。"
        case .unexpectedResponse: "服务返回格式有误，请稍后重试。"
        case let .server(message): message
        }
    }
}

public struct SessionCredential: Sendable {
    public static let cookieName = "reminder_session"
    public let value: String
    public let expires: Date

    public init?(_ value: String, now: Date = .now) {
        guard value.range(of: #"^\d{1,16}\.[\w-]{24}\.[\w-]{43}$"#, options: .regularExpression) != nil,
              let first = value.split(separator: ".").first,
              let time = Double(first) else { return nil }
        let expires = BeijingTime.date(from: time)
        guard expires > now else { return nil }
        self.value = value
        self.expires = expires
    }
}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

public actor ReminderAPI {
    public static let productionURL = URL(string: "https://reminder.example.invalid/")!

    private let baseURL: URL
    private let origin: String
    private let session: URLSession
    private var credential: SessionCredential?

    public init(baseURL: URL = productionURL, configuration: URLSessionConfiguration = .ephemeral) {
        self.baseURL = baseURL
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.path = ""
        components?.query = nil
        components?.fragment = nil
        origin = components?.url?.absoluteString ?? ""
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        session = URLSession(configuration: configuration, delegate: RejectRedirects(), delegateQueue: nil)
    }

    public func restoreSession(_ candidate: SessionCredential?) {
        credential = candidate
    }

    public func login(password: String) async throws -> SessionCredential {
        let (_, response) = try await call("login", method: "POST",
            payload: JSONEncoder().encode(["password": password]), authenticated: false)
        var headers: [String: String] = [:]
        for (key, value) in response.allHeaderFields {
            if let key = key as? String {
                headers[key] = String(describing: value)
            }
        }
        guard let url = response.url,
              let value = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
                .first(where: { $0.name == SessionCredential.cookieName })?.value,
              let signed = SessionCredential(value) else { throw APIError.unexpectedResponse }
        credential = signed
        return signed
    }

    public func logout() async throws {
        defer { credential = nil }
        _ = try await call("logout", method: "POST", payload: Data("{}".utf8))
    }

    public func snapshot() async throws -> DeskSnapshot {
        let (data, _) = try await call("state")
        return try decode(data)
    }

    public func openClawModels(refresh: Bool = false) async throws -> OpenClawModelSelection {
        let query = refresh ? [URLQueryItem(name: "refresh", value: "true")] : []
        let (data, _) = try await call("openclaw/models", query: query)
        return try decode(data)
    }

    public func applyOpenClawModel(_ model: String) async throws -> OpenClawModelSelection {
        let payload = try JSONEncoder().encode(["model": model])
        let (data, _) = try await call("openclaw/models", method: "PUT", payload: payload)
        return try decode(data)
    }

    public func deepSeekUsage(_ range: ModelUsageRange, refresh: Bool = false) async throws -> DeepSeekUsageSnapshot {
        var query = [URLQueryItem(name: "days", value: String(range.rawValue))]
        if refresh { query.append(URLQueryItem(name: "refresh", value: "true")) }
        let (data, _) = try await call("model-usage", query: query)
        return try decode(data)
    }

    public func saveDeepSeekAlerts(_ settings: DeepSeekAlerts) async throws -> DeepSeekAlerts {
        let payload = try JSONEncoder().encode(settings)
        let (data, _) = try await call("settings/model-alerts", method: "PUT", payload: payload)
        return try decode(data)
    }

    public func conversation(before: String? = nil) async throws -> Conversation {
        let query = before.map { [URLQueryItem(name: "before", value: $0)] } ?? []
        let (data, _) = try await call("chat", query: query)
        return try decode(data)
    }

    public func attachment(_ id: Int64) async throws -> Data {
        guard id > 0 else { throw APIError.invalidAddress }
        let (data, _) = try await call("chat/media/\(id)")
        guard data.count <= 32_000_000 else { throw APIError.unexpectedResponse }
        return data
    }

    public func saveTask(_ change: TaskChange, id: String? = nil) async throws {
        let payload = try JSONEncoder().encode(change)
        if let id {
            guard UUID(uuidString: id) != nil else { throw APIError.invalidAddress }
            _ = try await call("tasks/\(id)", method: "PATCH", payload: payload)
        } else {
            _ = try await call("tasks", method: "POST", payload: payload)
        }
    }

    public func organizeInbox(_ action: InboxAction, id: String) async throws {
        struct Change: Encodable {
            let action: InboxAction
            let id: String
        }
        let fields = try JSONEncoder().encode(Change(action: action, id: id))
        _ = try await call("inbox/organize", method: "POST", payload: fields)
    }

    public func saveDaily(time: String?, dual: Bool) async throws {
        struct Daily: Encodable {
            let time: String?
            let dual: Bool

            enum CodingKeys: String, CodingKey { case daily, dual }

            func encode(to encoder: Encoder) throws {
                var values = encoder.container(keyedBy: CodingKeys.self)
                try values.encode(time, forKey: .daily)
                try values.encode(dual, forKey: .dual)
            }
        }
        let fields = try JSONEncoder().encode(Daily(time: time, dual: dual))
        _ = try await call("settings", method: "PUT", payload: fields)
    }

    public func savePolicy(_ policy: DeliveryPolicy) async throws {
        _ = try await call("settings/delivery", method: "PUT", payload: JSONEncoder().encode(policy))
    }

    public func testDelivery(fallback: Bool = false) async throws {
        _ = try await call(fallback ? "fallback/test" : "push/test", method: "POST", payload: Data("{}".utf8))
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.unexpectedResponse }
    }

    private func call(
        _ path: String, method: String = "GET", payload: Data? = nil, query: [URLQueryItem] = [],
        authenticated: Bool = true
    ) async throws -> (Data, HTTPURLResponse) {
        let host = baseURL.host
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host ?? "")
        guard (baseURL.scheme == "https" || (baseURL.scheme == "http" && loopback)),
              host != nil, baseURL.user == nil, baseURL.password == nil, baseURL.query == nil,
              baseURL.fragment == nil, !origin.isEmpty else { throw APIError.invalidAddress }
        let endpoint = baseURL.appendingPathComponent("api").appendingPathComponent(path)
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { throw APIError.invalidAddress }
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw APIError.invalidAddress }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = payload
        if authenticated {
            guard let credential, credential.expires > .now else { throw APIError.sessionExpired }
            request.setValue("\(SessionCredential.cookieName)=\(credential.value)", forHTTPHeaderField: "Cookie")
        }
        if method != "GET" { request.setValue(origin, forHTTPHeaderField: "Origin") }
        if payload != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, result) = try await session.data(for: request)
        guard let response = result as? HTTPURLResponse else { throw APIError.unexpectedResponse }
        if authenticated && response.statusCode == 401 { throw APIError.sessionExpired }
        guard (200..<300).contains(response.statusCode) else {
            struct Failure: Decodable { let error: String }
            let detail = try? JSONDecoder().decode(Failure.self, from: data).error
            throw APIError.server(detail ?? "请求失败（\(response.statusCode)）。")
        }
        return (data, response)
    }
}
