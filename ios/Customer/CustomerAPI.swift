import CooperKit
import Foundation

/// Typed customer endpoints (same as CustomerApi in the Android apps).
struct CustomerAPI {
    let api: APIClient

    func me() async throws -> CustomerProfile { try await api.get("customer/me") }
    func updateMe(name: String) async throws -> CustomerProfile { try await api.patch("customer/me", UpdateProfileRequest(name: name)) }
    func config() async throws -> CustomerConfig { try await api.get("customer/config") }

    func locations() async throws -> [SavedLocation] { try await api.get("customer/locations") }
    func addLocation(_ r: LocationRequest) async throws -> SavedLocation { try await api.post("customer/locations", r) }
    func updateLocation(_ id: String, _ r: LocationRequest) async throws -> SavedLocation { try await api.patch("customer/locations/\(id)", r) }
    func deleteLocation(_ id: String) async throws { try await api.delete("customer/locations/\(id)") }

    func packages() async throws -> [WaterPackage] { try await api.get("customer/packages") }
    func quote(_ r: QuoteRequest) async throws -> Quote { try await api.post("customer/quote", r) }
    func createOrder(_ r: CreateOrderRequest, key: String) async throws -> CreateOrderResponse { try await api.post("customer/orders", r, idempotencyKey: key) }
    func orders(cursor: String?, limit: Int = 20) async throws -> Page<Order> { try await api.get("customer/orders", query: ["cursor": cursor, "limit": String(limit)]) }
    func order(_ id: String) async throws -> Order { try await api.get("customer/orders/\(id)") }
    func startPayment(_ id: String, msisdn: String, key: String) async throws -> Payment { try await api.post("customer/orders/\(id)/payment", StartPaymentRequest(msisdn: msisdn), idempotencyKey: key) }
    func payment(_ id: String) async throws -> Payment? { try await api.getOptional("customer/orders/\(id)/payment") }
    func cancel(_ id: String, reason: String) async throws -> Order { try await api.post("customer/orders/\(id)/cancel", CancelRequest(reason: reason)) }
    func confirm(_ id: String) async throws -> Order { try await api.post("customer/orders/\(id)/confirm") }
    func rate(_ id: String, stars: Int, comment: String?) async throws { try await api.call("POST", "customer/orders/\(id)/rating", RateRequest(stars: stars, comment: comment)) }
    func dispute(_ id: String, category: String, description: String) async throws { try await api.call("POST", "customer/orders/\(id)/disputes", DisputeRequest(category: category, description: description)) }

    func wallet() async throws -> CustomerWallet { try await api.get("customer/wallet") }
    func walletEntries(cursor: String?) async throws -> Page<LedgerEntry> { try await api.get("customer/wallet/entries", query: ["cursor": cursor]) }
    func walletTopups(cursor: String?) async throws -> Page<Topup> { try await api.get("customer/wallet/topups", query: ["cursor": cursor]) }
    func topup(_ r: TopupRequest, key: String) async throws -> Topup { try await api.post("customer/wallet/topups", r, idempotencyKey: key) }

    func offers() async throws -> [PromoOffer] { try await api.get("customer/offers") }
    func checkOffer(_ code: String) async throws -> PromoOffer { try await api.post("customer/offers/check", PromoCheckRequest(code: code)) }
    func referral() async throws -> ReferralInfo { try await api.get("customer/referral") }
    func applyReferral(_ code: String) async throws -> ReferralInfo { try await api.post("customer/referral/apply", ReferralApplyRequest(code: code)) }

    func inbox(cursor: String?) async throws -> Page<InboxItem> { try await api.get("customer/inbox", query: ["cursor": cursor]) }
    func chats() async throws -> [ChatConversation] { try await api.get("customer/chats") }
    func messages(_ orderId: String) async throws -> ChatThread { try await api.get("customer/orders/\(orderId)/messages") }
    func send(_ orderId: String, body: String) async throws -> ChatMessage { try await api.post("customer/orders/\(orderId)/messages", ChatSendRequest(body: body)) }
}

extension AppSession {
    var customer: CustomerAPI { CustomerAPI(api: api) }
}

/// Promo code picked on the Offers screen, used on the next order.
enum PromoStore {
    private static let key = "cw.offers.selected"
    static var selected: String? {
        get { UserDefaults.standard.string(forKey: key).flatMap { $0.isEmpty ? nil : $0 } }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }
}
