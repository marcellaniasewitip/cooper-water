import CooperKit
import MapKit
import SwiftUI

/// Which step the driver performs next for an order status (same as Android JobStep).
enum JobStep {
    case arriveDepot, confirmLoaded, markArrived, markDelivered, awaitCustomer, done

    init(_ status: String) {
        switch status {
        case OrderStatus.accepted: self = .arriveDepot
        case OrderStatus.loading: self = .confirmLoaded
        case OrderStatus.enRoute: self = .markArrived
        case OrderStatus.arrived: self = .markDelivered
        case OrderStatus.delivered, OrderStatus.disputed: self = .awaitCustomer
        default: self = .done
        }
    }

    var button: String? {
        switch self {
        case .arriveDepot: return "I'm at the depot"
        case .confirmLoaded: return "Water loaded"
        case .markArrived: return "I've arrived"
        case .markDelivered: return "Water delivered"
        default: return nil
        }
    }

    var help: String {
        switch self {
        case .arriveDepot: return "Drive to a Cooper Waters depot to load the water."
        case .confirmLoaded: return "Confirm once the tank is loaded, while you're still at the depot."
        case .markArrived: return "Drive to the customer. Tap when you arrive."
        case .markDelivered: return "Deliver the water. Add a photo as proof if you can."
        case .awaitCustomer: return "Waiting for the customer to confirm they received the water."
        case .done: return "This job is finished."
        }
    }
}

struct JobScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var state: DriverState
    @EnvironmentObject var router: DriverRouter
    let orderId: String

    @State private var order: Order?
    @State private var busy = false
    @State private var error: String?
    @State private var proof: UIImage?
    @State private var showCamera = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let o = order {
                    let step = JobStep(o.status)
                    map(o)
                    HStack {
                        StatusPill(o.status)
                        Spacer()
                        if let e = o.earningsToea { Text("Earn \(Money.format(e))").font(.headline).foregroundColor(.cwBlue) }
                    }
                    CardBox {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(o.customer?.name ?? "Customer").font(.headline)
                            if let a = o.delivery?.address { Text(a) }
                            if let n = o.delivery?.notes, !n.isEmpty { Text("Landmark: \(n)").font(.caption).foregroundColor(.secondary) }
                            Text("\(o.quantity ?? 1) × \(o.package?.name ?? "") (\(o.package?.volumeLitres ?? 0) L)").font(.subheadline)
                            Text(o.paymentMethod == "cod" ? "Collect \(Money.format(o.amountDueToea)) in cash" : "Paid: \(Labels.paymentMethod(o.paymentMethod))")
                                .font(.subheadline.bold()).foregroundColor(o.paymentMethod == "cod" ? .orange : .cwGreen)
                            HStack(spacing: 10) {
                                if let phone = o.customer?.phone { Button { Phone.dial(phone) } label: { Label("Call", systemImage: "phone.fill") }.buttonStyle(.bordered) }
                                Button { router.go(.chat(orderId: orderId)) } label: { Label("Message", systemImage: "message.fill") }.buttonStyle(.bordered)
                                if let d = o.delivery { Button { navigate(d) } label: { Label("Navigate", systemImage: "location.fill") }.buttonStyle(.bordered) }
                            }
                        }
                    }
                    Text(step.help).font(.subheadline).foregroundColor(.secondary)
                    if step == .markDelivered {
                        if let proof {
                            Image(uiImage: proof).resizable().scaledToFit().frame(maxHeight: 180).clipShape(RoundedRectangle(cornerRadius: 10))
                            Button("Remove photo") { self.proof = nil }.font(.subheadline)
                        } else {
                            SecondaryButton("Add proof photo") { showCamera = true }
                        }
                    }
                    ErrorBanner(error)
                    if let b = step.button { PrimaryButton(b, busy: busy) { perform(step) } }
                    if OrderStatus.isDisputable(o.status) {
                        Button("Report a problem") { router.go(.issue(orderId: orderId)) }.font(.subheadline)
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                    ErrorBanner(error) { Task { await load() } }
                }
            }
            .padding(16)
        }
        .cwTitle(order.map { "Job \($0.code)" } ?? "Job")
        .task { await load() }
        .refreshable { await load() }
        .onReceive(session.realtime.events) { e in
            if case .orderUpdated(let o) = e, o.id == orderId { Task { await load() } }
        }
        .sheet(isPresented: $showCamera) { PhotoPicker(image: $proof).ignoresSafeArea() }
    }

    private func map(_ o: Order) -> some View {
        var markers = state.depots.map { CwMarker(id: $0.id, lat: $0.lat, lng: $0.lng, title: $0.name, kind: .depot, radiusM: $0.geofenceRadiusM) }
        if let d = o.delivery { markers.append(CwMarker(id: "dest", lat: d.lat, lng: d.lng, title: "Customer", kind: .destination)) }
        let center = o.delivery.map { MapCenter(lat: $0.lat, lng: $0.lng, zoom: 14) } ?? .portMoresby
        return CwMap(center: center, markers: markers, followCenter: true, showsUser: true)
            .frame(height: 220)
            .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private func navigate(_ d: DeliveryLocation) {
        let item = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: d.lat, longitude: d.lng)))
        item.name = d.address
        item.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving])
    }

    private func load() async {
        do {
            let o = try await state.api.order(orderId)
            order = o
            state.activeOrder = OrderStatus.isTerminal(o.status) ? nil : o
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func perform(_ step: JobStep) {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let o: Order
                switch step {
                case .arriveDepot, .confirmLoaded:
                    // Depot geofence is checked on the server.
                    guard let loc = await LocationProvider.shared.current() else {
                        error = "Location is needed for this step. Turn on location and try again."
                        return
                    }
                    let (lat, lng) = (loc.coordinate.latitude, loc.coordinate.longitude)
                    o = step == .arriveDepot ? try await state.api.arriveDepot(orderId, lat: lat, lng: lng) : try await state.api.loaded(orderId, lat: lat, lng: lng)
                case .markArrived:
                    let loc = await LocationProvider.shared.current()
                    o = try await state.api.arrived(orderId, lat: loc?.coordinate.latitude, lng: loc?.coordinate.longitude)
                case .markDelivered:
                    var key: String?
                    if let proof, let jpeg = PhotoPicker.jpeg(proof) { key = try await state.api.upload(purpose: "proof_of_delivery", jpeg: jpeg) }
                    o = try await state.api.delivered(orderId, proofKey: key)
                    proof = nil
                default:
                    return
                }
                order = o
                state.activeOrder = OrderStatus.isTerminal(o.status) ? nil : o
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

struct IssueScreen: View {
    @EnvironmentObject var state: DriverState
    @EnvironmentObject var router: DriverRouter
    let orderId: String
    @State private var category = ""
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?

    private var categories: [String] {
        let c = state.config?.disputeCategories ?? []
        return c.isEmpty ? ["customer_absent", "wrong_address", "access_problem", "payment", "other"] : c
    }

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
                            try await state.api.reportIssue(orderId, category: category, description: text)
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
        .onAppear { if category.isEmpty { category = categories.first ?? "" } }
    }
}

/// Camera (or photo library on devices without one) returning a UIImage.
struct PhotoPicker: UIViewControllerRepresentable {
    @Binding var image: UIImage?
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController()
        p.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        p.delegate = context.coordinator
        return p
    }

    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: PhotoPicker
        init(_ p: PhotoPicker) { parent = p }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            parent.image = info[.originalImage] as? UIImage
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }

    /// JPEG at most 1600 px on the long side (keeps uploads small on 3G).
    static func jpeg(_ image: UIImage, maxSide: CGFloat = 1600, quality: CGFloat = 0.7) -> Data? {
        let s = image.size
        let scale = min(1, maxSide / max(s.width, s.height))
        let size = CGSize(width: s.width * scale, height: s.height * scale)
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        let resized = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        return resized.jpegData(compressionQuality: quality)
    }
}
