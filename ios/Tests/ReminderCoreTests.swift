import Foundation
import XCTest
@testable import ReminderCore

final class ReminderCoreTests: XCTestCase {
    private func date(_ value: String) throws -> Date {
        try XCTUnwrap(ISO8601DateFormatter().date(from: value))
    }

    private func task(
        _ id: String, _ due: Date, recurrence: Recurrence = .once, end: String? = nil,
        completed: Bool = false, archived: Bool = false, version: Int = 1
    ) throws -> ReminderTask {
        var fields: [String: Any] = [
            "id": id, "title": id, "dueAt": due.timeIntervalSince1970 * 1000, "dual": 0,
            "completed": completed ? 1 : 0, "version": version, "repeat": recurrence.rawValue
        ]
        if let end { fields["repeatUntil"] = end }
        if archived { fields["archivedAt"] = 1 }
        return try JSONDecoder().decode(ReminderTask.self, from: JSONSerialization.data(withJSONObject: fields))
    }

    func testLocalScheduleFinishesOnInclusiveBeijingDay() throws {
        let due = try date("2054-11-20T22:00:00+08:00")
        let now = try date("2054-11-27T22:30:00+08:00")
        let items = try [
            task("daily", due, recurrence: .daily, end: "2054-11-30"),
            task("expired", due),
            task("archived", due, recurrence: .daily, archived: true),
            task("completed", due, recurrence: .daily, completed: true)
        ]
        let dates = LocalSchedule.occurrences(from: items, now: now).map(\.date)
        XCTAssertEqual(dates.map(BeijingTime.iso8601), [
            "2054-11-28T22:00:00+08:00", "2054-11-29T22:00:00+08:00", "2054-11-30T22:00:00+08:00"
        ])
    }

    func testLocalSchedulePrioritizesNearestAndReplacesEditedOccurrences() throws {
        let due = try date("2054-11-20T22:00:00+08:00")
        let now = try date("2054-11-21T08:00:00+08:00")
        let tasks = try (0..<20).map { try task("task-\($0)", due, recurrence: .daily) }
        let occurrences = LocalSchedule.occurrences(from: tasks, now: now)
        XCTAssertEqual(occurrences.count, 60)
        XCTAssertEqual(occurrences.first?.date, try date("2054-11-21T22:00:00+08:00"))
        XCTAssertEqual(occurrences.last?.date, try date("2054-11-23T22:00:00+08:00"))
        let weekly = try task("weekly", due, recurrence: .weekly, version: 2)
        let first = try XCTUnwrap(LocalSchedule.occurrences(from: [weekly], now: now).first)
        XCTAssertEqual(first.date, try date("2054-11-27T22:00:00+08:00"))
        let updated = try task("weekly", due, recurrence: .weekly, version: 3)
        XCTAssertNotEqual(first.id, LocalSchedule.occurrences(from: [updated], now: now).first?.id)
    }

    func testPatchDistinguishesPreservingAndClearingDates() throws {
        var change = TaskChange()
        change.title = "改名"
        let encoder = JSONEncoder()
        let initial = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(change)) as? [String: Any])
        XCTAssertEqual(initial["title"] as? String, "改名")
        XCTAssertNil(initial["dueAt"])
        change.includesDueDate = true
        change.includesRepeatUntil = true
        let cleared = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(change)) as? [String: Any])
        XCTAssertTrue(cleared["dueAt"] is NSNull)
        XCTAssertTrue(cleared["repeatUntil"] is NSNull)
    }

    func testTimelineDistinguishesReminderAndMessageIdentifiers() throws {
        let data = Data("""
            {"messages":[
              {"kind":"message","id":8,"hasMedia":1,"body":"帮我设个提醒","at":7,"direction":"inbound","channel":"wechat"},
              {"kind":"reminder","id":"r:task:2","hasMedia":0,"body":"巡检时间到了","at":8,"wechat":"rejected","push":"accepted"}
            ],"before":"7:m:00000000000000000008"}
            """.utf8)
        let decoded = try JSONDecoder().decode(Conversation.self, from: data)
        XCTAssertEqual(decoded.messages.map(\.id), [.message(8), .reminder("r:task:2")])
        XCTAssertEqual(decoded.messages.last?.wechat, "rejected")
        XCTAssertEqual(decoded.messages.last?.body, "巡检时间到了")
        XCTAssertEqual(decoded.messages.last?.origin?.title, "程序发送")
        XCTAssertNil(decoded.messages.first?.origin)
        let cached = try JSONDecoder().decode(Conversation.self, from: JSONEncoder().encode(decoded))
        XCTAssertEqual(cached.messages.map(\.id), decoded.messages.map(\.id))
        XCTAssertNil(decoded.messages.first?.replySteps)
    }

    func testConversationRefreshMergesStepsAndPreservesOlderPage() throws {
        let decoder = JSONDecoder()
        let current = try decoder.decode(Conversation.self, from: Data("""
            {"messages":[
              {"id":1,"hasMedia":0,"body":"更早的消息","at":6},
              {"id":2,"hasMedia":0,"body":"已完成","at":7,"replyStage":"processing"}
            ],"before":"6:m:00000000000000000001"}
            """.utf8))
        let latest = try decoder.decode(Conversation.self, from: Data("""
            {"messages":[
              {"id":2,"hasMedia":0,"body":"已完成","at":7,"quoteState":"available","quoteBody":"提交材料",
               "replyStage":"rejected","replyReceivedAt":7,"replyFinishedAt":3100,"inbox":1,"push":"accepted",
               "replySteps":[
                 {"label":"DeepSeek · deepseek-flash","state":"done","at":8,"updatedAt":3008},
                 {"label":"发送回复","state":"failed","at":3008,"updatedAt":3100}
               ]},
              {"id":"r:later","hasMedia":0,"body":"备用提醒","at":3100,"kind":"reminder"}
            ],"before":"7:m:00000000000000000002"}
            """.utf8))
        let merged = current.merging(with: latest, older: false)
        XCTAssertEqual(merged.messages.map(\.id), [.message(1), .message(2), .reminder("r:later")])
        XCTAssertEqual(merged.before, current.before)
        let inbound = merged.messages[1]
        XCTAssertEqual(inbound.quoteBody, "提交材料")
        XCTAssertEqual(inbound.replyStage, "rejected")
        XCTAssertEqual(inbound.replySteps?.first?.elapsedMilliseconds, 3000)
        XCTAssertEqual(inbound.inbox, 1)
        XCTAssertEqual(try decoder.decode(Conversation.self, from: JSONEncoder().encode(merged)), merged)
    }

    func testUnknownOriginsAndSilentDurationUseAvailableEvidence() throws {
        let decoder = JSONDecoder()
        let chat = try decoder.decode(Conversation.self, from: Data("""
          {"messages":[
            {"id":1,"hasMedia":0,"body":"旧回复","at":1,"direction":"outbound"},
            {"id":2,"hasMedia":0,"body":"回复和补报","at":2,"direction":"outbound","contentOrigin":"mixed"}
          ]}
          """.utf8))
        XCTAssertEqual(chat.messages.first?.origin?.title, "来源未记录")
        XCTAssertEqual(chat.messages.last?.origin?.title, "AI 生成 · 含程序补报")
        let activity = try decoder.decode(WeChatActivity.self, from: Data("""
          {"lastInboundAt":1000000,"accepted":9,"deferred":true}
          """.utf8))
        XCTAssertEqual(activity.silence(at: Date(timeIntervalSince1970: 1000 + 43_260)), "12 小时 1 分钟")
        XCTAssertEqual(activity.accepted, 9)
        XCTAssertEqual(activity.deferred, true)
    }

    func testAuthenticatedServerContract() async throws {
        guard let origin = ProcessInfo.processInfo.environment["REMINDER_TEST_ORIGIN"],
              let address = URL(string: origin), address.scheme == "http", address.host == "127.0.0.1"
        else { throw XCTSkip("Run with the local Reminder API fixture.") }
        let api = ReminderAPI(baseURL: address)
        let credential = try await api.login(password: "reminder-ios-test")
        XCTAssertGreaterThan(credential.expires, .now)
        var change = TaskChange()
        change.title = "设备巡检"
        change.includesDueDate = true
        let due = Date().addingTimeInterval(3600)
        change.dueDate = due
        change.recurrence = .daily
        change.includesRepeatUntil = true
        change.repeatUntil = BeijingTime.day(due.addingTimeInterval(86_400))
        try await api.saveTask(change)
        let created = try await api.snapshot()
        let task = try XCTUnwrap(created.tasks.first { $0.title == "设备巡检" })
        XCTAssertEqual(task.recurrence, .daily)
        XCTAssertEqual(task.repeatUntil, change.repeatUntil)
        change = TaskChange()
        change.title = "设备巡检 · 更新"
        try await api.saveTask(change, id: task.id)
        try await api.saveDaily(time: "21:30", dual: false)
        try await api.savePolicy(DeliveryPolicy(levels: [[.wechat], [.qq, .push]], fallback: .rejected))
        let chat = try await api.conversation()
        XCTAssertTrue(chat.messages.contains { $0.channel == .wechat && $0.direction == "inbound" })
        let inbound = try XCTUnwrap(chat.messages.first { $0.direction == "inbound" })
        XCTAssertEqual(inbound.quoteBody, "提交材料")
        XCTAssertEqual(inbound.replyStage, "accepted")
        XCTAssertEqual(inbound.replySteps?.first?.label, "请求模型 · DeepSeek")
        XCTAssertEqual(inbound.replySteps?.first?.details?.durationMs, 1700)
        XCTAssertTrue(chat.messages.contains { $0.direction == "outbound" && $0.origin?.title == "AI 生成" })
        XCTAssertTrue(chat.messages.contains { $0.isReminder && $0.wechat == "rejected" })
        XCTAssertEqual(chat.session?.model, "deepseek/deepseek-flash")
        let updated = try await api.snapshot()
        XCTAssertEqual(updated.tasks.first(where: { $0.id == task.id })?.repeatUntil, task.repeatUntil)
        XCTAssertEqual(updated.settings.daily, "21:30")
        XCTAssertEqual(updated.settings.policy.levels, [[.wechat], [.qq, .push]])
        XCTAssertNotNil(updated.wechatActivity?.lastInboundAt)
        XCTAssertGreaterThan(updated.badge.count, 0)
        try await api.organizeInbox(.archive, id: "all")
        let archived = try await api.snapshot()
        XCTAssertTrue(archived.inbox.isEmpty)
        XCTAssertGreaterThan(archived.archivedInbox.count, 0)
        XCTAssertEqual(archived.badge.count, 0)
        try await api.organizeInbox(.restore, id: "latest")
        let restored = try await api.snapshot()
        XCTAssertEqual(restored.inbox.map(\.id), updated.inbox.map(\.id))
        let models = try await api.openClawModels(refresh: true)
        XCTAssertTrue(models.isDeepSeek)
        XCTAssertEqual(models.providers, ["deepseek", "openrouter"])
        let report = try await api.deepSeekUsage(.today)
        XCTAssertEqual(report.usage.costCny, 0.000129)
        XCTAssertEqual(report.balance.accounts.first?.currency, "CNY")
        let alerts = DeepSeekAlerts(enabled: true, cny: 2, usd: 1)
        let saved = try await api.saveDeepSeekAlerts(alerts)
        XCTAssertEqual(saved, alerts)
        let pro = try await api.applyOpenClawModel("deepseek/deepseek-v4-pro")
        XCTAssertEqual(pro.currentName, "DeepSeek V4 Pro")
        XCTAssertTrue(pro.isDeepSeek)
        let routed = try await api.applyOpenClawModel("openrouter/deepseek-v4")
        XCTAssertFalse(routed.isDeepSeek)
        do {
            _ = try await api.deepSeekUsage(.week)
            XCTFail("DeepSeek usage must be scoped to the effective provider.")
        } catch APIError.server {
        }
        try await api.logout()
        do {
            _ = try await api.snapshot()
            XCTFail("Logout must clear the session on the client.")
        } catch APIError.sessionExpired {
            return
        }
    }
}
