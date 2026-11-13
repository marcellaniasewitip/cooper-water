import { MantineProvider } from '@mantine/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { ActionModal } from './ActionModal';

beforeAll(() => {
  // Mantine needs these browser APIs, which jsdom lacks.
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

/** Type like a user: set the DOM value, then fire React's input event. */
function type(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ActionModal', () => {
  it('typing notes and confirming works (used to blank the page on the first keystroke)', async () => {
    const onSubmit = vi.fn(async () => undefined);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <MantineProvider>
          <ActionModal opened onClose={() => undefined} title="Approve" fields={[{ name: 'notes', label: 'Notes', type: 'textarea', maxLength: 500 }]} confirmLabel="Approve" onSubmit={onSubmit} />
        </MantineProvider>,
      );
    });
    const area = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(area).toBeTruthy();
    await act(async () => type(area, 'Checked with driver'));
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Checked with driver');
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Approve')!;
    await act(async () => button.click());
    expect(onSubmit).toHaveBeenCalledWith({ notes: 'Checked with driver' });
    await act(async () => root.unmount());
  });
});
