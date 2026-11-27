import Foundation
import SwiftUI
import ReminderCore

@MainActor
final class DeskModel: ObservableObject {
    @Published private(set) var snapshot: DeskSnapshot?
    @Published private(set) var syncedAt: Date?
    @Published private(set) var messages: [TimelineItem] = []
    @Published private(set) var conversationSession: ConversationSession?
    @Published private(set) var before: String?
    @Published private(set) var hasSession = false
    @Published private(set) var restoring = true
    @Published private(set) var busy = false
    @Published private(set) var chatBusy = false
    @Published private(set) var offline = false
    @Published private(set) var localAlerts = UserDefaults.standard.bool(forKey: "local-reminders")
    @Published private(set) var alertsAllowed = false
    @Published private(set) var badgesAllowed = false
    @Published private(set) var scheduledCount: Int?
    @Published var error: String?
    @Published private(set) var chatError: String?
    @Published private(set) var openClaw: OpenClawModelSelection?
    @Published private(set) var modelsBusy = false
    @Published private(set) var modelError: String?
    @Published private(set) var deepSeek: DeepSeekUsageSnapshot?
    @Published private(set) var usageLoading = false
    @Published private(set) var alertsSaving = false
    @Published private(set) var usageError: String?

    let api = ReminderAPI()
    private var authGeneration = 0
    private var usageRequest = 0

    var canEdit: Bool { hasSession && !offline && !busy }

    func start() async {
        guard restoring else { return }
        if let credential = DeviceSession.load() {
            await api.restoreSession(credential)
            hasSession = true
            if let cached = DeviceCache.read("state.json", as: DeviceCache.State.self) {
                snapshot = cached.snapshot
                syncedAt = cached.syncedAt
            }
            if let cached = DeviceCache.read("chat.json", as: Conversation.self) {
                applyConversation(cached)
            }
        } else {
            DeviceSession.clear()
            DeviceCache.clear()
            await DeviceNotifications.clear()
            await DeviceNotifications.badge(0)
        }
        restoring = false
        await refresh()
    }

    func login(_ password: String) async -> Bool {
        guard !busy else { return false }
        busy = true
        defer { busy = false }
        do {
            let credential = try await api.login(password: password)
            do { try DeviceSession.save(credential) }
            catch {
                await api.restoreSession(nil)
                throw error
            }
            hasSession = true
            do { try await fetchSnapshot() }
            catch { await handle(error, syncing: true) }
            return hasSession
        } catch {
            await handle(error)
            return false
        }
    }

    func logout() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        try? await api.logout()
        await clearSession()
    }

    func refresh() async {
        alertsAllowed = await DeviceNotifications.allowed()
        badgesAllowed = await DeviceNotifications.badgesAllowed()
        guard hasSession, !busy else { return }
        busy = true
        defer { busy = false }
        do { try await fetchSnapshot() }
        catch { await handle(error, syncing: true) }
    }

    func loadConversation(older: Bool = false) async {
        guard hasSession, !chatBusy, !older || before != nil else { return }
        let generation = authGeneration
        chatBusy = true
        defer { chatBusy = false }
        do {
            let page = try await api.conversation(before: older ? before : nil)
            guard hasSession, generation == authGeneration, !Task.isCancelled else { return }
            chatError = nil
            let current = Conversation(messages: messages, before: before, session: conversationSession)
            let merged = current.merging(with: page, older: older)
            guard merged != current else { return }
            applyConversation(merged)
            if !older { DeviceCache.write(page, name: "chat.json") }
        } catch {
            guard generation == authGeneration, !Task.isCancelled else { return }
            if case APIError.sessionExpired = error { await clearSession() }
            else { chatError = "聊天记录同步暂不可用。" }
        }
    }

    func loadOpenClaw(refresh: Bool = false, selecting selectedModel: String? = nil) async {
        guard hasSession, !modelsBusy, selectedModel == nil || canEdit else { return }
        let generation = authGeneration
        modelsBusy = true
        modelError = nil
        defer { modelsBusy = false }
        do {
            let selection: OpenClawModelSelection
            if let selectedModel { selection = try await api.applyOpenClawModel(selectedModel) }
            else { selection = try await api.openClawModels(refresh: refresh) }
            guard generation == authGeneration, !Task.isCancelled else { return }
            openClaw = selection
            if !selection.isDeepSeek { clearDeepSeek() }
        } catch {
            guard generation == authGeneration, !Task.isCancelled else { return }
            if case APIError.sessionExpired = error { await handle(error) }
            else { modelError = error.localizedDescription }
        }
    }

    func loadDeepSeekUsage(_ range: ModelUsageRange, refresh: Bool = false) async {
        guard hasSession, openClaw?.isDeepSeek == true, !alertsSaving else { return }
        usageRequest += 1
        let request = usageRequest
        let generation = authGeneration
        usageLoading = true
        usageError = nil
        defer { if request == usageRequest { usageLoading = false } }
        do {
            let report = try await api.deepSeekUsage(range, refresh: refresh)
            guard request == usageRequest, generation == authGeneration, !Task.isCancelled else { return }
            deepSeek = report
        } catch {
            guard request == usageRequest, generation == authGeneration, !Task.isCancelled else { return }
            if case APIError.sessionExpired = error { await handle(error) }
            else { usageError = error.localizedDescription }
        }
    }

    func saveDeepSeekAlerts(_ settings: DeepSeekAlerts) async {
        guard canEdit, openClaw?.isDeepSeek == true, !usageLoading, !alertsSaving else { return }
        let generation = authGeneration
        alertsSaving = true
        usageError = nil
        defer { alertsSaving = false }
        do {
            let saved = try await api.saveDeepSeekAlerts(settings)
            guard generation == authGeneration, openClaw?.isDeepSeek == true else { return }
            deepSeek?.alerts = saved
        } catch {
            guard generation == authGeneration, openClaw?.isDeepSeek == true else { return }
            if case APIError.sessionExpired = error { await handle(error) }
            else { usageError = error.localizedDescription }
        }
    }

    func saveTask(_ change: TaskChange, id: String?) async -> Bool {
        await mutate { try await api.saveTask(change, id: id) }
    }

    func setCompleted(_ task: ReminderTask) async {
        var change = TaskChange()
        change.completed = !task.isCompleted
        _ = await saveTask(change, id: task.id)
    }

    func archiveTask(_ task: ReminderTask) async {
        var change = TaskChange()
        change.archived = !task.isArchived
        _ = await saveTask(change, id: task.id)
    }

    func organize(_ action: InboxAction, id: String) async {
        _ = await mutate { try await api.organizeInbox(action, id: id) }
    }

    func saveDaily(_ time: String?, dual: Bool) async -> Bool {
        await mutate { try await api.saveDaily(time: time, dual: dual) }
    }

    func savePolicy(_ policy: DeliveryPolicy) async -> Bool {
        await mutate { try await api.savePolicy(policy) }
    }

    func sendTest(fallback: Bool) async {
        if await mutate({ try await api.testDelivery(fallback: fallback) }) {
            error = "测试已进入投递队列，可在收件箱查看结果。"
        }
    }

    func setLocalAlerts(_ enabled: Bool) async {
        if enabled {
            await requestDevicePermission()
            guard alertsAllowed else {
                error = "请在 iOS 设置中允许 ROSETTE 通知。"
                return
            }
        }
        localAlerts = enabled
        UserDefaults.standard.set(enabled, forKey: "local-reminders")
        if enabled { await refresh() }
        else {
            scheduledCount = nil
            await DeviceNotifications.clear()
        }
    }

    func enableIconBadge() async {
        await requestDevicePermission()
        if badgesAllowed {
            await DeviceNotifications.badge(snapshot?.badge.count ?? 0)
        } else if error == nil {
            error = "请在 iOS 通知设置中启用 ROSETTE 角标。"
        }
    }

    private func requestDevicePermission() async {
        do {
            _ = try await DeviceNotifications.requestPermission()
            alertsAllowed = await DeviceNotifications.allowed()
            badgesAllowed = await DeviceNotifications.badgesAllowed()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func mutate(_ operation: () async throws -> Void) async -> Bool {
        guard canEdit else { return false }
        busy = true
        defer { busy = false }
        do { try await operation() }
        catch {
            await handle(error)
            return false
        }
        do { try await fetchSnapshot() }
        catch { await handle(error, syncing: true) }
        return hasSession
    }

    private func fetchSnapshot() async throws {
        let snapshot = try await api.snapshot()
        guard hasSession else { return }
        self.snapshot = snapshot
        offline = false
        let now = Date()
        syncedAt = now
        DeviceCache.write(DeviceCache.State(snapshot: snapshot, syncedAt: now), name: "state.json")
        await DeviceNotifications.badge(snapshot.badge.count)
        if localAlerts {
            do { scheduledCount = try await DeviceNotifications.reconcile(tasks: snapshot.tasks) }
            catch { scheduledCount = nil }
        }
    }

    private func applyConversation(_ page: Conversation) {
        messages = page.messages
        before = page.before
        conversationSession = page.session
    }

    private func handle(_ error: Error, syncing: Bool = false) async {
        if case APIError.sessionExpired = error {
            await clearSession()
            self.error = APIError.sessionExpired.localizedDescription
        } else if syncing {
            offline = true
            if snapshot == nil { self.error = error.localizedDescription }
        } else {
            self.error = error.localizedDescription
        }
    }

    private func clearDeepSeek() {
        usageRequest += 1
        usageLoading = false
        usageError = nil
        deepSeek = nil
    }

    private func clearSession() async {
        authGeneration += 1
        hasSession = false
        snapshot = nil
        messages = []
        conversationSession = nil
        before = nil
        offline = false
        scheduledCount = nil
        syncedAt = nil
        chatError = nil
        openClaw = nil
        modelError = nil
        clearDeepSeek()
        await api.restoreSession(nil)
        DeviceSession.clear()
        DeviceCache.clear()
        await DeviceNotifications.clear()
        await DeviceNotifications.badge(0)
    }
}
