import { ActorType, OrderStatus } from '@prisma/client';
import { assertTransition, canTransition, customerMayCancel, InvalidTransitionError, isDisputable } from '../../src/orders/state-machine';

const STATUSES = Object.values(OrderStatus);
const ACTORS: ActorType[] = ['customer', 'driver', 'admin', 'system'];

/**
 * The expected transition table, written out independently from the implementation (§6).
 * Every (from, to, actor) triple NOT listed here must be rejected.
 */
const ALLOWED: [OrderStatus, OrderStatus, ActorType[]][] = [
  ['PENDING_PAYMENT', 'SEARCHING', ['system', 'admin']],
  ['PENDING_PAYMENT', 'ACCEPTED', ['driver']],
  ['PENDING_PAYMENT', 'FAILED', ['system', 'admin']],
  ['PENDING_PAYMENT', 'CANCELLED', ['customer', 'admin']],
  ['SEARCHING', 'ACCEPTED', ['driver', 'admin']],
  ['SEARCHING', 'EXPIRED', ['system']],
  ['SEARCHING', 'CANCELLED', ['customer', 'admin']],
  ['ACCEPTED', 'LOADING', ['driver']],
  ['ACCEPTED', 'SEARCHING', ['admin']],
  ['ACCEPTED', 'ACCEPTED', ['admin']],
  ['ACCEPTED', 'CANCELLED', ['customer', 'admin']],
  ['ACCEPTED', 'DISPUTED', ['customer', 'driver', 'admin']],
  ['LOADING', 'EN_ROUTE', ['driver']],
  ['LOADING', 'SEARCHING', ['admin']],
  ['LOADING', 'ACCEPTED', ['admin']],
  ['LOADING', 'CANCELLED', ['customer', 'admin']],
  ['LOADING', 'DISPUTED', ['customer', 'driver', 'admin']],
  ['EN_ROUTE', 'ARRIVED', ['driver']],
  ['EN_ROUTE', 'CANCELLED', ['customer', 'admin']],
  ['EN_ROUTE', 'DISPUTED', ['customer', 'driver', 'admin']],
  ['ARRIVED', 'DELIVERED', ['driver']],
  ['ARRIVED', 'CANCELLED', ['customer', 'admin']],
  ['ARRIVED', 'DISPUTED', ['customer', 'driver', 'admin']],
  ['DELIVERED', 'COMPLETED', ['customer', 'system', 'admin']],
  ['DELIVERED', 'DISPUTED', ['customer', 'driver', 'admin']],
  ['COMPLETED', 'DISPUTED', ['customer', 'driver', 'admin']],
  ['DISPUTED', 'ACCEPTED', ['admin']],
  ['DISPUTED', 'LOADING', ['admin']],
  ['DISPUTED', 'EN_ROUTE', ['admin']],
  ['DISPUTED', 'ARRIVED', ['admin']],
  ['DISPUTED', 'DELIVERED', ['admin']],
  ['DISPUTED', 'COMPLETED', ['admin']],
  ['DISPUTED', 'CANCELLED', ['admin']],
];

const allowedSet = new Set(ALLOWED.flatMap(([f, t, actors]) => actors.map((a) => `${f}>${t}>${a}`)));

describe('order state machine', () => {
  describe('every allowed transition', () => {
    it.each([...allowedSet].map((k) => k.split('>') as [OrderStatus, OrderStatus, ActorType]))('%s → %s by %s', (from, to, actor) => {
      expect(canTransition(from, to, actor)).toBe(true);
      expect(() => assertTransition(from, to, actor)).not.toThrow();
    });
  });

  it('rejects every other (from, to, actor) combination', () => {
    let rejected = 0;
    for (const from of STATUSES)
      for (const to of STATUSES)
        for (const actor of ACTORS) {
          if (allowedSet.has(`${from}>${to}>${actor}`)) continue;
          expect({ from, to, actor, ok: canTransition(from, to, actor) }).toEqual({ from, to, actor, ok: false });
          expect(() => assertTransition(from, to, actor)).toThrow(InvalidTransitionError);
          rejected++;
        }
    expect(rejected).toBe(STATUSES.length * STATUSES.length * ACTORS.length - allowedSet.size);
  });

  it('terminal states have no exits', () => {
    for (const s of ['CANCELLED', 'EXPIRED', 'FAILED'] as OrderStatus[])
      for (const to of STATUSES) for (const a of ACTORS) expect(canTransition(s, to, a)).toBe(false);
  });

  it('drivers can never cancel, expire or complete', () => {
    for (const from of STATUSES) {
      expect(canTransition(from, 'CANCELLED', 'driver')).toBe(false);
      expect(canTransition(from, 'EXPIRED', 'driver')).toBe(false);
      expect(canTransition(from, 'COMPLETED', 'driver')).toBe(false);
    }
  });

  it('nobody but the system can skip payment, except an admin matching a manual payment', () => {
    expect(canTransition('PENDING_PAYMENT', 'SEARCHING', 'customer')).toBe(false);
    expect(canTransition('PENDING_PAYMENT', 'SEARCHING', 'driver')).toBe(false);
  });

  describe('customer cancellation window (order.customer_cancel_free_until)', () => {
    it('default ACCEPTED: free before a driver accepts, not after', () => {
      expect(customerMayCancel('PENDING_PAYMENT', 'ACCEPTED')).toBe(true);
      expect(customerMayCancel('SEARCHING', 'ACCEPTED')).toBe(true);
      expect(customerMayCancel('ACCEPTED', 'ACCEPTED')).toBe(false);
      expect(customerMayCancel('EN_ROUTE', 'ACCEPTED')).toBe(false);
    });
    it('a later window allows cancelling an accepted order', () => {
      expect(customerMayCancel('ACCEPTED', 'LOADING')).toBe(true);
      expect(customerMayCancel('LOADING', 'LOADING')).toBe(false);
    });
    it('never after delivery or for closed orders', () => {
      for (const s of ['DELIVERED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED', 'DISPUTED'] as OrderStatus[]) {
        expect(customerMayCancel(s, 'ARRIVED')).toBe(false);
      }
    });
  });

  it('disputes can be raised from ACCEPTED through COMPLETED only', () => {
    const disputable = STATUSES.filter(isDisputable).sort();
    expect(disputable).toEqual(['ACCEPTED', 'ARRIVED', 'COMPLETED', 'DELIVERED', 'EN_ROUTE', 'LOADING'].sort());
  });
});
