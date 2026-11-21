import CooperKit
import SwiftUI

// MARK: - Manual booking API (driver books water for a customer by phone)

struct BookingTruck: Decodable { let plate: String; let capacityLitres: Int }
struct BookingPackage: Decodable, Identifiable, Hashable { let id: String; let name: String; let volumeLitres: Int; let priceToea: Int64 }
struct BookingOptions: Decodable {
    let truck: BookingTruck?
    let packages: [BookingPackage]
    let maxQuantity: Int?
}
struct CustomerLookupCompany: Decodable { let name: String }
struct CustomerLookup: Decodable {
    let phone: String
    let exists: Bool
    let name: String?
    let company: CustomerLookupCompany?
}
struct DriverBookingRequest: Encodable {
    let phone: String
    let customerName: String?
    let packageId: String
    let quantity: Int
    let location: DeliveryLocation
    let paymentMethod: String
}
struct DriverGeoStatus: Decodable { let search: Bool }
struct DriverGeoPlace: Decodable, Identifiable {
    let placeId: String?
    let name: String
    let address: String
    let lat: Double
    let lng: Double
    var id: String { placeId ?? "\(lat),\(lng)" }
}
struct DriverGeoSearchResult: Decodable { let items: [DriverGeoPlace] }
struct DriverGeoReverseResult: Decodable { let place: DriverGeoPlace? }

extension DriverAPI {
    func bookingOptions() async throws -> BookingOptions { try await api.get("driver/booking-options") }
    func lookupCustomer(_ phone: String) async throws -> CustomerLookup { try await api.get("driver/customers/lookup", query: ["phone": phone]) }
    func book(_ r: DriverBookingRequest, key: String) async throws -> Order { try await api.post("driver/bookings", r, idempotencyKey: key) }
    func geoStatus() async throws -> DriverGeoStatus { try await api.get("geo/status") }
    func geoSearch(_ q: String, lat: Double?, lng: Double?) async throws -> DriverGeoSearchResult {
        try await api.get("geo/search", query: ["q": q, "lat": lat.map { String($0) }, "lng": lng.map { String($0) }])
    }
    func geoReverse(lat: Double, lng: Double) async throws -> DriverGeoReverseResult {
        try await api.get("geo/reverse", query: ["lat": String(lat), "lng": String(lng)])
    }
}

// MARK: - Screen

/// Book for a customer: a customer phoned or stopped the truck. The driver books the water with the customer's
/// phone number (a new number gets a customer account) and the job is theirs straight away.
struct BookingScreen: View {
    @EnvironmentObject var state: DriverState
    @EnvironmentObject var router: DriverRouter

    @State private var loading = true
    @State private var options: BookingOptions?
    @State private var searchEnabled = false
    @State private var phone = ""
    @State private var lookup: CustomerLookup?
    @State private var lookingUp = false
    @State private var name = ""
    @State private var packageId: String?
    @State private var quantity = 1
    @State private var address = ""
    @State private var notes = ""
    @State private var lat: Double?
    @State private var lng: Double?
    @State private var pinSource: String?
    @State private var results: [DriverGeoPlace] = []
    @State private var paymentMethod = "cod"
    @State private var busy = false
    @State private var error: String?
    @State private var key = newIdempotencyKey()
    @State private var lookupTask: Task<Void, Never>?
    @State private var searchTask: Task<Void, Never>?
    @State private var picking = false

    private var selected: BookingPackage? { options?.packages.first { $0.id == packageId } }

    var body: some View {
        Form {
            if loading {
                Section { HStack { Spacer(); ProgressView(); Spacer() } }
            } else {
                Section {
                    Text("A customer called you or stopped your truck? Book the water here with their phone number. The job is yours straight away and the customer gets an SMS with the order.")
                        .font(.subheadline)
                }
                Section {
                    TextField("Customer phone number (7xxx xxxx)", text: $phone).keyboardType(.phonePad)
                    Text(lookupHelp).font(.footnote).foregroundColor(.secondary)
                    TextField("Customer name", text: $name).textContentType(.name)
                } header: { Text("Customer") }

                Section {
                    if let t = options?.truck { Text("Your truck \(t.plate) carries \(t.capacityLitres) L").font(.footnote).foregroundColor(.secondary) }
                    if options?.packages.isEmpty ?? true {
                        Text("No package matches your truck size. Ask the office to add one.").foregroundColor(.red)
                    }
                    ForEach(options?.packages ?? []) { p in
                        Button {
                            packageId = p.id
                        } label: {
                            HStack {
                                Image(systemName: packageId == p.id ? "largecircle.fill.circle" : "circle").foregroundColor(.cwBlue)
                                Text("\(p.name) · \(Money.format(p.priceToea))").foregroundColor(.primary)
                            }
                        }
                    }
                    Stepper("Quantity: \(quantity)", value: $quantity, in: 1...(options?.maxQuantity ?? 10))
                } header: { Text("Water") }

                Section {
                    TextField(searchEnabled ? "Address / landmark (type to search)" : "Address / landmark", text: $address)
                    ForEach(results.prefix(5)) { p in
                        Button { pick(p) } label: {
                            VStack(alignment: .leading) {
                                Text(p.name.isEmpty ? p.address : p.name).foregroundColor(.primary)
                                if !p.name.isEmpty && !p.address.isEmpty { Text(p.address).font(.caption).foregroundColor(.secondary) }
                            }
                        }
                    }
                    Button { useMyLocation() } label: {
                        HStack {
                            Label("Use my location", systemImage: "location.fill")
                            if picking { Spacer(); ProgressView() }
                        }
                    }
                    Text(pinText).font(.footnote).foregroundColor(lat == nil ? .red : .secondary)
                    TextField("Directions for delivery (optional)", text: $notes)
                } header: { Text("Deliver to") }

                Section {
                    Picker("Payment", selection: $paymentMethod) {
                        Text("Cash on delivery").tag("cod")
                        if let c = lookup?.company { Text("Company account (\(c.name))").tag("account") }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                } header: { Text("Payment") }

                if let p = selected {
                    Section { Text("Total: \(Money.format(p.priceToea * Int64(quantity)))").font(.headline) }
                }
                if let error { Section { ErrorBanner(error) } }
                Section {
                    PrimaryButton("Book and start the job", busy: busy, enabled: !(options?.packages.isEmpty ?? true)) { submit() }
                        .listRowInsets(EdgeInsets())
                } footer: {
                    Text("You can only book while you have no other job and your wallet is above the minimum.")
                }
            }
        }
        .cwTitle("Book for a customer")
        .task { await load() }
        .onChange(of: phone) { v in phoneChanged(v) }
        .onChange(of: address) { v in addressChanged(v) }
    }

    private var lookupHelp: String {
        if lookingUp { return "Checking…" }
        guard let l = lookup else { return "The number the customer uses (or will use) in the Cooper Waters app." }
        return l.exists ? "Registered customer: \(l.name ?? l.phone)" : "New customer: an account will be made for this number."
    }

    private var pinText: String {
        switch pinSource {
        case "gps": return "Pin: where you are now"
        case "search": return "Pin: from the search result"
        default: return "No pin yet: search or use your location"
        }
    }

    private func load() async {
        guard options == nil else { return }
        do {
            let o = try await state.api.bookingOptions()
            options = o
            packageId = o.packages.first?.id
        } catch { self.error = error.localizedDescription }
        searchEnabled = (try? await state.api.geoStatus())?.search ?? false
        loading = false
    }

    private func phoneChanged(_ v: String) {
        lookup = nil
        lookupTask?.cancel()
        guard v.filter(\.isNumber).count >= 7 else { return }
        lookupTask = Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            if Task.isCancelled { return }
            lookingUp = true
            do {
                let l = try await state.api.lookupCustomer(v)
                if Task.isCancelled { return }
                lookup = l
                if name.trimmingCharacters(in: .whitespaces).isEmpty, let n = l.name { name = n }
                if l.company == nil { paymentMethod = "cod" }
                error = nil
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
            lookingUp = false
        }
    }

    private func addressChanged(_ v: String) {
        searchTask?.cancel()
        let q = v.trimmingCharacters(in: .whitespaces)
        guard searchEnabled, q.count >= 3 else { results = []; return }
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 500_000_000)
            if Task.isCancelled { return }
            let r = try? await state.api.geoSearch(q, lat: lat, lng: lng)
            if !Task.isCancelled { results = r?.items ?? [] }
        }
    }

    private func pick(_ p: DriverGeoPlace) {
        searchTask?.cancel()
        let label = [p.name, p.address].filter { !$0.isEmpty }.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }.joined(separator: ", ")
        lat = p.lat
        lng = p.lng
        pinSource = "search"
        if !label.isEmpty { address = label }
        // Setting the address re-runs the search; clear the list after it.
        Task { try? await Task.sleep(nanoseconds: 50_000_000); searchTask?.cancel(); results = [] }
    }

    private func useMyLocation() {
        picking = true
        Task {
            defer { picking = false }
            guard let loc = await LocationProvider.shared.current() else {
                error = "Could not get your location. Turn on location, or search the address."
                return
            }
            lat = loc.coordinate.latitude
            lng = loc.coordinate.longitude
            pinSource = "gps"
            error = nil
            if address.trimmingCharacters(in: .whitespaces).isEmpty,
               let place = try? await state.api.geoReverse(lat: loc.coordinate.latitude, lng: loc.coordinate.longitude).place {
                address = place.address.isEmpty ? place.name : place.address
                searchTask?.cancel()
                results = []
            }
        }
    }

    private func submit() {
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        let trimmedAddress = address.trimmingCharacters(in: .whitespaces)
        guard phone.filter(\.isNumber).count >= 7 else { error = "Enter the customer's phone number."; return }
        guard lookup?.exists == true || !trimmedName.isEmpty else { error = "Enter the customer's name."; return }
        guard let packageId else { error = "Choose the water."; return }
        guard !trimmedAddress.isEmpty else { error = "Enter where to deliver."; return }
        guard let lat, let lng else { error = "Set the delivery pin: pick a search result or tap Use my location."; return }
        busy = true
        error = nil
        let notesText = notes.trimmingCharacters(in: .whitespaces)
        let req = DriverBookingRequest(
            phone: phone.trimmingCharacters(in: .whitespaces),
            customerName: trimmedName.isEmpty ? nil : trimmedName,
            packageId: packageId,
            quantity: quantity,
            location: DeliveryLocation(lat: lat, lng: lng, address: trimmedAddress, notes: notesText.isEmpty ? nil : notesText),
            paymentMethod: paymentMethod
        )
        Task {
            do {
                let order = try await state.api.book(req, key: key)
                await state.refreshAll()
                router.home()
                router.go(.job(orderId: order.id))
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}
