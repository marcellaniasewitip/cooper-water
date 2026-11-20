import { ActionIcon, Anchor, Badge, Card, Grid, Group, ScrollArea, SegmentedControl, Stack, Switch, Tabs, Text, Tooltip as MTooltip, UnstyledButton } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Circle, CircleMarker, Marker, Polygon, Polyline, Popup, Tooltip, useMap } from 'react-leaflet';
import { Link } from 'react-router-dom';
import { api, type AdminOrder, type Depot, type FleetDriver } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { MapBase } from '@/components/MapBase';
import { PageHeader } from '@/components/PageHeader';
import { QueryState } from '@/components/QueryState';
import { OrderStatusBadge } from '@/components/StatusBadge';
import { config } from '@/config';
import { fmt, m } from '@/i18n';
import { carIcon, carSvg } from '@/lib/carIcon';
import { distanceM } from '@/lib/geo';
import { timeAgo } from '@/lib/time';
import { notifyError, notifySuccess } from '@/lib/notify';
import { useRealtime } from '@/realtime/RealtimeProvider';

/** online = free (green), active = busy on a job (orange), stale = free but GPS not updated, offline = inactive (grey). */
type MarkerKind = 'online' | 'active' | 'stale' | 'offline';
type DriverTab = 'free' | 'busy' | 'inactive';
type OrderTab = 'unassigned' | 'assigned';

function markerKind(d: FleetDriver): MarkerKind {
  if (d.activeOrder) return 'active';
  if (!d.online) return 'offline';
  return d.stale ? 'stale' : 'online';
}

function driverTab(d: FleetDriver): DriverTab {
  if (d.activeOrder) return 'busy';
  return d.online ? 'free' : 'inactive';
}

const GREEN = '#2f9e44';
const ORANGE = '#f76707';
const RED = '#e03131';
const COLORS: Record<MarkerKind, string> = { online: GREEN, active: ORANGE, stale: '#69db7c', offline: '#868e96' };
const LABELS: Record<MarkerKind, string> = { online: m.fleet.legendOnline, active: m.fleet.legendActive, stale: m.fleet.legendStale, offline: m.fleet.legendOffline };

const WAITING = 'SEARCHING,PENDING_PAYMENT';
const ON_JOB = 'ACCEPTED,LOADING,EN_ROUTE,ARRIVED';

function stageLabel(d: FleetDriver): string | null {
  return d.activeOrder ? (m.fleet.stage[d.activeOrder.status] ?? null) : null;
}

/** Depot the driver loads at: the nearest one to the driver (else to the customer). */
function loadingDepot(depots: Depot[], from: { lat: number; lng: number } | null): Depot | null {
  if (!from || depots.length === 0) return depots[0] ?? null;
  return depots.reduce((best, dp) => (distanceM(from.lat, from.lng, dp.lat, dp.lng) < distanceM(from.lat, from.lng, best.lat, best.lng) ? dp : best));
}

/** On first load, zoom the map to fit every driver and waiting request. */
function FitOnce({ points }: { points: [number, number][] }) {
  const map = useMap();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done || points.length === 0) return;
    if (points.length === 1) map.setView(points[0], 15);
    else map.fitBounds(points, { padding: [40, 40], maxZoom: 15 });
    setDone(true);
  }, [map, points, done]);
  return null;
}

/** Hour:minute in Port Moresby time. */
function hhmm(v: string): string {
  return new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Pacific/Port_Moresby' });
}

/** Pans the map to whatever was clicked in a side list. */
function FlyTo({ target }: { target: { lat: number; lng: number; at: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo([target.lat, target.lng], Math.max(map.getZoom(), 15), { duration: 0.6 });
  }, [map, target]);
  return null;
}

function CarDot({ color }: { color: string }) {
  return <span style={{ display: 'inline-flex', flex: 'none' }} dangerouslySetInnerHTML={{ __html: carSvg(color, 22) }} />;
}

/** Green dot = load at the depot, red dot = drop-off (like a pickup / drop-off pair). */
function Stop({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <Group gap={6} wrap="nowrap" align="flex-start">
      <span style={{ width: 10, height: 10, borderRadius: 10, border: `3px solid ${color}`, marginTop: 4, flex: 'none' }} />
      <Text size="xs" lh={1.35}>
        {children}
      </Text>
    </Group>
  );
}

function OrderCard({ o, depot, onClick, selected }: { o: AdminOrder; depot: Depot | null; onClick: () => void; selected: boolean }) {
  const assigned = !!o.driver;
  return (
    <UnstyledButton onClick={onClick} data-testid="fleet-order" style={{ display: 'block', width: '100%' }}>
      <Card withBorder padding="sm" radius="md" style={{ borderColor: selected ? ORANGE : undefined, background: selected ? 'var(--mantine-color-orange-0)' : undefined }}>
        <Group justify="space-between" wrap="nowrap" gap={4}>
          <Text size="xs" c="dimmed">
            {assigned ? `${m.fleet.driverLabel}: ${o.driver?.plate ?? o.driver?.name ?? '—'}` : m.fleet.waitingDriver}
          </Text>
          <Anchor component={Link} to={`/orders/${o.id}`} size="xs" onClick={(e) => e.stopPropagation()}>
            {fmt(m.fleet.requestId, { code: o.shortCode })}
          </Anchor>
        </Group>
        <Group justify="space-between" wrap="nowrap" mt={4}>
          <Text fw={700} size="sm" truncate>
            {o.customer.name || o.customer.phone || '—'}
          </Text>
          <Text size="xs" fw={600}>
            {hhmm(o.timeline.acceptedAt ?? o.timeline.createdAt)}
          </Text>
        </Group>
        <Group justify="space-between" wrap="nowrap">
          <Text size="xs" c="dimmed">
            {o.quantity} × {o.package.name ?? ''}
          </Text>
          <Text size="xs" c="dimmed">
            {o.customer.phone}
          </Text>
        </Group>
        <Stack gap={4} mt={6}>
          {depot && <Stop color={GREEN}>{fmt(m.fleet.loadAt, { depot: depot.name })}</Stop>}
          <Stop color={RED}>{o.delivery.address || m.fleet.dropOff}</Stop>
        </Stack>
        <Group justify="space-between" mt={6} gap={4}>
          {assigned ? (
            <Text size="xs" c={ORANGE} fw={600}>
              {o.driver?.name ?? o.driver?.phone} · {m.fleet.stage[o.status] ?? o.status}
            </Text>
          ) : (
            <Text size="xs" c="dimmed">
              {timeAgo(o.timeline.searchingAt ?? o.timeline.createdAt)}
            </Text>
          )}
          <OrderStatusBadge status={o.status} />
        </Group>
      </Card>
    </UnstyledButton>
  );
}

function DriverRow({ d, onClick, selected }: { d: FleetDriver; onClick: () => void; selected: boolean }) {
  const kind = markerKind(d);
  return (
    <UnstyledButton onClick={onClick} data-testid="fleet-driver" style={{ display: 'block', width: '100%' }}>
      <Group wrap="nowrap" gap="sm" p={8} style={{ borderRadius: 8, background: selected ? 'var(--mantine-color-gray-1)' : undefined }}>
        <CarDot color={COLORS[kind]} />
        <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
          <Text size="xs" c="dimmed">
            {d.plate ?? '—'}
          </Text>
          <Anchor component={Link} to={`/drivers/${d.driverId}`} size="sm" fw={700} truncate onClick={(e) => e.stopPropagation()}>
            {d.name ?? d.phone}
          </Anchor>
          <Text size="xs" c="dimmed">
            {d.phone}
          </Text>
          {d.activeOrder && (
            <Text size="xs" c={ORANGE}>
              {d.activeOrder.shortCode} · {stageLabel(d) ?? d.activeOrder.status}
            </Text>
          )}
          {kind === 'stale' && (
            <Text size="xs" c="dimmed">
              {m.fleet.lastSeen} {timeAgo(d.lastSeenAt)}
            </Text>
          )}
        </Stack>
      </Group>
    </UnstyledButton>
  );
}

export default function FleetPage() {
  const { connected } = useRealtime();
  const { can } = useAuth();
  const poll = connected ? 60_000 : config.pollMs.fleet;
  const fleet = useQuery({ queryKey: ['fleet'], queryFn: api.fleet, refetchInterval: poll });
  // Same 'orders' key prefix as the Orders page, so live order.updated events refresh these too.
  const waiting = useQuery({ queryKey: ['orders', 'fleet', 'waiting'], queryFn: () => api.orders.list({ status: WAITING, limit: 100 }), refetchInterval: poll });
  const onJob = useQuery({ queryKey: ['orders', 'fleet', 'on-job'], queryFn: () => api.orders.list({ status: ON_JOB, limit: 100 }), refetchInterval: poll });
  const depots = useQuery({ queryKey: ['depots'], queryFn: api.depots.list, staleTime: 300_000 });
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones.list, staleTime: 300_000 });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.all, staleTime: 300_000, retry: false, enabled: can('settings.edit') });
  const defaultRadius = (settings.data?.['depot.geofence_radius_m']?.value as number | undefined) ?? 150;
  const qc = useQueryClient();
  const autoAssign = settings.data?.['dispatch.auto_assign']?.value === true;
  const [savingAuto, setSavingAuto] = useState(false);
  const toggleAutoAssign = async (on: boolean) => {
    setSavingAuto(true);
    try {
      await api.settings.set('dispatch.auto_assign', on);
      await qc.invalidateQueries({ queryKey: ['settings'] });
      notifySuccess(on ? m.fleet.autoAssignOn : m.fleet.autoAssignOff);
    } catch (err) {
      notifyError(err);
    } finally {
      setSavingAuto(false);
    }
  };

  const [orderTab, setOrderTab] = useState<OrderTab>('unassigned');
  const [driverTabValue, setDriverTab] = useState<DriverTab>('free');
  const [selected, setSelected] = useState<string | null>(null);
  // Dark (dispatcher) map by default; remembered per browser.
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem('cw.fleet.dark') !== '0';
    } catch {
      return true;
    }
  });
  const toggleDark = (v: boolean) => {
    setDark(v);
    try {
      localStorage.setItem('cw.fleet.dark', v ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };
  const [target, setTarget] = useState<{ lat: number; lng: number; at: number } | null>(null);
  const focus = (id: string, lat: number | null | undefined, lng: number | null | undefined) => {
    setSelected(id);
    if (lat != null && lng != null) setTarget({ lat, lng, at: Date.now() });
  };

  const drivers = (fleet.data ?? []).filter((d) => d.lat !== null && d.lng !== null);
  const byTab: Record<DriverTab, FleetDriver[]> = { free: [], busy: [], inactive: [] };
  for (const d of drivers) byTab[driverTab(d)].push(d);
  byTab.free.sort((a, b) => Number(a.stale) - Number(b.stale));
  const unassigned = waiting.data?.items ?? [];
  const assigned = onJob.data?.items ?? [];
  const depotList = (depots.data ?? []).filter((dp) => dp.active);
  const driverPos = new Map(drivers.map((d) => [d.driverId, { lat: d.lat!, lng: d.lng! }]));
  const depotFor = (o: AdminOrder) => loadingDepot(depotList, (o.driver && driverPos.get(o.driver.id)) || o.delivery);

  const refresh = () => Promise.all([fleet.refetch(), waiting.refetch(), onJob.refetch()]);
  const refreshing = fleet.isFetching || waiting.isFetching || onJob.isFetching;

  return (
    <>
      <PageHeader
        title={m.fleet.title}
        subtitle={`${fmt(m.fleet.freeCount, { count: byTab.free.length })} · ${fmt(m.fleet.busyCount, { count: byTab.busy.length })} · ${fmt(m.fleet.inactiveCount, { count: byTab.inactive.length })} · ${fmt(m.fleet.waitingCount, { count: unassigned.length })}`}
        actions={
          <Group gap="md">
            {can('settings.edit') && settings.data && (
              <MTooltip label={m.fleet.autoAssignHelp} multiline w={280}>
                <Switch
                  label={m.fleet.autoAssign}
                  checked={autoAssign}
                  disabled={savingAuto}
                  onChange={(e) => void toggleAutoAssign(e.currentTarget.checked)}
                  data-testid="auto-assign"
                />
              </MTooltip>
            )}
            <MTooltip label={m.fleet.refresh}>
              <ActionIcon variant="default" size="lg" onClick={() => void refresh()} loading={refreshing} aria-label={m.fleet.refresh}>
                <IconRefresh size={18} />
              </ActionIcon>
            </MTooltip>
          </Group>
        }
      />
      <QueryState isPending={fleet.isPending} error={fleet.error} refetch={fleet.refetch}>
        <Grid className="cw-fleet" gutter="sm">
          {/* Left: requests waiting for a driver / already assigned. */}
          <Grid.Col span={{ base: 12, md: 3 }} order={{ base: 2, md: 1 }}>
            <Card withBorder p={0} h="100%">
              <Tabs value={orderTab} onChange={(v) => setOrderTab((v as OrderTab) ?? 'unassigned')} color="orange">
                <Tabs.List grow>
                  <Tabs.Tab value="unassigned" data-testid="fleet-tab-unassigned">
                    {m.fleet.tabUnassigned} ({unassigned.length})
                  </Tabs.Tab>
                  <Tabs.Tab value="assigned" data-testid="fleet-tab-assigned">
                    {m.fleet.tabAssigned} ({assigned.length})
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs>
              <ScrollArea.Autosize mah="var(--cw-list-h)" p="xs">
                <Stack gap="xs" data-testid="fleet-orders">
                  {(orderTab === 'unassigned' ? unassigned : assigned).length === 0 && (
                    <Text c="dimmed" ta="center" size="sm" py="xl">
                      {orderTab === 'unassigned' ? m.fleet.noUnassigned : m.fleet.noAssigned}
                    </Text>
                  )}
                  {(orderTab === 'unassigned' ? unassigned : assigned).map((o) => {
                    const pos = o.driver ? (driverPos.get(o.driver.id) ?? o.delivery) : o.delivery;
                    return <OrderCard key={o.id} o={o} depot={depotFor(o)} selected={selected === o.id} onClick={() => focus(o.id, pos.lat, pos.lng)} />;
                  })}
                </Stack>
              </ScrollArea.Autosize>
            </Card>
          </Grid.Col>

          {/* Middle: the live map with car icons. */}
          <Grid.Col span={{ base: 12, md: 6 }} order={{ base: 1, md: 2 }}>
            <Card withBorder p={0} style={{ position: 'relative' }}>
              <MapBase height="var(--cw-map-h)" dark={dark}>
                <FlyTo target={target} />
                {/* Zones: an order inside one only goes to drivers inside it. */}
                {(zones.data ?? [])
                  .filter((z) => z.active)
                  .map((z) => (
                    <Polygon
                      key={`zone-${z.id}`}
                      positions={z.polygon.coordinates[0].map(([lng, lat]) => [lat, lng] as [number, number])}
                      pathOptions={{ color: '#ae3ec9', weight: 2, dashArray: '6 4', fillOpacity: 0.06 }}
                    >
                      <Tooltip>{`${m.fleet.zone}: ${z.name}`}</Tooltip>
                    </Polygon>
                  ))}
                <FitOnce points={[...drivers.map((d) => [d.lat!, d.lng!] as [number, number]), ...unassigned.map((o) => [o.delivery.lat, o.delivery.lng] as [number, number])]} />
                {depotList.map((dp) =>
                  dp.geofencePolygon ? (
                    <Polygon key={dp.id} positions={dp.geofencePolygon.coordinates[0].map(([lng, lat]) => [lat, lng] as [number, number])} pathOptions={{ color: '#1c7ed6', weight: 1, fillOpacity: 0.1 }}>
                      <Tooltip>{`${m.fleet.depot}: ${dp.name}`}</Tooltip>
                    </Polygon>
                  ) : (
                    <Circle key={dp.id} center={[dp.lat, dp.lng]} radius={dp.geofenceRadiusM ?? defaultRadius} pathOptions={{ color: '#1c7ed6', weight: 1, fillOpacity: 0.1 }}>
                      <Tooltip>{`${m.fleet.depot}: ${dp.name}`}</Tooltip>
                    </Circle>
                  ),
                )}
                {/* Busy drivers: dashed orange line from the truck to the customer. */}
                {byTab.busy.map((d) => (
                  <Polyline
                    key={`route-${d.driverId}`}
                    positions={[
                      [d.lat!, d.lng!],
                      [d.activeOrder!.deliveryLat, d.activeOrder!.deliveryLng],
                    ]}
                    pathOptions={{ color: ORANGE, weight: 3, opacity: 0.7, dashArray: '6 6' }}
                  >
                    <Tooltip>{`${m.fleet.toCustomer} · ${d.activeOrder!.shortCode}`}</Tooltip>
                  </Polyline>
                ))}
                {byTab.busy.map((d) => (
                  <CircleMarker key={`dest-${d.driverId}`} center={[d.activeOrder!.deliveryLat, d.activeOrder!.deliveryLng]} radius={6} pathOptions={{ color: RED, weight: 3, fillColor: '#fff', fillOpacity: 1 }}>
                    <Tooltip>{`${m.fleet.dropOff} · ${d.activeOrder!.shortCode}`}</Tooltip>
                  </CircleMarker>
                ))}
                {/* Requests still waiting for a driver: red pin at the customer. */}
                {unassigned.map((o) => (
                  <CircleMarker key={`wait-${o.id}`} center={[o.delivery.lat, o.delivery.lng]} radius={selected === o.id ? 10 : 7} pathOptions={{ color: '#fff', weight: 2, fillColor: RED, fillOpacity: 0.95 }}>
                    <Tooltip>{`${m.fleet.waitingDriver} · ${o.shortCode} · ${o.customer.name ?? o.customer.phone ?? ''}`}</Tooltip>
                  </CircleMarker>
                ))}
                {drivers.map((d) => {
                  const kind = markerKind(d);
                  return (
                    <Marker
                      key={d.driverId}
                      position={[d.lat!, d.lng!]}
                      icon={carIcon(COLORS[kind], { selected: selected === d.driverId || selected === d.activeOrder?.id, dimmed: kind === 'offline' })}
                      zIndexOffset={kind === 'active' ? 500 : kind === 'offline' ? -500 : 0}
                      eventHandlers={{ click: () => setSelected(d.driverId) }}
                    >
                      <Tooltip>{`${d.name ?? d.phone} · ${d.plate ?? ''} · ${stageLabel(d) ?? LABELS[kind]}`}</Tooltip>
                      <Popup>
                        <Stack gap={4}>
                          <Anchor component={Link} to={`/drivers/${d.driverId}`} fw={600}>
                            {d.name ?? d.phone}
                          </Anchor>
                          <Text size="xs">
                            {d.phone} · {d.plate ?? '—'}
                          </Text>
                          <Text size="xs">
                            {LABELS[kind]} · {m.fleet.lastSeen} {timeAgo(d.lastSeenAt)}
                          </Text>
                          {stageLabel(d) && (
                            <Text size="xs" fw={600} c={ORANGE}>
                              {stageLabel(d)}
                            </Text>
                          )}
                          {d.activeOrder && (
                            <Group gap={4}>
                              <Anchor component={Link} to={`/orders/${d.activeOrder.id}`} size="xs">
                                {d.activeOrder.shortCode}
                              </Anchor>
                              <OrderStatusBadge status={d.activeOrder.status} />
                            </Group>
                          )}
                        </Stack>
                      </Popup>
                    </Marker>
                  );
                })}
              </MapBase>
              {/* Legend over the map. */}
              <SegmentedControl
                size="xs"
                value={dark ? 'dark' : 'light'}
                onChange={(v) => toggleDark(v === 'dark')}
                data={[
                  { value: 'dark', label: m.fleet.mapDark },
                  { value: 'light', label: m.fleet.mapLight },
                ]}
                style={{ position: 'absolute', top: 10, right: 10, zIndex: 500 }}
                data-testid="fleet-map-theme"
              />
              <Group gap={10} className={`cw-fleet-legend${dark ? ' cw-fleet-legend--dark' : ''}`}>
                {(['online', 'active', 'offline'] as MarkerKind[]).map((k) => (
                  <Group key={k} gap={4} wrap="nowrap">
                    <CarDot color={COLORS[k]} />
                    <Text size="xs">{k === 'online' ? m.fleet.tabFree : k === 'active' ? m.fleet.tabBusy : m.fleet.tabInactive}</Text>
                  </Group>
                ))}
                <Group gap={4} wrap="nowrap">
                  <span style={{ width: 12, height: 12, borderRadius: 12, background: RED, border: '2px solid #fff', display: 'inline-block' }} />
                  <Text size="xs">{m.fleet.waitingDriver}</Text>
                </Group>
              </Group>
            </Card>
          </Grid.Col>

          {/* Right: drivers by Free / Busy / Inactive. */}
          <Grid.Col span={{ base: 12, md: 3 }} order={{ base: 3, md: 3 }}>
            <Card withBorder p={0} h="100%">
              <Tabs value={driverTabValue} onChange={(v) => setDriverTab((v as DriverTab) ?? 'free')} color="teal">
                <Tabs.List grow>
                  <Tabs.Tab
                    value="free"
                    data-testid="fleet-tab-free"
                    rightSection={
                      <Badge size="sm" circle color="green" variant="filled">
                        {byTab.free.length}
                      </Badge>
                    }
                  >
                    {m.fleet.tabFree}
                  </Tabs.Tab>
                  <Tabs.Tab
                    value="busy"
                    data-testid="fleet-tab-busy"
                    rightSection={
                      <Badge size="sm" circle color="orange" variant="filled">
                        {byTab.busy.length}
                      </Badge>
                    }
                  >
                    {m.fleet.tabBusy}
                  </Tabs.Tab>
                  <Tabs.Tab
                    value="inactive"
                    data-testid="fleet-tab-inactive"
                    rightSection={
                      <Badge size="sm" circle color="gray" variant="filled">
                        {byTab.inactive.length}
                      </Badge>
                    }
                  >
                    {m.fleet.tabInactive}
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs>
              <ScrollArea.Autosize mah="var(--cw-list-h)" p="xs">
                <Stack gap={2} data-testid="fleet-list">
                  {byTab[driverTabValue].length === 0 && (
                    <Text c="dimmed" ta="center" size="sm" py="xl">
                      {drivers.length === 0 ? m.fleet.noLocation : m.fleet.noDriversHere}
                    </Text>
                  )}
                  {byTab[driverTabValue].map((d) => (
                    <DriverRow key={d.driverId} d={d} selected={selected === d.driverId} onClick={() => focus(d.driverId, d.lat, d.lng)} />
                  ))}
                </Stack>
              </ScrollArea.Autosize>
            </Card>
          </Grid.Col>
        </Grid>
      </QueryState>
    </>
  );
}
