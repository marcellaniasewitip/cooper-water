package com.cooperwaters.core.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/*
 * API models for /api/v1 (see shared/openapi.json and the backend views in backend/src).
 * Money is always integer toea (Long). Timestamps are UTC ISO-8601 strings; format them with PomTime.
 * Response fields are defaulted generously because some realtime payloads are partial
 * (e.g. `order.updated` for a reassigned driver only carries id/shortCode/status).
 */

// ───────────── Common ─────────────

@Serializable
data class Page<T>(
    val items: List<T> = emptyList(),
    val nextCursor: String? = null,
)

@Serializable
data class LatLng(val lat: Double, val lng: Double)

@Serializable
data class PushTokenRequest(val token: String?)

// ───────────── Auth ─────────────

@Serializable
data class OtpRequest(val phone: String)

@Serializable
data class OtpRequestResponse(
    val phone: String,
    val ttlSec: Int = 300,
    /** Training mode (testing only): no SMS was sent and the server returns the code for the app to show. */
    val trainingMode: Boolean = false,
    val trainingCode: String? = null,
)

@Serializable
data class OtpVerifyRequest(
    val phone: String,
    val code: String,
    /** "customer" or "driver". */
    val app: String,
    val name: String? = null,
)

@Serializable
data class AuthUser(
    val id: String,
    val phone: String,
    val name: String? = null,
    val role: String = "",
)

@Serializable
data class AuthResponse(
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Long = 0,
    val user: AuthUser,
    val isNew: Boolean = false,
)

@Serializable
data class RefreshRequest(val refreshToken: String)

@Serializable
data class TokenPair(
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Long = 0,
)

@Serializable
data class UpdateProfileRequest(val name: String)

// ───────────── Orders (shared by both apps) ─────────────

@Serializable
data class PackageRef(
    val id: String = "",
    val name: String? = null,
    val volumeLitres: Int? = null,
)

@Serializable
data class DeliveryLocation(
    val lat: Double,
    val lng: Double,
    val address: String = "",
    val notes: String? = null,
)

@Serializable
data class OrderTimeline(
    val createdAt: String? = null,
    val paymentPendingAt: String? = null,
    val searchingAt: String? = null,
    val acceptedAt: String? = null,
    val loadingAt: String? = null,
    val enRouteAt: String? = null,
    val arrivedAt: String? = null,
    val deliveredAt: String? = null,
    val completedAt: String? = null,
    val cancelledAt: String? = null,
    val expiredAt: String? = null,
    val failedAt: String? = null,
    val disputedAt: String? = null,
)

@Serializable
data class TruckRef(val plate: String = "", val capacityLitres: Int = 0)

@Serializable
data class DriverLocation(val lat: Double, val lng: Double, val at: String? = null)

@Serializable
data class OrderDriver(
    val name: String = "",
    /** Only present while the order is trackable (ACCEPTED…ARRIVED). */
    val phone: String? = null,
    val ratingAvg: Double = 0.0,
    val truck: TruckRef? = null,
    val location: DriverLocation? = null,
)

@Serializable
data class OrderCustomer(
    val name: String = "",
    /** Only present while the job is active. */
    val phone: String? = null,
)

/**
 * One order as seen by a customer (customerOrderView) or a driver (driverOrderView).
 * Driver-only fields: commissionToea, earningsToea, customer. Customer-only: driver.
 */
@Serializable
data class Order(
    val id: String,
    val shortCode: String = "",
    val status: String = "",
    val `package`: PackageRef? = null,
    val quantity: Int = 0,
    val unitPriceToea: Long = 0,
    val priceToea: Long = 0,
    /** Promo discount; the customer pays (and a cash driver collects) [payableToea]. */
    val discountToea: Long = 0,
    val payableToea: Long = priceToea - discountToea,
    val paymentMethod: String? = null,
    val paymentStatus: String? = null,
    val delivery: DeliveryLocation? = null,
    val cancelReason: String? = null,
    val expiresAt: String? = null,
    val timeline: OrderTimeline = OrderTimeline(),
    val driver: OrderDriver? = null,
    val commissionToea: Long? = null,
    val earningsToea: Long? = null,
    val customer: OrderCustomer? = null,
)

@Serializable
data class ErrorBody(
    val code: String = "error",
    val message: String? = null,
    val details: JsonElement? = null,
)

@Serializable
data class ErrorEnvelope(val error: ErrorBody)

/** Payment view (PaymentsService.view). */
@Serializable
data class Payment(
    val id: String,
    /** initiated | pending | succeeded | failed | reversed | expired */
    val status: String,
    val amountToea: Long = 0,
    val feeToea: Long = 0,
    val reference: String = "",
    val expiresAt: String? = null,
    val failureReason: String? = null,
    val manual: Boolean = false,
    val instructions: String? = null,
) {
    val isOpen: Boolean get() = status == "initiated" || status == "pending"
}

// ───────────── Customer ─────────────

@Serializable
data class CustomerProfile(
    val id: String,
    val phone: String,
    val name: String? = null,
    val role: String? = null,
    val createdAt: String? = null,
)

@Serializable
data class CustomerConfig(
    val currency: String = "PGK",
    val timeZone: String = "Pacific/Port_Moresby",
    /** Customer may cancel while the order is strictly before this status. */
    val cancelFreeUntil: String = "ACCEPTED",
    val maxQuantity: Int = 10,
    val disputeCategories: List<String> = emptyList(),
    val paymentMethods: List<String> = listOf("cod", "cellmoney"),
    val cellmoneyTimeoutSec: Int = 300,
    val autoCompleteAfterSec: Int = 7200,
)

@Serializable
data class SavedLocation(
    val id: String,
    val label: String,
    val addressText: String,
    val lat: Double,
    val lng: Double,
    val landmarkNotes: String = "",
)

@Serializable
data class LocationRequest(
    val label: String,
    val addressText: String,
    val lat: Double,
    val lng: Double,
    val landmarkNotes: String? = null,
)

@Serializable
data class WaterPackage(
    val id: String,
    val name: String,
    val volumeLitres: Int,
    val priceToea: Long,
)

@Serializable
data class QuoteRequest(val packageId: String, val quantity: Int, val promoCode: String? = null)

@Serializable
data class Quote(
    val `package`: PackageRef,
    val quantity: Int,
    val unitPriceToea: Long,
    val priceToea: Long,
    /** Promo discount (Offers); the customer pays [payableToea]. */
    val discountToea: Long = 0,
    val payableToea: Long = priceToea,
    val promo: AppliedPromo? = null,
)

@Serializable
data class AppliedPromo(val code: String, val description: String = "")

@Serializable
data class CreateOrderRequest(
    val packageId: String,
    val quantity: Int,
    val locationId: String? = null,
    val location: DeliveryLocation? = null,
    /** "cod" | "cellmoney" | "wallet" */
    val paymentMethod: String,
    val msisdn: String? = null,
    val promoCode: String? = null,
)

@Serializable
data class CreateOrderResponse(
    val order: Order,
    val payment: Payment? = null,
    val paymentError: ErrorBody? = null,
)

@Serializable
data class StartPaymentRequest(val msisdn: String)

@Serializable
data class CancelRequest(val reason: String)

@Serializable
data class RateRequest(val stars: Int, val comment: String? = null)

@Serializable
data class Rating(
    val id: String,
    val orderId: String = "",
    val stars: Int = 0,
    val comment: String? = null,
)

@Serializable
data class DisputeRequest(val category: String, val description: String)

@Serializable
data class Dispute(
    val id: String,
    val orderId: String = "",
    val category: String = "",
    val description: String = "",
    val status: String = "open",
    val createdAt: String? = null,
)

// ───────────── Driver ─────────────

@Serializable
data class DriverConfig(
    val requiredDocuments: List<String> = emptyList(),
    val minBalanceToea: Long = 0,
    val onlineRequiresDepot: Boolean = true,
    val locationIntervalSec: Int = 20,
    val disputeCategories: List<String> = emptyList(),
    val merchantNumber: String? = null,
)

@Serializable
data class Truck(
    val id: String? = null,
    val plate: String,
    val capacityLitres: Int,
    val photoKey: String? = null,
)

@Serializable
data class DocumentState(
    val type: String,
    /** missing | pending | approved | rejected */
    val status: String = "missing",
    val notes: String? = null,
    val uploadedAt: String? = null,
)

@Serializable
data class WalletBrief(
    val balanceToea: Long = 0,
    val minBalanceToea: Long = 0,
    val blocked: Boolean = false,
)

@Serializable
data class DriverProfile(
    val id: String,
    val name: String? = null,
    val phone: String = "",
    /** pending_docs | pending_approval | approved | rejected | suspended */
    val status: String,
    val rejectReason: String? = null,
    val online: Boolean = false,
    val ratingAvg: Double = 0.0,
    val ratingCount: Int = 0,
    val truck: Truck? = null,
    val documents: List<DocumentState> = emptyList(),
    val wallet: WalletBrief = WalletBrief(),
    val canGoOnline: Boolean = false,
)

@Serializable
data class UploadRequest(
    /** document | topup_proof | proof_of_delivery | truck_photo */
    val purpose: String,
    val contentType: String,
    val contentLength: Long,
)

@Serializable
data class DirectUploadResult(val key: String)

@Serializable
data class UploadTicket(
    val key: String,
    val url: String,
    val method: String = "PUT",
    val headers: Map<String, String> = emptyMap(),
    val expiresIn: Long? = null,
)

@Serializable
data class SubmitDocumentRequest(val type: String, val fileKey: String)

@Serializable
data class DriverDocument(
    val id: String,
    val type: String,
    val fileKey: String = "",
    val status: String = "pending",
)

@Serializable
data class TruckRequest(val plate: String, val capacityLitres: Int, val photoKey: String? = null)

@Serializable
data class Depot(
    val id: String,
    val name: String,
    val lat: Double,
    val lng: Double,
    val geofenceRadiusM: Double? = null,
    val geofencePolygon: JsonElement? = null,
)

@Serializable
data class PositionRequest(val lat: Double, val lng: Double)

@Serializable
data class OptionalPositionRequest(val lat: Double? = null, val lng: Double? = null)

@Serializable
data class LocationPoint(val lat: Double, val lng: Double, val at: String? = null)

@Serializable
data class LocationBatch(val points: List<LocationPoint>)

@Serializable
data class LocationAck(val ok: Boolean = true, val online: Boolean = true)

@Serializable
data class Offer(
    val offerId: String = "",
    val orderId: String,
    val shortCode: String = "",
    /** Package name. */
    val `package`: String = "",
    /** Total litres (package volume × quantity). */
    val volumeLitres: Int = 0,
    val quantity: Int = 1,
    val distanceM: Double? = null,
    val earningsToea: Long = 0,
    val priceToea: Long = 0,
    val paymentMethod: String? = null,
    val expiresAt: String? = null,
    val delivery: DeliveryLocation? = null,
)

@Serializable
data class DeliveredRequest(val proofPhotoKey: String? = null)

@Serializable
data class PendingTopups(val count: Int = 0, val amountToea: Long = 0)

@Serializable
data class WalletSummary(
    val walletId: String = "",
    val balanceToea: Long = 0,
    val minBalanceToea: Long = 0,
    val blocked: Boolean = false,
    val shortfallToea: Long = 0,
    val withdrawableToea: Long = 0,
    val payoutMinToea: Long = 0,
    val pendingTopups: PendingTopups = PendingTopups(),
    /** Withdrawals requested but not yet deducted (Cooper Waters deducts them when paying). */
    val pendingPayouts: PendingTopups = PendingTopups(),
)

@Serializable
data class LedgerEntry(
    val id: String,
    val amountToea: Long,
    val balanceAfter: Long = 0,
    /** topup | commission | order_earning | refund | adjustment | payout */
    val type: String,
    val referenceType: String? = null,
    val referenceId: String? = null,
    val description: String? = null,
    val createdAt: String? = null,
)

@Serializable
data class TopupRequest(
    /** bank_transfer | cellmoney | cash */
    val method: String,
    val amountToea: Long,
    val referenceText: String? = null,
    val proofFileKey: String? = null,
    val msisdn: String? = null,
)

@Serializable
data class Topup(
    val id: String,
    val method: String,
    val amountToea: Long,
    val referenceText: String = "",
    /** pending | approved | rejected | failed */
    val status: String = "pending",
    val rejectReason: String? = null,
    val createdAt: String? = null,
)

@Serializable
data class TopupResponse(val topup: Topup, val payment: Payment? = null)

@Serializable
data class WithdrawalRequest(
    val amountToea: Long,
    /** cellmoney | bank_transfer */
    val method: String,
    val destination: String,
)

@Serializable
data class Payout(
    val id: String,
    val amountToea: Long,
    val method: String = "",
    val destination: String = "",
    /** requested | approved | paid | rejected */
    val status: String = "requested",
    val createdAt: String? = null,
)

@Serializable
data class Earnings(
    val since: String? = null,
    val completedOrders: Int = 0,
    val grossToea: Long = 0,
    val commissionToea: Long = 0,
    val netToea: Long = 0,
    val cashCollectedToea: Long = 0,
    val cellmoneyEarningsCreditedToea: Long = 0,
    val topupsToea: Long = 0,
    val payoutsToea: Long = 0,
)

/** Realtime `wallet.updated` payload. */
@Serializable
data class WalletUpdate(
    val balanceToea: Long,
    val minBalanceToea: Long? = null,
    val blocked: Boolean? = null,
)

// ───────────── Customer wallet, offers, referral, inbox, chat ─────────────

@Serializable
data class CustomerWallet(
    val walletId: String = "",
    val balanceToea: Long = 0,
    val pendingTopups: PendingTopups = PendingTopups(),
)

/** A promo code shown on the Offers screen (named to avoid clashing with driver job [Offer]s). */
@Serializable
data class PromoOffer(
    val code: String,
    val description: String = "",
    /** percent | flat */
    val discountType: String = "flat",
    /** percent: 1–100; flat: toea */
    val discountValue: Long = 0,
    val maxDiscountToea: Long? = null,
    val minOrderToea: Long = 0,
    val expiresAt: String? = null,
    val usable: Boolean = true,
)

@Serializable
data class PromoCheckRequest(val code: String)

@Serializable
data class ReferralInfo(
    val enabled: Boolean = true,
    val code: String = "",
    val rewardToea: Long = 0,
    val invitedCount: Int = 0,
    val rewardedCount: Int = 0,
    val earnedToea: Long = 0,
    val referredByCode: String? = null,
    val canApplyCode: Boolean = false,
)

@Serializable
data class ReferralApplyRequest(val code: String)

@Serializable
data class InboxItem(
    val id: String,
    val title: String = "",
    val body: String = "",
    val template: String = "",
    val createdAt: String? = null,
)

@Serializable
data class ChatMessage(
    val id: String,
    val body: String,
    val mine: Boolean = false,
    /** customer | driver */
    val senderRole: String = "",
    val createdAt: String? = null,
    val readAt: String? = null,
)

@Serializable
data class ChatLastMessage(val body: String, val mine: Boolean = false, val createdAt: String? = null)

@Serializable
data class ChatConversation(
    val orderId: String,
    val shortCode: String = "",
    val otherName: String = "",
    /** Messages can still be sent (order active). */
    val open: Boolean = false,
    val lastMessage: ChatLastMessage? = null,
    val unread: Int = 0,
    val updatedAt: String? = null,
)

@Serializable
data class ChatThread(
    val orderId: String,
    val shortCode: String = "",
    val otherName: String = "",
    val open: Boolean = false,
    val messages: List<ChatMessage> = emptyList(),
)

@Serializable
data class ChatSendRequest(val body: String)

// ───────────── Google Maps address search (GET /geo/*) ─────────────

@Serializable
data class GeoStatus(val search: Boolean = false, val provider: String? = null)

@Serializable
data class GeoPlace(
    val placeId: String? = null,
    val name: String = "",
    val address: String = "",
    val lat: Double,
    val lng: Double,
)

@Serializable
data class GeoSearchResult(val items: List<GeoPlace> = emptyList())

@Serializable
data class GeoReverseResult(val place: GeoPlace? = null)
