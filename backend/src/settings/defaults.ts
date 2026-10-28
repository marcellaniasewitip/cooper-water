/**
 * Admin-editable settings (§4). Every value here is a [CONFIRM] default until the client decides;
 * the code reads them at runtime so business decisions never need a code change.
 */
export const SETTING_DEFAULTS = {
  'commission.type': 'percent' as 'percent' | 'flat',
  /** Percent (e.g. 10 = 10%) when type=percent, toea when type=flat. */
  'commission.value': 10,
  'commission.deduct_at': 'completion' as 'acceptance' | 'completion',

  'wallet.min_balance_toea': 5000,

  /** Total time an order may stay unaccepted, split evenly across all broadcast rounds. */
  'order.acceptance_timeout_sec': 600,
  /** Extra rounds after the first, each with the next (wider) radius. */
  'order.rebroadcast_rounds': 1,
  /** Radius per broadcast round; the last value is reused if there are more rounds than values. */
  'order.dispatch_radius_m': [5000, 10000],
  /** Customer may cancel (free) only while the order is before this status. */
  'order.customer_cancel_free_until': 'ACCEPTED',
  'order.auto_complete_after_sec': 7200,
  /** [CONFIRM] One driver = one active order. */
  'order.one_active_per_driver': true,
  'order.max_quantity': 10,

  'payment.cellmoney.timeout_sec': 300,
  'payment.cellmoney.fee_bearer': 'platform' as 'customer' | 'driver' | 'platform',
  /** Provider fee as a percent of the amount, used to quote fees up front. [CONFIRM] with provider. */
  'payment.cellmoney.fee_percent': 0,
  /** Adapter used for new cell money payments: manual | mock | <real provider>. */
  'payment.cellmoney.adapter': 'manual',
  /** Shown to customers/drivers by the manual adapter: "Pay to <merchant_number> with reference <code>". */
  'payment.cellmoney.merchant_number': '',
  'payment.cellmoney.poll_interval_sec': 30,

  'depot.geofence_radius_m': 150,
  /** [CONFIRM] Driver can only go online inside a depot geofence. */
  'depot.online_gated': true,

  'driver.required_documents': ['drivers_licence', 'vehicle_registration', 'national_id', 'truck_photo'],
  'driver.location_stale_sec': 120,

  'otp.ttl_sec': 300,
  /** Channel tried first for sign-in codes when WhatsApp is configured (WHATSAPP_PROVIDER). SMS is always the fallback. */
  'otp.primary_channel': 'whatsapp' as 'whatsapp' | 'sms',
  /** Re-send the code by SMS if WhatsApp hasn't confirmed delivery within this many seconds. */
  'otp.whatsapp_fallback_sec': 45,
  'otp.max_attempts': 5,
  'otp.max_sends_per_phone_per_hour': 5,
  /** High because of carrier-grade NAT on PNG mobile networks. */
  'otp.max_sends_per_ip_per_hour': 200,

  'dispute.categories': ['not_delivered', 'short_volume', 'quality', 'payment', 'behaviour', 'other'],

  'payout.min_toea': 1000,
};

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFAULTS)[K];

/** Light validation so admins can't store values that break the engine. */
export function validateSetting(key: string, value: unknown): string | null {
  if (!(key in SETTING_DEFAULTS)) return `Unknown setting ${key}`;
  const def = (SETTING_DEFAULTS as Record<string, unknown>)[key];
  if (Array.isArray(def)) {
    if (!Array.isArray(value)) return `${key} must be a list`;
    if (typeof def[0] === 'number' && !value.every((v) => typeof v === 'number' && v > 0))
      return `${key} must be a list of positive numbers`;
    if (typeof def[0] === 'string' && !value.every((v) => typeof v === 'string' && v.length > 0))
      return `${key} must be a list of names`;
    if (value.length === 0) return `${key} cannot be empty`;
    return null;
  }
  if (typeof def !== typeof value) return `${key} must be a ${typeof def}`;
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) return `${key} must be a non-negative number`;
  const enums: Record<string, string[]> = {
    'commission.type': ['percent', 'flat'],
    'commission.deduct_at': ['acceptance', 'completion'],
    'payment.cellmoney.fee_bearer': ['customer', 'driver', 'platform'],
    'otp.primary_channel': ['whatsapp', 'sms'],
    'order.customer_cancel_free_until': ['SEARCHING', 'ACCEPTED', 'LOADING', 'EN_ROUTE', 'ARRIVED'],
  };
  if (enums[key] && !enums[key].includes(value as string)) return `${key} must be one of ${enums[key].join(', ')}`;
  const integerKeys = [
    'wallet.min_balance_toea',
    'order.acceptance_timeout_sec',
    'order.rebroadcast_rounds',
    'order.auto_complete_after_sec',
    'order.max_quantity',
    'payment.cellmoney.timeout_sec',
    'payment.cellmoney.poll_interval_sec',
    'depot.geofence_radius_m',
    'driver.location_stale_sec',
    'otp.ttl_sec',
    'otp.whatsapp_fallback_sec',
    'otp.max_attempts',
    'otp.max_sends_per_phone_per_hour',
    'otp.max_sends_per_ip_per_hour',
    'payout.min_toea',
  ];
  if (integerKeys.includes(key) && !Number.isInteger(value)) return `${key} must be a whole number`;
  return null;
}
