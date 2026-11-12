#if canImport(UIKit)
import Combine
import Network
import SwiftUI
import UserNotifications

/// App-wide state shared by every screen: API client, sign-in, live connection and connectivity.
@MainActor
public final class AppSession: ObservableObject {
    /// "customer" or "driver" (sent with the sign-in code).
    public let role: String
    public let api: APIClient
    public let realtime: RealtimeClient
    @Published public private(set) var signedIn: Bool
    @Published public private(set) var user: AuthUser?
    @Published public private(set) var online = true
    @Published public var foreground = true

    private let monitor = NWPathMonitor()
    private var bag = Set<AnyCancellable>()

    public init(role: String, userAgent: String) {
        self.role = role
        let tokens = TokenStore(service: "com.cooperwaters.\(role).session")
        let api = APIClient(config: .fromBundle(userAgent: userAgent), tokens: tokens)
        self.api = api
        realtime = RealtimeClient(api: api)
        signedIn = tokens.isSignedIn
        user = tokens.user()
        api.onSessionExpired = { [weak self] in self?.markSignedOut() }
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in self?.online = path.status == .satisfied }
        }
        monitor.start(queue: DispatchQueue(label: "cw.net"))
        // Show Cooper Waters push messages that arrive live as phone notifications.
        realtime.events.sink { event in
            if case let .message(id, title, body) = event { LocalNotifications.show(id: id, title: title, body: body) }
        }.store(in: &bag)
    }

    public func didSignIn(_ r: AuthResponse) {
        user = r.user
        signedIn = true
    }

    public func updateUserName(_ name: String) {
        guard var u = user else { return }
        u.name = name
        user = u
        api.tokens.saveUser(u)
    }

    public func signOut() {
        realtime.disconnect()
        Task {
            await api.logout()
            markSignedOut()
        }
    }

    private func markSignedOut() {
        realtime.disconnect()
        api.tokens.clear()
        user = nil
        signedIn = false
    }

    public var appVersion: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        let sha = (Bundle.main.object(forInfoDictionaryKey: "GIT_SHA") as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "dev"
        return "Version \(v) (\(b)) · \(sha)"
    }
}

/// Local notifications (push messages, chat, offers) shown even while the app is open.
public enum LocalNotifications {
    public static func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    public static func show(id: String, title: String, body: String, sound: UNNotificationSound? = .default) {
        let content = UNMutableNotificationContent()
        content.title = title.isEmpty ? "Cooper Waters" : title
        content.body = body
        content.sound = sound
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    public static func cancel(id: String) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [id])
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
    }
}

/// Presents notifications as banners while the app is in the foreground.
public final class ForegroundNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    public static let shared = ForegroundNotificationDelegate()
    public func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }
}

// MARK: - Sign in

/// Phone number → SMS code sign-in, shared by both apps.
public struct OtpLoginView: View {
    @EnvironmentObject var session: AppSession
    let appTitle: String
    let subtitle: String
    let onSignedIn: (AuthResponse) -> Void

    @State private var phone = ""
    @State private var code = ""
    @State private var codeSentTo: String?
    @State private var trainingCode: String?
    @State private var busy = false
    @State private var error: String?

    public init(appTitle: String, subtitle: String, onSignedIn: @escaping (AuthResponse) -> Void) {
        self.appTitle = appTitle
        self.subtitle = subtitle
        self.onSignedIn = onSignedIn
    }

    public var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Image(systemName: "drop.fill").font(.system(size: 64)).foregroundColor(.cwBlue).padding(.top, 50)
                Text(appTitle).font(.largeTitle.bold())
                Text(subtitle).font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
                if codeSentTo == nil {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Mobile number").font(.subheadline.bold())
                        HStack {
                            Text("+675").foregroundColor(.secondary)
                            TextField("7xxx xxxx", text: $phone).keyboardType(.phonePad).textContentType(.telephoneNumber)
                        }
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.35)))
                    }
                    ErrorBanner(error)
                    PrimaryButton("Send code", busy: busy, enabled: phone.filter(\.isNumber).count >= 7) { sendCode() }
                } else {
                    Text("Enter the 6-digit code we sent to \(codeSentTo ?? "")").font(.subheadline).multilineTextAlignment(.center)
                    if let trainingCode {
                        Text("Training mode: your code is \(trainingCode)").font(.footnote.bold()).foregroundColor(.orange)
                    }
                    TextField("123456", text: $code)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .font(.title2.monospacedDigit())
                        .multilineTextAlignment(.center)
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.35)))
                        .onChange(of: code) { v in code = String(v.filter(\.isNumber).prefix(6)) }
                    ErrorBanner(error)
                    PrimaryButton("Sign in", busy: busy, enabled: code.count == 6) { verify() }
                    Button("Change number") {
                        codeSentTo = nil
                        code = ""
                        error = nil
                    }
                    .font(.subheadline)
                }
                Text(session.appVersion).font(.caption2).foregroundColor(.secondary).padding(.top, 20)
            }
            .padding(24)
        }
    }

    private var e164: String {
        let digits = phone.filter { $0.isNumber || $0 == "+" }
        if digits.hasPrefix("+") { return digits }
        if digits.hasPrefix("675") { return "+" + digits }
        return "+675" + digits
    }

    private func sendCode() {
        busy = true
        error = nil
        Task {
            do {
                let r = try await session.api.requestOtp(phone: e164)
                codeSentTo = r.phone
                trainingCode = r.trainingMode == true ? r.trainingCode : nil
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    private func verify() {
        busy = true
        error = nil
        Task {
            do {
                let r = try await session.api.verifyOtp(phone: codeSentTo ?? e164, code: code, app: session.role, name: nil)
                session.didSignIn(r)
                onSignedIn(r)
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

// MARK: - Cursor paging

/// Cursor-paginated list state (`{ items, nextCursor }` pages) for "Load more" lists.
@MainActor
public final class CursorList<T: Decodable & Identifiable>: ObservableObject {
    @Published public private(set) var items: [T] = []
    @Published public private(set) var loading = false
    @Published public private(set) var endReached = false
    @Published public var error: String?
    private var cursor: String?
    private var fetch: (String?) async throws -> Page<T>

    public init(fetch: @escaping (String?) async throws -> Page<T> = { _ in Page(items: [], nextCursor: nil) }) { self.fetch = fetch }

    /// Set the page loader once the screen has its session (StateObject can't see the environment at init).
    public func setFetch(_ f: @escaping (String?) async throws -> Page<T>) { fetch = f }

    public func refresh() async {
        cursor = nil
        endReached = false
        await load(reset: true)
    }

    public func loadMore() async {
        guard !endReached, !loading else { return }
        await load(reset: false)
    }

    private func load(reset: Bool) async {
        loading = true
        error = nil
        do {
            let page = try await fetch(reset ? nil : cursor)
            items = reset ? page.items : items + page.items
            cursor = page.nextCursor
            endReached = page.nextCursor == nil
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}
#endif
