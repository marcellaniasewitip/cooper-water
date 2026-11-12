// swift-tools-version:5.9
import PackageDescription

/// Code shared by the Cooper Waters iPhone apps: API client, models, sign-in, realtime, theme and UI pieces.
let package = Package(
    name: "CooperKit",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "CooperKit", targets: ["CooperKit"])],
    dependencies: [
        .package(url: "https://github.com/socketio/socket.io-client-swift", exact: "16.1.1"),
    ],
    targets: [
        .target(
            name: "CooperKit",
            dependencies: [.product(name: "SocketIO", package: "socket.io-client-swift")]
        ),
        .testTarget(name: "CooperKitTests", dependencies: ["CooperKit"]),
    ]
)
