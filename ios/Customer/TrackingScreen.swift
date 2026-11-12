import CooperKit
import SwiftUI

/// Live tracking: map with the driver, status timeline, driver card (call / message), and the actions
/// allowed in the current status (pay, confirm receipt, rate, cancel, report a problem).
struct TrackingScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    let orderId: String

    @State private var order: Order?
    @State private var driverLoc: DriverLocation?
    @State private var cancelFreeUntil = OrderStatus.accepted
    @State private var busy = false
    @State private var error: String?
    @State private var info: String?
    @State private var askCancel = false
    private let timer = Timer.publish(every: 20, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let o = order {
                    map(o)
                    HStack {
                        StatusPill(o.status)
                        Spacer()
                        Text(Money.format(o.amountDueToea)).font(.headline)
                    }
                    ErrorBanner(error)
                    if let info { Text(info).foregroundColor(.cwBlue) }
                    if let d = o.driver, let name = d.name, !name.isEmpty { driverCard(d, name: name) }
                    actions(o)
                    timeline(o)
                    details(o)
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                    ErrorBanner(error) { Task { await load() } }
                }
            }
            .padding(16)
        }
        .cwTitle(order.map { "#\($0.code)" } ?? "Order")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
            }
        }
        .task {
            if let c = try? await session.customer.config() { cancelFreeUntil = c.cancelFreeUntil ?? OrderStatus.accepted }
            await load()
        }
        .onReceive(timer) { _ in
            if let o = order, !OrderStatus.isTerminal(o.status) { Task { await load() } }
        }
        .onReceive(session.realtime.events) { e in
            switch e {
            case .orderUpdated(let o) where o.id == orderId:
                if o.delivery == nil, var cur = order { cur.status = o.status; order = cur } else { order = o }
                Task { await load() }
            case .driverLocation(let id, let lat, let lng, let at) where id == orderId:
                driverLoc = DriverLocation(lat: lat, lng: lng, at: at)
            default: break
            }
        }
        .confirmationDialog("Cancel this order?", isPresented: $askCancel, titleVisibility: .visible) {
            ForEach(["Ordered by mistake", "Changed my mind", "Taking too long", "Found water elsewhere"], id: \.self) { r in
                Button(r, role: .destructive) { cancel(r) }
            }
        }
    }

    private func map(_ o: Order) -> some View {
        var markers: [CwMarker] = []
        if let d = o.delivery { markers.append(CwMarker(id: "dest", lat: d.lat, lng: d.lng, title: "Delivery", kind: .destination)) }
        let loc = driverLoc ?? o.driver?.location
        if let l = loc, OrderStatus.isTrackable(o.status) { markers.append(CwMarker(id: "driver", lat: l.lat, lng: l.lng, title: "Driver", kind: .driver)) }
        let center = loc.flatMap { OrderStatus.isTrackable(o.status) ? MapCenter(lat: $0.lat, lng: $0.lng, zoom: 15) : nil }
            ?? o.delivery.map { MapCenter(lat: $0.lat, lng: $0.lng, zoom: 15) } ?? .portMoresby
        return VStack(alignment: .leading, spacing: 4) {
            CwMap(center: center, markers: markers, followCenter: true)
                .frame(height: 230)
                .clipShape(RoundedRectangle(cornerRadius: 14))
            if let at = loc?.at, OrderStatus.isTrackable(o.status) {
                Text("Driver seen at \(PomTime.formatTime(at))").font(.caption).foregroundColor(.secondary)
            }
        }
    }

    private func driverCard(_ d: OrderDriver, name: String) -> some View {
        CardBox {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(name).font(.headline)
                    if let p = d.truck?.plate, !p.isEmpty { Text("Truck \(p)").font(.caption) }
                    if let r = d.ratingAvg, r > 0 { Text(String(format: "★ %.1f", r)).font(.caption) }
                }
                Spacer()
                Button { router.go(.chat(orderId: orderId)) } label: {
                    Image(systemName: "message.fill").padding(10).background(Circle().fill(Color.cwBlueTint))
                }
                if let phone = d.phone {
                    Button { Phone.dial(phone) } label: {
                        Image(systemName: "phone.fill").padding(10).background(Circle().fill(Color.cwBlueTint))
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func actions(_ o: Order) -> some View {
        if o.status == OrderStatus.pendingPayment {
            PrimaryButton("Pay now") { router.go(.payment(orderId: orderId)) }
        }
        if o.status == OrderStatus.delivered {
            Text("Did you receive your water? Confirm to complete the order.").font(.subheadline)
            PrimaryButton("Confirm I received it", busy: busy) { confirm() }
        }
        if o.status == OrderStatus.completed {
            PrimaryButton("Rate your delivery") { router.go(.rate(orderId: orderId)) }
        }
        if OrderStatus.customerMayCancel(o.status, cancelFreeUntil: cancelFreeUntil) {
            SecondaryButton("Cancel order", enabled: !busy) { askCancel = true }
        } else if !OrderStatus.isTerminal(o.status) && o.status != OrderStatus.delivered {
            Text("The driver is on the job, so the order can no longer be cancelled here.").font(.caption).foregroundColor(.secondary)
        }
        if OrderStatus.isDisputable(o.status) {
            Button("Report a problem") { router.go(.dispute(orderId: orderId)) }.font(.subheadline)
        }
    }

    private func timeline(_ o: Order) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle("Progress")
            ForEach(OrderStatus.steps(o), id: \.self) { s in
                HStack(spacing: 12) {
                    Image(systemName: s.done ? "checkmark.circle.fill" : "circle")
                        .foregroundColor(s.current ? .cwBlue : (s.done ? .cwGreen : .secondary))
                    Text(OrderStatus.label(s.status)).fontWeight(s.current ? .bold : .regular)
                    Spacer()
                    Text(PomTime.formatTime(s.at)).font(.caption).foregroundColor(.secondary)
                }
            }
        }
    }

    private func details(_ o: Order) -> some View {
        CardBox {
            VStack(spacing: 8) {
                if let p = o.package { LabelValue("Package", "\(p.name ?? "") × \(o.quantity ?? 1)") }
                if let a = o.delivery?.address { LabelValue("Deliver to", a) }
                LabelValue("Payment", Labels.paymentMethod(o.paymentMethod))
                if (o.discountToea ?? 0) > 0 { LabelValue("Discount", "-" + Money.format(o.discountToea)) }
                if let r = o.cancelReason { LabelValue("Reason", r) }
                LabelValue("Ordered", PomTime.formatDateTime(o.timeline?.createdAt))
            }
        }
    }

    private func load() async {
        do {
            let o = try await session.customer.order(orderId)
            order = o
            if let l = o.driver?.location { driverLoc = l }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func confirm() {
        busy = true
        Task {
            do {
                order = try await session.customer.confirm(orderId)
                info = "Thanks! Your order is complete."
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    private func cancel(_ reason: String) {
        busy = true
        Task {
            do {
                order = try await session.customer.cancel(orderId, reason: reason)
                info = "Order cancelled."
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

struct RateScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    let orderId: String
    @State private var stars = 5
    @State private var comment = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            Section("How was your delivery?") {
                HStack {
                    ForEach(1...5, id: \.self) { i in
                        Image(systemName: i <= stars ? "star.fill" : "star").font(.title).foregroundColor(.orange)
                            .onTapGesture { stars = i }
                    }
                }
                .frame(maxWidth: .infinity)
                TextField("Comment (optional)", text: $comment, axis: .vertical).lineLimit(3...6)
            }
            if let error { Section { ErrorBanner(error) } }
            Section {
                PrimaryButton("Submit rating", busy: busy) {
                    busy = true
                    Task {
                        do {
                            try await session.customer.rate(orderId, stars: stars, comment: comment.isEmpty ? nil : comment)
                            router.back()
                        } catch {
                            self.error = error.localizedDescription
                        }
                        busy = false
                    }
                }
                .listRowInsets(EdgeInsets())
            }
        }
        .cwTitle("Rate delivery")
    }
}

struct DisputeScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    let orderId: String
    @State private var categories: [String] = []
    @State private var category = ""
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            Section("What went wrong?") {
                Picker("Problem", selection: $category) {
                    ForEach(categories, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0) }
                }
                TextField("Tell us what happened", text: $text, axis: .vertical).lineLimit(4...8)
            }
            if let error { Section { ErrorBanner(error) } }
            Section {
                PrimaryButton("Send report", busy: busy, enabled: !category.isEmpty && text.trimmingCharacters(in: .whitespaces).count >= 5) {
                    busy = true
                    Task {
                        do {
                            try await session.customer.dispute(orderId, category: category, description: text)
                            router.back()
                        } catch {
                            self.error = error.localizedDescription
                        }
                        busy = false
                    }
                }
                .listRowInsets(EdgeInsets())
            }
        }
        .cwTitle("Report a problem")
        .task {
            let c = (try? await session.customer.config())?.disputeCategories ?? []
            categories = c.isEmpty ? ["short_delivery", "late", "quality", "driver_conduct", "other"] : c
            if category.isEmpty { category = categories.first ?? "" }
        }
    }
}
