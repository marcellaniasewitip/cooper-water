import Foundation

/// PNG Kina helpers. Amounts are integer toea (K1 = 100 toea). Display: `K12.50`, `K1,250.00`, `-K5.00`.
public enum Money {
    public static let maxInputToea: Int64 = 1_000_000_000

    public static func format(_ toea: Int64) -> String {
        let negative = toea < 0
        let abs = toea == Int64.min ? Int64.max : Swift.abs(toea)
        let kina = abs / 100
        let cents = abs % 100
        return "\(negative ? "-" : "")K\(group(kina)).\(cents < 10 ? "0" : "")\(cents)"
    }

    public static func format(_ toea: Int64?) -> String { format(toea ?? 0) }

    /// "+K12.50" for credits, "-K12.50" for debits.
    public static func formatSigned(_ toea: Int64) -> String { toea > 0 ? "+" + format(toea) : format(toea) }

    /// Exact parse of what a user typed in Kina ("12", "12.5", "K1,250.00") into toea; nil if invalid.
    public static func parseKina(_ input: String) -> Int64? {
        var s = input.trimmingCharacters(in: .whitespaces)
        if s.uppercased().hasPrefix("PGK") { s = String(s.dropFirst(3)).trimmingCharacters(in: .whitespaces) }
        if s.hasPrefix("K") || s.hasPrefix("k") { s = String(s.dropFirst()).trimmingCharacters(in: .whitespaces) }
        if s.isEmpty { return nil }
        if s.hasPrefix(".") && s.count > 1 { s = "0" + s }
        if s.contains(",") {
            let intPart = s.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
            guard intPart.range(of: #"^\d{1,3}(,\d{3})+$"#, options: .regularExpression) != nil else { return nil }
            s = s.replacingOccurrences(of: ",", with: "")
        }
        guard s.range(of: #"^\d+(\.\d{1,2})?$"#, options: .regularExpression) != nil else { return nil }
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard let kina = Int64(parts[0]), kina <= maxInputToea / 100 else { return nil }
        var cents: Int64 = 0
        if parts.count == 2 {
            let frac = parts[1].count == 1 ? parts[1] + "0" : parts[1]
            cents = Int64(frac) ?? 0
        }
        let total = kina * 100 + cents
        return total <= maxInputToea ? total : nil
    }

    private static func group(_ n: Int64) -> String {
        let s = String(n)
        var out = ""
        for (i, ch) in s.reversed().enumerated() {
            if i > 0 && i % 3 == 0 { out.append(",") }
            out.append(ch)
        }
        return String(out.reversed())
    }
}
