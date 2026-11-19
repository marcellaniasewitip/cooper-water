import Foundation
import SwiftUI

/// A vehicle size a driver can sign up with (one per order size); orders only go to matching vehicles.
public struct VehicleType: Decodable, Hashable, Identifiable {
    public let capacityLitres: Int
    public let name: String?
    public let packages: [String]?
    public var id: Int { capacityLitres }
    public var label: String { name.flatMap { $0.isEmpty ? nil : $0 } ?? "\(capacityLitres) L water tanker" }

    public init(capacityLitres: Int, name: String? = nil, packages: [String]? = nil) {
        self.capacityLitres = capacityLitres
        self.name = name
        self.packages = packages
    }
}

public struct SignatureRequest: Encodable {
    public let imagePng: String
    public let signedByName: String?
    public init(imagePng: String, signedByName: String?) {
        self.imagePng = imagePng
        self.signedByName = signedByName
    }
}

public struct SignatureSaved: Decodable {
    public let signed: Bool?
    public let signedByName: String?
}

public struct SendReceiptRequest: Encodable {
    public let email: String
    public let saveEmail: Bool?
    public init(email: String, saveEmail: Bool? = nil) {
        self.email = email
        self.saveEmail = saveEmail
    }
}

public struct ReceiptSent: Decodable {
    public let sent: Bool?
    public let email: String?
    public let configured: Bool?
}

/// Rules shared by the receipt screens (same as Android).
public enum ReceiptRules {
    /// Statuses where the receipt can be emailed (water handed over).
    public static let statuses: Set<String> = [OrderStatus.delivered, OrderStatus.completed, OrderStatus.disputed]

    public static func isValidEmail(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespaces)
        return t.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$"#, options: .regularExpression) != nil
    }
}

#if canImport(UIKit)
import UIKit

/// Strokes of a signature drawn with a finger.
public final class SignatureModel: ObservableObject {
    @Published public var strokes: [[CGPoint]] = []
    @Published public var current: [CGPoint] = []
    public var size: CGSize = .zero

    public init() {}

    public var isEmpty: Bool { strokes.isEmpty && current.count < 2 }

    public func clear() {
        strokes = []
        current = []
    }

    /// Black ink on white as PNG, base64; nil when nothing was drawn.
    public func pngBase64() -> String? {
        guard !isEmpty, size.width > 0, size.height > 0 else { return nil }
        let scale = min(1, 900 / size.width)
        let out = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: out, format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: out))
            UIColor.black.setStroke()
            for stroke in strokes + [current] where stroke.count > 1 {
                let path = UIBezierPath()
                path.lineWidth = 5
                path.lineCapStyle = .round
                path.lineJoinStyle = .round
                path.move(to: CGPoint(x: stroke[0].x * scale, y: stroke[0].y * scale))
                for p in stroke.dropFirst() { path.addLine(to: CGPoint(x: p.x * scale, y: p.y * scale)) }
                path.stroke()
            }
        }
        return image.pngData()?.base64EncodedString()
    }
}

/// White box the customer signs in with a finger.
public struct SignaturePad: View {
    @ObservedObject var model: SignatureModel
    let hint: String

    public init(model: SignatureModel, hint: String = "Customer signs here with a finger") {
        self.model = model
        self.hint = hint
    }

    public var body: some View {
        GeometryReader { geo in
            ZStack {
                RoundedRectangle(cornerRadius: 12).fill(Color.white)
                RoundedRectangle(cornerRadius: 12).stroke(Color.gray.opacity(0.5))
                if model.isEmpty { Text(hint).foregroundColor(.gray).font(.subheadline) }
                Path { path in
                    for stroke in model.strokes + [model.current] where stroke.count > 1 {
                        path.move(to: stroke[0])
                        for p in stroke.dropFirst() { path.addLine(to: p) }
                    }
                }
                .stroke(Color.black, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .local)
                    .onChanged { v in
                        model.size = geo.size
                        model.current.append(v.location)
                    }
                    .onEnded { _ in
                        if model.current.count > 1 { model.strokes.append(model.current) }
                        model.current = []
                    }
            )
            .onAppear { model.size = geo.size }
        }
        .frame(height: 170)
        .accessibilityLabel("Signature pad")
    }
}
#endif
