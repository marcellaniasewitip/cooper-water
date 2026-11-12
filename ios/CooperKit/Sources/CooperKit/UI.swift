#if canImport(UIKit)
import MapKit
import SwiftUI

// MARK: - Theme

public extension Color {
    /// Cooper Waters brand blue (same as Android CwBrandBlue and the admin).
    static let cwBlue = Color(red: 0x0A / 255, green: 0x6C / 255, blue: 0xBF / 255)
    static let cwBlueDeep = Color(red: 0x00 / 255, green: 0x3A / 255, blue: 0x66 / 255)
    static let cwBlueTint = Color(red: 0xD6 / 255, green: 0xE9 / 255, blue: 0xFA / 255)
    static let cwGreen = Color(red: 0x1B / 255, green: 0x7F / 255, blue: 0x3B / 255)
    static let cwRed = Color(red: 0xBA / 255, green: 0x1A / 255, blue: 0x1A / 255)
    static let cwCard = Color(UIColor.secondarySystemGroupedBackground)
    static let cwBackground = Color(UIColor.systemGroupedBackground)
}

// MARK: - Buttons

/// Full-width brand button with a spinner while busy.
public struct PrimaryButton: View {
    let title: String
    let busy: Bool
    let enabled: Bool
    let action: () -> Void

    public init(_ title: String, busy: Bool = false, enabled: Bool = true, action: @escaping () -> Void) {
        self.title = title
        self.busy = busy
        self.enabled = enabled
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            ZStack {
                Text(title.uppercased()).font(.headline).opacity(busy ? 0 : 1)
                if busy { ProgressView().tint(.white) }
            }
            .frame(maxWidth: .infinity, minHeight: 50)
        }
        .foregroundColor(.white)
        .background(RoundedRectangle(cornerRadius: 10).fill(enabled && !busy ? Color.cwBlue : Color.cwBlue.opacity(0.45)))
        .disabled(!enabled || busy)
    }
}

public struct SecondaryButton: View {
    let title: String
    let enabled: Bool
    let action: () -> Void
    public init(_ title: String, enabled: Bool = true, action: @escaping () -> Void) {
        self.title = title
        self.enabled = enabled
        self.action = action
    }
    public var body: some View {
        Button(action: action) {
            Text(title.uppercased()).font(.headline).frame(maxWidth: .infinity, minHeight: 50)
        }
        .foregroundColor(enabled ? .cwBlue : .secondary)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(enabled ? Color.cwBlue : Color.secondary.opacity(0.4), lineWidth: 1.5))
        .disabled(!enabled)
    }
}

// MARK: - Messages

public struct ErrorBanner: View {
    let message: String?
    let retry: (() -> Void)?
    public init(_ message: String?, retry: (() -> Void)? = nil) {
        self.message = message
        self.retry = retry
    }
    public var body: some View {
        if let message, !message.isEmpty {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.cwRed)
                Text(message).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
                if let retry { Button("Retry", action: retry).font(.subheadline.bold()) }
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.cwRed.opacity(0.1)))
        }
    }
}

public struct EmptyState: View {
    let text: String
    let systemImage: String
    public init(_ text: String, systemImage: String = "tray") {
        self.text = text
        self.systemImage = systemImage
    }
    public var body: some View {
        VStack(spacing: 12) {
            Image(systemName: systemImage).font(.system(size: 40)).foregroundColor(.secondary)
            Text(text).font(.body).foregroundColor(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
}

/// Small "Offline" strip shown at the top of screens when there's no connection.
public struct OfflineStrip: View {
    let offline: Bool
    public init(offline: Bool) { self.offline = offline }
    public var body: some View {
        if offline {
            Text("No connection. Showing saved data.")
                .font(.caption.bold())
                .foregroundColor(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(Color.orange)
        }
    }
}

public struct LabelValue: View {
    let label: String
    let value: String
    public init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }
    public var body: some View {
        HStack(alignment: .top) {
            Text(label).foregroundColor(.secondary)
            Spacer(minLength: 12)
            Text(value).multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
    }
}

public struct SectionTitle: View {
    let text: String
    public init(_ text: String) { self.text = text }
    public var body: some View {
        Text(text).font(.headline).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
    }
}

/// Card with a light border, like the Android apps.
public struct CardBox<Content: View>: View {
    let content: Content
    public init(@ViewBuilder content: () -> Content) { self.content = content() }
    public var body: some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.cwCard))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.secondary.opacity(0.18), lineWidth: 1))
    }
}

public struct StatusPill: View {
    let status: String
    public init(_ status: String) { self.status = status }
    public var body: some View {
        Text(OrderStatus.label(status))
            .font(.caption.bold())
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundColor(color)
            .background(Capsule().fill(color.opacity(0.12)))
    }
    private var color: Color {
        switch status {
        case OrderStatus.completed, OrderStatus.delivered: return .cwGreen
        case OrderStatus.cancelled, OrderStatus.expired, OrderStatus.failed: return .cwRed
        case OrderStatus.disputed: return .orange
        default: return .cwBlue
        }
    }
}

public extension View {
    /// Centred UPPERCASE title, StarTrip style.
    func cwTitle(_ title: String) -> some View {
        navigationTitle(title.uppercased()).navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Map

public struct CwMarker: Identifiable, Equatable {
    public enum Kind { case destination, driver, depot, me }
    public let id: String
    public let lat: Double
    public let lng: Double
    public let title: String?
    public let kind: Kind
    /** Draw a circle of this radius (depot geofence). */
    public let radiusM: Double?
    public init(id: String, lat: Double, lng: Double, title: String?, kind: Kind, radiusM: Double? = nil) {
        self.id = id
        self.lat = lat
        self.lng = lng
        self.title = title
        self.kind = kind
        self.radiusM = radiusM
    }
}

public struct MapCenter: Equatable {
    public let lat: Double
    public let lng: Double
    /** Rough zoom like the Android map: 12 ≈ city, 15 ≈ streets. */
    public let zoom: Double
    public init(lat: Double, lng: Double, zoom: Double = 14) {
        self.lat = lat
        self.lng = lng
        self.zoom = zoom
    }
    public static let portMoresby = MapCenter(lat: -9.4438, lng: 147.1803, zoom: 13)

    var region: MKCoordinateRegion {
        let span = 360 / pow(2, zoom) * 1.2
        return MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: lat, longitude: lng), span: MKCoordinateSpan(latitudeDelta: span, longitudeDelta: span))
    }
}

/// Apple Maps view with Cooper Waters markers. `followCenter` re-centres whenever `center` changes;
/// `onCenterChanged` reports the centre after the user pans (for "drag the map under the pin" pickers).
public struct CwMap: UIViewRepresentable {
    let center: MapCenter
    let markers: [CwMarker]
    let followCenter: Bool
    let showsUser: Bool
    let onCenterChanged: ((Double, Double) -> Void)?

    public init(center: MapCenter, markers: [CwMarker] = [], followCenter: Bool = false, showsUser: Bool = false, onCenterChanged: ((Double, Double) -> Void)? = nil) {
        self.center = center
        self.markers = markers
        self.followCenter = followCenter
        self.showsUser = showsUser
        self.onCenterChanged = onCenterChanged
    }

    public func makeCoordinator() -> Coordinator { Coordinator(self) }

    public func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        map.showsUserLocation = showsUser
        map.pointOfInterestFilter = .includingAll
        map.setRegion(center.region, animated: false)
        context.coordinator.lastCenter = center
        context.coordinator.sync(map, markers)
        return map
    }

    public func updateUIView(_ map: MKMapView, context: Context) {
        context.coordinator.parent = self
        map.showsUserLocation = showsUser
        if followCenter, context.coordinator.lastCenter != center {
            context.coordinator.lastCenter = center
            map.setRegion(center.region, animated: true)
        }
        context.coordinator.sync(map, markers)
    }

    public final class Coordinator: NSObject, MKMapViewDelegate {
        var parent: CwMap
        var lastCenter: MapCenter?
        private var shown: [CwMarker] = []

        init(_ parent: CwMap) { self.parent = parent }

        func sync(_ map: MKMapView, _ markers: [CwMarker]) {
            guard markers != shown else { return }
            shown = markers
            map.removeAnnotations(map.annotations.filter { !($0 is MKUserLocation) })
            map.removeOverlays(map.overlays)
            for m in markers {
                let a = MarkerAnnotation(m)
                map.addAnnotation(a)
                if let r = m.radiusM, r > 0 { map.addOverlay(MKCircle(center: a.coordinate, radius: r)) }
            }
        }

        public func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            guard let a = annotation as? MarkerAnnotation else { return nil }
            let v = MKMarkerAnnotationView(annotation: a, reuseIdentifier: "cw")
            switch a.marker.kind {
            case .destination:
                v.markerTintColor = UIColor(Color.cwRed)
                v.glyphImage = UIImage(systemName: "drop.fill")
            case .driver:
                v.markerTintColor = UIColor(Color.cwBlue)
                v.glyphImage = UIImage(systemName: "truck.box.fill")
            case .depot:
                v.markerTintColor = UIColor(Color.cwGreen)
                v.glyphImage = UIImage(systemName: "building.2.fill")
            case .me:
                v.markerTintColor = .systemBlue
                v.glyphImage = UIImage(systemName: "person.fill")
            }
            v.canShowCallout = a.title != nil
            return v
        }

        public func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            let r = MKCircleRenderer(overlay: overlay)
            r.fillColor = UIColor(Color.cwGreen).withAlphaComponent(0.12)
            r.strokeColor = UIColor(Color.cwGreen).withAlphaComponent(0.6)
            r.lineWidth = 1
            return r
        }

        public func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            let c = mapView.region.center
            parent.onCenterChanged?(c.latitude, c.longitude)
        }
    }
}

final class MarkerAnnotation: NSObject, MKAnnotation {
    let marker: CwMarker
    let coordinate: CLLocationCoordinate2D
    let title: String?
    init(_ m: CwMarker) {
        marker = m
        coordinate = CLLocationCoordinate2D(latitude: m.lat, longitude: m.lng)
        title = m.title
    }
}

// MARK: - Countdown

/// Seconds left until an ISO time, ticking every second.
public struct Countdown<Content: View>: View {
    let until: String?
    let content: (Int?) -> Content
    @State private var now = Date()
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    public init(until: String?, @ViewBuilder content: @escaping (Int?) -> Content) {
        self.until = until
        self.content = content
    }

    public var body: some View {
        content(PomTime.secondsUntil(until, now: now)).onReceive(timer) { now = $0 }
    }
}

// MARK: - Phone actions

public enum Phone {
    public static func dial(_ number: String) {
        let digits = number.filter { $0.isNumber || $0 == "+" }
        if let url = URL(string: "tel://\(digits)") { UIApplication.shared.open(url) }
    }
}
#endif
