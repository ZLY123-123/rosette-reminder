import SwiftUI
import ReminderCore

struct InboxView: View {
    @ObservedObject var model: DeskModel
    @State private var archived = false
    @State private var selected: InboxItem?
    @State private var confirmArchive = false

    private var entries: [InboxItem] {
        (archived ? model.snapshot?.archivedInbox : model.snapshot?.inbox) ?? []
    }

    var body: some View {
        List {
            RosetteSegmentedPicker("收件箱分类", selection: $archived, options: [false, true]) {
                $0 ? "归档" : "收件箱"
            }
            .listRowBackground(RosettePalette.panel)
            Section {
                ForEach(entries) { item in
                    Button {
                        selected = item
                        if !archived && !item.isRead {
                            Task { await model.organize(.read, id: item.id) }
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(item.title).font(.headline)
                                if !item.isRead && !archived {
                                    Circle().fill(RosettePalette.roseAccent).frame(width: 7, height: 7)
                                        .accessibilityLabel("未读")
                                }
                                Spacer()
                                Text(deskDate(item.date)).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(item.body).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                        }
                        .padding(.vertical, 3)
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(archived ? "恢复" : "归档", systemImage: "archivebox") {
                            Task { await model.organize(archived ? .restore : .archive, id: item.id) }
                        }
                        .tint(.orange)
                        .disabled(!model.canEdit)
                    }
                    .swipeActions(edge: .leading) {
                        if !archived {
                            Button(item.isRead ? "标为未读" : "标为已读", systemImage: "envelope") {
                                Task { await model.organize(item.isRead ? .unread : .read, id: item.id) }
                            }
                            .tint(.blue)
                            .disabled(!model.canEdit)
                        }
                    }
                }
                if entries.isEmpty {
                    ContentUnavailableView(archived ? "归档暂空" : "收件箱暂空",
                        systemImage: archived ? "archivebox" : "tray")
                }
            }
            .listRowBackground(RosettePalette.panel)
        }
        .rosetteList()
        .navigationTitle("提醒")
        .refreshable { await model.refresh() }
        .toolbar {
            Menu("整理提醒", systemImage: "ellipsis.circle") {
                if archived {
                    Button("恢复最近一次清空", systemImage: "arrow.uturn.backward") {
                        Task { await model.organize(.restore, id: "latest") }
                    }
                } else {
                    Button("全部标为已读", systemImage: "envelope.open") {
                        Task { await model.organize(.read, id: "all") }
                    }
                    Button("清空收件箱", systemImage: "archivebox") { confirmArchive = true }
                }
            }
            .disabled(!model.canEdit || entries.isEmpty)
        }
        .confirmationDialog("将所有提醒归档？", isPresented: $confirmArchive, titleVisibility: .visible) {
            Button("归档全部提醒") { Task { await model.organize(.archive, id: "all") } }
        } message: {
            Text("可以在归档内恢复这批提醒。")
        }
        .sheet(item: $selected) { item in
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 13) {
                        Text(deskDate(item.date)).font(.subheadline).foregroundStyle(.secondary)
                        Text(item.body).textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }
                .background { RosetteBackdrop() }
                .navigationTitle(item.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    Button("完成") { selected = nil }
                }
            }
            .presentationBackground(RosettePalette.canvas)
        }
    }
}
