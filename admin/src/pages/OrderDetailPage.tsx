import { Alert, Anchor, Badge, Button, Card, Code, Grid, Group, Image, Radio, Rating, Select, Stack, Table, Text, Timeline, Title } from '@mantine/core';
import { IconArrowBackUp, IconCash, IconMapPin, IconUserShare, IconX } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { CircleMarker, Tooltip } from 'react-leaflet';
import { Link, useParams } from 'react-router-dom';
import { api, type AdminOrderDetail } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { ActionModal } from '@/components/ActionModal';
import { InfoGrid } from '@/components/InfoGrid';
import { MapBase } from '@/components/MapBase';
import { Money } from '@/components/Money';
import { PageHeader } from '@/components/PageHeader';
import { Empty, QueryState } from '@/components/QueryState';
import { OrderStatusBadge, StatusBadge } from '@/components/StatusBadge';
import { fmt, label, m } from '@/i18n';
import { formatKina, parseKinaToToea } from '@/lib/money';
import { canAdminCancel, canAssign, canRefund, canRelease, canReassign } from '@/lib/orderRules';
import { formatDateTime } from '@/lib/time';

function metaText(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const entries = Object.entries(meta as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined);
  if (!entries.length) return null;
  return entries.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ');
}

function ReassignModal({ order, opened, onClose, onDone }: { order: AdminOrderDetail; opened: boolean; onClose: () => void; onDone: () => Promise<unknown> }) {
  const [mode, setMode] = useState<'release' | 'assign'>(canRelease(order) ? 'release' : 'assign');
  const [driverId, setDriverId] = useState<string | null>(null);
  const drivers = useQuery({
    queryKey: ['drivers', 'assignable'],
    queryFn: () => api.drivers.list({ status: 'approved', limit: 100 }),
    enabled: opened,
  });
  const options = (drivers.data?.items ?? [])
    .filter((d) => d.id !== order.driver?.id)
    .map((d) => ({
      value: d.id,
      label: `${d.name ?? d.phone} · ${d.truck?.plate ?? '—'} · ${d.online ? m.drivers.online : m.drivers.offline} · ${formatKina(d.balanceToea)}`,
    }));
  return (
    <ActionModal
      opened={opened}
      onClose={onClose}
      title={fmt(m.orders.reassignTitle, { code: order.shortCode })}
      fields={[{ name: 'reason', label: m.common.reason, type: 'textarea', required: true, maxLength: 300 }]}
      validate={() => (mode === 'assign' && !driverId ? m.orders.pickDriver : null)}
      successMessage={m.orders.reassigned}
      onSubmit={async (v) => {
        await api.orders.reassign(order.id, { reason: v.reason, driverId: mode === 'assign' ? (driverId ?? undefined) : undefined });
        await onDone();
      }}
    >
      <Radio.Group label={m.orders.reassignMode} value={mode} onChange={(v) => setMode(v as 'release' | 'assign')}>
        <Stack gap="xs" mt="xs">
          <Radio value="release" label={m.orders.releaseToDispatch} disabled={!canRelease(order)} />
          <Radio value="assign" label={m.orders.assignToDriver} disabled={!canAssign(order)} />
        </Stack>
      </Radio.Group>
      {mode === 'assign' && (
        <Select label={m.orders.pickDriver} data={options} value={driverId} onChange={setDriverId} searchable nothingFoundMessage={m.common.noData} withAsterisk />
      )}
    </ActionModal>
  );
}

export default function OrderDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api.orders.get(id) });
  const [modal, setModal] = useState<'cancel' | 'reassign' | 'refund' | null>(null);
  const o = q.data;

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['order', id] }), qc.invalidateQueries({ queryKey: ['orders'] }), qc.invalidateQueries({ queryKey: ['overview'] })]);

  return (
    <QueryState isPending={q.isPending} error={q.error} refetch={q.refetch}>
      {o && (
        <>
          <PageHeader
            title={
              <Group gap="sm">
                <span style={{ fontFamily: 'monospace' }}>{o.shortCode}</span>
                <OrderStatusBadge status={o.status} />
              </Group>
            }
            subtitle={formatDateTime(o.timeline.createdAt)}
            actions={
              <>
                {can('orders.manage') && canReassign(o) && (
                  <Button variant="light" leftSection={<IconUserShare size={16} />} onClick={() => setModal('reassign')}>
                    {m.orders.reassign}
                  </Button>
                )}
                {can('payments.refund') && canRefund(o) && (
                  <Button variant="light" color="grape" leftSection={<IconCash size={16} />} onClick={() => setModal('refund')}>
                    {m.orders.refund}
                  </Button>
                )}
                {can('orders.manage') && canAdminCancel(o) && (
                  <Button variant="light" color="red" leftSection={<IconX size={16} />} onClick={() => setModal('cancel')}>
                    {m.orders.cancel}
                  </Button>
                )}
              </>
            }
          />
          <Grid>
            <Grid.Col span={{ base: 12, lg: 8 }}>
              <Stack>
                <Card withBorder>
                  <InfoGrid
                    items={[
                      [m.orders.package, `${o.package.name ?? '—'} (${o.package.volumeLitres ?? '?'} L) × ${o.quantity}`],
                      [m.orders.price, <Money key="p" toea={o.priceToea} />],
                      ...((o.discountToea ?? 0) > 0
                        ? ([
                            [m.orders.discount, <Money key="d" toea={-(o.discountToea ?? 0)} />],
                            [m.orders.customerPays, <Money key="cp" toea={o.payableToea ?? o.priceToea - (o.discountToea ?? 0)} fw={600} />],
                          ] as [ReactNode, ReactNode][])
                        : []),
                      [m.orders.commission, <span key="c"><Money toea={o.commissionToea} /> ({o.commissionType === 'percent' ? `${o.commissionValue}%` : formatKina(o.commissionValue)}, {o.commissionDeductAt})</span>],
                      [m.orders.paymentMethod, label(m.enums.paymentMethod, o.paymentMethod)],
                      [m.orders.paymentStatus, <StatusBadge key="ps" value={o.paymentStatus} />],
                      [m.orders.dispatchRound, o.dispatchRound],
                      [m.orders.settlement, o.settledAt ? `${m.orders.settled} ${formatDateTime(o.settledAt)}` : m.orders.notSettled],
                      [m.orders.commissionDeducted, o.commissionDeducted ? m.common.yes : m.common.no],
                      [m.orders.expiresAt, formatDateTime(o.expiresAt)],
                    ]}
                  />
                  {o.cancelReason && (
                    <Alert mt="md" color="gray" title={m.orders.cancelReason}>
                      {o.cancelReason}
                    </Alert>
                  )}
                </Card>
                <OrderChat orderId={o.id} />
                <Card withBorder>
                  <Title order={5} mb="sm">
                    {m.orders.timeline}
                  </Title>
                  {o.events && o.events.length > 0 ? (
                    <Timeline active={o.events.length - 1} bulletSize={18} lineWidth={2} data-testid="order-timeline">
                      {o.events.map((e) => (
                        <Timeline.Item
                          key={e.id}
                          title={
                            <Group gap={6}>
                              {e.fromStatus && <OrderStatusBadge status={e.fromStatus} />}
                              {e.fromStatus && '→'}
                              <OrderStatusBadge status={e.toStatus} />
                            </Group>
                          }
                        >
                          <Text size="xs" c="dimmed">
                            {formatDateTime(e.createdAt)} · {m.orders.actor}: {label(m.enums.actorType, e.actorType)}
                            {e.actorId ? ` (${e.actorId.slice(0, 8)})` : ''}
                          </Text>
                          {metaText(e.metadata) && (
                            <Text size="xs" mt={2}>
                              {metaText(e.metadata)}
                            </Text>
                          )}
                        </Timeline.Item>
                      ))}
                    </Timeline>
                  ) : (
                    <Empty />
                  )}
                </Card>
                <Card withBorder>
                  <Title order={5} mb="sm">
                    {m.orders.offers}
                  </Title>
                  {o.offers.length === 0 ? (
                    <Empty>{m.orders.noOffers}</Empty>
                  ) : (
                    <Table fz="sm">
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>{m.orders.round}</Table.Th>
                          <Table.Th>{m.common.driver}</Table.Th>
                          <Table.Th>{m.orders.distance}</Table.Th>
                          <Table.Th>{m.orders.sent}</Table.Th>
                          <Table.Th>{m.orders.response}</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {o.offers.map((f) => (
                          <Table.Tr key={f.id}>
                            <Table.Td>{f.round}</Table.Td>
                            <Table.Td>
                              <Anchor component={Link} to={`/drivers/${f.driverId}`} size="sm">
                                {f.driverName ?? f.driverId.slice(0, 8)}
                              </Anchor>
                            </Table.Td>
                            <Table.Td>{f.distanceM !== null ? `${(f.distanceM / 1000).toFixed(1)} km` : '—'}</Table.Td>
                            <Table.Td>{formatDateTime(f.sentAt)}</Table.Td>
                            <Table.Td>
                              <StatusBadge value={f.response ?? 'pending'} />
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  )}
                </Card>
                <Card withBorder>
                  <Title order={5} mb="sm">
                    {m.orders.payments}
                  </Title>
                  {o.payments.length === 0 ? (
                    <Empty>{m.orders.noPayments}</Empty>
                  ) : (
                    <Table fz="sm">
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>{m.common.created}</Table.Th>
                          <Table.Th>{m.payments.purpose}</Table.Th>
                          <Table.Th>{m.payments.adapter}</Table.Th>
                          <Table.Th>{m.common.status}</Table.Th>
                          <Table.Th ta="right">{m.common.amount}</Table.Th>
                          <Table.Th>{m.payments.providerRef}</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {o.payments.map((p) => (
                          <Table.Tr key={p.id}>
                            <Table.Td>{formatDateTime(p.createdAt)}</Table.Td>
                            <Table.Td>
                              {label(m.enums.purpose, p.purpose)} ({p.direction})
                            </Table.Td>
                            <Table.Td>{p.adapter}</Table.Td>
                            <Table.Td>
                              <StatusBadge value={p.status} />
                              {p.failureReason && (
                                <Text size="xs" c="dimmed">
                                  {p.failureReason}
                                </Text>
                              )}
                            </Table.Td>
                            <Table.Td ta="right">
                              <Money toea={p.amountToea} />
                            </Table.Td>
                            <Table.Td>
                              {can('payments.view') ? (
                                <Anchor component={Link} to={`/payments?q=${encodeURIComponent(p.reference)}`} size="xs" ff="monospace">
                                  {p.providerRef ?? p.reference}
                                </Anchor>
                              ) : (
                                <Code>{p.providerRef ?? p.reference}</Code>
                              )}
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  )}
                </Card>
                <Card withBorder>
                  <Title order={5} mb="sm">
                    {m.orders.disputes}
                  </Title>
                  {o.disputes.length === 0 ? (
                    <Empty>{m.orders.noDisputes}</Empty>
                  ) : (
                    <Stack gap="xs">
                      {o.disputes.map((d) => (
                        <Group key={d.id} justify="space-between">
                          <Stack gap={0}>
                            {can('disputes.resolve') ? (
                              <Anchor component={Link} to={`/disputes/${d.id}`} size="sm">
                                {label({}, d.category)}
                              </Anchor>
                            ) : (
                              <Text size="sm">{label({}, d.category)}</Text>
                            )}
                            <Text size="xs" c="dimmed" lineClamp={2}>
                              {d.description}
                            </Text>
                          </Stack>
                          <StatusBadge value={d.status} />
                        </Group>
                      ))}
                    </Stack>
                  )}
                </Card>
              </Stack>
            </Grid.Col>
            <Grid.Col span={{ base: 12, lg: 4 }}>
              <Stack>
                <Card withBorder>
                  <Title order={5} mb="xs">
                    {m.orders.customerInfo}
                  </Title>
                  {can('customers.view') ? (
                    <Anchor component={Link} to={`/customers/${o.customer.id}`}>
                      {o.customer.name ?? o.customer.phone ?? o.customer.id.slice(0, 8)}
                    </Anchor>
                  ) : (
                    <Text>{o.customer.name ?? '—'}</Text>
                  )}
                  <Text size="sm" c="dimmed">
                    {o.customer.phone}
                  </Text>
                </Card>
                <Card withBorder>
                  <Title order={5} mb="xs">
                    {m.orders.driverInfo}
                  </Title>
                  {o.driver ? (
                    <>
                      {can('drivers.view') ? (
                        <Anchor component={Link} to={`/drivers/${o.driver.id}`}>
                          {o.driver.name ?? o.driver.phone}
                        </Anchor>
                      ) : (
                        <Text>{o.driver.name}</Text>
                      )}
                      <Text size="sm" c="dimmed">
                        {o.driver.phone} · {o.driver.plate ?? '—'}
                      </Text>
                    </>
                  ) : (
                    <Text c="dimmed" size="sm">
                      {m.orders.noDriver}
                    </Text>
                  )}
                </Card>
                <Card withBorder>
                  <Group justify="space-between" mb="xs">
                    <Title order={5}>{m.orders.delivery}</Title>
                    <Anchor href={`https://www.openstreetmap.org/?mlat=${o.delivery.lat}&mlon=${o.delivery.lng}#map=17/${o.delivery.lat}/${o.delivery.lng}`} target="_blank" rel="noreferrer" size="xs">
                      <IconMapPin size={12} /> {m.orders.openMap}
                    </Anchor>
                  </Group>
                  <Text size="sm">{o.delivery.address}</Text>
                  {o.delivery.notes && (
                    <Text size="sm" c="dimmed" mt={4}>
                      {m.orders.landmark}: {o.delivery.notes}
                    </Text>
                  )}
                  <div style={{ marginTop: 8 }}>
                    <MapBase height={220} center={[o.delivery.lat, o.delivery.lng]} zoom={14}>
                      <CircleMarker center={[o.delivery.lat, o.delivery.lng]} radius={8} pathOptions={{ color: '#e8590c', fillOpacity: 0.8 }}>
                        <Tooltip>{m.orders.delivery}</Tooltip>
                      </CircleMarker>
                      {o.driver?.location?.lng != null && (
                        <CircleMarker center={[o.driver.location.lat, o.driver.location.lng]} radius={8} pathOptions={{ color: '#7048e8', fillOpacity: 0.8 }}>
                          <Tooltip>{o.driver.name ?? m.common.driver}</Tooltip>
                        </CircleMarker>
                      )}
                    </MapBase>
                  </div>
                </Card>
                <Card withBorder>
                  <Title order={5} mb="xs">
                    {m.orders.proof}
                  </Title>
                  {o.proofPhotoUrl ? (
                    <Anchor href={o.proofPhotoUrl} target="_blank" rel="noreferrer">
                      <Image src={o.proofPhotoUrl} radius="sm" alt={m.orders.proof} mah={300} fit="contain" />
                    </Anchor>
                  ) : (
                    <Text c="dimmed" size="sm">
                      {m.orders.noProof}
                    </Text>
                  )}
                </Card>
                {o.rating && (
                  <Card withBorder>
                    <Title order={5} mb="xs">
                      {m.orders.rating}
                    </Title>
                    <Rating value={o.rating.stars} readOnly />
                    {o.rating.comment && (
                      <Text size="sm" mt={4}>
                        {o.rating.comment}
                      </Text>
                    )}
                  </Card>
                )}
                {o.statusBeforeDispute && (
                  <Badge variant="outline" color="orange" leftSection={<IconArrowBackUp size={12} />}>
                    {m.disputes.beforeDispute}: {label(m.enums.orderStatus, o.statusBeforeDispute)}
                  </Badge>
                )}
              </Stack>
            </Grid.Col>
          </Grid>

          <ActionModal
            opened={modal === 'cancel'}
            onClose={() => setModal(null)}
            title={fmt(m.orders.cancelTitle, { code: o.shortCode })}
            body={m.orders.cancelBody}
            color="red"
            confirmLabel={m.orders.cancel}
            fields={[{ name: 'reason', label: m.common.reason, type: 'textarea', required: true, maxLength: 300 }]}
            successMessage={m.orders.cancelled}
            onSubmit={async (v) => {
              await api.orders.cancel(o.id, { reason: v.reason });
              await refresh();
            }}
          />
          {modal === 'reassign' && <ReassignModal order={o} opened onClose={() => setModal(null)} onDone={refresh} />}
          <ActionModal
            opened={modal === 'refund'}
            onClose={() => setModal(null)}
            title={fmt(m.orders.refundTitle, { code: o.shortCode })}
            body={fmt(m.orders.refundBody, { amount: formatKina(o.priceToea) })}
            color="grape"
            confirmLabel={m.orders.refund}
            fields={[
              { name: 'amount', label: m.orders.refundAmount, type: 'kina' },
              { name: 'reason', label: m.common.reason, type: 'textarea', required: true, maxLength: 300 },
            ]}
            validate={(v) => {
              const t = v.amount ? parseKinaToToea(v.amount) : null;
              if (t !== null && (t <= 0 || t > o.priceToea)) return `${m.common.invalidAmount} (≤ ${formatKina(o.priceToea)})`;
              return null;
            }}
            successMessage={m.orders.refunded}
            onSubmit={async (v) => {
              const amountToea = v.amount ? (parseKinaToToea(v.amount) ?? undefined) : undefined;
              await api.orders.refund(o.id, { reason: v.reason, amountToea });
              await refresh();
            }}
          />
        </>
      )}
    </QueryState>
  );
}

/** Customer ↔ driver chat transcript (read-only; useful for disputes). */
function OrderChat({ orderId }: { orderId: string }) {
  const q = useQuery({ queryKey: ['order-messages', orderId], queryFn: () => api.orders.messages(orderId) });
  return (
    <Card withBorder data-testid="order-chat">
      <Title order={5} mb="sm">
        {m.orders.chat}
      </Title>
      <QueryState isPending={q.isPending} error={q.error} refetch={q.refetch}>
        {!q.data?.length ? (
          <Text size="sm" c="dimmed">
            {m.orders.chatEmpty}
          </Text>
        ) : (
          <Stack gap="xs">
            {q.data.map((msg) => (
              <Group key={msg.id} justify={msg.senderRole === 'customer' ? 'flex-start' : 'flex-end'}>
                <Card withBorder p="xs" maw="80%" bg={msg.senderRole === 'customer' ? 'gray.0' : 'blue.0'}>
                  <Text size="xs" fw={600}>
                    {msg.senderName ?? (msg.senderRole === 'customer' ? m.orders.chatCustomer : m.orders.chatDriver)} ·{' '}
                    {msg.senderRole === 'customer' ? m.orders.chatCustomer : m.orders.chatDriver}
                  </Text>
                  <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                    {msg.body}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {formatDateTime(msg.createdAt)}
                  </Text>
                </Card>
              </Group>
            ))}
          </Stack>
        )}
      </QueryState>
    </Card>
  );
}
