import CooperKit
import SwiftUI
import UserNotifications

@main
struct DriverApp: App {
    @StateObject private var session = AppSession(role: "driver", userAgent: "CooperWaters-iOS-Driver")

    init() {
        UNUserNotificationCenter.current().delegate = ForegroundNotificationDelegate.shared
    }

    var body: some Scene {
        WindowGroup {
            DriverRoot().environmentObject(session).tint(.cwBlue)
        }
    }
}

struct DriverRoot: View {
    @EnvironmentObject var session: AppSession
    var body: some View {
        if session.signedIn {
            NavigationStack {
                VStack(spacing: 16) {
                    Text("Signed in as \(session.user?.name ?? session.user?.phone ?? "")")
                    SecondaryButton("Sign out") { session.signOut() }
                }
                .padding()
                .cwTitle("Driver")
            }
        } else {
            OtpLoginView(appTitle: "Cooper Waters Driver", subtitle: "Deliver water and earn with Cooper Waters.") { _ in }
        }
    }
}
