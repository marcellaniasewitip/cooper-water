import { notifications } from '@mantine/notifications';
import type { AdminOrder } from '@/api';
import { fmt, m } from '@/i18n';

const KEY = 'cw.requests.alerts';

/** New-request alerts (toast + short beep) are on unless switched off on the Live requests page. */
export function requestAlertsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function setRequestAlertsEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Private mode: the setting just isn't remembered.
  }
}

/** Two short tones; browsers only allow sound after the admin has clicked on the page once. */
function beep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.18].forEach((t, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = i === 0 ? 880 : 1175;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.16);
    });
    setTimeout(() => void ctx.close(), 600);
  } catch {
    // No audio: the toast is enough.
  }
}

/** A customer just asked for water: show where, and beep. */
export function announceNewRequest(order: AdminOrder, bookedByDriver: boolean): void {
  if (!requestAlertsEnabled()) return;
  notifications.show({
    color: 'orange',
    title: fmt(bookedByDriver ? m.liveRequests.newBooked : m.liveRequests.newRequest, { code: order.shortCode }),
    message: `${order.customer.name ?? order.customer.phone ?? ''} · ${order.delivery.address} · ${order.quantity} × ${order.package.name ?? ''}`,
    autoClose: 10_000,
  });
  if (!bookedByDriver) beep();
}
