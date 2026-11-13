import CooperKit
import SwiftUI

struct DriverWalletScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var state: DriverState
    @EnvironmentObject var router: DriverRouter
    @State private var summary: WalletSummary?
    @State private var entries: [LedgerEntry] = []
    @State private var pending: [Topup] = []
    @State private var error: String?

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Wallet balance").font(.subheadline).foregroundColor(.secondary)
                    Text(Money.format(summary?.balanceToea ?? 0)).font(.largeTitle.bold())
                    if summary?.blocked == true {
                        Text("Below the \(Money.format(summary?.minBalanceToea)) minimum — top up \(Money.format(summary?.shortfallToea)) to take jobs.").font(.subheadline).foregroundColor(.cwRed)
                    } else {
                        Text("You can take jobs (minimum \(Money.format(summary?.minBalanceToea))).").font(.subheadline).foregroundColor(.cwGreen)
                    }
                    if let w = summary?.withdrawableToea { Text("Available to withdraw: \(Money.format(w))").font(.caption).foregroundColor(.secondary) }
                    if let p = summary?.pendingPayouts, (p.count ?? 0) > 0 {
                        Text("Withdrawals waiting (\(p.count ?? 0)): \(Money.format(p.amountToea))").font(.caption).foregroundColor(.orange)
                    }
                }
                HStack {
                    Button { router.go(.topup) } label: { Label("Top up", systemImage: "plus.circle.fill") }.buttonStyle(.borderedProminent)
                    Spacer()
                    Button { router.go(.withdraw) } label: { Label("Withdraw", systemImage: "arrow.up.circle") }.buttonStyle(.bordered)
                }
            }
            if let error { Section { ErrorBanner(error) { Task { await load() } } } }
            if !pending.isEmpty {
                Section("Top-ups in review (\(pending.count))") {
                    ForEach(pending) { t in
                        Text("\(Money.format(t.amountToea)) by \(Labels.paymentMethod(t.method)) · \(PomTime.formatDateTime(t.createdAt))").font(.subheadline)
                    }
                }
            }
            Section("Transactions") {
                if entries.isEmpty { Text("No transactions yet.").foregroundColor(.secondary) }
                ForEach(entries) { e in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(e.description ?? label(e.type))
                            Text(PomTime.formatDateTime(e.createdAt)).font(.caption).foregroundColor(.secondary)
                        }
                        Spacer()
                        Text(Money.formatSigned(e.amountToea)).bold().foregroundColor(e.amountToea >= 0 ? .cwGreen : .cwRed)
                    }
                }
            }
        }
        .cwTitle("Wallet")
        .task { await load() }
        .refreshable { await load() }
        .onReceive(session.realtime.events) { e in if case .walletUpdated = e { Task { await load() } } }
    }

    private func label(_ t: String) -> String {
        switch t {
        case "topup": return "Top-up"
        case "commission": return "Commission"
        case "order_earning": return "Job earnings"
        case "refund": return "Refund"
        case "payout": return "Withdrawal"
        case "promo": return "Promo top-up"
        default: return "Adjustment"
        }
    }

    private func load() async {
        let api = state.api
        async let s = capture { try await api.wallet() }
        async let e = capture { try await api.walletEntries(cursor: nil) }
        async let t = capture { try await api.topups(cursor: nil) }
        let (sr, er, tr) = await (s, e, t)
        if case .success(let v) = sr {
            summary = v
            state.wallet = WalletBrief(balanceToea: v.balanceToea, minBalanceToea: v.minBalanceToea, blocked: v.blocked)
            error = nil
        } else if case .failure(let x) = sr { error = x.localizedDescription }
        if case .success(let v) = er { entries = v.items }
        if case .success(let v) = tr { pending = v.items.filter { $0.status == "pending" } }
    }
}

struct DriverTopupScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var state: DriverState
    @EnvironmentObject var router: DriverRouter
    @State private var method = "cash"
    @State private var amount = ""
    @State private var reference = ""
    @State private var msisdn = ""
    @State private var receipt: UIImage?
    @State private var picking = false
    @State private var busy = false
    @State private var error: String?
    @State private var done: Topup?
    @State private var key = newIdempotencyKey()

    var body: some View {
        Form {
            if let done {
                Section {
                    Text("Top-up of \(Money.format(done.amountToea)) submitted.").font(.headline)
                    Text(done.status == "approved" ? "It has been added to your wallet." : "It will be added to your wallet once confirmed.")
                    PrimaryButton("Back to wallet") { router.back() }.listRowInsets(EdgeInsets())
                }
            } else {
                if let min = state.wallet?.minBalanceToea { Section { Text("The minimum balance to take jobs is \(Money.format(min)).").font(.subheadline) } }
                Section("How did you pay?") {
                    Picker("Method", selection: $method) {
                        Text("Cash").tag("cash")
                        Text("Bank").tag("bank_transfer")
                        Text("Cell money").tag("cellmoney")
                    }
                    .pickerStyle(.segmented)
                    Text(help).font(.footnote).foregroundColor(.secondary)
                    if method == "cellmoney", let m = state.config?.merchantNumber { Text("Cooper Waters merchant number: \(m)").font(.footnote.bold()) }
                }
                Section {
                    HStack {
                        Text("K")
                        TextField("Amount", text: $amount).keyboardType(.decimalPad)
                    }
                    TextField(method == "cash" ? "Receipt number" : method == "bank_transfer" ? "Bank transaction reference" : "Cell money transaction ID", text: $reference)
                    if method == "cellmoney" { TextField("Number you paid from", text: $msisdn).keyboardType(.phonePad) }
                    if let receipt { Image(uiImage: receipt).resizable().scaledToFit().frame(maxHeight: 120) }
                    Button(receipt == nil ? "Photo of the receipt (optional)" : "Retake receipt photo") { picking = true }
                }
                if let error { Section { ErrorBanner(error) } }
                Section {
                    PrimaryButton("Submit top-up", busy: busy) { submit() }.listRowInsets(EdgeInsets())
                }
            }
        }
        .cwTitle("Top up wallet")
        .onAppear { if msisdn.isEmpty { msisdn = session.user?.phone ?? "" } }
        .onChange(of: method) { _ in key = newIdempotencyKey() }
        .onChange(of: amount) { _ in key = newIdempotencyKey() }
        .sheet(isPresented: $picking) { PhotoPicker(image: $receipt).ignoresSafeArea() }
    }

    private var help: String {
        switch method {
        case "cash": return "Pay cash at a Cooper Waters office or depot, then enter the receipt number."
        case "bank_transfer": return "Transfer to the Cooper Waters account first, then enter the bank's transaction reference."
        default: return "Send the amount by cell money to Cooper Waters, then enter the transaction ID."
        }
    }

    private func submit() {
        guard let toea = Money.parseKina(amount) else { error = "Enter a valid amount, e.g. 50 or 50.00."; return }
        guard toea >= 100 else { error = "The minimum is K1.00."; return }
        guard !reference.trimmingCharacters(in: .whitespaces).isEmpty else { error = "Enter the payment reference."; return }
        busy = true
        error = nil
        Task {
            do {
                var proof: String?
                if let receipt, let jpeg = PhotoPicker.jpeg(receipt) { proof = try await state.api.upload(purpose: "topup_proof", jpeg: jpeg) }
                let r = try await state.api.topup(TopupRequest(method: method, amountToea: toea, referenceText: reference.trimmingCharacters(in: .whitespaces), proofFileKey: proof,
                                                               msisdn: method == "cellmoney" ? msisdn.filter { $0.isNumber || $0 == "+" } : nil), key: key)
                done = r.topup
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

struct WithdrawScreen: View {
    @EnvironmentObject var state: DriverState
    @EnvironmentObject var router: DriverRouter
    @State private var summary: WalletSummary?
    @State private var amount = ""
    @State private var method = "cellmoney"
    @State private var destination = ""
    @State private var busy = false
    @State private var error: String?
    @State private var done: Payout?
    @State private var key = newIdempotencyKey()

    var body: some View {
        Form {
            if let done {
                Section {
                    Text("Withdrawal of \(Money.format(done.amountToea)) requested.").font(.headline)
                    Text("Cooper Waters will send it to \(done.destination ?? ""). Your balance stays the same until it's paid and deducted.")
                    PrimaryButton("Back to wallet") { router.back() }.listRowInsets(EdgeInsets())
                }
            } else {
                Section(footer: Text("Nothing is taken from your wallet now: Cooper Waters pays you, then deducts it from your wallet.")) {
                    LabelValue("Available", Money.format(summary?.withdrawableToea))
                    if let p = summary?.pendingPayouts, (p.count ?? 0) > 0 { LabelValue("Already requested", Money.format(p.amountToea)) }
                    if let m = summary?.payoutMinToea { LabelValue("Minimum", Money.format(m)) }
                }
                Section {
                    Picker("Send to", selection: $method) {
                        Text("Cell money").tag("cellmoney")
                        Text("Bank account").tag("bank_transfer")
                    }
                    .pickerStyle(.segmented)
                    HStack {
                        Text("K")
                        TextField("Amount", text: $amount).keyboardType(.decimalPad)
                    }
                    TextField(method == "cellmoney" ? "Cell money number" : "Bank, account name and number", text: $destination)
                }
                if let error { Section { ErrorBanner(error) } }
                Section {
                    PrimaryButton("Request withdrawal", busy: busy) { submit() }.listRowInsets(EdgeInsets())
                }
            }
        }
        .cwTitle("Withdraw")
        .task { summary = try? await state.api.wallet() }
        .onChange(of: amount) { _ in key = newIdempotencyKey() }
    }

    private func submit() {
        guard let toea = Money.parseKina(amount), toea > 0 else { error = "Enter a valid amount."; return }
        guard destination.trimmingCharacters(in: .whitespaces).count >= 5 else { error = "Enter where to send the money."; return }
        busy = true
        error = nil
        Task {
            do {
                done = try await state.api.withdraw(WithdrawalRequest(amountToea: toea, method: method, destination: destination.trimmingCharacters(in: .whitespaces)), key: key)
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

struct EarningsScreen: View {
    @EnvironmentObject var state: DriverState
    @State private var period = "today"
    @State private var earnings: Earnings?
    @State private var error: String?

    var body: some View {
        List {
            Picker("", selection: $period) {
                Text("Today").tag("today")
                Text("This week").tag("week")
                Text("This month").tag("month")
            }
            .pickerStyle(.segmented)
            if let error { ErrorBanner(error) }
            if let e = earnings {
                Section {
                    VStack(alignment: .leading) {
                        Text("Net earnings").font(.subheadline).foregroundColor(.secondary)
                        Text(Money.format(e.netToea)).font(.largeTitle.bold()).foregroundColor(.cwGreen)
                    }
                    LabelValue("Completed jobs", "\(e.completedOrders ?? 0)")
                    LabelValue("Gross", Money.format(e.grossToea))
                    LabelValue("Commission", "-" + Money.format(e.commissionToea))
                    LabelValue("Cash collected", Money.format(e.cashCollectedToea))
                    LabelValue("Top-ups", Money.format(e.topupsToea))
                    LabelValue("Withdrawals", Money.format(e.payoutsToea))
                }
            } else if error == nil {
                ProgressView()
            }
        }
        .cwTitle("Earnings")
        .task(id: period) {
            do {
                earnings = try await state.api.earnings(period: period)
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

struct JobHistoryScreen: View {
    @EnvironmentObject var state: DriverState
    @EnvironmentObject var router: DriverRouter
    @StateObject private var list = CursorList<Order>()

    var body: some View {
        List {
            if let e = list.error { ErrorBanner(e) { Task { await list.refresh() } } }
            if !list.loading && list.items.isEmpty && list.error == nil { EmptyState("No jobs yet.", systemImage: "truck.box") }
            ForEach(list.items) { o in
                Button { router.go(.job(orderId: o.id)) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(o.code).font(.headline)
                            Spacer()
                            StatusPill(o.status)
                        }
                        Text(PomTime.formatDateTime(o.timeline?.createdAt)).font(.caption).foregroundColor(.secondary)
                        if let a = o.delivery?.address { Text(a).font(.subheadline).lineLimit(1) }
                        if let e = o.earningsToea { Text("Earned \(Money.format(e))").font(.subheadline.bold()).foregroundColor(.cwGreen) }
                    }
                }
                .buttonStyle(.plain)
            }
            if !list.endReached && !list.items.isEmpty { Button("Load more") { Task { await list.loadMore() } } }
        }
        .listStyle(.plain)
        .cwTitle("Job History")
        .task {
            let api = state.api
            list.setFetch { cursor in try await api.orders(cursor: cursor) }
            await list.refresh()
        }
        .refreshable { await list.refresh() }
    }
}
