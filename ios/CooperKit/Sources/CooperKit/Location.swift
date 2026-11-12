#if os(iOS)
import CoreLocation
import Foundation

/// One-shot "where am I" with the When-In-Use permission prompt (both apps).
@MainActor
public final class LocationProvider: NSObject, CLLocationManagerDelegate {
    public static let shared = LocationProvider()
    private let manager = CLLocationManager()
    private var waiters: [CheckedContinuation<CLLocation?, Never>] = []
    private var authWaiters: [CheckedContinuation<Void, Never>] = []

    override private init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    public var authorized: Bool {
        let s = manager.authorizationStatus
        return s == .authorizedWhenInUse || s == .authorizedAlways
    }

    public var lastKnown: CLLocation? { manager.location }

    /// Current position, asking for permission first if needed; nil if denied or unavailable (15 s timeout).
    public func current() async -> CLLocation? {
        if manager.authorizationStatus == .notDetermined {
            await withCheckedContinuation { c in
                authWaiters.append(c)
                manager.requestWhenInUseAuthorization()
            }
        }
        guard authorized else { return nil }
        return await withCheckedContinuation { c in
            waiters.append(c)
            manager.requestLocation()
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                self.finish(self.manager.location)
            }
        }
    }

    private func finish(_ loc: CLLocation?) {
        let w = waiters
        waiters.removeAll()
        w.forEach { $0.resume(returning: loc) }
    }

    nonisolated public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let last = locations.last
        Task { @MainActor in self.finish(last) }
    }

    nonisolated public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finish(nil) }
    }

    nonisolated public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            guard manager.authorizationStatus != .notDetermined else { return }
            let w = self.authWaiters
            self.authWaiters.removeAll()
            w.forEach { $0.resume() }
        }
    }
}
#endif
