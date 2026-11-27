import Foundation

public struct LocalOccurrence: Hashable, Sendable {
    public let taskID: String
    public let title: String
    public let date: Date
    public let version: Int

    public var id: String {
        "reminder.task.\(taskID).\(version).\(Int64(date.timeIntervalSince1970))"
    }
}

public enum LocalSchedule {
    public static let windowDays = 14
    public static let pendingLimit = 60

    public static func occurrences(
        from tasks: [ReminderTask], now: Date, days: Int = windowDays, limit: Int = pendingLimit
    ) -> [LocalOccurrence] {
        guard days > 0, limit > 0, let end = BeijingTime.calendar.date(byAdding: .day, value: days, to: now)
        else { return [] }
        let calendar = BeijingTime.calendar
        var result: [LocalOccurrence] = []
        for task in tasks where !task.isCompleted && !task.isArchived {
            guard var next = task.dueDate else { continue }
            let interval = task.recurrence.intervalInDays
            if let interval, next <= now {
                let elapsedDays = calendar.dateComponents([.day], from: next, to: now).day ?? 0
                let jump = (elapsedDays / interval) * interval
                guard let advanced = calendar.date(byAdding: .day, value: jump, to: next) else { continue }
                next = advanced
                if next <= now {
                    guard let advanced = calendar.date(byAdding: .day, value: interval, to: next) else { continue }
                    next = advanced
                }
            }
            while next > now && next <= end {
                if let cutoff = task.repeatUntil, BeijingTime.day(next) > cutoff { break }
                result.append(LocalOccurrence(taskID: task.id, title: task.title, date: next, version: task.version))
                guard let interval, let following = calendar.date(byAdding: .day, value: interval, to: next) else { break }
                next = following
            }
        }
        return Array(result.sorted {
            $0.date == $1.date ? $0.taskID < $1.taskID : $0.date < $1.date
        }.prefix(limit))
    }
}
