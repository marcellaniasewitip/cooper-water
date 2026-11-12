import XCTest
@testable import CooperKit

final class CooperKitTests: XCTestCase {
    func testMoneyFormat() {
        XCTAssertEqual(Money.format(Int64(1250)), "K12.50")
        XCTAssertEqual(Money.format(Int64(125_000_00)), "K125,000.00")
        XCTAssertEqual(Money.format(Int64(-500)), "-K5.00")
        XCTAssertEqual(Money.formatSigned(1000), "+K10.00")
    }

    func testMoneyParse() {
        XCTAssertEqual(Money.parseKina("12"), 1200)
        XCTAssertEqual(Money.parseKina("12.5"), 1250)
        XCTAssertEqual(Money.parseKina("K1,250.00"), 125_000)
        XCTAssertNil(Money.parseKina("12.345"))
        XCTAssertNil(Money.parseKina("abc"))
        XCTAssertNil(Money.parseKina(""))
        XCTAssertNil(Money.parseKina("1,25"))
    }

    func testCancelRule() {
        XCTAssertTrue(OrderStatus.customerMayCancel("SEARCHING", cancelFreeUntil: "ACCEPTED"))
        XCTAssertFalse(OrderStatus.customerMayCancel("ACCEPTED", cancelFreeUntil: "ACCEPTED"))
        XCTAssertFalse(OrderStatus.customerMayCancel("COMPLETED", cancelFreeUntil: "COMPLETED"))
    }

    func testParsesRealtimeEvents() {
        let order = RealtimeEvents.parse("order.updated", Data(#"{"order":{"id":"o1","shortCode":"CW-1","status":"CANCELLED"}}"#.utf8))
        guard case .orderUpdated(let o)? = order else { return XCTFail("order") }
        XCTAssertEqual(o.status, "CANCELLED")

        let offer = RealtimeEvents.parse("order.offer", Data(#"{"offer":{"orderId":"o","shortCode":"CW-2","package":"Small tank","volumeLitres":2000,"quantity":2,"earningsToea":14400,"expiresAt":"2026-10-16T06:00:00.000Z","delivery":{"lat":-9.4,"lng":147.1,"address":"Boroko"}}}"#.utf8))
        guard case .offerReceived(let f)? = offer else { return XCTFail("offer") }
        XCTAssertEqual(f.earningsToea, 14400)

        let msg = RealtimeEvents.parse("notification.message", Data(#"{"broadcastId":"b1","title":"Depot closed","body":"Gordons is closed today."}"#.utf8))
        guard case .message(let id, let title, _)? = msg else { return XCTFail("message") }
        XCTAssertEqual(id, "b1")
        XCTAssertEqual(title, "Depot closed")

        XCTAssertNil(RealtimeEvents.parse("unknown", Data("{}".utf8)))
    }

    func testDecodesOrderWithMissingFields() throws {
        let o = try JSONDecoder().decode(Order.self, from: Data(#"{"id":"x","status":"SEARCHING","priceToea":30000,"discountToea":5000}"#.utf8))
        XCTAssertEqual(o.amountDueToea, 25000)
        XCTAssertEqual(OrderStatus.steps(o).first?.status, "SEARCHING")
    }

    func testPomTime() {
        XCTAssertEqual(PomTime.formatTime("2026-10-16T00:30:00.000Z"), "10:30 AM")
        XCTAssertEqual(PomTime.formatCountdown(75), "1:15")
    }
}
