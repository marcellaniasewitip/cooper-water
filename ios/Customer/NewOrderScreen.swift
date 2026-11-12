import CooperKit
import SwiftUI

enum OrderStep: Hashable {
    case package, location, payment, review

    var title: String {
        switch self {
        case .package: return "Choose water"
        case .location: return "Delivery location"
        case .payment: return "Payment"
        case .review: return "Confirm order"
        }
    }
}

@MainActor
final class NewOrderModel: ObservableObject {
    let steps: [OrderStep]
    @Published var step: OrderStep
    @Published var loading = true
    @Published var packages: [WaterPackage] = []
    @Published var packageId: String?
    @Published var quantity = 1
    @Published var maxQuantity = 10
    @Published var locations: [SavedLocation] = []
    @Published var locationId: String?
    @Published var paymentMethod = "cod"
    @Published var methods = ["cod", "cellmoney", "wallet"]
    @Published var msisdn = ""
    @Published var walletBalance: Int64?
    @Published var quote: Quote?
    @Published var quoting = false
    @Published var promoInput = ""
    @Published var appliedPromo: String?
    @Published var promoError: String?
    /** Success note under the promo box (e.g. a Refer & Earn code was applied instead). */
    @Published var promoInfo: String?
    @Published var promoChecking = false
    @Published var placing = false
    @Published var error: String?

    /// One key per filled-in order so a retried "Place order" never creates two orders.
    private var orderKey = newIdempotencyKey()
    private var lastRequest: CreateOrderRequest?

    init(initialLocationId: String?, addressFirst: Bool, phone: String?) {
        steps = addressFirst ? [.location, .package, .payment, .review] : [.package, .location, .payment, .review]
        // A saved place was tapped: the address is chosen, so open on the package step.
        step = addressFirst && initialLocationId == nil ? .location : .package
        locationId = initialLocationId
        msisdn = phone ?? ""
        promoInput = PromoStore.selected ?? ""
    }

    var selectedPackage: WaterPackage? { packages.first { $0.id == packageId } }
    var selectedLocation: SavedLocation? { locations.first { $0.id == locationId } }
    var priceToea: Int64? { quote?.priceToea ?? selectedPackage.map { $0.priceToea * Int64(quantity) } }
    var discountToea: Int64 { quote?.discountToea ?? 0 }
    var payableToea: Int64? { priceToea.map { max(0, $0 - discountToea) } }
    var isFirstStep: Bool { step == steps.first }

    func load(_ s: AppSession) async {
        let c = s.customer
        async let pk = capture { try await c.packages() }
        async let lc = capture { try await c.locations() }
        async let cf = capture { try await c.config() }
        async let wl = capture { try await c.wallet() }
        let (p, l, cfg, w) = await (pk, lc, cf, wl)
        if case .success(let v) = p {
            packages = v
            if packageId == nil { packageId = v.first?.id }
        } else if case .failure(let e) = p { error = e.localizedDescription }
        if case .success(let v) = l {
            locations = v
            if locationId == nil { locationId = v.first?.id }
        }
        if case .success(let v) = cfg {
            maxQuantity = v.maxQuantity ?? 10
            let allowed = (v.paymentMethods ?? ["cod", "cellmoney"]) + ["wallet"]
            methods = ["cod", "cellmoney", "wallet"].filter { allowed.contains($0) }
        }
        if case .success(let v) = w { walletBalance = v.balanceToea }
        loading = false
        if !promoInput.isEmpty { await applyPromo(s) } else { await requestQuote(s) }
    }

    func reloadLocations(_ s: AppSession) async {
        if let v = try? await s.customer.locations() {
            let added = v.first { n in !locations.contains { $0.id == n.id } }
            locations = v
            if let added { locationId = added.id } else if locationId == nil { locationId = v.first?.id }
        }
    }

    func requestQuote(_ s: AppSession) async {
        guard let pid = packageId else { return }
        quoting = true
        do {
            quote = try await s.customer.quote(QuoteRequest(packageId: pid, quantity: quantity, promoCode: appliedPromo))
        } catch let e as APIError where e.code.hasPrefix("promo_") {
            // The promo stopped applying (e.g. minimum order): drop it and re-quote.
            promoError = e.localizedDescription
            appliedPromo = nil
            quote = try? await s.customer.quote(QuoteRequest(packageId: pid, quantity: quantity, promoCode: nil))
        } catch {
            quote = nil
        }
        quoting = false
    }

    func applyPromo(_ s: AppSession) async {
        let code = promoInput.trimmingCharacters(in: .whitespaces).uppercased()
        guard code.count >= 3, let pid = packageId else { return }
        promoChecking = true
        promoError = nil
        promoInfo = nil
        do {
            quote = try await s.customer.quote(QuoteRequest(packageId: pid, quantity: quantity, promoCode: code))
            appliedPromo = quote?.promo?.code ?? code
        } catch let e as APIError where e.code == "promo_is_referral" {
            // A friend's Refer & Earn code: apply it as a referral (wallet credit after the first order).
            do {
                let r = try await s.customer.applyReferral(code)
                promoInput = ""
                promoInfo = "\(code) is a Refer & Earn code — applied! You and your friend each get \(Money.format(r.rewardToea)) in your wallet after your first completed order."
            } catch {
                promoError = error.localizedDescription
            }
            if PromoStore.selected == code { PromoStore.selected = nil }
            await requestQuote(s)
        } catch {
            promoError = error.localizedDescription
            appliedPromo = nil
            await requestQuote(s)
        }
        promoChecking = false
    }

    func removePromo(_ s: AppSession) async {
        appliedPromo = nil
        promoInput = ""
        promoError = nil
        await requestQuote(s)
    }

    func next() {
        error = nil
        switch step {
        case .package where selectedPackage == nil: error = "Choose a package."; return
        case .location where selectedLocation == nil: error = "Choose where to deliver."; return
        case .payment:
            if paymentMethod == "cellmoney" && msisdn.filter(\.isNumber).count < 7 { error = "Enter the cell money number to charge."; return }
            if paymentMethod == "wallet", let bal = walletBalance, let pay = payableToea, bal < pay {
                error = "Your wallet has \(Money.format(bal)). Top up or choose another payment method."
                return
            }
        default: break
        }
        if let i = steps.firstIndex(of: step), i + 1 < steps.count { step = steps[i + 1] }
    }

    /// false when already on the first step (the screen should close).
    func back() -> Bool {
        guard !placing, let i = steps.firstIndex(of: step), i > 0 else { return false }
        step = steps[i - 1]
        error = nil
        return true
    }

    func place(_ s: AppSession) async -> CreateOrderResponse? {
        guard let pid = packageId, let lid = locationId else { return nil }
        let req = CreateOrderRequest(packageId: pid, quantity: quantity, locationId: lid, paymentMethod: paymentMethod,
                                     msisdn: paymentMethod == "cellmoney" ? msisdn.filter { $0.isNumber || $0 == "+" } : nil,
                                     promoCode: appliedPromo)
        if req != lastRequest {
            orderKey = newIdempotencyKey()
            lastRequest = req
        }
        placing = true
        error = nil
        defer { placing = false }
        // Retry network failures with the same key: the server returns the same order, never a second one.
        for attempt in 0..<3 {
            do {
                let r = try await s.customer.createOrder(req, key: orderKey)
                if appliedPromo != nil { PromoStore.selected = nil }
                orderKey = newIdempotencyKey()
                lastRequest = nil
                return r
            } catch let e as APIError where e.isNetwork && attempt < 2 {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
            } catch {
                self.error = error.localizedDescription
                return nil
            }
        }
        error = APIError.network().localizedDescription
        return nil
    }
}

struct NewOrderScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    @StateObject private var model: NewOrderModel

    init(initialLocationId: String?, addressFirst: Bool) {
        _model = StateObject(wrappedValue: NewOrderModel(initialLocationId: initialLocationId, addressFirst: addressFirst, phone: nil))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if model.loading { ProgressView().frame(maxWidth: .infinity) }
                    switch model.step {
                    case .package: packageStep
                    case .location: locationStep
                    case .payment: paymentStep
                    case .review: reviewStep
                    }
                    ErrorBanner(model.error)
                }
                .padding(16)
            }
            priceBar
        }
        .cwTitle(model.step.title)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button { if !model.back() { router.back() } } label: { Image(systemName: "chevron.left") }
            }
        }
        .task {
            if model.msisdn.isEmpty { model.msisdn = session.user?.phone ?? "" }
            if model.packages.isEmpty { await model.load(session) } else { await model.reloadLocations(session) }
        }
    }

    // MARK: Steps

    private var packageStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle("Choose water")
            ForEach(model.packages) { p in
                Button {
                    model.packageId = p.id
                    Task { await model.requestQuote(session) }
                } label: {
                    HStack {
                        Image(systemName: model.packageId == p.id ? "largecircle.fill.circle" : "circle").foregroundColor(.cwBlue)
                        VStack(alignment: .leading) {
                            Text(p.name).font(.headline)
                            Text("\(p.volumeLitres) litres").font(.subheadline).foregroundColor(.secondary)
                        }
                        Spacer()
                        Text(Money.format(p.priceToea)).font(.headline)
                    }
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 12).stroke(model.packageId == p.id ? Color.cwBlue : Color.secondary.opacity(0.3), lineWidth: model.packageId == p.id ? 2 : 1))
                }
                .buttonStyle(.plain)
            }
            Stepper(value: $model.quantity, in: 1...max(1, model.maxQuantity)) {
                Text("Quantity: \(model.quantity)").font(.headline)
            }
            .onChange(of: model.quantity) { _ in Task { await model.requestQuote(session) } }
        }
    }

    private var locationStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle("Where should we deliver?")
            if !model.loading && model.locations.isEmpty {
                Text("Add a delivery place to continue.").foregroundColor(.secondary)
            }
            ForEach(model.locations) { l in
                Button { model.locationId = l.id } label: {
                    HStack(alignment: .top) {
                        Image(systemName: model.locationId == l.id ? "largecircle.fill.circle" : "circle").foregroundColor(.cwBlue)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(l.label).font(.headline)
                            Text(l.addressText).font(.subheadline).foregroundColor(.secondary)
                        }
                        Spacer()
                    }
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 12).stroke(model.locationId == l.id ? Color.cwBlue : Color.secondary.opacity(0.3), lineWidth: model.locationId == l.id ? 2 : 1))
                }
                .buttonStyle(.plain)
            }
            SecondaryButton("Add a new place") { router.go(.placeEdit(id: nil)) }
        }
    }

    private var paymentStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle("Payment method")
            ForEach(model.methods, id: \.self) { m in
                Button { model.paymentMethod = m } label: {
                    HStack(alignment: .top) {
                        Image(systemName: model.paymentMethod == m ? "largecircle.fill.circle" : "circle").foregroundColor(.cwBlue)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(Labels.paymentMethod(m)).font(.headline)
                            Text(help(m)).font(.caption).foregroundColor(.secondary)
                        }
                        Spacer()
                    }
                    .padding(.vertical, 6)
                }
                .buttonStyle(.plain)
            }
            if model.paymentMethod == "cellmoney" {
                TextField("Cell money number", text: $model.msisdn).keyboardType(.phonePad)
                    .padding(12).background(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.35)))
            }
        }
    }

    private func help(_ m: String) -> String {
        switch m {
        case "cod": return "Pay the driver in cash when the water arrives."
        case "cellmoney": return "You'll get a prompt on your phone to approve the payment."
        default:
            return model.walletBalance.map { "Paid now from your wallet (balance \(Money.format($0)))." } ?? "Paid now from your Cooper Waters wallet."
        }
    }

    private var reviewStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            CardBox {
                VStack(spacing: 8) {
                    if let p = model.selectedPackage {
                        LabelValue("Package", "\(p.name) × \(model.quantity)")
                        LabelValue("Unit price", Money.format(p.priceToea))
                    }
                    if let l = model.selectedLocation { LabelValue("Deliver to", "\(l.label)\n\(l.addressText)") }
                    Divider()
                    LabelValue("Payment method", Labels.paymentMethod(model.paymentMethod))
                    if model.paymentMethod == "cellmoney" { LabelValue("Number", model.msisdn) }
                    if model.discountToea > 0 {
                        Divider()
                        if let p = model.priceToea { LabelValue("Price", Money.format(p)) }
                        LabelValue("Discount", "-" + Money.format(model.discountToea))
                        if let p = model.payableToea { LabelValue("To pay", Money.format(p)) }
                    }
                }
            }
            SectionTitle("Promo code")
            if let code = model.appliedPromo {
                HStack {
                    VStack(alignment: .leading) {
                        Text(code).font(.headline)
                        Text("You save \(Money.format(model.discountToea))").font(.subheadline)
                    }
                    Spacer()
                    Button("Remove") { Task { await model.removePromo(session) } }
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.cwGreen.opacity(0.12)))
            } else {
                HStack {
                    TextField("Enter a promo code", text: $model.promoInput).textInputAutocapitalization(.characters)
                        .padding(12).background(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.35)))
                    Button("Apply") { Task { await model.applyPromo(session) } }
                        .disabled(model.promoInput.trimmingCharacters(in: .whitespaces).count < 3 || model.promoChecking)
                }
            }
            if let e = model.promoError { Text(e).font(.subheadline).foregroundColor(.cwRed) }
            if let i = model.promoInfo { Text(i).font(.subheadline).foregroundColor(.cwGreen) }
            Text("You can cancel for free until a driver accepts.").font(.caption).foregroundColor(.secondary)
        }
    }

    // MARK: Price bar

    private var priceBar: some View {
        VStack(spacing: 10) {
            HStack {
                Text(model.quote != nil ? "Fixed price" : "Estimated price").font(.subheadline)
                Spacer()
                VStack(alignment: .trailing) {
                    if model.discountToea > 0, let p = model.priceToea {
                        Text(Money.format(p)).font(.subheadline).strikethrough().foregroundColor(.secondary)
                    }
                    Text(Money.format(model.payableToea ?? 0)).font(.title2.bold())
                }
            }
            if model.step == .review {
                PrimaryButton("Place order", busy: model.placing) {
                    Task {
                        guard let r = await model.place(session) else { return }
                        let needsPayment = r.order.status == OrderStatus.pendingPayment
                        router.replaceTop(with: needsPayment ? .payment(orderId: r.order.id) : .tracking(orderId: r.order.id))
                    }
                }
            } else {
                PrimaryButton("Next", enabled: !model.loading) { model.next() }
            }
        }
        .padding(16)
        .background(Color(UIColor.systemBackground).shadow(color: .black.opacity(0.08), radius: 6, y: -2))
    }
}
