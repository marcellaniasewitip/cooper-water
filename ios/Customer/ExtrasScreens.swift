import CooperKit
import SwiftUI

// MARK: - Wallet

struct WalletScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    @State private var wallet: CustomerWallet?
    @State private var entries: [LedgerEntry] = []
    @State private var pending: [Topup] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    Image(systemName: "creditcard.fill").font(.title).foregroundColor(.cwBlue)
                    VStack(alignment: .leading) {
                        Text("Cooper Waters Cash").font(.headline)
                        Text("Pay for orders from your balance. Refunds and referral rewards land here too.").font(.caption).foregroundColor(.secondary)
                    }
                    Spacer()
                    Text(Money.format(wallet?.balanceToea ?? 0)).font(.title2.bold()).foregroundColor(.cwGreen)
                }
                Button { router.go(.topup) } label: { Label("Top up", systemImage: "plus.circle.fill") }
            }
            if let error { Section { ErrorBanner(error) { Task { await load() } } } }
            if !pending.isEmpty {
                Section("Top-ups in review") {
                    ForEach(pending) { t in
                        Text("\(Money.format(t.amountToea)) by \(Labels.paymentMethod(t.method)) · \(PomTime.formatDateTime(t.createdAt))").font(.subheadline).foregroundColor(.secondary)
                    }
                }
            }
            Section("Transactions") {
                if !loading && entries.isEmpty { Text("No transactions yet.").foregroundColor(.secondary) }
                ForEach(entries) { e in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(e.description ?? entryLabel(e.type))
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

    private func entryLabel(_ t: String) -> String {
        switch t {
        case "topup": return "Top-up"
        case "order_payment": return "Order payment"
        case "refund": return "Refund"
        case "referral": return "Referral reward"
        default: return "Adjustment"
        }
    }

    private func load() async {
        let c = session.customer
        async let w = capture { try await c.wallet() }
        async let e = capture { try await c.walletEntries(cursor: nil) }
        async let t = capture { try await c.walletTopups(cursor: nil) }
        let (wr, er, tr) = await (w, e, t)
        if case .success(let v) = wr { wallet = v; error = nil } else if case .failure(let x) = wr { error = x.localizedDescription }
        if case .success(let v) = er { entries = v.items }
        if case .success(let v) = tr { pending = v.items.filter { $0.status == "pending" } }
        loading = false
    }
}

/// Top up by cash, bank transfer or cell money; an admin approves it (same flow as drivers).
struct TopupScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    @State private var method = "cash"
    @State private var amount = ""
    @State private var reference = ""
    @State private var msisdn = ""
    @State private var busy = false
    @State private var error: String?
    @State private var done: Topup?
    @State private var key = newIdempotencyKey()

    var body: some View {
        Form {
            if let done {
                Section {
                    Text("Top-up submitted").font(.headline)
                    Text("Your top-up of \(Money.format(done.amountToea)) will be added to your wallet once Cooper Waters confirms it.")
                    PrimaryButton("Back to wallet") { router.back() }.listRowInsets(EdgeInsets())
                }
            } else {
                Section("How did you pay?") {
                    Picker("Method", selection: $method) {
                        Text("Cash").tag("cash")
                        Text("Bank transfer").tag("bank_transfer")
                        Text("Cell money").tag("cellmoney")
                    }
                    .pickerStyle(.segmented)
                    Text(help).font(.footnote).foregroundColor(.secondary)
                }
                Section {
                    HStack {
                        Text("K")
                        TextField("Amount", text: $amount).keyboardType(.decimalPad)
                    }
                    TextField(referenceLabel, text: $reference)
                    if method == "cellmoney" { TextField("Number you paid from", text: $msisdn).keyboardType(.phonePad) }
                }
                if let error { Section { ErrorBanner(error) } }
                Section(footer: Text("Our team checks each top-up before the money is added.")) {
                    PrimaryButton("Submit top-up", busy: busy) { submit() }.listRowInsets(EdgeInsets())
                }
            }
        }
        .cwTitle("Top up wallet")
        .onAppear { if msisdn.isEmpty { msisdn = session.user?.phone ?? "" } }
        .onChange(of: method) { _ in key = newIdempotencyKey() }
        .onChange(of: amount) { _ in key = newIdempotencyKey() }
    }

    private var help: String {
        switch method {
        case "cash": return "Pay cash at a Cooper Waters office or depot, then enter the receipt number."
        case "bank_transfer": return "Transfer to the Cooper Waters account first, then enter the bank's transaction reference."
        default: return "Send the amount by cell money to Cooper Waters, then enter the transaction ID and the number you paid from."
        }
    }

    private var referenceLabel: String {
        switch method {
        case "cash": return "Receipt number"
        case "bank_transfer": return "Bank transaction reference"
        default: return "Cell money transaction ID"
        }
    }

    private func submit() {
        guard let toea = Money.parseKina(amount) else { error = "Enter a valid amount, e.g. 50 or 50.00."; return }
        guard toea >= 100 else { error = "The minimum is K1.00."; return }
        guard !reference.trimmingCharacters(in: .whitespaces).isEmpty else { error = "Enter the payment reference."; return }
        busy = true
        error = nil
        let req = TopupRequest(method: method, amountToea: toea, referenceText: reference.trimmingCharacters(in: .whitespaces),
                               msisdn: method == "cellmoney" ? msisdn.filter { $0.isNumber || $0 == "+" } : nil)
        Task {
            do {
                done = try await session.customer.topup(req, key: key)
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

// MARK: - Offers

struct OffersScreen: View {
    @EnvironmentObject var session: AppSession
    @State private var offers: [PromoOffer] = []
    @State private var input = ""
    @State private var selected = PromoStore.selected
    @State private var message: String?
    @State private var error: String?
    @State private var checking = false
    @State private var loading = true

    var body: some View {
        List {
            Section {
                HStack {
                    TextField("Have a promo code?", text: $input).textInputAutocapitalization(.characters)
                    Button("ADD") { add() }.bold().disabled(input.count < 3 || checking)
                }
                if let message { Text(message).foregroundColor(.cwGreen).font(.subheadline) }
                if let error { Text(error).foregroundColor(.cwRed).font(.subheadline) }
            }
            if let selected {
                Section {
                    HStack {
                        Text("Using \(selected) on your next order")
                        Spacer()
                        Button("Remove") {
                            PromoStore.selected = nil
                            self.selected = nil
                            message = nil
                        }
                    }
                }
            }
            Section("Available offers") {
                if !loading && offers.isEmpty { Text("No offers right now. Check back soon.").foregroundColor(.secondary) }
                ForEach(offers) { o in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(o.code).font(.headline)
                            Spacer()
                            Text(discount(o)).font(.headline).foregroundColor(.cwGreen)
                        }
                        if let d = o.description, !d.isEmpty { Text(d).font(.subheadline) }
                        if let m = o.minOrderToea, m > 0 { Text("Min. order \(Money.format(m))").font(.caption).foregroundColor(.secondary) }
                        if let e = o.expiresAt { Text("Valid until \(PomTime.formatDate(e))").font(.caption).foregroundColor(.secondary) }
                        if o.usable == false {
                            Text("Used").font(.caption).foregroundColor(.cwRed)
                        } else if selected != o.code {
                            Button("Use") { use(o.code) }.font(.subheadline.bold())
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .cwTitle("Offers")
        .task {
            offers = (try? await session.customer.offers()) ?? []
            loading = false
        }
    }

    private func discount(_ o: PromoOffer) -> String {
        o.discountType == "percent" ? "\(o.discountValue ?? 0)% off" : "\(Money.format(o.discountValue)) off"
    }

    private func use(_ code: String) {
        PromoStore.selected = code
        selected = code
        message = "Code \(code) saved. It will be applied to your next order."
    }

    private func add() {
        checking = true
        error = nil
        message = nil
        let code = input.trimmingCharacters(in: .whitespaces).uppercased()
        Task {
            do {
                let o = try await session.customer.checkOffer(code)
                use(o.code)
                input = ""
            } catch {
                self.error = error.localizedDescription
            }
            checking = false
        }
    }
}

// MARK: - Refer & Earn

struct ReferralScreen: View {
    @EnvironmentObject var session: AppSession
    @State private var info: ReferralInfo?
    @State private var friendCode = ""
    @State private var applied = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let info {
                    let reward = Money.format(info.rewardToea)
                    VStack(spacing: 10) {
                        Image(systemName: "drop.fill").font(.system(size: 44)).foregroundColor(.white)
                        Text("Give \(reward), get \(reward)").font(.title2.bold()).foregroundColor(.white)
                        Text("Share your code. When a friend completes their first order, you both get \(reward) in your wallet.")
                            .multilineTextAlignment(.center).foregroundColor(.white.opacity(0.9))
                        Text("Your code").font(.caption).foregroundColor(.white.opacity(0.7))
                        Text(info.code).font(.system(size: 30, weight: .bold, design: .monospaced)).foregroundColor(.white)
                        ShareLink(item: "Order water with Cooper Waters and get \(reward) in your wallet after your first delivery. Use my code: \(info.code)") {
                            Label("Share code", systemImage: "square.and.arrow.up").font(.headline)
                                .padding(.horizontal, 20).padding(.vertical, 10)
                                .background(Capsule().fill(Color.white)).foregroundColor(.cwBlue)
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Color.cwBlue))
                    HStack {
                        stat("\(info.invitedCount ?? 0)", "Friends joined")
                        stat(Money.format(info.earnedToea), "Earned")
                    }
                    if info.enabled == false { Text("Referral rewards are paused at the moment.").foregroundColor(.cwRed) }
                    if info.canApplyCode == true {
                        SectionTitle("Got a code from a friend?")
                        TextField("Friend's code", text: $friendCode).textInputAutocapitalization(.characters)
                            .padding(12).background(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.35)))
                        PrimaryButton("Apply code", busy: busy, enabled: friendCode.count >= 4) { apply() }
                    } else if let by = info.referredByCode {
                        Text(applied ? "Code \(by) applied. You'll get \(reward) after your first completed order." : "You joined with code \(by) (\(reward) after your first completed order).")
                            .foregroundColor(.cwGreen)
                    }
                } else if error == nil {
                    ProgressView().padding(.top, 40)
                }
                ErrorBanner(error)
            }
            .padding(16)
        }
        .cwTitle("Refer & Earn")
        .task {
            do { info = try await session.customer.referral() } catch { self.error = error.localizedDescription }
        }
    }

    private func stat(_ v: String, _ l: String) -> some View {
        VStack {
            Text(v).font(.title2.bold())
            Text(l).font(.subheadline).foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private func apply() {
        busy = true
        error = nil
        Task {
            do {
                info = try await session.customer.applyReferral(friendCode.uppercased().filter { $0.isLetter || $0.isNumber })
                applied = true
                friendCode = ""
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

// MARK: - Inbox

struct InboxScreen: View {
    @EnvironmentObject var session: AppSession
    @StateObject private var list = CursorList<InboxItem>()

    var body: some View {
        List {
            if let e = list.error { ErrorBanner(e) { Task { await list.refresh() } } }
            if !list.loading && list.items.isEmpty && list.error == nil {
                EmptyState("No messages yet.", systemImage: "bell")
            }
            ForEach(list.items) { n in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "bell.fill").foregroundColor(.cwBlue)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(n.title ?? "").font(.headline)
                        Text(n.body ?? "").font(.subheadline)
                        Text(PomTime.formatDateTime(n.createdAt)).font(.caption).foregroundColor(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }
            if !list.endReached && !list.items.isEmpty {
                Button("Load more") { Task { await list.loadMore() } }
            }
        }
        .listStyle(.plain)
        .cwTitle("Inbox")
        .task {
            let c = session.customer
            list.setFetch { cursor in try await c.inbox(cursor: cursor) }
            await list.refresh()
        }
        .refreshable { await list.refresh() }
        .onReceive(session.realtime.events) { e in if case .message = e { Task { await list.refresh() } } }
    }
}

// MARK: - Chat

struct ChatListScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    @State private var chats: [ChatConversation] = []
    @State private var tab = 0
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                Text("Current").tag(0)
                Text("Past").tag(1)
            }
            .pickerStyle(.segmented)
            .padding(16)
            List {
                if let error { ErrorBanner(error) { Task { await load() } } }
                let shown = chats.filter { ($0.open ?? false) == (tab == 0) }
                if !loading && shown.isEmpty {
                    EmptyState(tab == 0 ? "No active chats. You can message your driver once an order is accepted." : "No past chats.", systemImage: "message")
                }
                ForEach(shown) { c in
                    Button { router.go(.chat(orderId: c.orderId)) } label: { ConversationRow(c: c, fallbackName: "Your driver") }
                        .buttonStyle(.plain)
                }
            }
            .listStyle(.plain)
        }
        .cwTitle("Chat")
        .task { await load() }
        .refreshable { await load() }
        .onReceive(session.realtime.events) { e in if case .chatMessage = e { Task { await load() } } }
    }

    private func load() async {
        do {
            chats = try await session.customer.chats()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}

/// Customer ↔ driver chat for one order, refreshed by realtime chat events.
struct ChatThreadScreen: View {
    @EnvironmentObject var session: AppSession
    let orderId: String
    @State private var thread: ChatThread?
    @State private var draft = ""
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        ChatView(
            title: (thread?.otherName).flatMap { $0.isEmpty ? nil : $0 } ?? "Chat",
            subtitle: thread?.shortCode.map { "Order \($0)" },
            messages: thread?.messages ?? [],
            open: thread?.open ?? true,
            loaded: thread != nil,
            emptyText: "Send \((thread?.otherName).flatMap { $0.isEmpty ? nil : $0 } ?? "your driver") a message about your delivery.",
            draft: $draft,
            sending: sending,
            error: error,
            onSend: send
        )
        .task { await load() }
        .onReceive(session.realtime.events) { e in
            if case .chatMessage(let id, _, _) = e, id == orderId { Task { await load() } }
        }
    }

    private func load() async {
        do {
            thread = try await session.customer.messages(orderId)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func send() {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, !sending else { return }
        sending = true
        Task {
            do {
                _ = try await session.customer.send(orderId, body: body)
                draft = ""
                await load()
            } catch {
                self.error = error.localizedDescription
            }
            sending = false
        }
    }
}
