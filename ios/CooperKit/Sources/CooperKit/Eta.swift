import Foundation

/// Time until the driver reaches the customer, along the road route (via the depot until the water is loaded).
public struct Eta: Decodable, Equatable {
    public let orderId: String?
    public let status: String?
    public let etaSec: Int?
    public let distanceM: Int?
    public let arriveAt: String?
    public let viaDepot: Bool?
    public let depotName: String?
    /// "google" = road route with live traffic; "estimate" = straight line at town speeds.
    public let source: String?
    public let arrived: Bool?

    public init(orderId: String? = nil, status: String? = nil, etaSec: Int? = nil, distanceM: Int? = nil, arriveAt: String? = nil,
                viaDepot: Bool? = nil, depotName: String? = nil, source: String? = nil, arrived: Bool? = nil) {
        self.orderId = orderId
        self.status = status
        self.etaSec = etaSec
        self.distanceM = distanceM
        self.arriveAt = arriveAt
        self.viaDepot = viaDepot
        self.depotName = depotName
        self.source = source
        self.arrived = arrived
    }

    /// Statuses that have an arrival estimate (a driver is on the way).
    public static let statuses: Set<String> = [OrderStatus.accepted, OrderStatus.loading, OrderStatus.enRoute, OrderStatus.arrived]
}

/// Turning an ETA into what people read (same rules as Android).
public enum EtaFormat {
    /// Whole minutes, rounded up; 0 means "less than a minute".
    public static func minutes(_ etaSec: Int) -> Int { etaSec < 45 ? 0 : Int((Double(etaSec) / 60).rounded(.up)) }

    /// "650 m" under a kilometre, else "2.3 km".
    public static func distance(_ m: Int) -> String {
        m < 1000 ? "\(Int((Double(m) / 10).rounded()) * 10) m" : String(format: "%.1f km", Double(m) / 1000)
    }
}
