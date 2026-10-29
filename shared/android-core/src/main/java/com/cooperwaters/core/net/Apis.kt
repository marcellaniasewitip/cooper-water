package com.cooperwaters.core.net

import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query

const val IDEMPOTENCY_HEADER = "Idempotency-Key"

/** Public auth endpoints. Served by a client WITHOUT the token authenticator. */
interface AuthApi {
    @POST("auth/otp/request")
    suspend fun requestOtp(@Body body: OtpRequest): OtpRequestResponse

    @POST("auth/otp/verify")
    suspend fun verifyOtp(@Body body: OtpVerifyRequest): AuthResponse

    @POST("auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): TokenPair

    @POST("auth/logout")
    suspend fun logout(@Body body: RefreshRequest): Response<Unit>
}

interface CustomerApi {
    @GET("customer/me")
    suspend fun me(): CustomerProfile

    @PATCH("customer/me")
    suspend fun updateMe(@Body body: UpdateProfileRequest): CustomerProfile

    @PUT("customer/me/push-token")
    suspend fun setPushToken(@Body body: PushTokenRequest): Response<Unit>

    @GET("customer/config")
    suspend fun config(): CustomerConfig

    @GET("customer/locations")
    suspend fun locations(): List<SavedLocation>

    @POST("customer/locations")
    suspend fun addLocation(@Body body: LocationRequest): SavedLocation

    @PATCH("customer/locations/{id}")
    suspend fun updateLocation(@Path("id") id: String, @Body body: LocationRequest): SavedLocation

    @DELETE("customer/locations/{id}")
    suspend fun deleteLocation(@Path("id") id: String): Response<Unit>

    @GET("customer/packages")
    suspend fun packages(): List<WaterPackage>

    @POST("customer/quote")
    suspend fun quote(@Body body: QuoteRequest): Quote

    /** Idempotent: reuse the same key for every retry of one "Place order" tap. */
    @POST("customer/orders")
    suspend fun createOrder(@Header(IDEMPOTENCY_HEADER) key: String, @Body body: CreateOrderRequest): CreateOrderResponse

    @GET("customer/orders")
    suspend fun orders(@Query("cursor") cursor: String? = null, @Query("limit") limit: Int? = null): Page<Order>

    @GET("customer/orders/{id}")
    suspend fun order(@Path("id") id: String): Order

    /** Idempotent: retry starting a cell money collection. */
    @POST("customer/orders/{id}/payment")
    suspend fun startPayment(@Header(IDEMPOTENCY_HEADER) key: String, @Path("id") id: String, @Body body: StartPaymentRequest): Payment

    /** Body is the payment view or `null`; decode with [decodeNullable]. */
    @GET("customer/orders/{id}/payment")
    suspend fun payment(@Path("id") id: String): Response<ResponseBody>

    @POST("customer/orders/{id}/cancel")
    suspend fun cancel(@Path("id") id: String, @Body body: CancelRequest): Order

    @POST("customer/orders/{id}/confirm")
    suspend fun confirm(@Path("id") id: String): Order

    @POST("customer/orders/{id}/rating")
    suspend fun rate(@Path("id") id: String, @Body body: RateRequest): Rating

    @POST("customer/orders/{id}/disputes")
    suspend fun dispute(@Path("id") id: String, @Body body: DisputeRequest): Dispute
}

interface DriverApi {
    @GET("driver/me")
    suspend fun me(): DriverProfile

    @PATCH("driver/me")
    suspend fun updateMe(@Body body: UpdateProfileRequest): DriverProfile

    @PUT("driver/me/push-token")
    suspend fun setPushToken(@Body body: PushTokenRequest): Response<Unit>

    @GET("driver/config")
    suspend fun config(): DriverConfig

    @POST("driver/uploads")
    suspend fun requestUpload(@Body body: UploadRequest): UploadTicket

    /** Fallback when the presigned PUT to S3 fails: send the bytes through the API instead. */
    @POST("driver/uploads/direct")
    suspend fun uploadDirect(
        @Query("purpose") purpose: String,
        @Header("X-Upload-Fallback-Reason") reason: String?,
        @Body body: okhttp3.RequestBody,
    ): DirectUploadResult

    @POST("driver/documents")
    suspend fun submitDocument(@Body body: SubmitDocumentRequest): DriverDocument

    @PUT("driver/truck")
    suspend fun putTruck(@Body body: TruckRequest): Truck

    @GET("driver/depots")
    suspend fun depots(): List<Depot>

    @POST("driver/online")
    suspend fun goOnline(@Body body: PositionRequest): DriverProfile

    @POST("driver/offline")
    suspend fun goOffline(): DriverProfile

    @POST("driver/location")
    suspend fun sendLocations(@Body body: LocationBatch): LocationAck

    @GET("driver/offers")
    suspend fun offers(): List<Offer>

    /** Idempotent, first-come-first-served. 409 `order_taken` when another driver won. */
    @POST("driver/orders/{id}/accept")
    suspend fun accept(@Header(IDEMPOTENCY_HEADER) key: String, @Path("id") orderId: String): Order

    @POST("driver/orders/{id}/decline")
    suspend fun decline(@Path("id") orderId: String): Response<Unit>

    /** Body is the active order or `null`; decode with [decodeNullable]. */
    @GET("driver/orders/active")
    suspend fun activeOrder(): Response<ResponseBody>

    @GET("driver/orders")
    suspend fun orders(@Query("cursor") cursor: String? = null, @Query("limit") limit: Int? = null): Page<Order>

    @GET("driver/orders/{id}")
    suspend fun order(@Path("id") id: String): Order

    @POST("driver/orders/{id}/arrive-depot")
    suspend fun arriveDepot(@Path("id") id: String, @Body body: PositionRequest): Order

    @POST("driver/orders/{id}/loaded")
    suspend fun loaded(@Path("id") id: String, @Body body: PositionRequest): Order

    @POST("driver/orders/{id}/arrived")
    suspend fun arrived(@Path("id") id: String, @Body body: OptionalPositionRequest): Order

    @POST("driver/orders/{id}/delivered")
    suspend fun delivered(@Path("id") id: String, @Body body: DeliveredRequest): Order

    @POST("driver/orders/{id}/issues")
    suspend fun reportIssue(@Path("id") id: String, @Body body: DisputeRequest): Dispute

    @GET("driver/wallet")
    suspend fun wallet(): WalletSummary

    @GET("driver/wallet/entries")
    suspend fun walletEntries(@Query("cursor") cursor: String? = null, @Query("limit") limit: Int? = null): Page<LedgerEntry>

    /** Idempotent. */
    @POST("driver/wallet/topups")
    suspend fun topup(@Header(IDEMPOTENCY_HEADER) key: String, @Body body: TopupRequest): TopupResponse

    @GET("driver/wallet/topups")
    suspend fun topups(@Query("cursor") cursor: String? = null, @Query("limit") limit: Int? = null): Page<Topup>

    /** Idempotent. */
    @POST("driver/wallet/withdrawals")
    suspend fun withdraw(@Header(IDEMPOTENCY_HEADER) key: String, @Body body: WithdrawalRequest): Payout

    @GET("driver/wallet/withdrawals")
    suspend fun withdrawals(@Query("cursor") cursor: String? = null, @Query("limit") limit: Int? = null): Page<Payout>

    /** period = today | week | month */
    @GET("driver/earnings")
    suspend fun earnings(@Query("period") period: String): Earnings
}
