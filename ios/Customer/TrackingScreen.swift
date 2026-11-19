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
    @State private var eta: Eta?
    @State private var profileEmail: String?
    @State private var receiptEmail = ""
    @State private var saveEmail = true
    @State private var receiptBusy = false
    @State private var receiptInfo: String?
    @State private var receiptError: String?
    @State private var etaAt = Date.distantPast
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
                    if let eta, Eta.statuses.contains(o.status) { etaCard(eta) }
                    if let d = o.driver, let name = d.name, !name.isEmpty { driverCard(d, name: name) }
                    actions(o)
                    if ReceiptRules.statuses.contains(o.status) { receiptCard(o) }
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
            if let me = try? await session.customer.me() { profileEmail = me.email }
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
                // The driver moved: refresh the arrival time (at most every 30 s).
                if Date().timeIntervalSince(etaAt) > 30 { Task { await loadEta() } }
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
        await loadEta()
    }

    /// "Email my receipt": prefilled with the profile email (or the last one used); any address can be typed.
    @ViewBuilder
    private func receiptCard(_ o: Order) -> some View {
        let value = receiptEmail.isEmpty ? (profileEmail ?? o.receipt?.email ?? "") : receiptEmail
        let isProfile = !(profileEmail ?? "").isEmpty && value.lowercased() == (profileEmail ?? "").lowercased()
        CardBox {
            VStack(alignment: .leading, spacing: 10) {
                Text("Your receipt").font(.headline)
                if o.receipt?.signed == true {
                    Text("Signed for by \((o.receipt?.signedByName).flatMap { $0.isEmpty ? nil : $0 } ?? "you")").font(.subheadline)
                }
                TextField("Email address", text: Binding(get: { value }, set: { receiptEmail = $0.trimmingCharacters(in: .whitespaces) }))
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                if !isProfile { Toggle("Save this email on my profile", isOn: $saveEmail).font(.subheadline) }
                PrimaryButton("Email my receipt", busy: receiptBusy) { sendReceipt(value, save: saveEmail && !isProfile) }
                if let receiptInfo { Text(receiptInfo).font(.subheadline).foregroundColor(.cwGreen) }
                ErrorBanner(receiptError)
                if let at = o.receipt?.sentAt {
                    Text("Last sent to \(o.receipt?.email ?? "") at \(PomTime.formatTime(at))").font(.caption).foregroundColor(.secondary)
                }
            }
        }
    }

    private func sendReceipt(_ email: String, save: Bool) {
        guard ReceiptRules.isValidEmail(email) else {
            receiptError = "Enter a valid email address."
            receiptInfo = nil
            return
        }
        receiptBusy = true
        receiptError = nil
        receiptInfo = nil
        Task {
            defer { receiptBusy = false }
            do {
                let r = try await session.customer.sendReceipt(orderId, email: email.trimmingCharacters(in: .whitespaces), save: save)
                receiptInfo = "Receipt sent to \(r.email ?? email)"
                if save { profileEmail = r.email ?? email }
                await load()
            } catch {
                receiptError = error.localizedDescription
            }
        }
    }

    /// "Your driver is about 7 min away" while a driver is on the way.
    private func loadEta() async {
        guard let o = order, Eta.statuses.contains(o.status) else {
            eta = nil
            return
        }
        etaAt = Date()
        if let e = try? await session.customer.eta(orderId) { eta = e }
    }

    @ViewBuilder
    private func etaCard(_ e: Eta) -> some View {
        if let sec = e.etaSec {
            VStack(alignment: .leading, spacing: 3) {
                if e.arrived == true {
                    Text("Your driver has arrived").font(.headline)
                } else {
                    let mins = EtaFormat.minutes(sec)
                    Text(mins == 0 ? "Your driver is less than a minute away" : "Your driver is about \(mins) min away").font(.headline)
                    let bits = [e.distanceM.map { EtaFormat.distance($0) }, e.arriveAt.map { "Arriving around \(PomTime.formatTime($0))" }].compactMap { $0 }
                    if !bits.isEmpty { Text(bits.joined(separator: " · ")).font(.subheadline) }
                    if e.viaDepot == true {
                        Text("Includes loading the water at \(e.depotName ?? "the depot") first").font(.caption).foregroundColor(.secondary)
                    } else if e.status == OrderStatus.loading {
                        Text("Loading your water now, then on the way").font(.caption).foregroundColor(.secondary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.cwBlueTint))
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
