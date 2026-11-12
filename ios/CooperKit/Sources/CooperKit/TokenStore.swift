import Foundation
import Security

/// Sign-in tokens in the Keychain (this device only), plus the signed-in user.
public final class TokenStore {
    private let service: String
    private let lock = NSLock()
    private var cachedAccess: String?
    private var cachedRefresh: String?

    public init(service: String) {
        self.service = service
        cachedAccess = read("access")
        cachedRefresh = read("refresh")
    }

    public var accessToken: String? { lock.withLock { cachedAccess } }
    public var refreshToken: String? { lock.withLock { cachedRefresh } }
    public var isSignedIn: Bool { refreshToken != nil }

    public func save(access: String, refresh: String) {
        lock.withLock {
            cachedAccess = access
            cachedRefresh = refresh
        }
        write("access", access)
        write("refresh", refresh)
    }

    public func saveUser(_ user: AuthUser) {
        if let data = try? JSONEncoder().encode(user) { write("user", String(decoding: data, as: UTF8.self)) }
    }

    public func user() -> AuthUser? {
        guard let s = read("user") else { return nil }
        return try? JSONDecoder().decode(AuthUser.self, from: Data(s.utf8))
    }

    public func clear() {
        lock.withLock {
            cachedAccess = nil
            cachedRefresh = nil
        }
        for k in ["access", "refresh", "user"] { delete(k) }
    }

    // MARK: Keychain

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }

    private func read(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func write(_ key: String, _ value: String) {
        let data = Data(value.utf8)
        let status = SecItemUpdate(query(key) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var q = query(key)
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(q as CFDictionary, nil)
        }
    }

    private func delete(_ key: String) {
        SecItemDelete(query(key) as CFDictionary)
    }
}
