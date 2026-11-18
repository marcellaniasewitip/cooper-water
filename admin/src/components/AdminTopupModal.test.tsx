import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const { create } = vi.hoisted(() => ({ create: vi.fn(async (..._args: unknown[]) => ({ id: 't1', status: 'approved' })) }));
vi.mock('@/api', () => ({
  api: {
    drivers: { list: vi.fn(async () => ({ items: [{ id: 'drv-1', name: 'John Paul', phone: '+67576322261', balanceToea: 12400 }], nextCursor: null })) },
    customers: { list: vi.fn(async () => ({ items: [], nextCursor: null })) },
    topups: { create },
  },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('@/lib/notify', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));

import { AdminTopupModal } from './AdminTopupModal';

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  Element.prototype.scrollIntoView ??= () => undefined;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function type(el: HTMLInputElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const tick = () => new Promise((r) => setTimeout(r, 400));

describe('AdminTopupModal', () => {
  it('admin picks a driver, types an amount and credits the wallet once', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onDone = vi.fn();
    await act(async () => {
      root.render(
        <MantineProvider>
          <QueryClientProvider client={new QueryClient()}>
            <AdminTopupModal opened onClose={() => undefined} onDone={onDone} />
          </QueryClientProvider>
        </MantineProvider>,
      );
    });
    await act(tick);
    // Open the driver list and pick John Paul.
    const select = byTestId('admin-topup-owner') as HTMLInputElement;
    await act(async () => {
      select.click();
      select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await act(tick);
    const option = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes('John Paul')) as HTMLElement;
    expect(option).toBeTruthy();
    await act(async () => {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      option.click();
    });
    await act(async () => type(byTestId('admin-topup-amount') as HTMLInputElement, '150.50'));
    await act(async () => byTestId('admin-topup-next').click());
    expect(byTestId('admin-topup-confirm').textContent).toContain('K150.50');
    await act(async () => byTestId('admin-topup-submit').click());
    await act(tick);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toEqual({ ownerType: 'driver', ownerId: 'drv-1', amountToea: 15050, method: 'cash' });
    expect(onDone).toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
