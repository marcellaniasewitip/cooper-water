import Foundation

/// A failed API call, in words a user can read.
public struct APIError: Error, LocalizedError, Equatable {
    public enum Kind: Equatable { case network, http, parse, sessionExpired }
    public let kind: Kind
    public let status: Int
    public let code: String
    public let serverMessage: String?

    public var errorDescription: String? {
        switch kind {
        case .network: return "No connection. Check your mobile data and try again."
        case .sessionExpired: return "Your session has ended. Please sign in again."
        case .parse: return "The server sent an unexpected reply. Please try again."
        case .http:
            if let m = serverMessage, !m.isEmpty { return m }
            if code == "rate_limited" { return "Too many attempts. Please wait a minute and try again." }
            return "Something went wrong. Please try again."
        }
    }

    public var isNetwork: Bool { kind == .network }
    public static func network() -> APIError { APIError(kind: .network, status: 0, code: "network", serverMessage: nil) }
}

/// Where the API lives. `baseURL` has no `/api/v1` (e.g. https://d123.cloudfront.net).
public struct APIConfig {
    public let baseURL: URL
    public let userAgent: String
    public init(baseURL: URL, userAgent: String) {
        self.baseURL = baseURL
        self.userAgent = userAgent
    }

    /// Reads `API_BASE_URL` from the app's Info.plist (set at build time by CI).
    public static func fromBundle(userAgent: String) -> APIConfig {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        let url = URL(string: raw.isEmpty ? "http://localhost:3100" : raw) ?? URL(string: "http://localhost:3100")!
        return APIConfig(baseURL: url, userAgent: userAgent)
    }
}

/// REST client for /api/v1: bearer token, single-flight refresh on 401 (refresh tokens rotate),
/// GET retries on flaky networks, and an Idempotency-Key header for retry-safe mutations.
public final class APIClient {
    public let config: APIConfig
    public let tokens: TokenStore
    /// Called when the refresh token is rejected: the app signs out.
    public var onSessionExpired: (() -> Void)?

    private let session: URLSession
    private let refresher = Refresher()
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(config: APIConfig, tokens: TokenStore) {
        self.config = config
        self.tokens = tokens
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        c.timeoutIntervalForResource = 90
        c.waitsForConnectivity = false
        session = URLSession(configuration: c)
    }

    var apiRoot: URL { config.baseURL.appendingPathComponent("api/v1") }

    // MARK: Typed helpers

    public func get<T: Decodable>(_ path: String, query: [String: String?] = [:]) async throws -> T {
        try await send("GET", path, query: query, body: Optional<Empty>.none)
    }

    public func post<T: Decodable, B: Encodable>(_ path: String, _ body: B, idempotencyKey: String? = nil) async throws -> T {
        try await send("POST", path, body: body, idempotencyKey: idempotencyKey)
    }

    public func post<T: Decodable>(_ path: String, idempotencyKey: String? = nil) async throws -> T {
        try await send("POST", path, body: Empty(), idempotencyKey: idempotencyKey)
    }

    public func patch<T: Decodable, B: Encodable>(_ path: String, _ body: B) async throws -> T {
        try await send("PATCH", path, body: body)
    }

    public func put<T: Decodable, B: Encodable>(_ path: String, _ body: B) async throws -> T {
        try await send("PUT", path, body: body)
    }

    public func delete(_ path: String) async throws {
        let _: Empty? = try await sendOptional("DELETE", path, body: Optional<Empty>.none)
    }

    /// For endpoints whose body may be JSON `null` (e.g. GET /driver/orders/active).
    public func getOptional<T: Decodable>(_ path: String) async throws -> T? {
        try await sendOptional("GET", path, body: Optional<Empty>.none)
    }

    /// Calls that ignore the response body.
    public func call<B: Encodable>(_ method: String, _ path: String, _ body: B) async throws {
        let _: Empty? = try await sendOptional(method, path, body: body)
    }

    public func call(_ method: String, _ path: String) async throws {
        let _: Empty? = try await sendOptional(method, path, body: Empty())
    }

    // MARK: Auth (no bearer)

    public func requestOtp(phone: String) async throws -> OtpRequestResponse {
        try await raw("POST", "auth/otp/request", body: OtpRequest(phone: phone), authorized: false)
    }

    public func verifyOtp(phone: String, code: String, app: String, name: String?) async throws -> AuthResponse {
        let r: AuthResponse = try await raw("POST", "auth/otp/verify", body: OtpVerifyRequest(phone: phone, code: code, app: app, name: name), authorized: false)
        tokens.save(access: r.accessToken, refresh: r.refreshToken)
        tokens.saveUser(r.user)
        return r
    }

    public func logout() async {
        if let rt = tokens.refreshToken {
            _ = try? await raw("POST", "auth/logout", body: RefreshRequest(refreshToken: rt), authorized: false) as Empty?
        }
        tokens.clear()
    }

    // MARK: Core

    private func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, query: [String: String?] = [:], body: B?, idempotencyKey: String? = nil) async throws -> T {
        guard let v: T = try await sendOptional(method, path, query: query, body: body, idempotencyKey: idempotencyKey) else {
            throw APIError(kind: .parse, status: 200, code: "empty", serverMessage: nil)
        }
        return v
    }

    private func sendOptional<T: Decodable, B: Encodable>(_ method: String, _ path: String, query: [String: String?] = [:], body: B?, idempotencyKey: String? = nil) async throws -> T? {
        var attempt = 0
        var refreshed = false
        while true {
            do {
                return try await raw(method, path, query: query, body: body, idempotencyKey: idempotencyKey, authorized: true)
            } catch let e as APIError where e.status == 401 && !refreshed {
                refreshed = true
                guard await refreshTokens(failed: tokens.accessToken) else {
                    throw APIError(kind: .sessionExpired, status: 401, code: "session_expired", serverMessage: nil)
                }
            } catch let e as APIError where method == "GET" && attempt < 2 && (e.isNetwork || (502...504).contains(e.status)) {
                attempt += 1
                try? await Task.sleep(nanoseconds: UInt64(500_000_000 * attempt))
            }
        }
    }

    private func raw<T: Decodable, B: Encodable>(_ method: String, _ path: String, query: [String: String?] = [:], body: B?, idempotencyKey: String? = nil, authorized: Bool) async throws -> T? {
        var comps = URLComponents(url: apiRoot.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        let items = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }
        if !items.isEmpty { comps.queryItems = items }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.setValue(config.userAgent, forHTTPHeaderField: "User-Agent")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let key = idempotencyKey { req.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        if authorized, let t = tokens.accessToken { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        if let body, method != "GET" {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try encoder.encode(body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.network()
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let env = try? decoder.decode(ErrorEnvelope.self, from: data)
            throw APIError(kind: .http, status: status, code: env?.error.code ?? "http_\(status)", serverMessage: env?.error.message)
        }
        let trimmed = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty || trimmed == "null" {
            if T.self == Empty.self { return (Empty() as! T) }
            return nil
        }
        if T.self == Empty.self { return (Empty() as! T) }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError(kind: .parse, status: status, code: "parse", serverMessage: nil)
        }
    }

    /// Single-flight refresh: concurrent 401s share one refresh call (refresh tokens rotate).
    @discardableResult
    public func refreshTokens(failed: String?) async -> Bool {
        await refresher.run { [weak self] in
            guard let self else { return false }
            // Someone else already refreshed while we waited.
            if let current = self.tokens.accessToken, current != failed { return true }
            guard let rt = self.tokens.refreshToken else { return false }
            do {
                guard let pair: TokenPair = try await self.raw("POST", "auth/refresh", body: RefreshRequest(refreshToken: rt), authorized: false) else { return false }
                self.tokens.save(access: pair.accessToken, refresh: pair.refreshToken)
                return true
            } catch let e as APIError where e.status == 401 || e.status == 403 {
                self.tokens.clear()
                await MainActor.run { self.onSessionExpired?() }
                return false
            } catch {
                return false
            }
        }
    }

    /// Upload bytes to a presigned URL (S3).
    public func uploadPresigned(_ ticket: UploadTicket, data: Data, contentType: String) async throws {
        guard let url = URL(string: ticket.url) else { throw APIError(kind: .parse, status: 0, code: "bad_url", serverMessage: nil) }
        var req = URLRequest(url: url)
        req.httpMethod = ticket.method ?? "PUT"
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        for (k, v) in ticket.headers ?? [:] { req.setValue(v, forHTTPHeaderField: k) }
        let response: URLResponse
        do {
            (_, response) = try await session.upload(for: req, from: data)
        } catch {
            throw APIError.network()
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw APIError(kind: .http, status: status, code: "upload_failed", serverMessage: nil) }
    }

    /// Fallback upload through the API (POST /driver/uploads/direct) when the presigned PUT fails.
    public func uploadDirect(purpose: String, data: Data, contentType: String, reason: String?) async throws -> String {
        var comps = URLComponents(url: apiRoot.appendingPathComponent("driver/uploads/direct"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "purpose", value: purpose)]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        req.setValue(config.userAgent, forHTTPHeaderField: "User-Agent")
        if let reason { req.setValue(reason, forHTTPHeaderField: "X-Upload-Fallback-Reason") }
        if let t = tokens.accessToken { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        let (body, response): (Data, URLResponse)
        do {
            (body, response) = try await session.upload(for: req, from: data)
        } catch {
            throw APIError.network()
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let env = try? decoder.decode(ErrorEnvelope.self, from: body)
            throw APIError(kind: .http, status: status, code: env?.error.code ?? "upload_failed", serverMessage: env?.error.message)
        }
        guard let r = try? decoder.decode(DirectUploadResult.self, from: body) else { throw APIError(kind: .parse, status: status, code: "parse", serverMessage: nil) }
        return r.key
    }

    /// Socket.IO server URL (namespace `/realtime`).
    public var realtimeURL: URL { config.baseURL }
}

/// Serialises token refreshes.
actor Refresher {
    private var inFlight: Task<Bool, Never>?

    func run(_ op: @escaping () async -> Bool) async -> Bool {
        if let t = inFlight { return await t.value }
        let t = Task { await op() }
        inFlight = t
        let r = await t.value
        inFlight = nil
        return r
    }
}

/// Random key for one logical mutation (reuse it for every retry of that mutation).
public func newIdempotencyKey() -> String { UUID().uuidString.lowercased() }
