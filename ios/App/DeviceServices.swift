import Foundation
import Security
import UserNotifications
import ReminderCore

enum DeviceSession {
    private static var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Bundle.main.bundleIdentifier ?? "com.reminderdesk.ios",
            kSecAttrAccount as String: "workbench-session"
        ]
    }

    static func load() -> SessionCredential? {
        var query = Self.query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess,
              let data = value as? Data, let token = String(data: data, encoding: .utf8) else { return nil }
        return SessionCredential(token)
    }

    static func save(_ credential: SessionCredential) throws {
        let data = Data(credential.value.utf8)
        let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw APIError.server("钥匙串暂时无法保存会话。") }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
            throw APIError.server("钥匙串暂时无法保存会话。")
        }
    }

    static func clear() {
        SecItemDelete(query as CFDictionary)
    }
}

enum DeviceCache {
    struct State: Codable {
        let snapshot: DeskSnapshot
        let syncedAt: Date
    }

    private static var directory: URL {
        URL.applicationSupportDirectory.appendingPathComponent("ReminderCache", isDirectory: true)
    }

    static func read<T: Decodable>(_ name: String, as _: T.Type) -> T? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(name)) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    static func write<T: Encodable>(_ value: T, name: String) {
        do {
            var directory = Self.directory
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var resources = URLResourceValues()
            resources.isExcludedFromBackup = true
            try directory.setResourceValues(resources)
            try JSONEncoder().encode(value).write(to: directory.appendingPathComponent(name),
                options: [.atomic, .completeFileProtection])
        } catch {
            // A usable server session does not depend on the optional offline cache.
        }
    }

    static func clear() {
        try? FileManager.default.removeItem(at: directory)
    }
}

enum DeviceNotifications {
    private static let prefix = "reminder.task."

    static func requestPermission() async throws -> Bool {
        try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
    }

    static func allowed() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return settings.alertSetting == .enabled ||
            settings.notificationCenterSetting == .enabled || settings.lockScreenSetting == .enabled
    }

    static func badgesAllowed() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return settings.badgeSetting == .enabled
    }

    static func reconcile(tasks: [ReminderTask]) async throws -> Int {
        guard await allowed() else { return 0 }
        let occurrences = LocalSchedule.occurrences(from: tasks, now: .now)
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests()
        let existing = Set(pending.map(\.identifier).filter { $0.hasPrefix(prefix) })
        let desired = Set(occurrences.map(\.id))
        center.removePendingNotificationRequests(withIdentifiers: Array(existing.subtracting(desired)))
        for occurrence in occurrences where !existing.contains(occurrence.id) {
            let content = UNMutableNotificationContent()
            content.title = "ROSETTE 提醒"
            content.body = occurrence.title
            content.sound = .default
            content.userInfo = ["taskID": occurrence.taskID]
            let parts = BeijingTime.calendar.dateComponents(
                [.timeZone, .year, .month, .day, .hour, .minute, .second], from: occurrence.date
            )
            let trigger = UNCalendarNotificationTrigger(dateMatching: parts, repeats: false)
            try await center.add(UNNotificationRequest(identifier: occurrence.id, content: content, trigger: trigger))
        }
        return occurrences.count
    }

    static func clear() async {
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests()
        center.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier).filter { $0.hasPrefix(prefix) })
        let delivered = await center.deliveredNotifications()
        center.removeDeliveredNotifications(withIdentifiers: delivered.map(\.request.identifier).filter { $0.hasPrefix(prefix) })
    }

    static func badge(_ count: Int) async {
        try? await UNUserNotificationCenter.current().setBadgeCount(count)
    }
}
