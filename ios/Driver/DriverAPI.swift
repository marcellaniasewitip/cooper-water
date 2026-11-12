import CooperKit
import Foundation

/// Typed driver endpoints (same as DriverApi in the Android app).
struct DriverAPI {
    let api: APIClient

    func me() async throws -> DriverProfile { try await api.get("driver/me") }
    func updateMe(name: String) async throws -> DriverProfile { try await api.patch("driver/me", UpdateProfileRequest(name: name)) }
    func config() async throws -> DriverConfig { try await api.get("driver/config") }

    func submitDocument(type: String, fileKey: String) async throws { try await api.call("POST", "driver/documents", SubmitDocumentRequest(type: type, fileKey: fileKey)) }
    func putTruck(_ r: TruckRequest) async throws -> Truck { try await api.put("driver/truck", r) }
    func depots() async throws -> [Depot] { try await api.get("driver/depots") }

    func goOnline(lat: Double, lng: Double) async throws -> DriverProfile { try await api.post("driver/online", PositionRequest(lat: lat, lng: lng)) }
    func goOffline() async throws -> DriverProfile { try await api.post("driver/offline") }
    func sendLocations(_ points: [LocationPoint]) async throws -> LocationAck { try await api.post("driver/location", LocationBatch(points: points)) }

    func offers() async throws -> [Offer] { try await api.get("driver/offers") }
    func accept(_ orderId: String, key: String) async throws -> Order { try await api.post("driver/orders/\(orderId)/accept", idempotencyKey: key) }
    func decline(_ orderId: String) async throws { try await api.call("POST", "driver/orders/\(orderId)/decline") }
    func activeOrder() async throws -> Order? { try await api.getOptional("driver/orders/active") }
    func orders(cursor: String?) async throws -> Page<Order> { try await api.get("driver/orders", query: ["cursor": cursor]) }
    func order(_ id: String) async throws -> Order { try await api.get("driver/orders/\(id)") }
    func arriveDepot(_ id: String, lat: Double, lng: Double) async throws -> Order { try await api.post("driver/orders/\(id)/arrive-depot", PositionRequest(lat: lat, lng: lng)) }
    func loaded(_ id: String, lat: Double, lng: Double) async throws -> Order { try await api.post("driver/orders/\(id)/loaded", PositionRequest(lat: lat, lng: lng)) }
    func arrived(_ id: String, lat: Double?, lng: Double?) async throws -> Order { try await api.post("driver/orders/\(id)/arrived", OptionalPositionRequest(lat: lat, lng: lng)) }
    func delivered(_ id: String, proofKey: String?) async throws -> Order { try await api.post("driver/orders/\(id)/delivered", DeliveredRequest(proofPhotoKey: proofKey)) }
    func reportIssue(_ id: String, category: String, description: String) async throws { try await api.call("POST", "driver/orders/\(id)/issues", DisputeRequest(category: category, description: description)) }

    func wallet() async throws -> WalletSummary { try await api.get("driver/wallet") }
    func walletEntries(cursor: String?) async throws -> Page<LedgerEntry> { try await api.get("driver/wallet/entries", query: ["cursor": cursor]) }
    func topup(_ r: TopupRequest, key: String) async throws -> TopupResponse { try await api.post("driver/wallet/topups", r, idempotencyKey: key) }
    func topups(cursor: String?) async throws -> Page<Topup> { try await api.get("driver/wallet/topups", query: ["cursor": cursor]) }
    func withdraw(_ r: WithdrawalRequest, key: String) async throws -> Payout { try await api.post("driver/wallet/withdrawals", r, idempotencyKey: key) }
    func withdrawals(cursor: String?) async throws -> Page<Payout> { try await api.get("driver/wallet/withdrawals", query: ["cursor": cursor]) }
    func earnings(period: String) async throws -> Earnings { try await api.get("driver/earnings", query: ["period": period]) }

    func inbox(cursor: String?) async throws -> Page<InboxItem> { try await api.get("driver/inbox", query: ["cursor": cursor]) }
    func chats() async throws -> [ChatConversation] { try await api.get("driver/chats") }
    func messages(_ orderId: String) async throws -> ChatThread { try await api.get("driver/orders/\(orderId)/messages") }
    func send(_ orderId: String, body: String) async throws -> ChatMessage { try await api.post("driver/orders/\(orderId)/messages", ChatSendRequest(body: body)) }

    /// Upload a photo: presigned PUT to S3, falling back to sending it through the API.
    func upload(purpose: String, jpeg: Data) async throws -> String {
        do {
            let t: UploadTicket = try await api.post("driver/uploads", UploadRequest(purpose: purpose, contentType: "image/jpeg", contentLength: jpeg.count))
            do {
                try await api.uploadPresigned(t, data: jpeg, contentType: "image/jpeg")
                return t.key
            } catch {
                return try await api.uploadDirect(purpose: purpose, data: jpeg, contentType: "image/jpeg", reason: "presigned_put_failed")
            }
        } catch let e as APIError where e.isNetwork {
            throw e
        } catch {
            return try await api.uploadDirect(purpose: purpose, data: jpeg, contentType: "image/jpeg", reason: "ticket_failed")
        }
    }
}

extension AppSession {
    var driver: DriverAPI { DriverAPI(api: api) }
}

/// Run an async call and keep its result or error.
func capture<T>(_ body: () async throws -> T) async -> Result<T, Error> {
    do { return .success(try await body()) } catch { return .failure(error) }
}
