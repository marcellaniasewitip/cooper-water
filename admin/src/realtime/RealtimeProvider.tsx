import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { http, tokenStore, type AdminOrder, type FleetDriver, type FleetLocationEvent, type Page } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { config } from '@/config';
import { notifySuccess } from '@/lib/notify';
import { announceNewRequest } from './requestAlerts';
import { applyFleetEvent } from './fleet';

interface RealtimeState {
  connected: boolean;
  /** Timestamp of the last `order.updated` event (lets pages show a "live" hint). */
  lastOrderEventAt: number | null;
}

const Ctx = createContext<RealtimeState>({ connected: false, lastOrderEventAt: null });

/**
 * Socket.IO connection for admins (`/realtime`, `auth: { token }`). Order updates refresh order
 * caches; driver locations are merged into the fleet cache. Pages poll as a fallback while the
 * socket is disconnected (see `useRealtime().connected`).
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, can } = useAuth();
  const allowed = isAuthenticated && can('dashboard.view');
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [lastOrderEventAt, setLastOrderEventAt] = useState<number | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let authRetries = 0;
    const socket = io(`${config.apiBaseUrl}${config.realtimeNamespace}`, {
      transports: ['websocket', 'polling'],
      auth: (cb) => cb({ token: tokenStore.get()?.accessToken ?? '' }),
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30_000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      authRetries = 0;
      setConnected(true);
    });
    socket.on('disconnect', (reason) => {
      setConnected(false);
      // Server-side disconnects are not retried automatically by socket.io.
      if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 3000);
    });
    socket.on('connect_error', () => setConnected(false));
    // The gateway emits `error {code:'unauthorized'}` before disconnecting an expired token.
    socket.on('error', async (e: { code?: string }) => {
      if (e?.code !== 'unauthorized' || authRetries++ > 2) return;
      await http.refresh(tokenStore.get()?.accessToken ?? null).catch(() => null);
    });

    socket.on('order.updated', (msg: { order: AdminOrder }) => {
      setLastOrderEventAt(Date.now());
      const o = msg?.order;
      if (o) {
        // Patch the order in any loaded list pages, then refetch lists and the detail.
        qc.setQueriesData<InfiniteData<Page<AdminOrder>>>({ queryKey: ['orders'] }, (data) =>
          data?.pages
            ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((it) => (it.id === o.id ? { ...it, ...o } : it)) })) }
            : data,
        );
        void qc.invalidateQueries({ queryKey: ['order', o.id] });
      }
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      void qc.invalidateQueries({ queryKey: ['fleet'] });
    });

    // Live requests: a customer just placed a request (or a driver booked one for a customer).
    socket.on('order.created', (e: { order?: AdminOrder; bookedByDriver?: boolean }) => {
      if (e?.order) announceNewRequest(e.order, !!e.bookedByDriver);
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    });

    // Auto-assign: "Order CW-1234 is placed to John".
    socket.on('order.auto_assigned', (e: { message?: string }) => {
      if (e?.message) notifySuccess(e.message);
      void qc.invalidateQueries({ queryKey: ['orders'] });
    });

    socket.on('fleet.driver_location', (e: FleetLocationEvent) => {
      qc.setQueryData<FleetDriver[]>(['fleet'], (list) => applyFleetEvent(list, e));
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [allowed, qc]);

  return <Ctx.Provider value={{ connected, lastOrderEventAt }}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useRealtime(): RealtimeState {
  return useContext(Ctx);
}
