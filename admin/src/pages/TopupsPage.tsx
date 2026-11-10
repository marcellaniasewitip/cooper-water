import { Anchor, Badge, Button, Card, Group, SegmentedControl, Stack, Table, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Topup } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { ActionModal } from '@/components/ActionModal';
import { LoadMore } from '@/components/CursorList';
import { useCursorList } from '@/components/useCursorList';
import { Money } from '@/components/Money';
import { PageHeader } from '@/components/PageHeader';
import { Empty, QueryState } from '@/components/QueryState';
import { StatusBadge } from '@/components/StatusBadge';
import { fmt, label, m } from '@/i18n';
import { formatKina } from '@/lib/money';
import { formatDateTime } from '@/lib/time';

function Proof({ t }: { t: Topup }) {
  if (t.proofUrl) {
    return (
      <Anchor href={t.proofUrl} target="_blank" rel="noreferrer" size="xs">
        {m.common.open}
      </Anchor>
    );
  }
  if (t.proofFileKey) {
    return (
      <Text size="xs" c="dimmed" title={t.proofFileKey}>
        {fmt(m.topups.proofKeyOnly, { key: `…${t.proofFileKey.slice(-12)}` })}
      </Text>
    );
  }
  return (
    <Text size="xs" c="dimmed">
      {m.topups.noProof}
    </Text>
  );
}

/** Who the top-up is for: a driver or a customer (both use the same approval queue). */
function TopupOwner({ t }: { t: Topup }) {
  const isCustomer = !!t.customer;
  const name = isCustomer ? (t.customer?.name ?? t.customer?.phone) : (t.driver?.user.name ?? t.driver?.user.phone);
  const phone = isCustomer ? t.customer?.phone : t.driver?.user.phone;
  const to = isCustomer ? `/customers/${t.customer?.id}` : `/drivers/${t.driverId}`;
  return (
    <>
      <Group gap={6} wrap="nowrap">
        <Badge size="xs" variant="light" color={isCustomer ? 'grape' : 'blue'} data-testid="topup-owner">
          {isCustomer ? m.topups.ownerCustomer : m.topups.ownerDriver}
        </Badge>
        <Anchor component={Link} to={to} size="sm">
          {name ?? '—'}
        </Anchor>
      </Group>
      <Text size="xs" c="dimmed">
        {phone}
      </Text>
    </>
  );
}

export default function TopupsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [action, setAction] = useState<{ t: Topup; kind: 'approve' | 'reject' } | null>(null);
  const query = { status: status === 'all' ? undefined : status };
  const list = useCursorList<Topup>(['topups', query], (p) => api.topups.list({ ...query, ...p }));

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['topups'] }), qc.invalidateQueries({ queryKey: ['overview'] }), qc.invalidateQueries({ queryKey: ['payments'] })]);

  return (
    <>
      <PageHeader title={m.topups.title} subtitle={m.topups.pendingFirst} />
      <Card withBorder mb="md">
        <SegmentedControl
          value={status}
          onChange={setStatus}
          data={[
            { value: 'pending', label: 'Pending' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'failed', label: 'Failed' },
            { value: 'all', label: m.common.all },
          ]}
        />
      </Card>
      <Card withBorder>
        <QueryState isPending={list.isPending} error={list.error} refetch={list.refetch}>
          {list.items.length === 0 ? (
            <Empty />
          ) : (
            <Table.ScrollContainer minWidth={1000}>
              <Table striped highlightOnHover fz="sm" data-testid="topups-table">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{m.common.created}</Table.Th>
                    <Table.Th>{m.topups.from}</Table.Th>
                    <Table.Th>{m.topups.method}</Table.Th>
                    <Table.Th ta="right">{m.common.amount}</Table.Th>
                    <Table.Th>{m.topups.reference}</Table.Th>
                    <Table.Th>{m.topups.proof}</Table.Th>
                    <Table.Th>{m.common.status}</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.items.map((t) => (
                    <Table.Tr key={t.id}>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(t.createdAt)}</Table.Td>
                      <Table.Td>
                        <TopupOwner t={t} />
                      </Table.Td>
                      <Table.Td>
                        {label(m.enums.topupMethod, t.method)}
                        {t.msisdn && (
                          <Text size="xs" c="dimmed">
                            {m.topups.msisdn}: {t.msisdn}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td ta="right">
                        <Money toea={t.amountToea} fw={600} />
                      </Table.Td>
                      <Table.Td ff="monospace">{t.referenceText || '—'}</Table.Td>
                      <Table.Td>
                        <Proof t={t} />
                      </Table.Td>
                      <Table.Td>
                        <Stack gap={2}>
                          <StatusBadge value={t.status} />
                          {t.payment && (
                            <Text size="xs" c="dimmed">
                              {m.topups.paymentStatus}: {t.payment.adapter} / {t.payment.status}
                            </Text>
                          )}
                          {t.rejectReason && (
                            <Text size="xs" c="dimmed">
                              {t.rejectReason}
                            </Text>
                          )}
                          {t.reviewedAt && (
                            <Text size="xs" c="dimmed">
                              {m.topups.reviewed} {formatDateTime(t.reviewedAt)}
                            </Text>
                          )}
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        {t.status === 'pending' && can('wallet.approve_topup') && (
                          <Group gap="xs" wrap="nowrap">
                            <Button size="xs" color="teal" onClick={() => setAction({ t, kind: 'approve' })}>
                              {m.topups.approve}
                            </Button>
                            <Button size="xs" color="red" variant="light" onClick={() => setAction({ t, kind: 'reject' })}>
                              {m.topups.reject}
                            </Button>
                          </Group>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
          <LoadMore hasNextPage={list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} fetchNextPage={list.fetchNextPage} />
        </QueryState>
      </Card>
      {action && (
        <ActionModal
          opened
          onClose={() => setAction(null)}
          title={fmt(action.kind === 'approve' ? m.topups.approveTitle : m.topups.rejectTitle, { amount: formatKina(action.t.amountToea) })}
          body={action.kind === 'approve' ? fmt(m.topups.approveBody, { amount: formatKina(action.t.amountToea), driver: action.t.customer?.name ?? action.t.customer?.phone ?? action.t.driver?.user.name ?? action.t.driver?.user.phone ?? '' }) : undefined}
          color={action.kind === 'approve' ? 'teal' : 'red'}
          confirmLabel={action.kind === 'approve' ? m.topups.approve : m.topups.reject}
          fields={action.kind === 'reject' ? [{ name: 'reason', label: m.common.reason, type: 'textarea', required: true, maxLength: 500 }] : []}
          successMessage={action.kind === 'approve' ? m.topups.approved : m.topups.rejected}
          onSubmit={async (v) => {
            if (action.kind === 'approve') await api.topups.approve(action.t.id);
            else await api.topups.reject(action.t.id, v.reason);
            await refresh();
          }}
        />
      )}
    </>
  );
}
