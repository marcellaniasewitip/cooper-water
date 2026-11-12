import CooperKit
import SwiftUI
import UserNotifications

@main
struct DriverApp: App {
    @StateObject private var session: AppSession
    @StateObject private var state: DriverState
    @StateObject private var router = DriverRouter()

    init() {
        UNUserNotificationCenter.current().delegate = ForegroundNotificationDelegate.shared
        let s = AppSession(role: "driver", userAgent: "CooperWaters-iOS-Driver")
        _session = StateObject(wrappedValue: s)
        _state = StateObject(wrappedValue: DriverState(session: s))
    }

    var body: some Scene {
        WindowGroup {
            DriverRoot()
                .environmentObject(session)
                .environmentObject(state)
                .environmentObject(router)
                .tint(.cwBlue)
        }
    }
}

enum DriverRoute: Hashable {
    case job(orderId: String)
    case issue(orderId: String)
    case liveRequests
    case wallet
    case topup
    case withdraw
    case earnings
    case history
    case chats
    case chat(orderId: String)
    case announcements
    case profile
    case support
}

@MainActor
final class DriverRouter: ObservableObject {
    @Published var path: [DriverRoute] = []
    func go(_ r: DriverRoute) { path.append(r) }
    func back() { if !path.isEmpty { path.removeLast() } }
    func home() { path.removeAll() }
}

/// Gate: sign in → documents/truck (pending_docs) → waiting for approval → work (Home).
struct DriverRoot: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var state: DriverState
    @EnvironmentObject var router: DriverRouter
    @Environment(\.scenePhase) private var phase
    @State private var name = ""

    var body: some View {
        Group {
            if !session.signedIn {
                OtpLoginView(appTitle: "Cooper Waters Driver", subtitle: "Deliver water and earn with Cooper Waters.") { _ in
                    Task { await state.refreshAll() }
                }
            } else if let p = state.profile {
                if (p.name ?? "").trimmingCharacters(in: .whitespaces).isEmpty {
                    NavigationStack { DriverProfileScreen(onboarding: true) }
                } else {
                    switch p.status {
                    case "approved":
                        NavigationStack(path: $router.path) {
                            DriverHomeScreen().navigationDestination(for: DriverRoute.self) { destination($0) }
                        }
                    case "pending_docs":
                        NavigationStack { OnboardingScreen() }
                    default:
                        NavigationStack { WaitingScreen() }
                    }
                }
            } else {
                VStack(spacing: 16) {
                    ProgressView()
                    ErrorBanner(state.error) { Task { await state.refreshAll() } }
                }
                .padding()
            }
        }
        .onAppear {
            LocalNotifications.requestPermission()
            session.foreground = phase == .active
            syncRealtime()
            if session.signedIn { Task { await state.refreshAll() } }
        }
        .onChange(of: phase) { p in
            session.foreground = p == .active
            syncRealtime()
            if p == .active && session.signedIn { Task { await state.refreshAll() } }
        }
        .onChange(of: session.signedIn) { signedIn in
            syncRealtime()
            if !signedIn {
                state.signedOut()
                router.home()
            }
        }
        .onChange(of: state.profile?.online) { _ in syncRealtime() }
    }

    /// Live connection while the app is visible OR the driver is online (offers are time-critical).
    private func syncRealtime() {
        if session.signedIn && (phase == .active || state.online) { session.realtime.connect() } else { session.realtime.disconnect() }
    }

    @ViewBuilder
    private func destination(_ r: DriverRoute) -> some View {
        switch r {
        case .job(let id): JobScreen(orderId: id)
        case .issue(let id): IssueScreen(orderId: id)
        case .liveRequests: LiveRequestsScreen()
        case .wallet: DriverWalletScreen()
        case .topup: DriverTopupScreen()
        case .withdraw: WithdrawScreen()
        case .earnings: EarningsScreen()
        case .history: JobHistoryScreen()
        case .chats: DriverChatListScreen()
        case .chat(let id): DriverChatScreen(orderId: id)
        case .announcements: AnnouncementsScreen()
        case .profile: DriverProfileScreen(onboarding: false)
        case .support: DriverSupportScreen()
        }
    }
}
