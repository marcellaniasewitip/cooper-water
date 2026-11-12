import CooperKit
import SwiftUI

@MainActor
final class HomeModel: ObservableObject {
    @Published var places: [SavedLocation] = []
    @Published var active: [Order] = []
    @Published var loading = false
    @Published var error: String?

    func refresh(_ session: AppSession) async {
        loading = true
        let c = session.customer
        async let placesR = capture { try await c.locations() }
        async let ordersR = capture { try await c.orders(cursor: nil, limit: 20) }
        let (p, o) = await (placesR, ordersR)
        if case .success(let v) = p { places = v }
        if case .success(let page) = o { active = page.items.filter { !OrderStatus.isTerminal($0.status) } }
        if case .failure(let e) = o { error = e.localizedDescription } else { error = nil }
        loading = false
    }
}

/// Run an async call and keep its result or error (for loading several things at once).
func capture<T>(_ body: () async throws -> T) async -> Result<T, Error> {
    do { return .success(try await body()) } catch { return .failure(error) }
}

/// Home (StarTrip style): full-screen map, round menu button, white bottom panel with
/// "Where should we deliver?", saved places and service tiles. Everything else is in the side menu.
struct HomeScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    @StateObject private var model = HomeModel()
    @State private var menuOpen = false

    var body: some View {
        ZStack(alignment: .bottom) {
            CwMap(
                center: model.places.first.map { MapCenter(lat: $0.lat, lng: $0.lng, zoom: 15) } ?? .portMoresby,
                markers: model.places.map { CwMarker(id: $0.id, lat: $0.lat, lng: $0.lng, title: $0.label, kind: .destination) },
                followCenter: true
            )
            .ignoresSafeArea()

            VStack {
                HStack {
                    RoundButton(systemImage: "line.3.horizontal") { withAnimation { menuOpen = true } }
                    Spacer()
                    RoundButton(systemImage: "arrow.clockwise") { Task { await model.refresh(session) } }
                }
                .padding(.horizontal, 16)
                Spacer()
            }

            bottomPanel

            if menuOpen {
                SideMenu(open: $menuOpen).transition(.move(edge: .leading)).zIndex(2)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task { await model.refresh(session) }
        .onReceive(session.realtime.events) { e in
            if case .orderUpdated = e { Task { await model.refresh(session) } }
        }
        .onChange(of: router.path) { p in if p.isEmpty { Task { await model.refresh(session) } } }
    }

    private var bottomPanel: some View {
        VStack(spacing: 0) {
            OfflineStrip(offline: !session.online)
            VStack(spacing: 10) {
                ForEach(model.active) { o in ActiveOrderCard(order: o) { open(o) } }
                ErrorBanner(model.error) { Task { await model.refresh(session) } }
                Button { router.go(.newOrder(locationId: nil, addressFirst: true)) } label: {
                    HStack {
                        Text("Where should we deliver?").foregroundColor(.secondary)
                        Spacer()
                        Image(systemName: "drop.fill").foregroundColor(.white).frame(width: 40, height: 40).background(Circle().fill(Color.cwBlue))
                    }
                    .padding(.leading, 16)
                    .padding(.trailing, 8)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color(UIColor.secondarySystemBackground)))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)

            ForEach(model.places.prefix(2)) { p in
                Button { router.go(.newOrder(locationId: p.id, addressFirst: true)) } label: {
                    HStack(spacing: 16) {
                        Image(systemName: "clock").foregroundColor(.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.label).font(.body.bold())
                            Text(p.addressText).font(.subheadline).foregroundColor(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundColor(.secondary)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Divider().padding(.leading, 56)
            }

            HStack(spacing: 12) {
                ServiceTile(title: "Water delivery", systemImage: "drop.fill", selected: true) { router.go(.newOrder(locationId: nil, addressFirst: false)) }
                ServiceTile(title: "My orders", systemImage: "list.bullet", selected: false) { router.go(.history) }
            }
            .padding(16)
        }
        .background(
            RoundedRectangle(cornerRadius: 24).fill(Color(UIColor.systemBackground)).ignoresSafeArea(edges: .bottom)
                .shadow(color: .black.opacity(0.15), radius: 10, y: -2)
        )
    }

    private func open(_ o: Order) {
        router.go(o.status == OrderStatus.pendingPayment ? .payment(orderId: o.id) : .tracking(orderId: o.id))
    }
}

struct RoundButton: View {
    let systemImage: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage).font(.title3.bold()).foregroundColor(.white)
                .frame(width: 52, height: 52)
                .background(Circle().fill(Color.cwBlueDeep))
                .shadow(radius: 3)
        }
    }
}

struct ServiceTile: View {
    let title: String
    let systemImage: String
    let selected: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading) {
                HStack {
                    Spacer()
                    Image(systemName: systemImage).font(.title2).foregroundColor(selected ? .white.opacity(0.8) : .cwBlue)
                }
                Spacer()
                Text(title).font(.headline).foregroundColor(selected ? .white : .primary)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 92)
            .background(RoundedRectangle(cornerRadius: 12).fill(selected ? Color.cwBlue : Color(UIColor.systemBackground)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(selected ? Color.clear : Color.secondary.opacity(0.3)))
        }
        .buttonStyle(.plain)
    }
}

struct ActiveOrderCard: View {
    let order: Order
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("#\(order.code)").font(.headline)
                    StatusPill(order.status)
                    if let a = order.delivery?.address { Text(a).font(.caption).foregroundColor(.secondary).lineLimit(1) }
                }
                Spacer()
                Image(systemName: "chevron.right").foregroundColor(.secondary)
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.cwBlueTint.opacity(0.6)))
        }
        .buttonStyle(.plain)
    }
}

/// Side menu in the brand blue: profile header, then the menu list (same as the Android app).
struct SideMenu: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    @Binding var open: Bool

    var body: some View {
        ZStack(alignment: .leading) {
            Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { close() }
            VStack(alignment: .leading, spacing: 0) {
                Button { go(.profile) } label: {
                    HStack(spacing: 14) {
                        Image(systemName: "person.fill").font(.system(size: 34)).foregroundColor(.cwBlue)
                            .frame(width: 64, height: 64).background(Circle().fill(Color.white))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(session.user?.name ?? "Profile").font(.headline).foregroundColor(.white)
                            Text(session.user?.phone ?? "").font(.subheadline).foregroundColor(.white.opacity(0.8))
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundColor(.white)
                    }
                    .padding(20)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        item("drop.fill", "Order water") { go(.newOrder(locationId: nil, addressFirst: false)) }
                        item("list.bullet", "My orders") { go(.history) }
                        item("creditcard.fill", "Wallet") { go(.wallet) }
                        item("star.fill", "Offers") { go(.offers) }
                        item("heart.fill", "Refer & Earn") { go(.referral) }
                        item("bell.fill", "Inbox") { go(.inbox) }
                        item("paperplane.fill", "Chat") { go(.chats) }
                        item("mappin.and.ellipse", "Saved places") { go(.places) }
                        item("person.fill", "Profile") { go(.profile) }
                        item("envelope.fill", "Help & support") { go(.support) }
                        Divider().background(Color.white.opacity(0.3)).padding(.vertical, 8)
                        item("rectangle.portrait.and.arrow.right", "Sign out") {
                            close()
                            session.signOut()
                        }
                    }
                }
                Text(session.appVersion).font(.caption).foregroundColor(.white.opacity(0.7)).padding(16)
            }
            .frame(width: 300)
            .frame(maxHeight: .infinity)
            .background(Color.cwBlue.ignoresSafeArea())
        }
    }

    private func item(_ icon: String, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 18) {
                Image(systemName: icon).frame(width: 24).foregroundColor(.white)
                Text(title).font(.body).foregroundColor(.white)
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 13)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func go(_ r: Route) {
        close()
        router.go(r)
    }

    private func close() { withAnimation { open = false } }
}
