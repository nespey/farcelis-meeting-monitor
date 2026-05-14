import Foundation
import EventKit

struct RuntimeError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) {
        self.description = description
    }
}

struct CalendarEvent: Encodable {
    let id: String
    let calendar: String
    let source: String
    let title: String
    let start: String
    let end: String
    let location: String
    let notes: String
    let url: String
    let attendees: [String]
}

struct CalendarInfo: Encodable {
    let id: String
    let title: String
    let source: String
    let type: String
    let allowsContentModifications: Bool
}

struct CalendarPayload: Encodable {
    let calendars: [CalendarInfo]
    let events: [CalendarEvent]
}

final class CalendarReader {
    private let store = EKEventStore()

    func requestAccess() async throws {
        let granted: Bool
        if #available(macOS 14.0, *) {
            granted = try await store.requestFullAccessToEvents()
        } else {
            granted = try await withCheckedThrowingContinuation { continuation in
                store.requestAccess(to: .event) { allowed, error in
                    if let error = error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: allowed)
                    }
                }
            }
        }

        guard granted else {
            throw RuntimeError("Calendar access was not granted. Enable Calendar access for this terminal/app in macOS Settings.")
        }
    }

    func readEvents(daysBack: Int, daysForward: Int) -> [CalendarEvent] {
        let now = Date()
        let start = Calendar.current.date(byAdding: .day, value: -daysBack, to: now) ?? now
        let end = Calendar.current.date(byAdding: .day, value: daysForward, to: now) ?? now
        let calendars = store.calendars(for: .event)
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
        let events = store.events(matching: predicate)
            .sorted { $0.startDate < $1.startDate }

        return events.map { event in
            CalendarEvent(
                id: event.eventIdentifier ?? UUID().uuidString,
                calendar: event.calendar?.title ?? "Unknown Calendar",
                source: event.calendar?.source.title ?? "",
                title: event.title ?? "Untitled Event",
                start: iso(event.startDate),
                end: iso(event.endDate),
                location: event.location ?? "",
                notes: event.notes ?? "",
                url: event.url?.absoluteString ?? "",
                attendees: (event.attendees ?? []).map { participant in
                    participant.name ?? participant.url.absoluteString
                }
            )
        }
    }

    func readCalendars() -> [CalendarInfo] {
        return store.calendars(for: .event)
            .sorted {
                let left = "\($0.source.title) \($0.title)"
                let right = "\($1.source.title) \($1.title)"
                return left.localizedCaseInsensitiveCompare(right) == .orderedAscending
            }
            .map { calendar in
                CalendarInfo(
                    id: calendar.calendarIdentifier,
                    title: calendar.title,
                    source: calendar.source.title,
                    type: sourceTypeName(calendar.source.sourceType),
                    allowsContentModifications: calendar.allowsContentModifications
                )
            }
    }

    private func iso(_ date: Date?) -> String {
        guard let date = date else { return "" }
        return ISO8601DateFormatter().string(from: date)
    }

    private func sourceTypeName(_ sourceType: EKSourceType) -> String {
        switch sourceType {
        case .local:
            return "local"
        case .exchange:
            return "exchange"
        case .calDAV:
            return "caldav"
        case .mobileMe:
            return "mobileme"
        case .subscribed:
            return "subscribed"
        case .birthdays:
            return "birthdays"
        @unknown default:
            return "unknown"
        }
    }
}

@main
struct Main {
    static func main() async {
        do {
            let args = CommandLine.arguments
            let back = intArg(args, "--days-back") ?? 1
            let forward = intArg(args, "--days-forward") ?? 14
            let includeCalendars = args.contains("--include-calendars")
            let reader = CalendarReader()
            try await reader.requestAccess()
            let events = reader.readEvents(daysBack: back, daysForward: forward)
            let data: Data
            if includeCalendars {
                data = try JSONEncoder().encode(CalendarPayload(calendars: reader.readCalendars(), events: events))
            } else {
                data = try JSONEncoder().encode(events)
            }
            FileHandle.standardOutput.write(data)
        } catch {
            fputs("CALENDAR_READER_FATAL: \(error)\n", stderr)
            exit(1)
        }
    }

    static func intArg(_ args: [String], _ name: String) -> Int? {
        guard let index = args.firstIndex(of: name), args.indices.contains(index + 1) else {
            return nil
        }
        return Int(args[index + 1])
    }
}
