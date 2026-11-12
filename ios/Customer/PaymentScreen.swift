import CooperKit
import SwiftUI

/// Cell money payment for an order: waits for approval on the phone, allows a retry with another number.
struct PaymentScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    let orderId: String

    @State private var order: Order?
    @State private var payment: Payment?
    @State private var msisdn = ""
    @State private var busy = false
    @State private var error: String?
    @State private var retryKey = newIdempotencyKey()
    @State private var confirmCancel = false
    private let timer = Timer.publish(every: 4, on: .main, in: .common).autoconnect()

    private var canRetry: Bool { order?.status == OrderStatus.pendingPayment && (payment == nil || payment?.isOpen == false) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let o = order {
                    CardBox {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Order #\(o.code)").font(.headline)
                            StatusPill(o.status)
                            LabelValue("Amount", Money.format(o.amountDueToea))
                        }
                    }
                }
                if let p = payment {
                    CardBox {
                        VStack(alignment: .leading, spacing: 8) {
                            if p.isOpen {
                                HStack(spacing: 10) {
                                    ProgressView()
                                    Text("Approve the payment on your phone").font(.headline)
                                }
                                if let i = p.instructions, !i.isEmpty { Text(i).font(.subheadline) }
                                if let r = p.reference, !r.isEmpty { LabelValue("Reference", r) }
                                Countdown(until: p.expiresAt) { secs in
                                    if let secs, secs > 0 { Text("Expires in \(PomTime.formatCountdown(secs))").font(.caption).foregroundColor(.secondary) }
                                }
                            } else {
                                Text(p.status == "succeeded" ? "Payment received" : "Payment didn't go through").font(.headline)
                                if let r = p.failureReason, !r.isEmpty { Text(r).font(.subheadline).foregroundColor(.secondary) }
                            }
                        }
                    }
                }
                if canRetry {
                    SectionTitle("Try again")
                    TextField("Cell money number", text: $msisdn).keyboardType(.phonePad)
                        .padding(12).background(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.35)))
                    PrimaryButton("Send payment request", busy: busy, enabled: msisdn.filter(\.isNumber).count >= 7) { retry() }
                }
                ErrorBanner(error)
                if order?.status == OrderStatus.pendingPayment {
                    SecondaryButton("Cancel order") { confirmCancel = true }
                }
            }
            .padding(16)
        }
        .cwTitle("Payment")
        .task {
            msisdn = session.user?.phone ?? ""
            await poll()
        }
        .onReceive(timer) { _ in Task { await poll() } }
        .confirmationDialog("Cancel this order?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Cancel order", role: .destructive) { cancel() }
        }
    }

    private func poll() async {
        if let o = try? await session.customer.order(orderId) {
            order = o
            if o.status != OrderStatus.pendingPayment && o.status != OrderStatus.failed && o.status != OrderStatus.cancelled {
                router.replaceTop(with: .tracking(orderId: orderId))
                return
            }
        }
        if let p = try? await session.customer.payment(orderId) { payment = p }
    }

    private func retry() {
        busy = true
        error = nil
        Task {
            do {
                payment = try await session.customer.startPayment(orderId, msisdn: msisdn.filter { $0.isNumber || $0 == "+" }, key: retryKey)
                retryKey = newIdempotencyKey()
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    private func cancel() {
        Task {
            do {
                order = try await session.customer.cancel(orderId, reason: "Changed my mind")
                router.home()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
