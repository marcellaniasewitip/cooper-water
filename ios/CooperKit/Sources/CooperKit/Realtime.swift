import Combine
import Foundation
import SocketIO

/// Live events from the server (Socket.IO namespace `/realtime`), same names as the Android apps.
public enum RealtimeEvent {
    case orderUpdated(Order)
    case driverLocation(orderId: String, lat: Double, lng: Double, at: String?)
    case offerReceived(Offer)
    case offerRevoked(orderId: String, reason: String?)
    case walletUpdated(WalletUpdate)
    case chatMessage(orderId: String, shortCode: String, message: ChatMessage)
    /// A push message from Cooper Waters (admin → Push messages).
    case message(id: String, title: String, body: String)
}

public enum RealtimeEvents {
    public static let orderUpdated = "order.updated"
    public static let orderDriverLocation = "order.driver_location"
    public static let orderOffer = "order.offer"
    public static let orderOfferRevoked = "order.offer_revoked"
    public static let walletUpdated = "wallet.updated"
    public static let driverLocation = "driver.location"
    public static let chatMessage = "chat.message"
    public static let notificationMessage = "notification.message"
    public static let all = [orderUpdated, orderDriverLocation, orderOffer, orderOfferRevoked, walletUpdated, chatMessage, notificationMessage]

    private struct OrderWrap: Decodable { let order: Order }
    private struct OfferWrap: Decodable { let offer: Offer }
    private struct LocationMsg: Decodable { let orderId: String; let lat: Double; let lng: Double; let at: String? }
    private struct RevokedMsg: Decodable { let orderId: String; let reason: String? }
    private struct ChatMsg: Decodable { let orderId: String; let shortCode: String?; let message: ChatMessage }
    private struct BroadcastMsg: Decodable { let broadcastId: String; let title: String?; let body: String? }

    /// Parse one event's JSON payload; nil for unknown events or malformed payloads.
    public static func parse(_ event: String, _ json: Data) -> RealtimeEvent? {
        let d = JSONDecoder()
        switch event {
        case orderUpdated: return (try? d.decode(OrderWrap.self, from: json)).map { .orderUpdated($0.order) }
        case orderDriverLocation: return (try? d.decode(LocationMsg.self, from: json)).map { .driverLocation(orderId: $0.orderId, lat: $0.lat, lng: $0.lng, at: $0.at) }
        case orderOffer: return (try? d.decode(OfferWrap.self, from: json)).map { .offerReceived($0.offer) }
        case orderOfferRevoked: return (try? d.decode(RevokedMsg.self, from: json)).map { .offerRevoked(orderId: $0.orderId, reason: $0.reason) }
        case walletUpdated: return (try? d.decode(WalletUpdate.self, from: json)).map { .walletUpdated($0) }
        case chatMessage: return (try? d.decode(ChatMsg.self, from: json)).map { .chatMessage(orderId: $0.orderId, shortCode: $0.shortCode ?? "", message: $0.message) }
        case notificationMessage: return (try? d.decode(BroadcastMsg.self, from: json)).map { .message(id: $0.broadcastId, title: $0.title ?? "", body: $0.body ?? "") }
        default: return nil
        }
    }
}

/// Socket.IO client with `auth: { token }`. Reconnects by itself; when the server rejects the token it
/// refreshes it and reconnects. Push notifications cover the time it's disconnected.
public final class RealtimeClient: ObservableObject {
    @Published public private(set) var connected = false
    public let events = PassthroughSubject<RealtimeEvent, Never>()

    private let api: APIClient
    private var manager: SocketManager?
    private var socket: SocketIOClient?
    private var token: String?
    private var refreshing = false

    public init(api: APIClient) {
        self.api = api
    }

    public func connect() {
        guard let token = api.tokens.accessToken else { return }
        if let socket, self.token == token {
            if socket.status != .connected && socket.status != .connecting { socket.connect(withPayload: ["token": token]) }
            return
        }
        teardown()
        self.token = token
        let m = SocketManager(socketURL: api.realtimeURL, config: [
            .log(false),
            .compress,
            .forceWebsockets(true),
            .reconnects(true),
            .reconnectWait(2),
            .reconnectWaitMax(30),
        ])
        let s = m.socket(forNamespace: "/realtime")
        s.on(clientEvent: .connect) { [weak self] _, _ in self?.setConnected(true) }
        s.on(clientEvent: .disconnect) { [weak self] _, _ in self?.setConnected(false) }
        s.on(clientEvent: .error) { [weak self] data, _ in
            self?.setConnected(false)
            if String(describing: data).lowercased().contains("unauthorized") { self?.onAuthProblem() }
        }
        s.on("error") { [weak self] data, _ in
            if String(describing: data).lowercased().contains("unauthorized") { self?.onAuthProblem() }
        }
        for name in RealtimeEvents.all {
            s.on(name) { [weak self] data, _ in
                guard let first = data.first, JSONSerialization.isValidJSONObject(first),
                      let json = try? JSONSerialization.data(withJSONObject: first),
                      let event = RealtimeEvents.parse(name, json) else { return }
                DispatchQueue.main.async { self?.events.send(event) }
            }
        }
        manager = m
        socket = s
        s.connect(withPayload: ["token": token])
    }

    public func disconnect() {
        teardown()
        setConnected(false)
    }

    /// Driver app: one live position (same as POST /driver/location for a single fix).
    public func emitDriverLocation(lat: Double, lng: Double) {
        guard let socket, socket.status == .connected else { return }
        socket.emit(RealtimeEvents.driverLocation, ["lat": lat, "lng": lng])
    }

    private func teardown() {
        socket?.removeAllHandlers()
        socket?.disconnect()
        manager?.disconnect()
        socket = nil
        manager = nil
        token = nil
    }

    private func setConnected(_ v: Bool) {
        DispatchQueue.main.async { self.connected = v }
    }

    private func onAuthProblem() {
        guard !refreshing else { return }
        refreshing = true
        let failed = token
        Task { [weak self] in
            guard let self else { return }
            let ok = await self.api.refreshTokens(failed: failed)
            await MainActor.run {
                self.refreshing = false
                if ok {
                    self.teardown()
                    self.connect()
                }
            }
        }
    }
}
