import { Button, Card, Grid, Group, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CircleMarker, Tooltip } from 'react-leaflet';
import { Link, useParams } from 'react-router-dom';
import { api } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { ActionModal } from '@/components/ActionModal';
import { InfoGrid } from '@/components/InfoGrid';
import { LedgerTable, WalletAdjustModal } from '@/components/Ledger';
import { Money } from '@/components/Money';
import { MapBase } from '@/components/MapBase';
import { PageHeader } from '@/components/PageHeader';
import { Empty, QueryState } from '@/components/QueryState';
import { OrderStatusBadge, StatusBadge } from '@/components/StatusBadge';
import { fmt, m } from '@/i18n';
import { formatDateTime } from '@/lib/time';

export default function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['customer', id], queryFn: () => api.customers.get(id) });
  const [modal, setModal] = useState(false);
  const [adjust, setAdjust] = useState(false);
  const c = q.data;
  const suspended = c?.status === 'suspended';

  return (
    <QueryState isPending={q.isPending} error={q.error} refetch={q.refetch}>
      {c && (
        <>
          <PageHeader
            title={
              <Group gap="sm">
                {c.name ?? c.phone} <StatusBadge value={c.status} />
              </Group>
            }
            subtitle={c.phone}
            actions={
              <>
                {can('orders.view') && (
                  <Button component={Link} to={`/orders?customerId=${c.id}`} variant="default">
                    {m.customers.viewOrders}
                  </Button>
                )}
                {can('customers.manage') && (
                  <Button color={suspended ? 'teal' : 'orange'} variant="light" onClick={() => setModal(true)}>
                    {suspended ? m.customers.reactivate : m.customers.suspend}
                  </Button>
                )}
              </>
            }
          />
          <Grid>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <Stack>
                <Card withBorder>
                  <InfoGrid
                    cols={2}
                    items={[
                      [m.common.phone, c.phone],
                      [m.common.created, formatDateTime(c.createdAt)],
                      [m.customers.phoneVerified, formatDateTime(c.phoneVerifiedAt)],
                      [m.common.status, <StatusBadge key="s" value={c.status} />],
                    ]}
                  />
                </Card>
                <Card withBorder>
                  <Title order={5} mb="sm">
                    {m.customers.orderCounts}
                  </Title>
                  {Object.keys(c.orderCounts).length === 0 ? (
                    <Empty />
                  ) : (
                    <Group gap="sm">
                      {Object.entries(c.orderCounts).map(([s, n]) => (
                        <Group key={s} gap={4}>
                          <OrderStatusBadge status={s} /> <Text fw={600}>{n}</Text>
                        </Group>
                      ))}
                    </Group>
                  )}
                </Card>
              </Stack>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <Card withBorder>
                <Title order={5} mb="sm">
                  {m.customers.locations}
                </Title>
                {c.locations.length === 0 ? (
                  <Empty>{m.customers.noLocations}</Empty>
                ) : (
                  <Stack>
                    <MapBase height={220} center={[c.locations[0].lat, c.locations[0].lng]} zoom={13}>
                      {c.locations.map((l) => (
                        <CircleMarker key={l.id} center={[l.lat, l.lng]} radius={7} pathOptions={{ color: '#1c7ed6', fillOpacity: 0.8 }}>
                          <Tooltip>{l.label}</Tooltip>
                        </CircleMarker>
                      ))}
                    </MapBase>
                    <Table fz="sm">
                      <Table.Tbody>
                        {c.locations.map((l) => (
                          <Table.Tr key={l.id}>
                            <Table.Td fw={600}>{l.label}</Table.Td>
                            <Table.Td>
                              {l.addressText}
                              {l.landmarkNotes && (
                                <Text size="xs" c="dimmed">
                                  {l.landmarkNotes}
                                </Text>
                              )}
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Stack>
                )}
              </Card>
            </Grid.Col>
            {c.wallet && can('wallet.view') && (
              <Grid.Col span={12}>
                <Card withBorder data-testid="customer-wallet">
                  <Group justify="space-between" mb="sm" align="flex-start">
                    <div>
                      <Title order={5}>{m.wallet.customerTitle}</Title>
                      <Money toea={c.wallet.balanceToea} fz={28} fw={700} />
                    </div>
                    {can('wallet.adjust') && (
                      <Button variant="light" onClick={() => setAdjust(true)} data-testid="customer-wallet-adjust">
                        {m.wallet.adjust}
                      </Button>
                    )}
                  </Group>
                  <LedgerTable walletId={c.wallet.id} />
                </Card>
              </Grid.Col>
            )}
          </Grid>
          {adjust && c.wallet && (
            <WalletAdjustModal walletId={c.wallet.id} opened onClose={() => setAdjust(false)} invalidate={[['customer', id], ['customers']]} />
          )}
          <ActionModal
            opened={modal}
            onClose={() => setModal(false)}
            title={fmt(suspended ? m.customers.reactivateTitle : m.customers.suspendTitle, { name: c.name ?? c.phone })}
            body={suspended ? m.customers.reactivateBody : m.customers.suspendBody}
            color={suspended ? 'teal' : 'orange'}
            confirmLabel={suspended ? m.customers.reactivate : m.customers.suspend}
            successMessage={m.common.actionDone}
            onSubmit={async () => {
              await (suspended ? api.customers.reactivate(c.id) : api.customers.suspend(c.id));
              await Promise.all([qc.invalidateQueries({ queryKey: ['customer', id] }), qc.invalidateQueries({ queryKey: ['customers'] })]);
            }}
          />
        </>
      )}
    </QueryState>
  );
}
