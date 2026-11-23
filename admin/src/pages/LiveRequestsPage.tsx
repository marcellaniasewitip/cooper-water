import { Anchor, Badge, Card, Grid, Group, ScrollArea, SegmentedControl, Stack, Switch, Text, UnstyledButton } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { CircleMarker, Polyline, Popup, Tooltip, useMap } from 'react-leaflet';
import { Link } from 'react-router-dom';
import { api, type AdminOrder } from '@/api';
import { MapBase } from '@/components/MapBase';
import { PageHeader } from '@/components/PageHeader';
import { QueryState } from '@/components/QueryState';
import { OrderStatusBadge } from '@/components/StatusBadge';
import { fmt, m } from '@/i18n';
import { distanceM } from '@/lib/geo';
import { formatKina } from '@/lib/money';
import { localDayStartIso, localYmd, timeAgo } from '@/lib/time';
import { useRealtime } from '@/realtime/RealtimeProvider';
import { requestAlertsEnabled, setRequestAlertsEnabled } from '@/realtime/requestAlerts';

type View = 'waiting' | 'today';
const WAITING = 'SEARCHING,PENDING_PAYMENT';
const RED = '#e03131';
const BLUE = '#1c7ed6';

const fmtCoord = (lat: number, lng: number) => `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
const mapsLink = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;

/** Zooms to all requests once, then to the one picked in the list. */
function MapFocus({ points, focus }: { points: [number, number][]; focus: [number, number] | null }) {
  const map = useMap();
  const [fitted, setFitted] = useState(false);
  useEffect(() => {
    if (fitted || points.length === 0) return;
    if (points.length === 1) map.setView(points[0], 16);
    else map.fitBounds(points, { padding: [40, 40], maxZoom: 16 });
    setFitted(true);
  }, [map, points, fitted]);
  useEffect(() => {
    if (focus) map.flyTo(focus, Math.max(map.getZoom(), 17), { duration: 0.6 });
  }, [map, focus]);
  return null;
}

function Coordinates({ label, lat, lng, accuracyM }: { label: string; lat: number; lng: number; accuracyM?: number | null }) {
  return (
    <Text size="xs">
      <b>{label}:</b> {fmtCoord(lat, lng)}
      {accuracyM != null && ` (±${accuracyM} m)`}{' '}
      <Anchor href={mapsLink(lat, lng)} target="_blank" rel="noreferrer" size="xs">
        {m.liveRequests.openMap}
      </Anchor>
    </Text>
  );
}

/**
 * Live requests: every customer request as it comes in, on a map at the exact spot — the delivery pin the
 * customer chose (red) and where their phone actually was when they asked (blue) — with the coordinates.
 */
export default function LiveRequestsPage() {
  const { connected } = useRealtime();
  const [view, setView] = useState<View>('waiting');
  const [selected, setSelected] = useState<string | null>(null);
  const [alerts, setAlerts] = useState(requestAlertsEnabled());
  const poll = connected ? 30_000 : 10_000;
  const today = localDayStartIso(localYmd());
  const q = useQuery({
    queryKey: ['orders', 'live-requests', view, view === 'today' ? today : ''],
    queryFn: () => api.orders.list(view === 'waiting' ? { status: WAITING, limit: 100 } : { from: today, limit: 100 }),
    refetchInterval: poll,
  });
  // Re-render "x min ago" every 30 s.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => q.data?.items ?? [], [q.data]);
  const points = useMemo(
    () => rows.flatMap((o) => [[o.delivery.lat, o.delivery.lng] as [number, number], ...(o.requestedFrom ? [[o.requestedFrom.lat, o.requestedFrom.lng] as [number, number]] : [])]),
    [rows],
  );
  const sel = rows.find((o) => o.id === selected) ?? null;
  const focus = useMemo<[number, number] | null>(() => (sel ? [sel.delivery.lat, sel.delivery.lng] : null), [sel]);

  const away = (o: AdminOrder) => (o.requestedFrom ? Math.round(distanceM(o.requestedFrom.lat, o.requestedFrom.lng, o.delivery.lat, o.delivery.lng)) : null);

  return (
    <>
      <PageHeader
        title={m.liveRequests.title}
        subtitle={m.liveRequests.subtitle}
        actions={
          <Group gap="md">
            <Switch
              label={m.liveRequests.alerts}
              checked={alerts}
              onChange={(e) => {
                setAlerts(e.currentTarget.checked);
                setRequestAlertsEnabled(e.currentTarget.checked);
              }}
            />
            <SegmentedControl
              value={view}
              onChange={(v) => {
                setView(v as View);
                setSelected(null);
              }}
              data={[
                { value: 'waiting', label: m.liveRequests.waiting },
                { value: 'today', label: m.liveRequests.today },
              ]}
            />
          </Group>
        }
      />
      <QueryState isPending={q.isPending} error={q.error} refetch={q.refetch}>
        <Grid gutter="sm">
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Card withBorder p={0}>
              <Text size="sm" fw={600} p="sm">
                {fmt(m.liveRequests.count, { count: rows.length })}
              </Text>
              <ScrollArea h={620}>
                {rows.length === 0 && (
                  <Text c="dimmed" size="sm" p="sm">
                    {view === 'waiting' ? m.liveRequests.noneWaiting : m.liveRequests.noneToday}
                  </Text>
                )}
                <Stack gap={0}>
                  {rows.map((o) => {
                    const d = away(o);
                    return (
                      <UnstyledButton
                        key={o.id}
                        onClick={() => setSelected(o.id)}
                        p="sm"
                        style={{ borderTop: '1px solid var(--mantine-color-default-border)', background: o.id === selected ? 'var(--mantine-color-orange-light)' : undefined }}
                        data-testid={`request-${o.shortCode}`}
                      >
                        <Group justify="space-between" wrap="nowrap">
                          <Text fw={700}>{o.shortCode}</Text>
                          <OrderStatusBadge status={o.status} />
                        </Group>
                        <Text size="sm">
                          {o.customer.name ?? '—'} · {o.customer.phone}
                        </Text>
                        <Text size="sm" lineClamp={2}>
                          {o.delivery.address}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {o.quantity} × {o.package.name} · {formatKina(o.payableToea ?? o.priceToea)} · {m.enums.paymentMethod[o.paymentMethod] ?? o.paymentMethod}
                        </Text>
                        <Group gap={6} mt={4}>
                          <Text size="xs" c="dimmed">
                            {timeAgo(o.timeline.createdAt)}
                          </Text>
                          {o.requestedFrom ? (
                            <Badge size="xs" variant="light" color={d !== null && d > 200 ? 'orange' : 'blue'}>
                              {d !== null && d > 30 ? fmt(m.liveRequests.awayFromPin, { m: d.toLocaleString('en-US') }) : m.liveRequests.atPin}
                            </Badge>
                          ) : (
                            <Badge size="xs" variant="light" color="gray">
                              {m.liveRequests.noGps}
                            </Badge>
                          )}
                        </Group>
                      </UnstyledButton>
                    );
                  })}
                </Stack>
              </ScrollArea>
            </Card>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 8 }}>
            <Card withBorder p={0}>
              <MapBase height={660}>
                <MapFocus points={points} focus={focus} />
                {rows.map((o) => {
                  const isSel = o.id === selected;
                  const rf = o.requestedFrom;
                  return (
                    <Fragment key={o.id}>
                      {rf && (
                        <>
                          <Polyline positions={[[rf.lat, rf.lng], [o.delivery.lat, o.delivery.lng]]} pathOptions={{ color: BLUE, weight: 2, dashArray: '4 6', opacity: 0.8 }} />
                          <CircleMarker
                            center={[rf.lat, rf.lng]}
                            radius={isSel ? 8 : 5}
                            pathOptions={{ color: '#fff', weight: 2, fillColor: BLUE, fillOpacity: 0.95 }}
                            eventHandlers={{ click: () => setSelected(o.id) }}
                          >
                            <Tooltip>{fmt(m.liveRequests.requestedFromTip, { code: o.shortCode })}</Tooltip>
                          </CircleMarker>
                        </>
                      )}
                      <CircleMarker
                        center={[o.delivery.lat, o.delivery.lng]}
                        radius={isSel ? 11 : 8}
                        pathOptions={{ color: '#fff', weight: 2, fillColor: RED, fillOpacity: 0.95 }}
                        eventHandlers={{ click: () => setSelected(o.id) }}
                      >
                        <Tooltip>{`${o.shortCode} · ${o.customer.name ?? o.customer.phone ?? ''}`}</Tooltip>
                        <Popup>
                          <Stack gap={4}>
                            <Group gap="xs">
                              <Anchor component={Link} to={`/orders/${o.id}`} fw={700}>
                                {o.shortCode}
                              </Anchor>
                              <OrderStatusBadge status={o.status} />
                            </Group>
                            <Text size="sm">
                              {o.customer.name ?? '—'} · {o.customer.phone}
                            </Text>
                            <Text size="sm">{o.delivery.address}</Text>
                            {o.delivery.notes && (
                              <Text size="xs" c="dimmed">
                                {o.delivery.notes}
                              </Text>
                            )}
                            <Coordinates label={m.liveRequests.deliveryPin} lat={o.delivery.lat} lng={o.delivery.lng} />
                            {rf ? (
                              <Coordinates label={m.liveRequests.requestedFrom} lat={rf.lat} lng={rf.lng} accuracyM={rf.accuracyM} />
                            ) : (
                              <Text size="xs" c="dimmed">
                                {m.liveRequests.noGpsLong}
                              </Text>
                            )}
                          </Stack>
                        </Popup>
                      </CircleMarker>
                    </Fragment>
                  );
                })}
              </MapBase>
              <Group gap="lg" p="xs">
                <Group gap={6}>
                  <span style={{ width: 12, height: 12, borderRadius: 6, background: RED, display: 'inline-block' }} />
                  <Text size="xs">{m.liveRequests.legendPin}</Text>
                </Group>
                <Group gap={6}>
                  <span style={{ width: 12, height: 12, borderRadius: 6, background: BLUE, display: 'inline-block' }} />
                  <Text size="xs">{m.liveRequests.legendPhone}</Text>
                </Group>
              </Group>
            </Card>
          </Grid.Col>
        </Grid>
      </QueryState>
    </>
  );
}
