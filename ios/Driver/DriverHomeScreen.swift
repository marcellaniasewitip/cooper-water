import CooperKit
import SwiftUI

/// Home (StarTrip driver style): full-screen map under a white bar with the menu button, ONLINE/OFFLINE
/// title and the requests bell; a white bottom panel with offers or the current job and the big
/// GO ONLINE / GO OFFLINE button. Everything else lives in the blue side menu.
struct DriverHomeScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var state: DriverState
    @EnvironmentObject var router: DriverRouter
    @State private var menuOpen = false

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                topBar
                OfflineStrip(offline: !session.online)
                if state.toggling { ProgressView().progressViewStyle(.linear).tint(.cwBlue) }
                ZStack(alignment: .topTrailing) {
                    CwMap(center: mapCenter, markers: markers, followCenter: true, showsUser: true)
                    Button { Task { if let l = await LocationProvider.shared.current() { state.myLocation = l.coordinate } } } label: {
                        Image(systemName: "location.fill").foregroundColor(.cwBlue).frame(width: 44, height: 44)
                            .background(Circle().fill(Color(UIColor.systemBackground))).shadow(radius: 3)
                    }
                    .padding(12)
                }
            }
            VStack {
                Spacer()
                bottomPanel
            }
            if menuOpen { DriverSideMenu(open: $menuOpen).transition(.move(edge: .leading)).zIndex(2) }
        }
        .toolbar(.hidden, for: .navigationBar)
        .onChange(of: state.acceptedOrderId) { id in
            if let id {
                // Accepted from Home or Live Requests: show the job on top of Home.
                state.acceptedOrderId = nil
                router.home()
                router.go(.job(orderId: id))
            }
        }
        .task {
            if let l = LocationProvider.shared.lastKnown { state.myLocation = l.coordinate }
        }
    }

    private var mapCenter: MapCenter {
        if let me = state.myLocation { return MapCenter(lat: me.latitude, lng: me.longitude, zoom: 15) }
        if let d = state.depots.first { return MapCenter(lat: d.lat, lng: d.lng, zoom: 13) }
        return .portMoresby
    }

    private var markers: [CwMarker] {
        var m = state.depots.map { CwMarker(id: $0.id, lat: $0.lat, lng: $0.lng, title: $0.name, kind: .depot, radiusM: $0.geofenceRadiusM) }
        if state.online && state.activeOrder == nil {
            m += state.offers.compactMap { o in o.delivery.map { CwMarker(id: "offer-\(o.orderId)", lat: $0.lat, lng: $0.lng, title: o.shortCode, kind: .destination) } }
        }
        if let a = state.activeOrder, let d = a.delivery { m.append(CwMarker(id: "job-\(a.id)", lat: d.lat, lng: d.lng, title: a.shortCode, kind: .destination)) }
        return m
    }

    private var topBar: some View {
        HStack {
            Button { withAnimation { menuOpen = true } } label: { Image(systemName: "line.3.horizontal").font(.title2).frame(width: 44, height: 44) }
            Spacer()
            Text(state.online ? "ONLINE" : "OFFLINE").font(.headline).foregroundColor(state.online ? .cwBlue : .primary)
            Spacer()
            Button { router.go(.liveRequests) } label: {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "bell.fill").font(.title3).foregroundColor(.cwBlue).frame(width: 44, height: 44)
                    if !state.offers.isEmpty {
                        Text("\(state.offers.count)").font(.caption2.bold()).foregroundColor(.white).padding(4).background(Circle().fill(Color.cwRed)).offset(x: -4, y: 4)
                    }
                }
            }
        }
        .padding(.horizontal, 6)
        .padding(.bottom, 6)
        .background(Color(UIColor.systemBackground).ignoresSafeArea(edges: .top).shadow(color: .black.opacity(0.1), radius: 3, y: 2))
    }

    private var bottomPanel: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                ErrorBanner(state.error)
                if let m = state.message { Text(m).font(.subheadline).foregroundColor(.cwBlue) }
                if let w = state.wallet, w.blocked == true {
                    HStack {
                        Text("Your balance \(Money.format(w.balanceToea)) is below the \(Money.format(w.minBalanceToea)) minimum. Top up to take jobs.").font(.caption)
                        Spacer()
                        Button("Top up") { router.go(.topup) }.buttonStyle(.borderedProminent)
                    }
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.cwRed.opacity(0.12)))
                }
                if let job = state.activeOrder {
                    CardBox {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Current job \(job.code)").font(.headline)
                            Text(OrderStatus.label(job.status))
                            if let a = job.delivery?.address { Text(a).font(.caption).foregroundColor(.secondary) }
                            PrimaryButton("Open job") { router.go(.job(orderId: job.id)) }.padding(.top, 6)
                        }
                    }
                } else if state.online {
                    if state.offers.isEmpty {
                        Text("Waiting for requests near you…").font(.subheadline).foregroundColor(.secondary)
                    } else {
                        ForEach(state.offers) { o in OfferCard(offer: o) }
                    }
                } else if let nd = state.nearestDepot() {
                    Text("Nearest depot: \(nd.0.name) (\(Geo.formatDistance(nd.1))). Go online from inside a depot.").font(.caption).foregroundColor(.secondary)
                }
                Text(state.online ? "You are online" : "You are offline").font(.body)
                if state.online {
                    SecondaryButton("Go offline", enabled: !state.toggling) { Task { await state.goOffline() } }
                } else {
                    PrimaryButton("Go online", busy: state.toggling) { Task { await state.goOnline() } }
                }
            }
            .padding(16)
        }
        .frame(maxHeight: 440)
        .fixedSize(horizontal: false, vertical: true)
        .background(
            RoundedRectangle(cornerRadius: 20).fill(Color(UIColor.systemBackground)).ignoresSafeArea(edges: .bottom)
                .shadow(color: .black.opacity(0.15), radius: 10, y: -2)
        )
    }
}

/// One job offer with countdown, earnings, load, distance and Accept / Decline.
struct OfferCard: View {
    @EnvironmentObject var state: DriverState
    let offer: Offer

    var body: some View {
        CardBox {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(offer.shortCode ?? "").font(.headline)
                    Spacer()
                    Countdown(until: offer.expiresAt) { secs in
                        if let secs {
                            Text(secs <= 0 ? "Expired" : "Expires in \(PomTime.formatCountdown(secs))")
                                .font(.subheadline.bold()).foregroundColor(secs < 60 ? .cwRed : .primary)
                        }
                    }
                }
                Text("Earn \(Money.format(offer.earningsToea))").font(.title2.bold()).foregroundColor(.cwBlue)
                Text("\(offer.quantity ?? 1) × \(offer.package ?? "") (\(offer.volumeLitres ?? 0) L)")
                if let d = offer.distanceM { Text("\(Geo.formatDistance(d)) away") }
                if let m = offer.paymentMethod { Text(Labels.paymentMethod(m)).font(.caption).foregroundColor(.secondary) }
                if let d = offer.delivery {
                    Text(d.address ?? "").font(.subheadline)
                    if let n = d.notes, !n.isEmpty { Text("Landmark: \(n)").font(.caption).foregroundColor(.secondary) }
                }
                let expired = (PomTime.secondsUntil(offer.expiresAt) ?? 1) <= 0
                let busy = state.accepting != nil || state.declining == offer.orderId
                HStack(spacing: 10) {
                    SecondaryButton("Decline", enabled: !busy && !expired) { Task { await state.decline(offer) } }
                    PrimaryButton(state.accepting == offer.orderId ? "Accepting…" : "Accept", busy: state.accepting == offer.orderId, enabled: !busy && !expired) {
                        Task { await state.accept(offer) }
                    }
                }
            }
        }
    }
}

/// Side menu in the brand blue: profile header with rating and balance, online switch, menu items.
struct DriverSideMenu: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var state: DriverState
    @EnvironmentObject var router: DriverRouter
    @Binding var open: Bool

    var body: some View {
        ZStack(alignment: .leading) {
            Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { close() }
            VStack(alignment: .leading, spacing: 0) {
                Button { go(.profile) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Image(systemName: "drop.fill").font(.system(size: 36)).foregroundColor(.cwBlue)
                                .frame(width: 64, height: 64).background(RoundedRectangle(cornerRadius: 8).fill(Color.white))
                            Spacer()
                            Image(systemName: "chevron.right").foregroundColor(.white)
                        }
                        Text(state.profile?.name ?? "Profile").font(.headline).foregroundColor(.white)
                        HStack(spacing: 2) {
                            let r = state.profile?.ratingAvg ?? 0
                            ForEach(1...5, id: \.self) { i in
                                Image(systemName: "star.fill").font(.caption).foregroundColor(.white.opacity(r >= Double(i) - 0.5 ? 1 : 0.3))
                            }
                            if r > 0 { Text(String(format: " %.1f", r)).font(.caption).foregroundColor(.white) }
                        }
                        if let w = state.wallet { Text("\(Money.format(w.balanceToea)) balance").font(.caption).foregroundColor(.white.opacity(0.85)) }
                    }
                    .padding(20)
                }
                .buttonStyle(.plain)
                HStack {
                    Image(systemName: "truck.box.fill").foregroundColor(.white).frame(width: 24)
                    Text(state.online ? "Cooper Waters Driver ON" : "Cooper Waters Driver OFF").foregroundColor(.white)
                    Spacer()
                    Toggle("", isOn: Binding(get: { state.online }, set: { on in Task { if on { await state.goOnline() } else { await state.goOffline() } } }))
                        .labelsHidden().tint(.green).disabled(state.toggling)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        item("bell.fill", "Live Requests") { go(.liveRequests) }
                        item("chart.bar.fill", "Earnings") { go(.earnings) }
                        item("creditcard.fill", "Wallet") { go(.wallet) }
                        item("list.bullet", "Job History") { go(.history) }
                        item("envelope.fill", "Messages") { go(.chats) }
                        item("info.circle.fill", "Announcements") { go(.announcements) }
                        item("person.fill", "Profile") { go(.profile) }
                        item("phone.fill", "Support") { go(.support) }
                        Divider().background(Color.white.opacity(0.3)).padding(.vertical, 8)
                        item("rectangle.portrait.and.arrow.right", "Logout") {
                            close()
                            Task { if state.online { await state.goOffline() } ; session.signOut() }
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
            HStack(spacing: 16) {
                Image(systemName: icon).frame(width: 24).foregroundColor(.white)
                Text(title).foregroundColor(.white)
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 13)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func go(_ r: DriverRoute) {
        close()
        router.go(r)
    }

    private func close() { withAnimation { open = false } }
}

struct LiveRequestsScreen: View {
    @EnvironmentObject var state: DriverState
    @EnvironmentObject var router: DriverRouter

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                ErrorBanner(state.error)
                if state.offers.isEmpty {
                    EmptyState(state.online ? "No Live Requests Currently" : "You are offline. Go online to receive requests.", systemImage: "bell")
                }
                ForEach(state.offers) { o in OfferCard(offer: o) }
            }
            .padding(16)
        }
        .cwTitle("Live Requests")
        .refreshable { await state.refreshOffers() }
    }
}
