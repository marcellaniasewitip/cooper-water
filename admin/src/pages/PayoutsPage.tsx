import { Alert, Anchor, Badge, Button, Card, Group, SegmentedControl, Stack, Table, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Payout } from '@/api';
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

type PayoutAction = 'approve' | 'paid' | 'reject';

export default function PayoutsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState('requested,approved');
  const [action, setAction] = useState<{ p: Payout; a: PayoutAction } | null>(null);
  const query = { status: status === 'all' ? undefined : status };
  const list = useCursorList<Payout>(['payouts', query], (p) => api.payouts.list({ ...query, ...p }));
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['payouts'] }), qc.invalidateQueries({ queryKey: ['overview'] })]);

  const modal = (() => {
    if (!action) return null;
    const { p, a } = action;
    const amount = formatKina(p.amountToea);
    const driver = p.driver.user.name ?? p.driver.user.phone;
    const cfg = {
      approve: { title: fmt(m.payouts.approveTitle, { amount }), body: fmt(m.payouts.approveBody, { driver }), color: 'blue', label: m.payouts.approve, fields: [{ name: 'notes', label: m.common.notes, type: 'textarea' as const, maxLength: 500 }] },
      paid: {
        title: fmt(m.payouts.paidTitle, { amount }),
        body: (
          <Stack gap="xs">
            <Text size="sm">{fmt(m.payouts.paidBody, { destination: `${label(m.enums.payoutMethod, p.method)} ${p.destination}` })}</Text>
            {!p.deducted && (
              <Alert color="blue" variant="light">
                {m.payouts.paidNote}
              </Alert>
            )}
          </Stack>
        ),
        color: 'teal',
        label: m.payouts.markPaid,
        fields: [
          { name: 'externalRef', label: m.payouts.externalRef, required: true, maxLength: 100 },
          { name: 'notes', label: m.common.notes, type: 'textarea' as const, maxLength: 500 },
        ],
      },
      reject: { title: fmt(m.payouts.rejectTitle, { amount }), body: m.payouts.rejectBody, color: 'red', label: m.payouts.reject, fields: [{ name: 'notes', label: m.common.reason, type: 'textarea' as const, required: true, maxLength: 500 }] },
    }[a];
    return (
      <ActionModal
        opened
        onClose={() => setAction(null)}
        title={cfg.title}
        body={cfg.body}
        color={cfg.color}
        confirmLabel={cfg.label}
        fields={cfg.fields}
        successMessage={m.payouts.done}
        onSubmit={async (v) => {
          await api.payouts.act(p.id, a, { externalRef: v.externalRef || undefined, notes: v.notes || undefined });
          await refresh();
        }}
      />
    );
  })();

  return (
    <>
      <PageHeader title={m.payouts.title} subtitle={m.payouts.help} />
      <Card withBorder mb="md">
        <SegmentedControl
          value={status}
          onChange={setStatus}
          data={[
            { value: 'requested,approved', label: 'Open' },
            { value: 'requested', label: 'Requested' },
            { value: 'approved', label: 'Approved' },
            { value: 'paid', label: 'Paid' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'all', label: m.common.all },
          ]}
        />
      </Card>
      <Card withBorder>
        <QueryState isPending={list.isPending} error={list.error} refetch={list.refetch}>
          {list.items.length === 0 ? (
            <Empty />
          ) : (
            <Table.ScrollContainer minWidth={900}>
              <Table striped highlightOnHover fz="sm" data-testid="payouts-table">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{m.common.created}</Table.Th>
                    <Table.Th>{m.common.driver}</Table.Th>
                    <Table.Th ta="right">{m.common.amount}</Table.Th>
                    <Table.Th>{m.common.method}</Table.Th>
                    <Table.Th>{m.payouts.destination}</Table.Th>
                    <Table.Th>{m.common.status}</Table.Th>
                    <Table.Th>{m.payouts.wallet}</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.items.map((p) => (
                    <Table.Tr key={p.id}>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(p.createdAt)}</Table.Td>
                      <Table.Td>
                        <Anchor component={Link} to={`/drivers/${p.driverId}`} size="sm">
                          {p.driver.user.name ?? p.driver.user.phone}
                        </Anchor>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Money toea={p.amountToea} fw={600} />
                      </Table.Td>
                      <Table.Td>{label(m.enums.payoutMethod, p.method)}</Table.Td>
                      <Table.Td ff="monospace">{p.destination}</Table.Td>
                      <Table.Td>
                        <Stack gap={2}>
                          <StatusBadge value={p.status} />
                          {p.externalRef && (
                            <Text size="xs" c="dimmed">
                              {m.payouts.externalRef}: {p.externalRef}
                            </Text>
                          )}
                          {p.notes && (
                            <Text size="xs" c="dimmed">
                              {p.notes}
                            </Text>
                          )}
                          {p.processedAt && (
                            <Text size="xs" c="dimmed">
                              {m.payouts.processed} {formatDateTime(p.processedAt)}
                            </Text>
                          )}
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        <Stack gap={4}>
                          {p.status === 'rejected' ? (
                            <Text size="xs" c="dimmed">
                              —
                            </Text>
                          ) : p.deducted ? (
                            <Badge color="teal" variant="light" tt="none">
                              {m.payouts.deducted}
                            </Badge>
                          ) : (
                            <>
                              <Badge color="orange" variant="light" tt="none">
                                {m.payouts.notDeducted}
                              </Badge>
                              {p.walletBalanceToea != null && (
                                <Text size="xs" c="dimmed">
                                  {fmt(m.payouts.balance, { amount: formatKina(p.walletBalanceToea) })}
                                </Text>
                              )}
                              {can('wallet.adjust') && p.walletId && (
                                <Button size="compact-xs" variant="light" color="orange" onClick={() => navigate(deductLink(p))} data-testid="payout-deduct">
                                  {m.payouts.deduct}
                                </Button>
                              )}
                            </>
                          )}
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap" justify="flex-end">
                          {p.status === 'requested' && (
                            <Button size="xs" variant="light" onClick={() => setAction({ p, a: 'approve' })}>
                              {m.payouts.approve}
                            </Button>
                          )}
                          {(p.status === 'requested' || p.status === 'approved') && (
                            <>
                              <Button size="xs" color="teal" onClick={() => setAction({ p, a: 'paid' })}>
                                {m.payouts.markPaid}
                              </Button>
                              <Button size="xs" color="red" variant="subtle" onClick={() => setAction({ p, a: 'reject' })}>
                                {m.payouts.reject}
                              </Button>
                            </>
                          )}
                        </Group>
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
      {modal}
    </>
  );
}

/** Driver page with the wallet adjustment pre-filled to deduct this withdrawal (the admin confirms it there). */
function deductLink(p: Payout): string {
  const ref = p.externalRef ? ` · ref ${p.externalRef}` : '';
  const reason = fmt(m.payouts.deductReason, { method: label(m.enums.payoutMethod, p.method), destination: p.destination, ref });
  const q = new URLSearchParams({ deductPayout: p.id, amount: String(p.amountToea), reason });
  return `/drivers/${p.driverId}?${q.toString()}`;
}
