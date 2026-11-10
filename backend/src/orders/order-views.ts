import { Order, OrderEvent, Package } from '@prisma/client';
import { TRACKABLE_STATUSES } from './state-machine';

type WithRelations = Order & {
  package?: Package | null;
  driver?: ({ user?: { name: string | null; phone: string } | null; trucks?: { plate: string; capacityLitres: number }[] } & {
    id: string;
    currentLat: number | null;
    currentLng: number | null;
    ratingAvg: number;
    lastSeenAt: Date | null;
  }) | null;
  customer?: { id: string; name: string | null; phone: string } | null;
  events?: OrderEvent[];
};

const timeline = (o: Order) => ({
  createdAt: o.createdAt,
  paymentPendingAt: o.paymentPendingAt,
  searchingAt: o.searchingAt,
  acceptedAt: o.acceptedAt,
  loadingAt: o.loadingAt,
  enRouteAt: o.enRouteAt,
  arrivedAt: o.arrivedAt,
  deliveredAt: o.deliveredAt,
  completedAt: o.completedAt,
  cancelledAt: o.cancelledAt,
  expiredAt: o.expiredAt,
  failedAt: o.failedAt,
  disputedAt: o.disputedAt,
});

const base = (o: WithRelations) => ({
  id: o.id,
  shortCode: o.shortCode,
  status: o.status,
  package: o.package ? { id: o.package.id, name: o.package.name, volumeLitres: o.package.volumeLitres } : { id: o.packageId },
  quantity: o.quantity,
  unitPriceToea: o.unitPriceToea,
  priceToea: o.priceToea,
  /** Promo discount (absorbed by Cooper Waters). */
  discountToea: o.discountToea,
  /** What the customer pays: price − discount. A cash-on-delivery driver collects this amount. */
  payableToea: o.priceToea - o.discountToea,
  paymentMethod: o.paymentMethod,
  paymentStatus: o.paymentStatus,
  delivery: { lat: o.deliveryLat, lng: o.deliveryLng, address: o.deliveryAddress, notes: o.deliveryNotes },
  cancelReason: o.cancelReason,
  expiresAt: o.expiresAt,
  timeline: timeline(o),
});

/** What a customer sees: no commission; driver contact + live location only while trackable. */
export function customerOrderView(o: WithRelations) {
  const trackable = TRACKABLE_STATUSES.includes(o.status);
  return {
    ...base(o),
    driver:
      o.driver && o.driverId
        ? {
            name: o.driver.user?.name ?? 'Driver',
            phone: trackable ? o.driver.user?.phone : undefined,
            ratingAvg: o.driver.ratingAvg,
            truck: o.driver.trucks?.[0] ? { plate: o.driver.trucks[0].plate, capacityLitres: o.driver.trucks[0].capacityLitres } : null,
            location:
              trackable && o.driver.currentLat !== null && o.driver.currentLng !== null
                ? { lat: o.driver.currentLat, lng: o.driver.currentLng, at: o.driver.lastSeenAt }
                : null,
          }
        : null,
  };
}

/** Driver view: their earnings and the customer's contact while the job is active. */
export function driverOrderView(o: WithRelations) {
  const active = TRACKABLE_STATUSES.includes(o.status);
  return {
    ...base(o),
    commissionToea: o.commissionToea,
    earningsToea: o.priceToea - o.commissionToea,
    customer: o.customer ? { name: o.customer.name ?? 'Customer', phone: active ? o.customer.phone : undefined } : null,
  };
}

export function adminOrderView(o: WithRelations) {
  return {
    ...base(o),
    commissionToea: o.commissionToea,
    commissionType: o.commissionType,
    commissionValue: o.commissionValue,
    commissionDeductAt: o.commissionDeductAt,
    commissionDeducted: o.commissionDeducted,
    settledAt: o.settledAt,
    dispatchRound: o.dispatchRound,
    statusBeforeDispute: o.statusBeforeDispute,
    proofPhotoKey: o.proofPhotoKey,
    customer: o.customer ? { id: o.customer.id, name: o.customer.name, phone: o.customer.phone } : { id: o.customerId },
    driver: o.driver
      ? {
          id: o.driver.id,
          name: o.driver.user?.name,
          phone: o.driver.user?.phone,
          plate: o.driver.trucks?.[0]?.plate,
          location: o.driver.currentLat !== null ? { lat: o.driver.currentLat, lng: o.driver.currentLng, at: o.driver.lastSeenAt } : null,
        }
      : null,
    events: o.events?.map((e) => ({
      id: e.id,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      actorType: e.actorType,
      actorId: e.actorId,
      metadata: e.metadata,
      createdAt: e.createdAt,
    })),
  };
}

export const ORDER_INCLUDE = {
  package: true,
  customer: { select: { id: true, name: true, phone: true } },
  driver: { include: { user: { select: { name: true, phone: true } }, trucks: { where: { active: true, deletedAt: null }, take: 1 } } },
} as const;
