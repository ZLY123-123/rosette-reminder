import EventKit
import EventKitUI
import SwiftUI
import UIKit
import ReminderCore

struct TodayView: View {
    @ObservedObject var model: DeskModel
    @ObservedObject var navigation: DeskNavigation

    private var pending: [ReminderTask] {
        (model.snapshot?.tasks ?? []).filter { !$0.isCompleted }
    }

    private var today: [ReminderTask] {
        let date = BeijingTime.day(.now)
        return pending.filter { $0.dueDate.map(BeijingTime.day) == date }
    }

    var body: some View {
        List {
            Section {
                nextReminderCard
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            Section("今日待办") {
                ForEach(today) { task in
                    Button { navigation.show(task.id) } label: { TaskRow(task: task) }
                        .buttonStyle(.plain)
                }
                if today.isEmpty { Text("今天的待办暂时空着。").foregroundStyle(.secondary) }
            }
            .listRowBackground(RosettePalette.panel)
            Section {
                Button { navigation.tab = .tasks } label: {
                    LabeledContent("全部待办", value: "\(pending.count) 项待处理")
                }
                Button { navigation.tab = .inbox } label: {
                    LabeledContent("收件箱", value: "\(model.snapshot?.badge.count ?? 0) 条未读")
                }
            }
            .listRowBackground(RosettePalette.panel)
        }
        .rosetteList()
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { homeHeader }
        .refreshable { await model.refresh() }
    }

    private var homeHeader: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 12) {
                brand.fixedSize(horizontal: true, vertical: false)
                Spacer(minLength: 0)
                motto.fixedSize(horizontal: true, vertical: false)
            }
            VStack(alignment: .leading, spacing: 4) {
                brand
                motto.frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .background(RosettePalette.canvas)
        .overlay(alignment: .bottom) {
            Rectangle().fill(RosettePalette.edge).frame(height: 1)
                .accessibilityHidden(true)
        }
    }

    private var brand: some View {
        HStack(spacing: 8) {
            Image("DeskMark")
                .resizable()
                .scaledToFit()
                .frame(width: 36, height: 36)
                .accessibilityHidden(true)
            Text("ROSETTE")
                .font(RosetteTypography.wordmark(size: 26, relativeTo: .headline))
                .lineLimit(1)
                .minimumScaleFactor(0.65)
                .accessibilityAddTraits(.isHeader)
        }
    }

    private var motto: some View {
        Text("Time flies.")
            .font(RosetteTypography.motto)
            .foregroundStyle(RosettePalette.roseAccent)
            .lineLimit(1)
            .minimumScaleFactor(0.65)
    }

    private var nextReminderCard: some View {
        let now = Date()
        let next = pending.first { ($0.dueDate ?? .distantPast) > now }
        return Group {
            if let next, let date = next.dueDate {
                Button { navigation.show(next.id) } label: {
                    VStack(alignment: .leading, spacing: 9) {
                        Label("下一条提醒", systemImage: "bell").font(.subheadline.weight(.medium))
                            .foregroundStyle(RosettePalette.roseAccent)
                        Text(next.title).font(.system(.title2, design: .serif).weight(.semibold))
                            .foregroundStyle(.primary)
                        Text(deskDate(date) + " · 北京时间").font(.footnote).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                Label("等待安排下一条提醒", systemImage: "bell").foregroundStyle(RosettePalette.roseAccent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(LinearGradient(colors: [RosettePalette.roseWash, RosettePalette.petalWash],
            startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 21))
        .overlay { RoundedRectangle(cornerRadius: 21).strokeBorder(RosettePalette.edge).allowsHitTesting(false) }
    }
}

struct TaskRow: View {
    let task: ReminderTask

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: task.isCompleted ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(task.isCompleted ? Color.accentColor : Color.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(task.title).foregroundStyle(.primary)
                Text(details).font(.footnote).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if task.isImportant {
                Image(systemName: "flag.fill").foregroundStyle(.tint).accessibilityLabel("重要事项")
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private var details: String {
        var parts = [task.dueDate.map { deskDate($0) } ?? (task.repeatUntil == nil ? "待安排" : "周期已结束")]
        if task.recurrence != .once { parts.append(task.recurrence.title) }
        if let end = task.repeatUntil { parts.append("至 " + end) }
        return parts.joined(separator: " · ")
    }
}

struct TasksView: View {
    private enum Filter: String, CaseIterable { case active = "待处理", completed = "已完成", archived = "已归档" }
    private struct Editor: Identifiable {
        let id = UUID()
        let task: ReminderTask?
    }

    @Environment(\.colorScheme) private var colorScheme
    @ObservedObject var model: DeskModel
    @ObservedObject var navigation: DeskNavigation
    @State private var filter = Filter.active
    @State private var query = ""
    @State private var editor: Editor?
    @State private var calendarTask: ReminderTask?

    private var tasks: [ReminderTask] {
        let source = filter == .archived ? model.snapshot?.archivedTasks : model.snapshot?.tasks
        return (source ?? []).filter {
            (filter == .archived || $0.isCompleted == (filter == .completed)) &&
            (query.isEmpty || $0.title.localizedCaseInsensitiveContains(query))
        }
    }

    var body: some View {
        searchableList
            .rosetteList()
            .navigationTitle("待办")
            .refreshable { await model.refresh() }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("添加待办", systemImage: "plus") { editor = Editor(task: nil) }.disabled(!model.canEdit)
                }
            }
            .sheet(item: $editor) { selected in
                TaskEditor(model: model, task: selected.task)
                    .presentationBackground(RosettePalette.canvas)
            }
            .sheet(item: $calendarTask) { task in
                if let date = task.dueDate { SystemCalendarEditor(title: task.title, start: date) }
            }
            .task(id: navigation.taskID) {
                guard let id = navigation.taskID else { return }
                if model.snapshot == nil { await model.refresh() }
                let all = (model.snapshot?.tasks ?? []) + (model.snapshot?.archivedTasks ?? [])
                if let task = all.first(where: { $0.id == id }) {
                    editor = Editor(task: task)
                }
                navigation.taskID = nil
            }
    }

    @ViewBuilder private var searchableList: some View {
        if colorScheme == .dark {
            taskList.scrollDismissesKeyboard(.interactively)
        } else {
            taskList.searchable(text: $query, prompt: "搜索待办")
        }
    }

    private var taskList: some View {
        List {
            if colorScheme == .dark {
                Section {
                    searchField
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }
            RosetteSegmentedPicker("待办筛选", selection: $filter, options: Filter.allCases) { $0.rawValue }
                .listRowBackground(RosettePalette.panel)
            Section {
                ForEach(tasks) { task in
                    Button { editor = Editor(task: task) } label: { TaskRow(task: task) }
                        .buttonStyle(.plain)
                        .swipeActions(edge: .leading) {
                            if !task.isArchived {
                                Button(task.isCompleted ? "恢复" : "完成", systemImage: "checkmark") {
                                    Task { await model.setCompleted(task) }
                                }
                                .tint(.green)
                                .disabled(!model.canEdit)
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(task.isArchived ? "恢复" : "归档", systemImage: "archivebox") {
                                Task { await model.archiveTask(task) }
                            }
                            .tint(.orange)
                            .disabled(!model.canEdit)
                        }
                        .contextMenu {
                            if task.dueDate != nil {
                                Button("添加本次到系统日历", systemImage: "calendar.badge.plus") { calendarTask = task }
                            }
                            Button("查看待办", systemImage: "info.circle") { editor = Editor(task: task) }
                        }
                }
                if tasks.isEmpty {
                    ContentUnavailableView("这里还没有待办", systemImage: "checklist")
                }
            }
            .listRowBackground(RosettePalette.panel)
        }
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField("搜索待办", text: $query)
                .textFieldStyle(.plain)
                .submitLabel(.search)
            if !query.isEmpty {
                Button("清空搜索", systemImage: "xmark.circle.fill") { query = "" }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .rosetteSurface(RosettePalette.panel, radius: 19)
    }
}

private struct TaskEditor: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: DeskModel
    let task: ReminderTask?
    @State private var title: String
    @State private var hasDate: Bool
    @State private var date: Date
    @State private var recurrence: Recurrence
    @State private var hasEnd: Bool
    @State private var end: Date
    @State private var important: Bool
    @State private var calendarDate: Date?

    init(model: DeskModel, task: ReminderTask?) {
        self.model = model
        self.task = task
        let due = task?.dueDate ?? Date().addingTimeInterval(3600)
        _title = State(initialValue: task?.title ?? "")
        _hasDate = State(initialValue: task?.dueDate != nil)
        _date = State(initialValue: due)
        _recurrence = State(initialValue: task?.recurrence ?? .once)
        _hasEnd = State(initialValue: task?.repeatUntil != nil)
        _end = State(initialValue: task?.repeatUntil.flatMap(BeijingTime.parseDay) ??
            (BeijingTime.calendar.date(byAdding: .day, value: 7, to: due) ?? due))
        _important = State(initialValue: task?.isImportant ?? false)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("事项") {
                    TextField("名称", text: $title)
                    Toggle("启用提醒时间", isOn: $hasDate)
                }
                .listRowBackground(RosettePalette.panel)
                if hasDate {
                    Section("时间 · 北京时间") {
                        DatePicker("提醒时间", selection: $date)
                        Picker("重复", selection: $recurrence) {
                            ForEach(Recurrence.allCases) { Text($0.title).tag($0) }
                        }
                        if recurrence != .once {
                            Toggle("设定截止日", isOn: $hasEnd)
                            if hasEnd { DatePicker("截止日（含当天）", selection: $end, displayedComponents: .date) }
                        }
                        Toggle("重要事项", isOn: $important)
                    }
                    .listRowBackground(RosettePalette.panel)
                }
                if let current = task?.dueDate {
                    Section {
                        Button("添加本次到系统日历", systemImage: "calendar.badge.plus") { calendarDate = current }
                    }
                    .listRowBackground(RosettePalette.panel)
                }
            }
            .environment(\.calendar, BeijingTime.calendar)
            .rosetteList()
            .navigationTitle(task == nil ? "添加待办" : "待办详情")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { Task { await save() } }
                        .disabled(!model.canEdit || task?.isArchived == true ||
                            title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || title.utf16.count > 180)
                }
            }
            .sheet(isPresented: Binding(get: { calendarDate != nil }, set: { if !$0 { calendarDate = nil } })) {
                if let calendarDate { SystemCalendarEditor(title: title, start: calendarDate) }
            }
        }
    }

    private func save() async {
        let due = hasDate ? date : nil
        let original = task?.dueDate
        let keepEndedCycle = !hasDate && original == nil && task?.repeatUntil != nil
        let repeatMode = hasDate || keepEndedCycle ? recurrence : .once
        var change = TaskChange()
        change.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        change.includesDueDate = task == nil || due != original
        change.dueDate = due
        change.recurrence = repeatMode
        change.includesRepeatUntil = true
        change.repeatUntil = hasEnd && repeatMode != .once ? BeijingTime.day(end) : nil
        change.dual = important
        if await model.saveTask(change, id: task?.id) {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            dismiss()
        }
    }
}

private struct SystemCalendarEditor: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let start: Date

    func makeCoordinator() -> Coordinator { Coordinator(dismiss: dismiss) }

    func makeUIViewController(context: Context) -> EKEventEditViewController {
        let controller = EKEventEditViewController()
        controller.eventStore = context.coordinator.store
        let event = EKEvent(eventStore: context.coordinator.store)
        event.title = title
        event.startDate = start
        event.endDate = start.addingTimeInterval(1800)
        event.timeZone = BeijingTime.zone
        controller.event = event
        controller.editViewDelegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: EKEventEditViewController, context: Context) {}

    final class Coordinator: NSObject, EKEventEditViewDelegate {
        let store = EKEventStore()
        private let dismiss: DismissAction

        init(dismiss: DismissAction) { self.dismiss = dismiss }

        func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
            dismiss()
        }
    }
}
