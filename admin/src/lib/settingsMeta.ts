/**
 * How each admin setting (backend/src/settings/defaults.ts) is edited. Unknown keys fall back to
 * an editor inferred from the value's JSON type, so new backend settings still render.
 */
export type SettingKind =
  | { kind: 'enum'; options: string[] }
  | { kind: 'integer'; min?: number; unit?: string }
  | { kind: 'number'; min?: number; max?: number; unit?: string }
  | { kind: 'money' }
  | { kind: 'boolean' }
  | { kind: 'string'; suggestions?: string[] }
  | { kind: 'numberList'; unit?: string }
  | { kind: 'stringList' }
  | { kind: 'commissionValue' };

export const SETTING_META: Record<string, SettingKind> = {
  'commission.type': { kind: 'enum', options: ['percent', 'flat'] },
  'commission.value': { kind: 'commissionValue' },
  'commission.deduct_at': { kind: 'enum', options: ['acceptance', 'completion'] },
  'wallet.min_balance_toea': { kind: 'money' },
  'order.acceptance_timeout_sec': { kind: 'integer', min: 0, unit: 's' },
  'order.rebroadcast_rounds': { kind: 'integer', min: 0 },
  'order.dispatch_radius_m': { kind: 'numberList', unit: 'm' },
  'order.customer_cancel_free_until': { kind: 'enum', options: ['SEARCHING', 'ACCEPTED', 'LOADING', 'EN_ROUTE', 'ARRIVED'] },
  'order.auto_complete_after_sec': { kind: 'integer', min: 0, unit: 's' },
  'order.one_active_per_driver': { kind: 'boolean' },
  'order.max_quantity': { kind: 'integer', min: 1 },
  'payment.cellmoney.timeout_sec': { kind: 'integer', min: 0, unit: 's' },
  'payment.cellmoney.fee_bearer': { kind: 'enum', options: ['customer', 'driver', 'platform'] },
  'payment.cellmoney.fee_percent': { kind: 'number', min: 0, max: 100, unit: '%' },
  'payment.cellmoney.adapter': { kind: 'string', suggestions: ['manual', 'mock'] },
  'payment.cellmoney.merchant_number': { kind: 'string' },
  'payment.cellmoney.poll_interval_sec': { kind: 'integer', min: 0, unit: 's' },
  'depot.geofence_radius_m': { kind: 'integer', min: 0, unit: 'm' },
  'depot.online_gated': { kind: 'boolean' },
  'driver.required_documents': { kind: 'stringList' },
  'driver.location_stale_sec': { kind: 'integer', min: 0, unit: 's' },
  'otp.ttl_sec': { kind: 'integer', min: 0, unit: 's' },
  'otp.max_attempts': { kind: 'integer', min: 0 },
  'otp.max_sends_per_phone_per_hour': { kind: 'integer', min: 0 },
  'otp.max_sends_per_ip_per_hour': { kind: 'integer', min: 0 },
  'dispute.categories': { kind: 'stringList' },
  'payout.min_toea': { kind: 'money' },
};

export function settingKind(key: string, value: unknown): SettingKind {
  const known = SETTING_META[key];
  if (known) return known;
  if (typeof value === 'boolean') return { kind: 'boolean' };
  if (typeof value === 'number') return key.endsWith('_toea') ? { kind: 'money' } : { kind: 'number', min: 0 };
  if (Array.isArray(value)) return typeof value[0] === 'number' ? { kind: 'numberList' } : { kind: 'stringList' };
  return { kind: 'string' };
}

export const SETTING_GROUPS = ['commission', 'wallet', 'order', 'payment', 'depot', 'driver', 'otp', 'dispute', 'other'] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export function settingGroup(key: string): SettingGroup {
  const prefix = key.split('.')[0];
  if (prefix === 'payout') return 'wallet';
  return (SETTING_GROUPS as readonly string[]).includes(prefix) ? (prefix as SettingGroup) : 'other';
}
