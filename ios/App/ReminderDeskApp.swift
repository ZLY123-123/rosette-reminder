import AppIntents
import SwiftUI
import UIKit
import UserNotifications
import ReminderCore

enum DeskTab: Hashable { case today, tasks, conversation, inbox, settings }

@MainActor
final class DeskNavigation: ObservableObject {
    static let shared = DeskNavigation()
    @Published var tab: DeskTab = .today
    @Published var taskID: String?

    func show(_ taskID: String) {
        tab = .tasks
        self.taskID = taskID
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        if let taskID = response.notification.request.content.userInfo["taskID"] as? String {
            await MainActor.run { DeskNavigation.shared.show(taskID) }
        }
    }
}

struct ShowTodayIntent: AppIntent {
    static let title: LocalizedStringResource = "打开今日待办"
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        DeskNavigation.shared.tab = .today
        return .result()
    }
}

struct ReminderShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ShowTodayIntent(), phrases: ["查看\(.applicationName)的今日待办"],
            shortTitle: "今日待办", systemImageName: "sun.max")
    }
}

@main
struct ReminderDeskApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = DeskModel()
    @ObservedObject private var navigation = DeskNavigation.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if model.restoring {
                    ProgressView("打开 ROSETTE")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background { RosetteBackdrop() }
                } else if model.hasSession {
                    TabView(selection: $navigation.tab) {
                        NavigationStack { TodayView(model: model, navigation: navigation) }
                            .tabItem { Label("今日", systemImage: "sun.max") }.tag(DeskTab.today)
                        NavigationStack { TasksView(model: model, navigation: navigation) }
                            .tabItem { Label("待办", systemImage: "checklist") }.tag(DeskTab.tasks)
                        NavigationStack { ConversationView(model: model, isSelected: navigation.tab == .conversation) }
                            .tabItem { Label("对话", systemImage: "bubble.left.and.bubble.right") }.tag(DeskTab.conversation)
                        NavigationStack { InboxView(model: model) }
                            .tabItem { Label("提醒", systemImage: "bell") }
                            .badge(model.snapshot?.badge.count ?? 0).tag(DeskTab.inbox)
                        NavigationStack { SettingsView(model: model, isSelected: navigation.tab == .settings) }
                            .tabItem { Label("设置", systemImage: "gearshape") }.tag(DeskTab.settings)
                    }
                    .safeAreaInset(edge: .top, spacing: 0) {
                        if model.offline {
                            Label(model.syncedAt.map { "离线 · 上次同步 " + deskDate($0) } ?? "等待连接服务器",
                                systemImage: "wifi.slash")
                                .font(.footnote)
                                .frame(maxWidth: .infinity)
                                .padding(8)
                                .background(RosettePalette.canvas)
                        }
                    }
                } else {
                    LoginView(model: model)
                }
            }
            .tint(RosettePalette.roseAccent)
            .environment(\.timeZone, BeijingTime.zone)
            .task { await model.start() }
            .onChange(of: scenePhase) { _, next in
                if next == .active && !model.restoring {
                    Task { await model.refresh() }
                }
            }
            .alert("ROSETTE", isPresented: Binding(
                get: { model.error != nil }, set: { if !$0 { model.error = nil } }
            )) {
                Button("好") { model.error = nil }
            } message: {
                Text(model.error ?? "")
            }
        }
    }
}

func deskDate(_ date: Date, includeDay: Bool = true) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.timeZone = BeijingTime.zone
    formatter.dateFormat = includeDay ? "MM月dd日 HH:mm" : "HH:mm"
    return formatter.string(from: date)
}

private struct LoginView: View {
    @ObservedObject var model: DeskModel
    @State private var password = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 27) {
                VStack(alignment: .leading, spacing: 12) {
                    Image("DeskMark")
                        .resizable().scaledToFit()
                        .frame(width: 76, height: 76)
                        .accessibilityHidden(true)
                    Text("ROSETTE").font(RosetteTypography.wordmark(size: 38, relativeTo: .largeTitle))
                        .accessibilityAddTraits(.isHeader)
                    Text("用工作台口令登录，共用微信与网页的待办。")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 13) {
                    Text("工作台口令").font(.subheadline.weight(.medium))
                    SecureField("工作台口令", text: $password)
                        .textContentType(.password)
                        .submitLabel(.go)
                        .onSubmit(submit)
                        .padding(12)
                        .rosetteSurface(RosettePalette.canvas, radius: 12)
                    Button(action: submit) {
                        Group {
                            if model.busy { ProgressView().tint(RosettePalette.onRoseAccent) }
                            else { Label("登录", systemImage: "arrow.right") }
                        }
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .foregroundStyle(RosettePalette.onRoseAccent)
                        .background(RosettePalette.roseAccent, in: RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .opacity(model.busy || password.isEmpty ? 0.64 : 1)
                    .disabled(model.busy || password.isEmpty)
                }
                .padding(18)
                .rosetteSurface()
            }
            .frame(maxWidth: 418)
            .padding(.horizontal, 27)
            .padding(.vertical, 43)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .scrollDismissesKeyboard(.interactively)
        .background { RosetteBackdrop() }
    }

    private func submit() {
        guard !password.isEmpty else { return }
        Task {
            if await model.login(password) { password = "" }
        }
    }
}
