import AVFoundation
import Combine
import CooperKit
import CoreLocation
import SwiftUI
import UserNotifications

/// Process-wide driver state shared by every screen: profile / online flag, config, wallet, open offers,
/// the active job and depots. Fed by REST refreshes and live events (same as Android DriverState).
@MainActor
final class DriverState: ObservableObject {
    @Published var profile: DriverProfile?
    @Published var config: DriverConfig?
    @Published var wallet: WalletBrief?
    @Published var offers: [Offer] = []
    @Published var activeOrder: Order?
    @Published var depots: [Depot] = []
    @Published var toggling = false
    @Published var accepting: String?
    @Published var declining: String?
    @Published var error: String?
    @Published var message: String?
    /// Accepted job to open.
    @Published var acceptedOrderId: String?
    @Published var myLocation: CLLocationCoordinate2D?

    let session: AppSession
    let tracker: LocationTracker
    let alarm = OfferAlarm()
    private var bag = Set<AnyCancellable>()
    private var acceptKeys: [String: String] = [:]
    private var timers: [Timer] = []

    var online: Bool { profile?.online == true }
    var api: DriverAPI { session.driver }

    init(session: AppSession) {
        self.session = session
        tracker = LocationTracker(session: session)
        session.realtime.events.sink { [weak self] e in self?.handle(e) }.store(in: &bag)
        tracker.onFix = { [weak self] c in self?.myLocation = c }
        // Drop expired offers every 5 s; poll offers every 30 s while online (socket may be down on 3G).
        timers.append(Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in Task { @MainActor in self?.pruneExpired() } })
        timers.append(Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in if self?.online == true { await self?.refreshOffers() } }
        })
    }

    // MARK: Live events

    func handle(_ e: RealtimeEvent) {
        switch e {
        case .offerReceived(let o):
            let isNew = !offers.contains { $0.orderId == o.orderId }
            offers = offers.filter { $0.orderId != o.orderId } + [o]
            pruneExpired()
            if isNew { alertNewOffer(o) }
        case .offerRevoked(let id, _):
            removeOffer(id)
        case .walletUpdated(let u):
            let min = u.minBalanceToea ?? wallet?.minBalanceToea ?? 0
            wallet = WalletBrief(balanceToea: u.balanceToea, minBalanceToea: min, blocked: u.blocked ?? (u.balanceToea < min))
        case .orderUpdated(let o):
            if let cur = activeOrder, cur.id == o.id {
                var merged = o.delivery == nil ? cur : o
                merged.status = o.status
                activeOrder = OrderStatus.isTerminal(merged.status) ? nil : merged
            } else if OrderStatus.activeDriver.contains(o.status), o.delivery != nil {
                activeOrder = o
            }
            if o.status != OrderStatus.searching { removeOffer(o.id) }
        case .chatMessage(let orderId, let code, let m):
            if m.mine != true { LocalNotifications.show(id: "chat-\(m.id)", title: "Message · \(code)", body: m.body) }
            _ = orderId
        default:
            break
        }
        syncAlarm()
    }

    private func alertNewOffer(_ o: Offer) {
        guard activeOrder == nil else { return }
        alarm.start()
        if !session.foreground {
            // In the background the in-app ring may be paused by iOS: the notification rings too.
            LocalNotifications.show(id: "offer-\(o.orderId)", title: "New job offer", body: "\(o.shortCode ?? "") · earn \(Money.format(o.earningsToea))",
                                    sound: UNNotificationSound(named: UNNotificationSoundName("offer_alert.wav")))
        }
    }

    /// Stop ringing once nothing is waiting: accepted, declined, taken, expired, offline or signed out.
    private func syncAlarm() {
        if !(session.signedIn && online && activeOrder == nil && !offers.isEmpty) { alarm.stop() }
    }

    func removeOffer(_ orderId: String) {
        offers.removeAll { $0.orderId == orderId }
        LocalNotifications.cancel(id: "offer-\(orderId)")
        syncAlarm()
    }

    func pruneExpired() {
        let before = offers.count
        offers.removeAll { (PomTime.secondsUntil($0.expiresAt) ?? 1) <= 0 }
        if offers.count != before { syncAlarm() }
    }

    // MARK: Refresh

    func refreshAll() async {
        async let cfg = capture { try await self.api.config() }
        async let me = capture { try await self.api.me() }
        async let act = capture { try await self.api.activeOrder() }
        async let dep = capture { try await self.api.depots() }
        let (c, p, a, d) = await (cfg, me, act, dep)
        if case .success(let v) = c { config = v }
        if case .success(let v) = p { setProfile(v) }
        if case .success(let v) = a { activeOrder = v.flatMap { OrderStatus.isTerminal($0.status) ? nil : $0 } }
        if case .success(let v) = d { depots = v }
        if let w = try? await api.wallet() { wallet = WalletBrief(balanceToea: w.balanceToea, minBalanceToea: w.minBalanceToea, blocked: w.blocked) }
        if online { await refreshOffers() }
        syncTracking()
        syncAlarm()
    }

    func setProfile(_ p: DriverProfile) {
        profile = p
        if let w = p.wallet { wallet = w }
        syncTracking()
    }

    func refreshOffers() async {
        guard let list = try? await api.offers() else { return }
        let known = Set(offers.map(\.orderId))
        offers = list.filter { (PomTime.secondsUntil($0.expiresAt) ?? 1) > 0 }
        // An offer found by polling (socket was down) alerts the driver just like a pushed one.
        if let fresh = offers.last(where: { !known.contains($0.orderId) }) { alertNewOffer(fresh) }
        syncAlarm()
    }

    /// Location sharing runs exactly while the server says we're online.
    private func syncTracking() {
        if session.signedIn && online { tracker.start(intervalSec: config?.locationIntervalSec ?? 20) } else { tracker.stop() }
    }

    // MARK: Online / offline

    func goOnline() async {
        toggling = true
        error = nil
        message = nil
        defer { toggling = false }
        guard let loc = await LocationProvider.shared.current() else {
            error = "Location is needed to go online. Turn on location and try again."
            return
        }
        myLocation = loc.coordinate
        tracker.requestAlways()
        do {
            setProfile(try await api.goOnline(lat: loc.coordinate.latitude, lng: loc.coordinate.longitude))
            message = "You are online. Waiting for jobs."
            await refreshOffers()
        } catch let e as APIError {
            if e.code == "not_at_depot", let nd = nearestDepot() {
                error = "You need to be at a depot to go online. Nearest: \(nd.0.name) (\(Geo.formatDistance(nd.1)) away)."
            } else {
                error = e.localizedDescription
            }
            if let w = try? await api.wallet() { wallet = WalletBrief(balanceToea: w.balanceToea, minBalanceToea: w.minBalanceToea, blocked: w.blocked) }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func goOffline() async {
        toggling = true
        error = nil
        defer { toggling = false }
        do {
            setProfile(try await api.goOffline())
            offers = []
            syncAlarm()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func nearestDepot() -> (Depot, Double)? {
        guard let me = myLocation else { return nil }
        return depots.map { ($0, Geo.distanceM(me.latitude, me.longitude, $0.lat, $0.lng)) }.min { $0.1 < $1.1 }
    }

    // MARK: Offers

    func accept(_ o: Offer) async {
        guard accepting == nil else { return }
        accepting = o.orderId
        error = nil
        let key = acceptKeys[o.orderId] ?? newIdempotencyKey()
        acceptKeys[o.orderId] = key
        defer { accepting = nil }
        do {
            let order = try await api.accept(o.orderId, key: key)
            activeOrder = order
            offers = []
            acceptedOrderId = order.id
            acceptKeys[o.orderId] = nil
        } catch let e as APIError {
            switch e.code {
            case "order_taken":
                removeOffer(o.orderId)
                error = "Sorry, this job has already been taken by another driver."
            case "offer_expired":
                removeOffer(o.orderId)
                error = "This offer has expired."
            default:
                error = e.isNetwork ? "No answer yet. Tap Accept again — it is safe, you cannot take the job twice." : e.localizedDescription
            }
        } catch {
            self.error = error.localizedDescription
        }
        syncAlarm()
    }

    func decline(_ o: Offer) async {
        declining = o.orderId
        removeOffer(o.orderId)
        try? await api.decline(o.orderId)
        declining = nil
    }

    func signedOut() {
        tracker.stop()
        alarm.stop()
        profile = nil
        offers = []
        activeOrder = nil
    }
}

/// Shares the driver's position while online: POST /driver/location in batches every `intervalSec`,
/// plus a live socket emit. Uses background location so it keeps working with the screen off.
@MainActor
final class LocationTracker: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let session: AppSession
    private var buffer: [LocationPoint] = []
    private var timer: Timer?
    private(set) var running = false
    var onFix: ((CLLocationCoordinate2D) -> Void)?

    init(session: AppSession) {
        self.session = session
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 15
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
    }

    func requestAlways() {
        if manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .notDetermined {
            manager.requestAlwaysAuthorization()
        }
    }

    func start(intervalSec: Int) {
        guard !running else { return }
        running = true
        if manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse {
            manager.allowsBackgroundLocationUpdates = true
            manager.showsBackgroundLocationIndicator = true
        }
        manager.startUpdatingLocation()
        timer = Timer.scheduledTimer(withTimeInterval: TimeInterval(max(5, intervalSec)), repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.flush() }
        }
    }

    func stop() {
        guard running else { return }
        running = false
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        timer?.invalidate()
        timer = nil
        buffer.removeAll()
    }

    private func flush() async {
        guard !buffer.isEmpty else { return }
        let points = Array(buffer.suffix(50))
        buffer.removeAll()
        if (try? await session.driver.sendLocations(points)) == nil {
            buffer = Array((points + buffer).suffix(100)) // keep for the next try
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last else { return }
        let c = l.coordinate
        Task { @MainActor in
            guard self.running else { return }
            self.buffer.append(LocationPoint(lat: c.latitude, lng: c.longitude, at: PomTime.nowISO()))
            self.session.realtime.emitDriverLocation(lat: c.latitude, lng: c.longitude)
            self.onFix?(c)
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            let s = manager.authorizationStatus
            if self.running && (s == .authorizedAlways || s == .authorizedWhenInUse) {
                manager.allowsBackgroundLocationUpdates = true
                manager.startUpdatingLocation()
            }
        }
    }
}

/// Rings like a ride-hailing app for a new job offer: the "ding-ding-dong" tone loops with vibration until
/// the offer is handled or 45 s pass. Plays even with the ringer switch on silent.
@MainActor
final class OfferAlarm {
    private var player: AVAudioPlayer?
    private var vibrate: Timer?
    private var autoStop: Timer?

    func start() {
        autoStop?.invalidate()
        autoStop = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { [weak self] _ in Task { @MainActor in self?.stop() } }
        guard player == nil else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        if let url = Bundle.main.url(forResource: "offer_alert", withExtension: "wav"), let p = try? AVAudioPlayer(contentsOf: url) {
            p.numberOfLoops = -1
            p.play()
            player = p
        }
        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        vibrate = Timer.scheduledTimer(withTimeInterval: 1.6, repeats: true) { _ in AudioServicesPlaySystemSound(kSystemSoundID_Vibrate) }
    }

    func stop() {
        autoStop?.invalidate()
        autoStop = nil
        vibrate?.invalidate()
        vibrate = nil
        player?.stop()
        player = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}
