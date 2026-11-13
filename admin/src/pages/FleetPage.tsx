import { Anchor, Badge, Card, Grid, Group, ScrollArea, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Circle, CircleMarker, Polygon, Polyline, Popup, Tooltip } from 'react-leaflet';
import { Link } from 'react-router-dom';
import { api, type FleetDriver } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { MapBase } from '@/components/MapBase';
import { PageHeader } from '@/components/PageHeader';
import { QueryState } from '@/components/QueryState';
import { OrderStatusBadge } from '@/components/StatusBadge';
import { config } from '@/config';
import { fmt, m } from '@/i18n';
import { timeAgo } from '@/lib/time';
import { useRealtime } from '@/realtime/RealtimeProvider';

/** online = free (green), active = busy on a job (orange), stale = free but GPS not updated, offline = grey. */
type MarkerKind = 'online' | 'active' | 'stale' | 'offline';

function markerKind(d: FleetDriver): MarkerKind {
  if (d.activeOrder) return 'active';
  if (!d.online) return 'offline';
  return d.stale ? 'stale' : 'online';
}

const GREEN = '#2f9e44';
const ORANGE = '#f76707';
const COLORS: Record<MarkerKind, string> = { online: GREEN, active: ORANGE, stale: '#8ce99a', offline: '#868e96' };
const LABELS: Record<MarkerKind, string> = { online: m.fleet.legendOnline, active: m.fleet.legendActive, stale: m.fleet.legendStale, offline: m.fleet.legendOffline };
/** Free first, then busy, then the rest (list order). */
const ORDER: Record<MarkerKind, number> = { online: 0, stale: 1, active: 2, offline: 3 };

function stageLabel(d: FleetDriver): string | null {
  return d.activeOrder ? (m.fleet.stage[d.activeOrder.status] ?? null) : null;
}

export default function FleetPage() {
  const { connected } = useRealtime();
  const { can } = useAuth();
  const fleet = useQuery({ queryKey: ['fleet'], queryFn: api.fleet, refetchInterval: connected ? 60_000 : config.pollMs.fleet });
  const depots = useQuery({ queryKey: ['depots'], queryFn: api.depots.list, staleTime: 300_000 });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.all, staleTime: 300_000, retry: false, enabled: can('settings.edit') });
  const defaultRadius = (settings.data?.['depot.geofence_radius_m']?.value as number | undefined) ?? 150;
  const drivers = (fleet.data ?? []).filter((d) => d.lat !== null && d.lng !== null);
  const free = drivers.filter((d) => d.online && !d.activeOrder).length;
  const busy = drivers.filter((d) => d.activeOrder).length;
  const listed = [...drivers].sort((a, b) => ORDER[markerKind(a)] - ORDER[markerKind(b)]);

  return (
    <>
      <PageHeader title={m.fleet.title} subtitle={`${fmt(m.fleet.drivers, { count: drivers.length })} · ${fmt(m.fleet.freeCount, { count: free })} · ${fmt(m.fleet.busyCount, { count: busy })}`} />
      <QueryState isPending={fleet.isPending} error={fleet.error} refetch={fleet.refetch}>
        <Grid className="cw-fleet">
          <Grid.Col span={{ base: 12, md: 9 }}>
            <Card withBorder p={0}>
              <MapBase height="var(--cw-map-h)">
                {(depots.data ?? []).map((dp) =>
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
                {drivers
                  .filter((d) => d.activeOrder)
                  .map((d) => (
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
                {drivers.map((d) => {
                  const kind = markerKind(d);
                  return (
                    <CircleMarker
                      key={d.driverId}
                      center={[d.lat!, d.lng!]}
                      radius={kind === 'active' ? 11 : 9}
                      // Stale GPS: dashed outline so it's clear the dot may not be the exact spot right now.
                      pathOptions={{ color: kind === 'stale' ? GREEN : '#fff', weight: kind === 'stale' ? 2 : 3, dashArray: kind === 'stale' || (kind === 'active' && d.stale) ? '3 3' : undefined, fillColor: COLORS[kind], fillOpacity: 0.95 }}
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
                    </CircleMarker>
                  );
                })}
                {drivers
                  .filter((d) => d.activeOrder)
                  .map((d) => (
                    <CircleMarker key={`dest-${d.driverId}`} center={[d.activeOrder!.deliveryLat, d.activeOrder!.deliveryLng]} radius={6} pathOptions={{ color: ORANGE, weight: 2, fillColor: '#fff', fillOpacity: 1 }}>
                      <Tooltip>{d.activeOrder!.shortCode}</Tooltip>
                    </CircleMarker>
                  ))}
              </MapBase>
            </Card>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 3 }}>
            <Card withBorder>
              <Group gap="xs" mb="sm">
                {(Object.keys(COLORS) as MarkerKind[]).map((k) => (
                  <Badge key={k} variant="dot" color={COLORS[k]} styles={{ root: { '--badge-dot-color': COLORS[k] } as React.CSSProperties }}>
                    {LABELS[k]}
                  </Badge>
                ))}
              </Group>
              <ScrollArea.Autosize mah="var(--cw-list-h)">
                <Stack gap="xs" data-testid="fleet-list">
                  {drivers.length === 0 && <Text c="dimmed">{m.fleet.noLocation}</Text>}
                  {listed.map((d) => (
                    <Group key={d.driverId} justify="space-between" wrap="nowrap">
                      <Stack gap={0}>
                        <Anchor component={Link} to={`/drivers/${d.driverId}`} size="sm">
                          {d.name ?? d.phone}
                        </Anchor>
                        <Text size="xs" c="dimmed">
                          {d.plate ?? '—'} · {timeAgo(d.lastSeenAt)}
                        </Text>
                        {d.activeOrder && (
                          <Text size="xs" c={ORANGE}>
                            {d.activeOrder.shortCode} · {stageLabel(d) ?? d.activeOrder.status}
                          </Text>
                        )}
                      </Stack>
                      <Badge size="xs" style={{ background: COLORS[markerKind(d)], color: markerKind(d) === 'stale' ? '#1b5e20' : undefined }}>
                        {LABELS[markerKind(d)]}
                      </Badge>
                    </Group>
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
