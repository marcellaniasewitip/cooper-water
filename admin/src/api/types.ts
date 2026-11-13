/**
 * Response types hand-written to mirror the backend views (the OpenAPI spec only types requests).
 * Request DTOs come from the generated `schema.d.ts` (see `Dto` below).
 */
import type { components } from './schema';

export type Dto<K extends keyof components['schemas']> = components['schemas'][K];

export type ISO = string;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type LoginResult = ({ mfaRequired: false } & TokenPair) | { mfaRequired: true; mfaToken: string };

export interface Me {
  id: string;
  email: string;
  name: string;
  totpEnabled: boolean;
  role: { id: string; name: string };
  permissions: string[];
}

// ───────────── Orders ─────────────

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'SEARCHING',
  'ACCEPTED',
  'LOADING',
  'EN_ROUTE',
  'ARRIVED',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'FAILED',
  'DISPUTED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type PaymentMethod = 'cod' | 'cellmoney' | 'wallet';
export type OrderPaymentStatus = 'unpaid' | 'pending' | 'paid' | 'failed' | 'refund_pending' | 'refunded';
export type ActorType = 'customer' | 'driver' | 'admin' | 'system';

export interface OrderTimeline {
  createdAt: ISO;
  paymentPendingAt: ISO | null;
  searchingAt: ISO | null;
  acceptedAt: ISO | null;
  loadingAt: ISO | null;
  enRouteAt: ISO | null;
  arrivedAt: ISO | null;
  deliveredAt: ISO | null;
  completedAt: ISO | null;
  cancelledAt: ISO | null;
  expiredAt: ISO | null;
  failedAt: ISO | null;
  disputedAt: ISO | null;
}

export interface OrderEvent {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorType: ActorType;
  actorId: string | null;
  metadata: unknown;
  createdAt: ISO;
}

export interface AdminOrder {
  id: string;
  shortCode: string;
  status: OrderStatus;
  package: { id: string; name?: string; volumeLitres?: number };
  quantity: number;
  unitPriceToea: number;
  priceToea: number;
  /** Promo discount absorbed by Cooper Waters (0 when none). */
  discountToea?: number;
  /** What the customer pays: price − discount. */
  payableToea?: number;
  paymentMethod: PaymentMethod;
  paymentStatus: OrderPaymentStatus;
  delivery: { lat: number; lng: number; address: string; notes: string | null };
  cancelReason: string | null;
  expiresAt: ISO | null;
  timeline: OrderTimeline;
  commissionToea: number;
  commissionType: string;
  commissionValue: number;
  commissionDeductAt: string;
  commissionDeducted: boolean;
  settledAt: ISO | null;
  dispatchRound: number;
  statusBeforeDispute: OrderStatus | null;
  proofPhotoKey: string | null;
  customer: { id: string; name?: string | null; phone?: string };
  driver: {
    id: string;
    name?: string | null;
    phone?: string;
    plate?: string;
    location: { lat: number; lng: number | null; at: ISO | null } | null;
  } | null;
  events?: OrderEvent[];
}

export interface OrderOffer {
  id: string;
  driverId: string;
  driverName: string | null;
  round: number;
  distanceM: number | null;
  sentAt: ISO;
  response: 'accepted' | 'declined' | 'missed' | null;
  respondedAt: ISO | null;
}

export interface Rating {
  id: string;
  orderId: string;
  stars: number;
  comment: string | null;
  createdAt: ISO;
}

export interface AdminOrderDetail extends AdminOrder {
  proofPhotoUrl: string | null;
  offers: OrderOffer[];
  payments: Payment[];
  disputes: Dispute[];
  rating: Rating | null;
}

// ───────────── Payments ─────────────

export type PaymentStatus = 'initiated' | 'pending' | 'succeeded' | 'failed' | 'reversed' | 'expired';
export type PaymentPurpose = 'order' | 'topup' | 'refund' | 'payout';

export interface Payment {
  id: string;
  provider: 'cellmoney' | 'bank' | 'cash';
  adapter: string;
  direction: 'in' | 'out';
  amountToea: number;
  feeToea: number;
  feeBearer: string;
  status: PaymentStatus;
  providerRef: string | null;
  msisdn: string | null;
  reference: string;
  purpose: PaymentPurpose;
  purposeId: string;
  rawPayload: unknown;
  failureReason: string | null;
  idempotencyKey: string;
  expiresAt: ISO | null;
  settledAt: ISO | null;
  createdAt: ISO;
  updatedAt: ISO;
}

export interface WebhookEvent {
  id: string;
  provider: string;
  eventKey: string;
  signatureOk: boolean;
  headers: Record<string, string>;
  rawBody: string;
  processedAt: ISO | null;
  error: string | null;
  createdAt: ISO;
}

// ───────────── Overview / fleet ─────────────

export interface Overview {
  date: ISO;
  ordersToday: { total: number; byStatus: Partial<Record<OrderStatus, number>> };
  activeDrivers: number;
  revenueTodayToea: number;
  completedToday: number;
  gmvTodayToea: number;
  pending: { driverApprovals: number; topups: number; payouts: number; disputes: number; manualPayments: number; refunds: number };
}

export interface FleetDriver {
  driverId: string;
  name: string | null;
  phone: string;
  plate: string | null;
  online: boolean;
  stale: boolean;
  lat: number | null;
  lng: number | null;
  lastSeenAt: ISO | null;
  activeOrder: { id: string; shortCode: string; status: OrderStatus; driverId: string; deliveryLat: number; deliveryLng: number } | null;
}

export interface FleetLocationEvent {
  driverId: string;
  lat?: number;
  lng?: number;
  online: boolean;
  at?: ISO;
}

// ───────────── Drivers ─────────────

export type DriverStatus = 'pending_docs' | 'pending_approval' | 'approved' | 'rejected' | 'suspended';
export type DocumentStatus = 'pending' | 'approved' | 'rejected';

export interface DriverListItem {
  id: string;
  createdAt: ISO;
  userId: string;
  name: string | null;
  phone: string;
  accountStatus: 'active' | 'suspended';
  status: DriverStatus;
  online: boolean;
  lastSeenAt: ISO | null;
  location: { lat: number; lng: number | null } | null;
  ratingAvg: number;
  ratingCount: number;
  truck: { id: string; plate: string; capacityLitres: number } | null;
  balanceToea: number;
}

export interface DriverDocument {
  id: string;
  driverId: string;
  type: string;
  fileKey: string;
  status: DocumentStatus;
  reviewerId: string | null;
  notes: string | null;
  reviewedAt: ISO | null;
  createdAt: ISO;
  url: string | null;
}

export interface Truck {
  id: string;
  driverId: string;
  plate: string;
  capacityLitres: number;
  photoKey: string | null;
  active: boolean;
  createdAt: ISO;
  updatedAt: ISO;
}

export interface TruckWithDriver extends Truck {
  driver: { id: string; user: { name: string | null; phone: string } };
}

export interface DriverDetail {
  id: string;
  userId: string;
  name: string | null;
  phone: string;
  accountStatus: 'active' | 'suspended';
  status: DriverStatus;
  rejectReason: string | null;
  online: boolean;
  lastSeenAt: ISO | null;
  location: { lat: number; lng: number | null } | null;
  ratingAvg: number;
  ratingCount: number;
  createdAt: ISO;
  wallet: { id: string; balanceToea: number };
  documents: DriverDocument[];
  trucks: (Truck & { photoUrl: string | null })[];
  orderCounts: Partial<Record<OrderStatus, number>>;
}

export interface WalletSummary {
  walletId: string;
  balanceToea: number;
  minBalanceToea: number;
  blocked: boolean;
  shortfallToea: number;
  withdrawableToea: number;
  payoutMinToea: number;
  pendingTopups: { count: number; amountToea: number };
}

export type LedgerType = 'topup' | 'commission' | 'order_earning' | 'refund' | 'adjustment' | 'payout';

export interface LedgerEntry {
  id: string;
  walletId: string;
  amountToea: number;
  balanceAfter: number;
  type: LedgerType;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
  description: string | null;
  createdBy: string;
  createdAt: ISO;
}

export interface Wallet {
  id: string;
  ownerType: 'driver' | 'platform' | 'customer_refund';
  ownerId: string;
  balanceToea: number;
  createdAt: ISO;
  updatedAt: ISO;
}

// ───────────── Customers ─────────────

export interface CustomerListItem {
  id: string;
  phone: string;
  name: string | null;
  status: 'active' | 'suspended';
  createdAt: ISO;
  orderCount: number;
}

export interface CustomerLocation {
  id: string;
  label: string;
  addressText: string;
  lat: number;
  lng: number;
  landmarkNotes: string | null;
}

export interface CustomerDetail {
  id: string;
  phone: string;
  name: string | null;
  status: 'active' | 'suspended';
  createdAt: ISO;
  phoneVerifiedAt: ISO | null;
  locations: CustomerLocation[];
  orderCounts: Partial<Record<OrderStatus, number>>;
  /** Customer wallet (Cooper Waters Cash). */
  wallet?: { id: string; balanceToea: number };
}

// ───────────── Catalogue ─────────────

export interface GeoPolygon {
  type: 'Polygon';
  /** Rings of [lng, lat]; the first ring is the outer boundary and is closed. */
  coordinates: number[][][];
}

export interface Depot {
  id: string;
  name: string;
  lat: number;
  lng: number;
  geofenceRadiusM: number | null;
  geofencePolygon: GeoPolygon | null;
  active: boolean;
  createdAt: ISO;
  updatedAt: ISO;
}

export interface Package {
  id: string;
  name: string;
  volumeLitres: number;
  priceToea: number;
  active: boolean;
  sortOrder: number;
  createdAt: ISO;
  updatedAt: ISO;
}

export interface PromoCode {
  id: string;
  code: string;
  description: string;
  discountType: 'percent' | 'flat';
  /** percent: 1–100; flat: toea */
  discountValue: number;
  maxDiscountToea: number | null;
  minOrderToea: number;
  startsAt: ISO | null;
  expiresAt: ISO | null;
  maxUses: number | null;
  perCustomerLimit: number;
  public: boolean;
  active: boolean;
  uses: number;
  createdAt: ISO;
  updatedAt: ISO;
}

export interface ChatMessage {
  id: string;
  body: string;
  senderRole: 'customer' | 'driver';
  senderName: string | null;
  createdAt: ISO;
  readAt: ISO | null;
}

export type SettingsMap = Record<string, { value: unknown; isDefault: boolean }>;

// ───────────── Money queues ─────────────

export type TopupStatus = 'pending' | 'approved' | 'rejected' | 'failed';

export interface Topup {
  id: string;
  /** Exactly one of driverId / customerId is set. */
  driverId: string | null;
  customerId?: string | null;
  method: 'bank_transfer' | 'cellmoney' | 'cash';
  amountToea: number;
  referenceText: string;
  msisdn: string | null;
  proofFileKey: string | null;
  /** Not returned by the backend today (see README "Backend gaps"); used when present. */
  proofUrl?: string | null;
  status: TopupStatus;
  rejectReason: string | null;
  reviewedBy: string | null;
  reviewedAt: ISO | null;
  paymentId: string | null;
  createdAt: ISO;
  driver: { id: string; user: { name: string | null; phone: string } } | null;
  customer?: { id: string; name: string | null; phone: string } | null;
  payment: Payment | null;
}

export type PayoutStatus = 'requested' | 'approved' | 'paid' | 'rejected';

export interface Payout {
  id: string;
  driverId: string;
  amountToea: number;
  method: string;
  destination: string;
  status: PayoutStatus;
  processedBy: string | null;
  processedAt: ISO | null;
  externalRef: string | null;
  notes: string | null;
  createdAt: ISO;
  driver: { id: string; user: { name: string | null; phone: string } };
  /** Deducted from the driver's wallet (manually by an admin, or automatically for older requests). */
  deducted?: boolean;
  walletId?: string | null;
  walletBalanceToea?: number | null;
}

// ───────────── Disputes ─────────────

export type DisputeStatus = 'open' | 'investigating' | 'resolved' | 'rejected';

export interface Dispute {
  id: string;
  orderId: string;
  raisedById: string;
  raisedByType: ActorType;
  category: string;
  description: string;
  status: DisputeStatus;
  outcome: string | null;
  refundToea: number | null;
  resolutionNotes: string | null;
  resolvedBy: string | null;
  resolvedAt: ISO | null;
  createdAt: ISO;
}

export interface DisputeListItem extends Dispute {
  order: { id: string; shortCode: string; status: OrderStatus; priceToea: number; paymentMethod: PaymentMethod };
  raisedBy: { name: string | null; phone: string; role: string };
}

export interface DisputeDetail extends Dispute {
  order: {
    id: string;
    shortCode: string;
    status: OrderStatus;
    priceToea: number;
    paymentMethod: PaymentMethod;
    paymentStatus: OrderPaymentStatus;
    statusBeforeDispute: OrderStatus | null;
    driverId: string | null;
    customerId: string;
    deliveryAddress: string;
    createdAt: ISO;
  };
  raisedBy: { id: string; name: string | null; phone: string; role: string };
}

// ───────────── Notifications ─────────────

export interface NotificationTemplate {
  key: string;
  pushTitle?: string | null;
  pushBody?: string | null;
  smsBody?: string | null;
  critical: boolean;
}

// ───────────── Access ─────────────

export interface PermissionDef {
  key: string;
  description: string;
}

export interface Role {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  adminCount: number;
  permissions: string[];
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'disabled';
  totpEnabled: boolean;
  lastLoginAt: ISO | null;
  role: { id: string; name: string };
  createdAt: ISO;
}

export interface AuditLog {
  id: string;
  actorId: string | null;
  actorType: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: ISO;
}

// ───────────── Reports ─────────────

export interface DailyRow {
  day: string;
  orders: number;
  completed: number;
  cancelled: number;
  expired: number;
  failed: number;
  gmv_toea: number;
  commission_toea: number;
  cod_toea: number;
  cellmoney_toea: number;
}

export interface PaymentsReport {
  from: ISO;
  to: ISO;
  cash: { orders: number; amountToea: number };
  cellmoney: {
    orders: { count: number; amountToea: number; feesToea: number };
    topups: { count: number; amountToea: number; feesToea: number };
  };
  bank: { topups: number; amountToea: number };
  refunds: { count: number; amountToea: number };
  payouts: { count: number; amountToea: number };
  platformCommissionNetToea: number;
}

export interface DriverPerfRow {
  driver_id: string;
  name: string | null;
  phone: string;
  completed: number;
  gmv_toea: number;
  commission_toea: number;
  rating_avg: number;
}

export interface PlatformWallet {
  wallet: Wallet;
  entries: Page<LedgerEntry>;
}

/** Who a push message goes to. */
export type BroadcastAudience = 'drivers' | 'customers' | 'all' | 'user';

/** An admin push message (Notifications → Push messages). */
export interface Broadcast {
  id: string;
  audience: BroadcastAudience;
  userId: string | null;
  title: string;
  body: string;
  /** People it was sent to (each also sees it in the app). */
  recipients: number;
  /** Of those, how many phones the push reached (people without a push token still see it in the app). */
  pushed?: number;
  sentBy?: string | null;
  user?: { id: string; name: string | null; phone: string; role: 'driver' | 'customer' } | null;
  createdAt: ISO;
}

export interface BroadcastCount {
  recipients: number;
  /** Firebase push is set up: closed apps get it too. Otherwise it reaches open/online apps and the in-app Inbox. */
  pushEnabled: boolean;
  name?: string | null;
  role?: 'driver' | 'customer';
}
