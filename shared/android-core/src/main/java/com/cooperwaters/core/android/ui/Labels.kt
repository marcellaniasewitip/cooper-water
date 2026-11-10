package com.cooperwaters.core.android.ui

import androidx.annotation.StringRes
import com.cooperwaters.core.R
import com.cooperwaters.core.order.OrderStatus

/** Resource ids for server enums, so status names are translatable. */
object Labels {
    @StringRes
    fun status(status: String): Int = when (status) {
        OrderStatus.PENDING_PAYMENT -> R.string.cw_status_PENDING_PAYMENT
        OrderStatus.SEARCHING -> R.string.cw_status_SEARCHING
        OrderStatus.ACCEPTED -> R.string.cw_status_ACCEPTED
        OrderStatus.LOADING -> R.string.cw_status_LOADING
        OrderStatus.EN_ROUTE -> R.string.cw_status_EN_ROUTE
        OrderStatus.ARRIVED -> R.string.cw_status_ARRIVED
        OrderStatus.DELIVERED -> R.string.cw_status_DELIVERED
        OrderStatus.COMPLETED -> R.string.cw_status_COMPLETED
        OrderStatus.CANCELLED -> R.string.cw_status_CANCELLED
        OrderStatus.EXPIRED -> R.string.cw_status_EXPIRED
        OrderStatus.FAILED -> R.string.cw_status_FAILED
        OrderStatus.DISPUTED -> R.string.cw_status_DISPUTED
        else -> R.string.cw_status_unknown
    }

    @StringRes
    fun paymentMethod(method: String?): Int = when (method) {
        "cellmoney" -> R.string.cw_payment_cellmoney
        "wallet" -> R.string.cw_payment_wallet
        else -> R.string.cw_payment_cod
    }

    /** Dispute categories come from config; known ones get a friendly label, unknown ones fall back to the raw key. */
    @StringRes
    fun disputeCategory(category: String): Int? = when (category) {
        "not_delivered" -> R.string.cw_dispute_not_delivered
        "short_volume" -> R.string.cw_dispute_short_volume
        "quality" -> R.string.cw_dispute_quality
        "payment" -> R.string.cw_dispute_payment
        "behaviour" -> R.string.cw_dispute_behaviour
        "other" -> R.string.cw_dispute_other
        else -> null
    }
}
