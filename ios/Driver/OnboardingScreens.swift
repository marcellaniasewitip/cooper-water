import CooperKit
import SwiftUI

func documentLabel(_ type: String) -> String {
    switch type {
    case "drivers_licence": return "Driver's licence"
    case "vehicle_registration": return "Vehicle registration"
    case "national_id": return "National ID"
    case "truck_photo": return "Photo of your truck"
    default: return type.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

func documentStatus(_ s: String?) -> (String, Color) {
    switch s {
    case "pending": return ("In review", .orange)
    case "approved": return ("Approved", .cwGreen)
    case "rejected": return ("Rejected — upload again", .cwRed)
    default: return ("Needed", .secondary)
    }
}

/// Sign-up: upload the required documents and register the truck, then wait for approval.
struct OnboardingScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var state: DriverState
    @State private var picking: String?
    @State private var photo: UIImage?
    @State private var uploading: String?
    @State private var plate = ""
    @State private var capacity = ""
    @State private var truckPhoto: UIImage?
    @State private var pickingTruck = false
    @State private var savingTruck = false
    @State private var error: String?
    @State private var info: String?

    private var required: [String] { state.config?.requiredDocuments ?? ["drivers_licence", "vehicle_registration", "national_id"] }

    var body: some View {
        Form {
            Section(footer: Text("Take a clear photo of each document. Cooper Waters checks them before you can take jobs.")) {
                ForEach(required, id: \.self) { type in
                    let doc = state.profile?.documents?.first { $0.type == type }
                    let (label, color) = documentStatus(doc?.status)
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(documentLabel(type))
                            Text(label).font(.caption).foregroundColor(color)
                            if let n = doc?.notes, !n.isEmpty { Text(n).font(.caption).foregroundColor(.secondary) }
                        }
                        Spacer()
                        if uploading == type {
                            ProgressView()
                        } else if doc?.status != "approved" {
                            Button(doc?.status == nil || doc?.status == "missing" ? "Upload" : "Replace") { picking = type }
                        }
                    }
                }
            }
            Section("Your truck") {
                TextField("Number plate", text: $plate).textInputAutocapitalization(.characters)
                TextField("Tank capacity (litres)", text: $capacity).keyboardType(.numberPad)
                if let truckPhoto {
                    Image(uiImage: truckPhoto).resizable().scaledToFit().frame(maxHeight: 140)
                }
                Button(truckPhoto == nil ? "Add truck photo" : "Retake truck photo") { pickingTruck = true }
                PrimaryButton("Save truck", busy: savingTruck, enabled: plate.count >= 3 && Int(capacity) != nil) { saveTruck() }
                    .listRowInsets(EdgeInsets())
            }
            if let info { Section { Text(info).foregroundColor(.cwGreen) } }
            if let error { Section { ErrorBanner(error) } }
            Section {
                Button("Check approval status") { Task { await state.refreshAll() } }
                Button("Sign out", role: .destructive) { session.signOut() }
            }
        }
        .cwTitle("Get started")
        .onAppear {
            if plate.isEmpty { plate = state.profile?.truck?.plate ?? "" }
            if capacity.isEmpty, let c = state.profile?.truck?.capacityLitres { capacity = String(c) }
        }
        .sheet(item: Binding(get: { picking.map { Picked(id: $0) } }, set: { picking = $0?.id })) { p in
            PhotoPicker(image: Binding(get: { nil }, set: { img in if let img { upload(type: p.id, image: img) } })).ignoresSafeArea()
        }
        .sheet(isPresented: $pickingTruck) { PhotoPicker(image: $truckPhoto).ignoresSafeArea() }
    }

    private struct Picked: Identifiable { let id: String }

    private func upload(type: String, image: UIImage) {
        guard let jpeg = PhotoPicker.jpeg(image) else { return }
        uploading = type
        error = nil
        Task {
            do {
                let key = try await state.api.upload(purpose: "document", jpeg: jpeg)
                try await state.api.submitDocument(type: type, fileKey: key)
                info = "\(documentLabel(type)) uploaded."
                await state.refreshAll()
            } catch {
                self.error = error.localizedDescription
            }
            uploading = nil
        }
    }

    private func saveTruck() {
        guard let cap = Int(capacity) else { return }
        savingTruck = true
        error = nil
        Task {
            do {
                var key: String?
                if let truckPhoto, let jpeg = PhotoPicker.jpeg(truckPhoto) { key = try await state.api.upload(purpose: "truck_photo", jpeg: jpeg) }
                _ = try await state.api.putTruck(TruckRequest(plate: plate.uppercased().replacingOccurrences(of: " ", with: ""), capacityLitres: cap, photoKey: key))
                info = "Truck saved."
                await state.refreshAll()
            } catch {
                self.error = error.localizedDescription
            }
            savingTruck = false
        }
    }
}

/// Waiting for approval / rejected / suspended.
struct WaitingScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var state: DriverState

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: icon).font(.system(size: 60)).foregroundColor(.cwBlue)
            Text(title).font(.title2.bold()).multilineTextAlignment(.center)
            Text(bodyText).multilineTextAlignment(.center).foregroundColor(.secondary)
            if let r = state.profile?.rejectReason, !r.isEmpty { Text(r).font(.subheadline).foregroundColor(.cwRed) }
            Spacer()
            PrimaryButton("Refresh") { Task { await state.refreshAll() } }
            Button("Sign out", role: .destructive) { session.signOut() }
        }
        .padding(24)
        .cwTitle("Cooper Waters")
    }

    private var status: String { state.profile?.status ?? "" }
    private var icon: String { status == "pending_approval" ? "hourglass" : "exclamationmark.triangle" }
    private var title: String {
        switch status {
        case "pending_approval": return "Thanks! We're checking your documents"
        case "rejected": return "Your application needs attention"
        case "suspended": return "Your account is suspended"
        default: return "Almost there"
        }
    }
    private var bodyText: String {
        switch status {
        case "pending_approval": return "We'll let you know as soon as you're approved. This usually takes 1–2 working days."
        case "rejected": return "Please contact Cooper Waters support."
        case "suspended": return "Please contact Cooper Waters support."
        default: return "Pull to refresh."
        }
    }
}
