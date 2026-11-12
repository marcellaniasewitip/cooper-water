import Foundation

/// Order lifecycle, mirrored from backend/src/orders/state-machine.ts.
public enum OrderStatus {
    public static let pendingPayment = "PENDING_PAYMENT"
    public static let searching = "SEARCHING"
    public static let accepted = "ACCEPTED"
    public static let loading = "LOADING"
    public static let enRoute = "EN_ROUTE"
    public static let arrived = "ARRIVED"
    public static let delivered = "DELIVERED"
    public static let completed = "COMPLETED"
    public static let cancelled = "CANCELLED"
    public static let expired = "EXPIRED"
    public static let failed = "FAILED"
    public static let disputed = "DISPUTED"

    public static let progress = [pendingPayment, searching, accepted, loading, enRoute, arrived, delivered, completed]
    public static let terminal: Set<String> = [completed, cancelled, expired, failed]
    public static let trackable: Set<String> = [accepted, loading, enRoute, arrived]
    public static let activeDriver: Set<String> = [accepted, loading, enRoute, arrived]
    static let customerCancellable: Set<String> = [pendingPayment, searching, accepted, loading, enRoute, arrived]
    static let disputable: Set<String> = [accepted, loading, enRoute, arrived, delivered, completed]

    public static func isTerminal(_ s: String) -> Bool { terminal.contains(s) }
    public static func isTrackable(_ s: String) -> Bool { trackable.contains(s) }
    public static func isDisputable(_ s: String) -> Bool { disputable.contains(s) }

    /// Strictly before `cancelFreeUntil`, and cancellable by a customer at all (same rule as the backend).
    public static func customerMayCancel(_ status: String, cancelFreeUntil: String) -> Bool {
        guard let idx = progress.firstIndex(of: status), let limit = progress.firstIndex(of: cancelFreeUntil) else { return false }
        return idx < limit && customerCancellable.contains(status)
    }

    public static func label(_ s: String) -> String {
        switch s {
        case pendingPayment: return "Waiting for payment"
        case searching: return "Finding a driver"
        case accepted: return "Driver assigned"
        case loading: return "Loading water at depot"
        case enRoute: return "On the way"
        case arrived: return "Driver has arrived"
        case delivered: return "Delivered"
        case completed: return "Completed"
        case cancelled: return "Cancelled"
        case expired: return "No driver found"
        case failed: return "Payment failed"
        case disputed: return "Issue under review"
        default: return "Unknown status"
        }
    }

    /// Timeline rows for tracking: normal progression (no PENDING_PAYMENT for cash), plus the off-track final state.
    public static func steps(_ order: Order) -> [TimelineStep] {
        let t = order.timeline ?? OrderTimeline()
        let progression = progress.filter { $0 != pendingPayment || order.paymentMethod == "cellmoney" }
        let offTrack = !progress.contains(order.status)
        var rows: [TimelineStep] = []
        let currentIdx = progression.firstIndex(of: order.status)
        for (i, s) in progression.enumerated() {
            let at = t.at(s)
            let done = at != nil || (currentIdx.map { i <= $0 } ?? false)
            rows.append(TimelineStep(status: s, at: at, done: done, current: s == order.status))
            if offTrack && at == nil && !done { break }
        }
        if offTrack { rows.append(TimelineStep(status: order.status, at: t.at(order.status), done: true, current: true)) }
        return rows
    }
}

public struct TimelineStep: Hashable {
    public let status: String
    public let at: String?
    public let done: Bool
    public let current: Bool
}

public enum Labels {
    public static func paymentMethod(_ m: String?) -> String {
        switch m {
        case "cod": return "Cash on delivery"
        case "cellmoney": return "Cell money"
        case "wallet": return "Wallet"
        case "bank_transfer": return "Bank transfer"
        case "cash": return "Cash"
        default: return m ?? ""
        }
    }

    public static func topupStatus(_ s: String?) -> String {
        switch s {
        case "pending": return "In review"
        case "approved": return "Approved"
        case "rejected": return "Rejected"
        case "failed": return "Failed"
        default: return s ?? ""
        }
    }
}
