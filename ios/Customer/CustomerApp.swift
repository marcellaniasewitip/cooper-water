import CooperKit
import SwiftUI
import UserNotifications

@main
struct CustomerApp: App {
    @StateObject private var session = AppSession(role: "customer", userAgent: "CooperWaters-iOS-Customer")
    @StateObject private var router = Router()

    init() {
        UNUserNotificationCenter.current().delegate = ForegroundNotificationDelegate.shared
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(router)
                .tint(.cwBlue)
        }
    }
}

/// Every screen reachable from Home.
enum Route: Hashable {
    case places
    case placeEdit(id: String?)
    case newOrder(locationId: String?, addressFirst: Bool)
    case payment(orderId: String)
    case tracking(orderId: String)
    case rate(orderId: String)
    case dispute(orderId: String)
    case history
    case profile
    case support
    case wallet
    case topup
    case offers
    case referral
    case inbox
    case chats
    case chat(orderId: String)
}

@MainActor
final class Router: ObservableObject {
    @Published var path: [Route] = []
    func go(_ r: Route) { path.append(r) }
    func back() { if !path.isEmpty { path.removeLast() } }
    func home() { path.removeAll() }
    /// Replace the current screen (e.g. new order → tracking).
    func replaceTop(with r: Route) {
        if !path.isEmpty { path.removeLast() }
        path.append(r)
    }
}

struct RootView: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    @Environment(\.scenePhase) private var phase

    var body: some View {
        Group {
            if !session.signedIn {
                OtpLoginView(appTitle: "Cooper Waters", subtitle: "Clean water delivered to your door in Port Moresby.") { _ in router.home() }
            } else if (session.user?.name ?? "").trimmingCharacters(in: .whitespaces).isEmpty {
                NavigationStack { ProfileScreen(onboarding: true) }
            } else {
                NavigationStack(path: $router.path) {
                    HomeScreen().navigationDestination(for: Route.self) { destination($0) }
                }
            }
        }
        .onAppear {
            LocalNotifications.requestPermission()
            syncRealtime()
        }
        .onChange(of: phase) { _ in syncRealtime() }
        .onChange(of: session.signedIn) { _ in syncRealtime() }
    }

    /// Live updates only while the app is open and signed in.
    private func syncRealtime() {
        if session.signedIn && phase == .active { session.realtime.connect() } else if phase == .background { session.realtime.disconnect() }
    }

    @ViewBuilder
    private func destination(_ r: Route) -> some View {
        switch r {
        case .places: PlacesScreen()
        case .placeEdit(let id): PlaceEditScreen(locationId: id)
        case .newOrder(let loc, let addressFirst): NewOrderScreen(initialLocationId: loc, addressFirst: addressFirst)
        case .payment(let id): PaymentScreen(orderId: id)
        case .tracking(let id): TrackingScreen(orderId: id)
        case .rate(let id): RateScreen(orderId: id)
        case .dispute(let id): DisputeScreen(orderId: id)
        case .history: HistoryScreen()
        case .profile: ProfileScreen(onboarding: false)
        case .support: SupportScreen()
        case .wallet: WalletScreen()
        case .topup: TopupScreen()
        case .offers: OffersScreen()
        case .referral: ReferralScreen()
        case .inbox: InboxScreen()
        case .chats: ChatListScreen()
        case .chat(let id): ChatThreadScreen(orderId: id)
        }
    }
}
