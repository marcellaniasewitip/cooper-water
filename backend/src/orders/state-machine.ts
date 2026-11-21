import { ActorType, OrderStatus } from '@prisma/client';

/**
 * The single source of truth for order transitions (§6). Pure — no I/O — so every allowed and
 * disallowed transition is unit-tested. OrderTransitionsService applies it inside a locked DB transaction.
 */

type Rule = { to: OrderStatus; actors: ActorType[] };

const ACTIVE_FOR_DISPUTE: OrderStatus[] = ['ACCEPTED', 'LOADING', 'EN_ROUTE', 'ARRIVED', 'DELIVERED', 'COMPLETED'];
const DISPUTE_ACTORS: ActorType[] = ['customer', 'driver', 'admin'];

export const TRANSITIONS: Record<OrderStatus, Rule[]> = {
  PENDING_PAYMENT: [
    // payment succeeded (admin = manual match); system also moves a new COD order straight to dispatch
    { to: 'SEARCHING', actors: ['system', 'admin'] },
    // manual booking: a driver books the order for a customer (by phone) and takes it straight away
    { to: 'ACCEPTED', actors: ['driver'] },
    { to: 'FAILED', actors: ['system', 'admin'] }, // payment failed / timed out
    { to: 'CANCELLED', actors: ['customer', 'admin'] },
  ],
  SEARCHING: [
    { to: 'ACCEPTED', actors: ['driver', 'admin'] }, // admin = manual assignment
    { to: 'EXPIRED', actors: ['system'] },
    { to: 'CANCELLED', actors: ['customer', 'admin'] },
  ],
  ACCEPTED: [
    { to: 'LOADING', actors: ['driver'] },
    { to: 'SEARCHING', actors: ['admin'] }, // reassign: release back to dispatch
    { to: 'ACCEPTED', actors: ['admin'] }, // reassign directly to another driver
    { to: 'CANCELLED', actors: ['customer', 'admin'] },
    { to: 'DISPUTED', actors: DISPUTE_ACTORS },
  ],
  LOADING: [
    { to: 'EN_ROUTE', actors: ['driver'] },
    { to: 'SEARCHING', actors: ['admin'] },
    { to: 'ACCEPTED', actors: ['admin'] },
    { to: 'CANCELLED', actors: ['customer', 'admin'] },
    { to: 'DISPUTED', actors: DISPUTE_ACTORS },
  ],
  EN_ROUTE: [
    { to: 'ARRIVED', actors: ['driver'] },
    { to: 'CANCELLED', actors: ['customer', 'admin'] },
    { to: 'DISPUTED', actors: DISPUTE_ACTORS },
  ],
  ARRIVED: [
    { to: 'DELIVERED', actors: ['driver'] },
    { to: 'CANCELLED', actors: ['customer', 'admin'] },
    { to: 'DISPUTED', actors: DISPUTE_ACTORS },
  ],
  DELIVERED: [
    { to: 'COMPLETED', actors: ['customer', 'system', 'admin'] },
    { to: 'DISPUTED', actors: DISPUTE_ACTORS },
  ],
  COMPLETED: [{ to: 'DISPUTED', actors: DISPUTE_ACTORS }],
  // Resolution: admin returns the order to where it was, completes it, or cancels it.
  DISPUTED: [
    { to: 'ACCEPTED', actors: ['admin'] },
    { to: 'LOADING', actors: ['admin'] },
    { to: 'EN_ROUTE', actors: ['admin'] },
    { to: 'ARRIVED', actors: ['admin'] },
    { to: 'DELIVERED', actors: ['admin'] },
    { to: 'COMPLETED', actors: ['admin'] },
    { to: 'CANCELLED', actors: ['admin'] },
  ],
  CANCELLED: [],
  EXPIRED: [],
  FAILED: [],
};

/** Progression order, used for "customer may cancel before X" (§4). */
export const PROGRESS: OrderStatus[] = ['PENDING_PAYMENT', 'SEARCHING', 'ACCEPTED', 'LOADING', 'EN_ROUTE', 'ARRIVED', 'DELIVERED', 'COMPLETED'];

export const ACTIVE_DRIVER_STATUSES: OrderStatus[] = ['ACCEPTED', 'LOADING', 'EN_ROUTE', 'ARRIVED'];
export const TERMINAL_STATUSES: OrderStatus[] = ['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED'];
export const TRACKABLE_STATUSES: OrderStatus[] = ['ACCEPTED', 'LOADING', 'EN_ROUTE', 'ARRIVED'];

export function canTransition(from: OrderStatus, to: OrderStatus, actor: ActorType): boolean {
  return TRANSITIONS[from].some((r) => r.to === to && r.actors.includes(actor));
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: OrderStatus,
    public readonly to: OrderStatus,
    public readonly actor: ActorType,
  ) {
    super(`Order cannot go from ${from} to ${to} (${actor})`);
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus, actor: ActorType): void {
  if (!canTransition(from, to, actor)) throw new InvalidTransitionError(from, to, actor);
}

/** Customer may cancel free only while the order is strictly before `freeUntil`. */
export function customerMayCancel(status: OrderStatus, freeUntil: OrderStatus): boolean {
  const idx = PROGRESS.indexOf(status);
  const limit = PROGRESS.indexOf(freeUntil);
  if (idx < 0 || limit < 0) return false;
  return idx < limit && canTransition(status, 'CANCELLED', 'customer');
}

export function isDisputable(status: OrderStatus): boolean {
  return ACTIVE_FOR_DISPUTE.includes(status);
}

/** Timestamp column set when an order enters a status. */
export const STATUS_TIMESTAMP: Record<OrderStatus, string> = {
  PENDING_PAYMENT: 'paymentPendingAt',
  SEARCHING: 'searchingAt',
  ACCEPTED: 'acceptedAt',
  LOADING: 'loadingAt',
  EN_ROUTE: 'enRouteAt',
  ARRIVED: 'arrivedAt',
  DELIVERED: 'deliveredAt',
  COMPLETED: 'completedAt',
  CANCELLED: 'cancelledAt',
  EXPIRED: 'expiredAt',
  FAILED: 'failedAt',
  DISPUTED: 'disputedAt',
};
