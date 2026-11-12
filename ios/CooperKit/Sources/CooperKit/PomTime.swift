import Foundation

/// Dates shown in Port Moresby time (UTC+10, no DST), from the API's ISO-8601 strings.
public enum PomTime {
    public static let zone = TimeZone(identifier: "Pacific/Port_Moresby") ?? TimeZone(secondsFromGMT: 36000)!

    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    public static func parse(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return isoFrac.date(from: s) ?? iso.date(from: s)
    }

    private static func fmt(_ pattern: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_PG")
        f.timeZone = zone
        f.dateFormat = pattern
        return f
    }
    private static let dateTime = fmt("d MMM yyyy, h:mm a")
    private static let dateOnly = fmt("d MMM yyyy")
    private static let timeOnly = fmt("h:mm a")

    public static func formatDateTime(_ s: String?) -> String { parse(s).map { dateTime.string(from: $0) } ?? "" }
    public static func formatDate(_ s: String?) -> String { parse(s).map { dateOnly.string(from: $0) } ?? "" }
    public static func formatTime(_ s: String?) -> String { parse(s).map { timeOnly.string(from: $0) } ?? "" }

    /// Seconds from now until `s` (negative when past), or nil.
    public static func secondsUntil(_ s: String?, now: Date = Date()) -> Int? {
        parse(s).map { Int($0.timeIntervalSince(now).rounded(.down)) }
    }

    public static func formatCountdown(_ secs: Int) -> String {
        let s = max(0, secs)
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    public static func nowISO() -> String { isoFrac.string(from: Date()) }
}
