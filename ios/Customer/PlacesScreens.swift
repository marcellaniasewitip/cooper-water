import CooperKit
import SwiftUI

/// Saved places: list, add, edit, delete.
struct PlacesScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    @State private var places: [SavedLocation] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        List {
            if let error { ErrorBanner(error) { Task { await load() } }.listRowSeparator(.hidden) }
            if !loading && places.isEmpty && error == nil {
                EmptyState("No saved places yet. Add your home or office so ordering is quick.", systemImage: "mappin.and.ellipse").listRowSeparator(.hidden)
            }
            ForEach(places) { p in
                Button { router.go(.placeEdit(id: p.id)) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(p.label).font(.headline)
                        Text(p.addressText).font(.subheadline).foregroundColor(.secondary)
                        if let n = p.landmarkNotes, !n.isEmpty { Text(n).font(.caption).foregroundColor(.secondary) }
                    }
                }
                .buttonStyle(.plain)
            }
            .onDelete { idx in
                let ids = idx.map { places[$0].id }
                places.remove(atOffsets: idx)
                Task {
                    for id in ids { try? await session.customer.deleteLocation(id) }
                }
            }
        }
        .listStyle(.plain)
        .overlay { if loading && places.isEmpty { ProgressView() } }
        .cwTitle("Saved places")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { router.go(.placeEdit(id: nil)) } label: { Image(systemName: "plus") }
            }
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        do {
            places = try await session.customer.locations()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}

/// Add or edit a place: drag the map under the pin, then name it.
struct PlaceEditScreen: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var router: Router
    let locationId: String?

    @State private var label = ""
    @State private var address = ""
    @State private var landmark = ""
    @State private var lat = Geo.pomLat
    @State private var lng = Geo.pomLng
    @State private var center = MapCenter.portMoresby
    @State private var busy = false
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                CwMap(center: center, followCenter: true, showsUser: true) { la, ln in
                    lat = la
                    lng = ln
                }
                Image(systemName: "mappin").font(.system(size: 40)).foregroundColor(.cwRed).offset(y: -18).allowsHitTesting(false)
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Button { Task { await useMyLocation() } } label: {
                            Image(systemName: "location.fill").padding(12).background(Circle().fill(Color(UIColor.systemBackground))).shadow(radius: 2)
                        }
                        .padding(12)
                    }
                }
            }
            .frame(height: 300)
            Form {
                Section(footer: Text("Move the map so the pin is on your gate or tank.")) {
                    TextField("Name (e.g. Home, Office)", text: $label)
                    TextField("Address / area (e.g. Section 101, Gordons)", text: $address)
                    TextField("Landmark for the driver (optional)", text: $landmark)
                }
                if let error { Section { ErrorBanner(error) } }
                Section {
                    PrimaryButton("Save place", busy: busy, enabled: !label.trimmingCharacters(in: .whitespaces).isEmpty && !address.trimmingCharacters(in: .whitespaces).isEmpty) { save() }
                        .listRowInsets(EdgeInsets())
                }
            }
        }
        .cwTitle(locationId == nil ? "Add place" : "Edit place")
        .task { await load() }
    }

    private func load() async {
        guard !loaded else { return }
        loaded = true
        if let id = locationId, let p = try? await session.customer.locations().first(where: { $0.id == id }) {
            label = p.label
            address = p.addressText
            landmark = p.landmarkNotes ?? ""
            lat = p.lat
            lng = p.lng
            center = MapCenter(lat: p.lat, lng: p.lng, zoom: 17)
        } else if locationId == nil {
            await useMyLocation()
        }
    }

    private func useMyLocation() async {
        if let loc = await LocationProvider.shared.current() {
            center = MapCenter(lat: loc.coordinate.latitude, lng: loc.coordinate.longitude, zoom: 17)
        }
    }

    private func save() {
        busy = true
        error = nil
        let req = LocationRequest(label: label.trimmingCharacters(in: .whitespaces), addressText: address.trimmingCharacters(in: .whitespaces), lat: lat, lng: lng, landmarkNotes: landmark.isEmpty ? nil : landmark)
        Task {
            do {
                if let id = locationId { _ = try await session.customer.updateLocation(id, req) } else { _ = try await session.customer.addLocation(req) }
                router.back()
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}
