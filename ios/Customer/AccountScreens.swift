import CooperKit
import SwiftUI

/// My orders (StarTrip-style cards) with All / Active / Completed / Cancelled filters.
struct HistoryScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    @StateObject private var list = CursorList<Order>()
    @State private var filter = 0
    @State private var ready = false

    private var shown: [Order] {
        switch filter {
        case 1: return list.items.filter { !OrderStatus.isTerminal($0.status) }
        case 2: return list.items.filter { $0.status == OrderStatus.completed }
        case 3: return list.items.filter { [OrderStatus.cancelled, OrderStatus.expired, OrderStatus.failed].contains($0.status) }
        default: return list.items
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $filter) {
                Text("All").tag(0)
                Text("Active").tag(1)
                Text("Completed").tag(2)
                Text("Cancelled").tag(3)
            }
            .pickerStyle(.segmented)
            .padding(16)
            ScrollView {
                LazyVStack(spacing: 12) {
                    ErrorBanner(list.error) { Task { await list.refresh() } }
                    if !list.loading && shown.isEmpty {
                        EmptyState("No orders here yet.", systemImage: "drop")
                        PrimaryButton("Order water") { router.go(.newOrder(locationId: nil, addressFirst: false)) }
                    }
                    ForEach(shown) { o in
                        Button { router.go(o.status == OrderStatus.pendingPayment ? .payment(orderId: o.id) : .tracking(orderId: o.id)) } label: { OrderCard(order: o) }
                            .buttonStyle(.plain)
                    }
                    if !list.endReached && !list.items.isEmpty {
                        Button("Load more") { Task { await list.loadMore() } }.disabled(list.loading)
                    }
                    if list.loading { ProgressView() }
                }
                .padding(.horizontal, 16)
            }
            .refreshable { await list.refresh() }
        }
        .cwTitle("My orders")
        .task {
            guard !ready else { return }
            ready = true
            let c = session.customer
            list.setFetch { cursor in try await c.orders(cursor: cursor) }
            await list.refresh()
        }
    }
}

struct OrderCard: View {
    let order: Order
    var body: some View {
        CardBox {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("#\(order.code)").font(.headline)
                    Spacer()
                    StatusPill(order.status)
                }
                Text(PomTime.formatDateTime(order.timeline?.createdAt)).font(.caption).foregroundColor(.secondary)
                if let a = order.delivery?.address { Label(a, systemImage: "mappin").font(.subheadline).lineLimit(1) }
                HStack {
                    Text("\(order.package?.name ?? "Water") × \(order.quantity ?? 1)").font(.subheadline)
                    Spacer()
                    Text(Money.format(order.amountDueToea)).font(.headline)
                }
            }
        }
    }
}

struct ProfileScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    let onboarding: Bool
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            Section(footer: Text(onboarding ? "Drivers see this name when they deliver to you." : "")) {
                TextField("Your name", text: $name).textContentType(.name)
                LabelValue("Phone", session.user?.phone ?? "")
            }
            if let error { Section { ErrorBanner(error) } }
            Section {
                PrimaryButton(onboarding ? "Continue" : "Save", busy: busy, enabled: name.trimmingCharacters(in: .whitespaces).count >= 2) { save() }
                    .listRowInsets(EdgeInsets())
            }
            if !onboarding {
                Section {
                    Button("Sign out", role: .destructive) { session.signOut() }
                }
            }
        }
        .cwTitle(onboarding ? "Welcome" : "Profile")
        .onAppear { if name.isEmpty { name = session.user?.name ?? "" } }
    }

    private func save() {
        busy = true
        error = nil
        let n = name.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                _ = try await session.customer.updateMe(name: n)
                session.updateUserName(n)
                if !onboarding { router.back() }
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

/// "Send us a mail": opens the Mail app addressed to support.
struct SupportScreen: View {
    @EnvironmentObject var session: AppSession
    @State private var message = ""
    @State private var noMail = false
    private let to = "support@cooperwaters.com"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Send us a mail").font(.title3.bold())
                TextEditor(text: $message).frame(minHeight: 160).padding(6)
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.35)))
                if noMail { Text("No email app found. Please email \(to).").foregroundColor(.cwRed).font(.subheadline) }
                PrimaryButton("Continue", enabled: !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) { send() }
                Text("You can also email \(to) directly.").font(.caption).foregroundColor(.secondary)
            }
            .padding(16)
        }
        .cwTitle("Help & support")
    }

    private func send() {
        let subject = "Cooper Waters support (\(session.user?.phone ?? ""))"
        var c = URLComponents()
        c.scheme = "mailto"
        c.path = to
        c.queryItems = [URLQueryItem(name: "subject", value: subject), URLQueryItem(name: "body", value: message)]
        guard let url = c.url else { return }
        UIApplication.shared.open(url) { ok in noMail = !ok }
    }
}
