import Foundation

// API models for /api/v1 (same shapes as shared/android-core Models.kt and shared/openapi.json).
// Money is integer toea (Int64). Timestamps are UTC ISO-8601 strings; format them with PomTime.
// Fields the server may omit (partial realtime payloads, older servers) are optional.

// MARK: - Common

public struct Page<T: Decodable>: Decodable {
    public var items: [T]
    public var nextCursor: String?

    enum CodingKeys: String, CodingKey { case items, nextCursor }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([T].self, forKey: .items) ?? []
        nextCursor = try c.decodeIfPresent(String.self, forKey: .nextCursor)
    }
    public init(items: [T], nextCursor: String?) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

public struct Empty: Codable {}

// MARK: - Auth

public struct OtpRequest: Encodable { public let phone: String }
public struct OtpRequestResponse: Decodable {
    public let phone: String
    public let ttlSec: Int?
    public let trainingMode: Bool?
    public let trainingCode: String?
}
public struct OtpVerifyRequest: Encodable {
    public let phone: String
    public let code: String
    public let app: String
    public let name: String?
}
public struct AuthUser: Codable, Equatable {
    public let id: String
    public let phone: String
    public var name: String?
    public let role: String?
}
public struct AuthResponse: Decodable {
    public let accessToken: String
    public let refreshToken: String
    public let expiresIn: Int?
    public let user: AuthUser
    public let isNew: Bool?
}
public struct RefreshRequest: Encodable { public let refreshToken: String }
public struct TokenPair: Decodable {
    public let accessToken: String
    public let refreshToken: String
}
public struct UpdateProfileRequest: Encodable {
    public let name: String
    public init(name: String) { self.name = name }
}
public struct PushTokenRequest: Encodable {
    public let token: String?
    public init(token: String?) { self.token = token }
}

// MARK: - Orders (both apps)

public struct PackageRef: Codable, Hashable {
    public let id: String?
    public let name: String?
    public let volumeLitres: Int?
}

public struct DeliveryLocation: Codable, Hashable {
    public let lat: Double
    public let lng: Double
    public var address: String?
    public var notes: String?
    public init(lat: Double, lng: Double, address: String?, notes: String?) {
        self.lat = lat
        self.lng = lng
        self.address = address
        self.notes = notes
    }
}

public struct OrderTimeline: Codable, Hashable {
    public var createdAt: String?
    public var paymentPendingAt: String?
    public var searchingAt: String?
    public var acceptedAt: String?
    public var loadingAt: String?
    public var enRouteAt: String?
    public var arrivedAt: String?
    public var deliveredAt: String?
    public var completedAt: String?
    public var cancelledAt: String?
    public var expiredAt: String?
    public var failedAt: String?
    public var disputedAt: String?

    public func at(_ status: String) -> String? {
        switch status {
        case OrderStatus.pendingPayment: return paymentPendingAt
        case OrderStatus.searching: return searchingAt
        case OrderStatus.accepted: return acceptedAt
        case OrderStatus.loading: return loadingAt
        case OrderStatus.enRoute: return enRouteAt
        case OrderStatus.arrived: return arrivedAt
        case OrderStatus.delivered: return deliveredAt
        case OrderStatus.completed: return completedAt
        case OrderStatus.cancelled: return cancelledAt
        case OrderStatus.expired: return expiredAt
        case OrderStatus.failed: return failedAt
        case OrderStatus.disputed: return disputedAt
        default: return nil
        }
    }
}

public struct TruckRef: Codable, Hashable {
    public let plate: String?
    public let capacityLitres: Int?
}
public struct DriverLocation: Codable, Hashable {
    public let lat: Double
    public let lng: Double
    public let at: String?
    public init(lat: Double, lng: Double, at: String?) {
        self.lat = lat
        self.lng = lng
        self.at = at
    }
}
public struct OrderDriver: Codable, Hashable {
    public let name: String?
    public let phone: String?
    public let ratingAvg: Double?
    public let truck: TruckRef?
    public let location: DriverLocation?
}
public struct OrderCustomer: Codable, Hashable {
    public let name: String?
    public let phone: String?
}

/// One order as seen by a customer or a driver. Driver-only: commissionToea, earningsToea, customer. Customer-only: driver.
public struct Order: Codable, Identifiable, Hashable {
    public let id: String
    public var shortCode: String?
    public var status: String
    public var `package`: PackageRef?
    public var quantity: Int?
    public var unitPriceToea: Int64?
    public var priceToea: Int64?
    public var discountToea: Int64?
    public var payableToea: Int64?
    public var paymentMethod: String?
    public var paymentStatus: String?
    public var delivery: DeliveryLocation?
    public var cancelReason: String?
    public var expiresAt: String?
    public var timeline: OrderTimeline?
    public var driver: OrderDriver?
    public var commissionToea: Int64?
    public var earningsToea: Int64?
    public var customer: OrderCustomer?

    public var code: String { shortCode ?? "" }
    /** What the customer pays (price − discount). */
    public var amountDueToea: Int64 { payableToea ?? max(0, (priceToea ?? 0) - (discountToea ?? 0)) }
}

public struct ErrorBody: Decodable {
    public let code: String?
    public let message: String?
}
struct ErrorEnvelope: Decodable { let error: ErrorBody }

public struct Payment: Decodable, Hashable {
    public let id: String
    public let status: String
    public let amountToea: Int64?
    public let reference: String?
    public let expiresAt: String?
    public let failureReason: String?
    public let manual: Bool?
    public let instructions: String?
    public var isOpen: Bool { status == "initiated" || status == "pending" }
}

// MARK: - Customer

public struct CustomerProfile: Decodable {
    public let id: String
    public let phone: String
    public let name: String?
}

public struct CustomerConfig: Decodable {
    public var cancelFreeUntil: String?
    public var maxQuantity: Int?
    public var disputeCategories: [String]?
    public var paymentMethods: [String]?
    public var cellmoneyTimeoutSec: Int?
}

public struct SavedLocation: Codable, Identifiable, Hashable {
    public let id: String
    public var label: String
    public var addressText: String
    public var lat: Double
    public var lng: Double
    public var landmarkNotes: String?
}
public struct LocationRequest: Encodable {
    public let label: String
    public let addressText: String
    public let lat: Double
    public let lng: Double
    public let landmarkNotes: String?
    public init(label: String, addressText: String, lat: Double, lng: Double, landmarkNotes: String?) {
        self.label = label
        self.addressText = addressText
        self.lat = lat
        self.lng = lng
        self.landmarkNotes = landmarkNotes
    }
}

public struct WaterPackage: Codable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let volumeLitres: Int
    public let priceToea: Int64
}

public struct QuoteRequest: Encodable {
    public let packageId: String
    public let quantity: Int
    public let promoCode: String?
    public init(packageId: String, quantity: Int, promoCode: String?) {
        self.packageId = packageId
        self.quantity = quantity
        self.promoCode = promoCode
    }
}
public struct AppliedPromo: Decodable, Hashable {
    public let code: String
    public let description: String?
}
public struct Quote: Decodable {
    public let unitPriceToea: Int64
    public let priceToea: Int64
    public let discountToea: Int64?
    public let payableToea: Int64?
    public let promo: AppliedPromo?
}

public struct CreateOrderRequest: Codable, Equatable {
    public let packageId: String
    public let quantity: Int
    public let locationId: String?
    public let paymentMethod: String
    public let msisdn: String?
    public let promoCode: String?
    public init(packageId: String, quantity: Int, locationId: String?, paymentMethod: String, msisdn: String?, promoCode: String?) {
        self.packageId = packageId
        self.quantity = quantity
        self.locationId = locationId
        self.paymentMethod = paymentMethod
        self.msisdn = msisdn
        self.promoCode = promoCode
    }
}
public struct CreateOrderResponse: Decodable {
    public let order: Order
    public let payment: Payment?
    public let paymentError: ErrorBody?
}
public struct StartPaymentRequest: Encodable {
    public let msisdn: String
    public init(msisdn: String) { self.msisdn = msisdn }
}
public struct CancelRequest: Encodable {
    public let reason: String
    public init(reason: String) { self.reason = reason }
}
public struct RateRequest: Encodable {
    public let stars: Int
    public let comment: String?
    public init(stars: Int, comment: String?) {
        self.stars = stars
        self.comment = comment
    }
}
public struct DisputeRequest: Encodable {
    public let category: String
    public let description: String
    public init(category: String, description: String) {
        self.category = category
        self.description = description
    }
}

// MARK: - Wallet (both apps)

public struct PendingTopups: Decodable, Hashable {
    public let count: Int?
    public let amountToea: Int64?
}
public struct LedgerEntry: Decodable, Identifiable, Hashable {
    public let id: String
    public let amountToea: Int64
    public let balanceAfter: Int64?
    public let type: String
    public let description: String?
    public let createdAt: String?
}
public struct TopupRequest: Encodable {
    public let method: String
    public let amountToea: Int64
    public let referenceText: String?
    public let proofFileKey: String?
    public let msisdn: String?
    public init(method: String, amountToea: Int64, referenceText: String?, proofFileKey: String? = nil, msisdn: String?) {
        self.method = method
        self.amountToea = amountToea
        self.referenceText = referenceText
        self.proofFileKey = proofFileKey
        self.msisdn = msisdn
    }
}
public struct Topup: Decodable, Identifiable, Hashable {
    public let id: String
    public let method: String
    public let amountToea: Int64
    public let referenceText: String?
    public let status: String?
    public let rejectReason: String?
    public let createdAt: String?
}
public struct CustomerWallet: Decodable {
    public let balanceToea: Int64
    public let pendingTopups: PendingTopups?
}

// MARK: - Offers, referral, inbox, chat

public struct PromoOffer: Decodable, Identifiable, Hashable {
    public var id: String { code }
    public let code: String
    public let description: String?
    /** percent | flat */
    public let discountType: String?
    public let discountValue: Int64?
    public let maxDiscountToea: Int64?
    public let minOrderToea: Int64?
    public let expiresAt: String?
    public let usable: Bool?
}
public struct PromoCheckRequest: Encodable {
    public let code: String
    public init(code: String) { self.code = code }
}
public struct ReferralInfo: Decodable {
    public let enabled: Bool?
    public let code: String
    public let rewardToea: Int64?
    public let invitedCount: Int?
    public let rewardedCount: Int?
    public let earnedToea: Int64?
    public let referredByCode: String?
    public let canApplyCode: Bool?
}
public struct ReferralApplyRequest: Encodable {
    public let code: String
    public init(code: String) { self.code = code }
}
public struct InboxItem: Decodable, Identifiable, Hashable {
    public let id: String
    public let title: String?
    public let body: String?
    public let template: String?
    public let createdAt: String?
}
public struct ChatMessage: Codable, Identifiable, Hashable {
    public let id: String
    public let body: String
    public let mine: Bool?
    public let createdAt: String?
}
public struct ChatLastMessage: Decodable, Hashable {
    public let body: String
    public let mine: Bool?
    public let createdAt: String?
}
public struct ChatConversation: Decodable, Identifiable, Hashable {
    public var id: String { orderId }
    public let orderId: String
    public let shortCode: String?
    public let otherName: String?
    public let open: Bool?
    public let lastMessage: ChatLastMessage?
    public let unread: Int?
    public let updatedAt: String?
}
public struct ChatThread: Decodable {
    public let orderId: String
    public let shortCode: String?
    public let otherName: String?
    public let open: Bool?
    public let messages: [ChatMessage]?
}
public struct ChatSendRequest: Encodable {
    public let body: String
    public init(body: String) { self.body = body }
}

// MARK: - Driver

public struct DriverConfig: Decodable {
    public let requiredDocuments: [String]?
    public let minBalanceToea: Int64?
    public let onlineRequiresDepot: Bool?
    public let locationIntervalSec: Int?
    public let disputeCategories: [String]?
    public let merchantNumber: String?
}
public struct Truck: Codable, Hashable {
    public let id: String?
    public let plate: String
    public let capacityLitres: Int
    public let photoKey: String?
}
public struct DocumentState: Decodable, Hashable {
    public let type: String
    public let status: String?
    public let notes: String?
    public let uploadedAt: String?
}
public struct WalletBrief: Decodable, Hashable {
    public var balanceToea: Int64?
    public var minBalanceToea: Int64?
    public var blocked: Bool?
    public init(balanceToea: Int64?, minBalanceToea: Int64?, blocked: Bool?) {
        self.balanceToea = balanceToea
        self.minBalanceToea = minBalanceToea
        self.blocked = blocked
    }
}
public struct DriverProfile: Decodable {
    public let id: String
    public let name: String?
    public let phone: String?
    /** pending_docs | pending_approval | approved | rejected | suspended */
    public let status: String
    public let rejectReason: String?
    public var online: Bool?
    public let ratingAvg: Double?
    public let ratingCount: Int?
    public let truck: Truck?
    public let documents: [DocumentState]?
    public var wallet: WalletBrief?
    public let canGoOnline: Bool?
}
public struct UploadRequest: Encodable {
    public let purpose: String
    public let contentType: String
    public let contentLength: Int
    public init(purpose: String, contentType: String, contentLength: Int) {
        self.purpose = purpose
        self.contentType = contentType
        self.contentLength = contentLength
    }
}
public struct UploadTicket: Decodable {
    public let key: String
    public let url: String
    public let method: String?
    public let headers: [String: String]?
}
public struct DirectUploadResult: Decodable { public let key: String }
public struct SubmitDocumentRequest: Encodable {
    public let type: String
    public let fileKey: String
    public init(type: String, fileKey: String) {
        self.type = type
        self.fileKey = fileKey
    }
}
public struct TruckRequest: Encodable {
    public let plate: String
    public let capacityLitres: Int
    public let photoKey: String?
    public init(plate: String, capacityLitres: Int, photoKey: String?) {
        self.plate = plate
        self.capacityLitres = capacityLitres
        self.photoKey = photoKey
    }
}
public struct Depot: Decodable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let lat: Double
    public let lng: Double
    public let geofenceRadiusM: Double?
}
public struct PositionRequest: Encodable {
    public let lat: Double
    public let lng: Double
    public init(lat: Double, lng: Double) {
        self.lat = lat
        self.lng = lng
    }
}
public struct OptionalPositionRequest: Encodable {
    public let lat: Double?
    public let lng: Double?
    public init(lat: Double?, lng: Double?) {
        self.lat = lat
        self.lng = lng
    }
}
public struct LocationPoint: Encodable {
    public let lat: Double
    public let lng: Double
    public let at: String?
    public init(lat: Double, lng: Double, at: String?) {
        self.lat = lat
        self.lng = lng
        self.at = at
    }
}
public struct LocationBatch: Encodable {
    public let points: [LocationPoint]
    public init(points: [LocationPoint]) { self.points = points }
}
public struct LocationAck: Decodable {
    public let ok: Bool?
    public let online: Bool?
}
public struct Offer: Codable, Identifiable, Hashable {
    public var id: String { orderId }
    public let offerId: String?
    public let orderId: String
    public let shortCode: String?
    public let `package`: String?
    public let volumeLitres: Int?
    public let quantity: Int?
    public let distanceM: Double?
    public let earningsToea: Int64?
    public let priceToea: Int64?
    public let paymentMethod: String?
    public let expiresAt: String?
    public let delivery: DeliveryLocation?
}
public struct DeliveredRequest: Encodable {
    public let proofPhotoKey: String?
    public init(proofPhotoKey: String?) { self.proofPhotoKey = proofPhotoKey }
}
public struct WalletSummary: Decodable {
    public let balanceToea: Int64
    public let minBalanceToea: Int64?
    public let blocked: Bool?
    public let shortfallToea: Int64?
    public let withdrawableToea: Int64?
    public let payoutMinToea: Int64?
    public let pendingTopups: PendingTopups?
}
public struct TopupResponse: Decodable {
    public let topup: Topup
    public let payment: Payment?
}
public struct WithdrawalRequest: Encodable {
    public let amountToea: Int64
    public let method: String
    public let destination: String
    public init(amountToea: Int64, method: String, destination: String) {
        self.amountToea = amountToea
        self.method = method
        self.destination = destination
    }
}
public struct Payout: Decodable, Identifiable, Hashable {
    public let id: String
    public let amountToea: Int64
    public let method: String?
    public let destination: String?
    public let status: String?
    public let createdAt: String?
}
public struct Earnings: Decodable {
    public let completedOrders: Int?
    public let grossToea: Int64?
    public let commissionToea: Int64?
    public let netToea: Int64?
    public let cashCollectedToea: Int64?
    public let topupsToea: Int64?
    public let payoutsToea: Int64?
}
public struct WalletUpdate: Decodable, Hashable {
    public let balanceToea: Int64
    public let minBalanceToea: Int64?
    public let blocked: Bool?
}
