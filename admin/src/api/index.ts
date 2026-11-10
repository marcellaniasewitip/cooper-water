import { config } from '@/config';
import { ApiClient, type Query } from './client';
import { createLocalTokenStore } from './tokenStore';
import type * as T from './types';
import type { Dto } from './types';

export { ApiClient, ApiError, errorMessage } from './client';
export type * from './types';
export { ORDER_STATUSES } from './types';

let authLostHandler: () => void = () => undefined;
export function onAuthLost(fn: () => void): void {
  authLostHandler = fn;
}

export const tokenStore = createLocalTokenStore();

export const http = new ApiClient({
  baseUrl: config.apiBaseUrl,
  prefix: config.apiPrefix,
  store: tokenStore,
  onAuthLost: () => authLostHandler(),
});

type ListQuery = { cursor?: string | null; limit?: number; status?: string; q?: string; online?: string };
const enc = encodeURIComponent;

/** Typed endpoint functions for every admin route used by the dashboard. */
export const api = {
  auth: {
    login: (body: Dto<'AdminLoginDto'>) => http.request<T.LoginResult>('POST', '/auth/admin/login', { body, anonymous: true }),
    verifyTotp: (body: Dto<'AdminTotpVerifyDto'>) => http.request<T.TokenPair>('POST', '/auth/admin/totp/verify', { body, anonymous: true }),
    logout: (refreshToken: string) => http.request<void>('POST', '/auth/logout', { body: { refreshToken }, anonymous: true }),
    me: () => http.get<T.Me>('/auth/admin/me'),
    totpSetup: () => http.post<{ secret: string; otpauthUrl: string }>('/auth/admin/totp/setup'),
    totpEnable: (code: string) => http.post<void>('/auth/admin/totp/enable', { code } satisfies Dto<'TotpCodeDto'>),
  },
  overview: () => http.get<T.Overview>('/admin/overview'),
  fleet: () => http.get<T.FleetDriver[]>('/admin/fleet'),

  orders: {
    list: (q: Query) => http.get<T.Page<T.AdminOrder>>('/admin/orders', q),
    get: (id: string) => http.get<T.AdminOrderDetail>(`/admin/orders/${id}`),
    cancel: (id: string, body: Dto<'CancelDto'>) => http.post<T.AdminOrderDetail>(`/admin/orders/${id}/cancel`, body),
    reassign: (id: string, body: Dto<'ReassignDto'>) => http.post<T.AdminOrderDetail>(`/admin/orders/${id}/reassign`, body),
    refund: (id: string, body: Dto<'IssueRefundDto'>) => http.post<T.Payment>(`/admin/orders/${id}/refund`, body),
    messages: (id: string) => http.get<T.ChatMessage[]>(`/admin/orders/${id}/messages`),
  },
  customers: {
    list: (q: ListQuery) => http.get<T.Page<T.CustomerListItem>>('/admin/customers', q),
    get: (id: string) => http.get<T.CustomerDetail>(`/admin/customers/${id}`),
    suspend: (id: string) => http.post<{ id: string; status: string }>(`/admin/customers/${id}/suspend`),
    reactivate: (id: string) => http.post<{ id: string; status: string }>(`/admin/customers/${id}/reactivate`),
  },
  drivers: {
    list: (q: ListQuery) => http.get<T.Page<T.DriverListItem>>('/admin/drivers', q),
    get: (id: string) => http.get<T.DriverDetail>(`/admin/drivers/${id}`),
    setStatus: (id: string, action: 'approve' | 'reject' | 'suspend' | 'reinstate', reason?: string) =>
      http.post<unknown>(`/admin/drivers/${id}/${action}`, (reason ? { reason } : {}) satisfies Dto<'OptionalReasonDto'>),
    reviewDocument: (docId: string, body: Dto<'ReviewDocumentDto'>) => http.post<T.DriverDocument>(`/admin/drivers/documents/${docId}/review`, body),
    wallet: (id: string) => http.get<T.WalletSummary>(`/admin/drivers/${id}/wallet`),
  },
  trucks: {
    list: (q: ListQuery) => http.get<T.Page<T.TruckWithDriver>>('/admin/trucks', q),
    update: (id: string, body: Dto<'TruckUpdateDto'>) => http.patch<T.Truck>(`/admin/trucks/${id}`, body),
  },
  depots: {
    list: () => http.get<T.Depot[]>('/admin/depots'),
    create: (body: DepotInput) => http.post<T.Depot>('/admin/depots', body),
    update: (id: string, body: Partial<DepotInput>) => http.patch<T.Depot>(`/admin/depots/${id}`, body),
    remove: (id: string) => http.delete<void>(`/admin/depots/${id}`),
  },
  packages: {
    list: () => http.get<T.Package[]>('/admin/packages'),
    create: (body: Dto<'PackageDto'>) => http.post<T.Package>('/admin/packages', body),
    update: (id: string, body: Dto<'UpdatePackageDto'>) => http.patch<T.Package>(`/admin/packages/${id}`, body),
    remove: (id: string) => http.delete<void>(`/admin/packages/${id}`),
  },
  promos: {
    list: () => http.get<T.PromoCode[]>('/admin/promos'),
    create: (body: Dto<'PromoDto'>) => http.post<T.PromoCode>('/admin/promos', body),
    update: (id: string, body: Dto<'UpdatePromoDto'>) => http.patch<T.PromoCode>(`/admin/promos/${id}`, body),
  },
  settings: {
    all: () => http.get<T.SettingsMap>('/admin/settings'),
    set: (key: string, value: unknown) => http.put<{ key: string; value: unknown }>(`/admin/settings/${enc(key)}`, { value }),
  },
  topups: {
    list: (q: ListQuery) => http.get<T.Page<T.Topup>>('/admin/topups', q),
    approve: (id: string) => http.post<T.Topup>(`/admin/topups/${id}/approve`),
    reject: (id: string, reason: string) => http.post<T.Topup>(`/admin/topups/${id}/reject`, { reason } satisfies Dto<'ReasonDto'>),
  },
  wallets: {
    platform: () => http.get<T.PlatformWallet>('/admin/wallets/platform', { limit: 1 }),
    entries: (walletId: string, q: Query) => http.get<T.Page<T.LedgerEntry>>(`/admin/wallets/${walletId}/entries`, q),
    adjust: (walletId: string, body: Dto<'AdjustmentDto'>, idempotencyKey: string) =>
      http.post<T.LedgerEntry>(`/admin/wallets/${walletId}/adjustments`, body, { 'Idempotency-Key': idempotencyKey }),
  },
  payments: {
    list: (q: Query) => http.get<T.Page<T.Payment>>('/admin/payments', q),
    get: (id: string) => http.get<T.Payment>(`/admin/payments/${id}`),
    confirm: (id: string, receiptRef: string) => http.post<T.Payment>(`/admin/payments/${id}/confirm`, { receiptRef } satisfies Dto<'ConfirmPaymentDto'>),
    fail: (id: string, reason: string) => http.post<T.Payment>(`/admin/payments/${id}/fail`, { reason } satisfies Dto<'ReasonDto'>),
    recheck: (id: string) => http.post<T.Payment>(`/admin/payments/${id}/recheck`),
    completeRefund: (id: string, externalRef: string) =>
      http.post<void>(`/admin/payments/${id}/complete-refund`, { externalRef } satisfies Dto<'CompleteRefundDto'>),
    retryRefund: (id: string) => http.post<void>(`/admin/payments/${id}/retry-refund`),
    webhooks: (q: Query) => http.get<T.Page<T.WebhookEvent>>('/admin/webhook-events', q),
  },
  payouts: {
    list: (q: ListQuery) => http.get<T.Page<T.Payout>>('/admin/payouts', q),
    act: (id: string, action: 'approve' | 'paid' | 'reject', body: Dto<'PayoutActionDto'>) => http.post<T.Payout>(`/admin/payouts/${id}/${action}`, body),
  },
  disputes: {
    list: (q: ListQuery) => http.get<T.Page<T.DisputeListItem>>('/admin/disputes', q),
    get: (id: string) => http.get<T.DisputeDetail>(`/admin/disputes/${id}`),
    investigate: (id: string) => http.post<T.Dispute>(`/admin/disputes/${id}/investigate`),
    resolve: (id: string, body: Dto<'ResolveDisputeDto'>) => http.post<T.Dispute>(`/admin/disputes/${id}/resolve`, body),
  },
  templates: {
    list: () => http.get<T.NotificationTemplate[]>('/admin/notification-templates'),
    update: (key: string, body: Dto<'TemplateDto'>) => http.put<T.NotificationTemplate>(`/admin/notification-templates/${enc(key)}`, body),
  },
  access: {
    permissions: () => http.get<T.PermissionDef[]>('/admin/permissions'),
    roles: () => http.get<T.Role[]>('/admin/roles'),
    createRole: (body: Dto<'RoleDto'>) => http.post<unknown>('/admin/roles', body),
    updateRole: (id: string, body: Dto<'RoleDto'>) => http.put<unknown>(`/admin/roles/${id}`, body),
    deleteRole: (id: string) => http.delete<void>(`/admin/roles/${id}`),
    admins: () => http.get<T.AdminUser[]>('/admin/admins'),
    createAdmin: (body: Dto<'CreateAdminDto'>) => http.post<unknown>('/admin/admins', body),
    updateAdmin: (id: string, body: Dto<'UpdateAdminDto'>) => http.patch<unknown>(`/admin/admins/${id}`, body),
  },
  audit: (q: Query) => http.get<T.Page<T.AuditLog>>('/admin/audit-logs', q),
  reports: {
    daily: (q: RangeQuery) => http.get<T.DailyRow[]>('/admin/reports/daily', q),
    payments: (q: RangeQuery) => http.get<T.PaymentsReport>('/admin/reports/payments', q),
    drivers: (q: RangeQuery) => http.get<T.DriverPerfRow[]>('/admin/reports/drivers', q),
    csv: (kind: 'daily' | 'orders' | 'payments', q: RangeQuery) => http.raw('GET', `/admin/reports/${kind}.csv`, { query: q }),
  },
};

export interface RangeQuery extends Query {
  from: string;
  to: string;
}

/**
 * Depot body. The generated DTO marks geofencePolygon as required with loose typing (an OpenAPI
 * generation quirk); the backend accepts it as optional/nullable GeoJSON Polygon.
 */
export interface DepotInput {
  name: string;
  lat: number;
  lng: number;
  geofenceRadiusM?: number | null;
  geofencePolygon?: T.GeoPolygon | null;
  active?: boolean;
}
