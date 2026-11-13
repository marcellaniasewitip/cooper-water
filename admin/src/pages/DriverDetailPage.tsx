import { Alert, Anchor, Badge, Button, Card, Grid, Group, Image, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconCheck, IconFileTypePdf, IconX } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, type DriverDetail, type DriverDocument } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { ActionModal } from '@/components/ActionModal';
import { InfoGrid } from '@/components/InfoGrid';
import { LedgerTable, WalletAdjustModal } from '@/components/Ledger';
import { Money } from '@/components/Money';
import { PageHeader } from '@/components/PageHeader';
import { Empty, QueryState } from '@/components/QueryState';
import { OrderStatusBadge, StatusBadge } from '@/components/StatusBadge';
import { fmt, label, m } from '@/i18n';
import { formatDateTime, timeAgo } from '@/lib/time';
import { formatKina, toeaToKinaInput } from '@/lib/money';

type DriverAction = 'approve' | 'reject' | 'suspend' | 'reinstate';

function isPdf(doc: Pick<DriverDocument, 'fileKey'>): boolean {
  return doc.fileKey.toLowerCase().endsWith('.pdf');
}

function availableActions(d: DriverDetail): DriverAction[] {
  switch (d.status) {
    case 'pending_docs':
    case 'pending_approval':
      return ['approve', 'reject'];
    case 'rejected':
      return ['approve'];
    case 'approved':
      return ['suspend'];
    case 'suspended':
      return ['reinstate'];
    default:
      return [];
  }
}

function DocumentCard({ doc, canReview, onReview }: { doc: DriverDocument; canReview: boolean; onReview: (doc: DriverDocument, status: 'approved' | 'rejected') => void }) {
  const typeLabel = label(m.enums.documentType, doc.type);
  return (
    <Card withBorder data-testid="driver-document">
      <Group justify="space-between" mb="xs">
        <Text fw={600}>{typeLabel}</Text>
        <StatusBadge value={doc.status} />
      </Group>
      {doc.url ? (
        isPdf(doc) ? (
          <Button component="a" href={doc.url} target="_blank" rel="noreferrer" variant="light" leftSection={<IconFileTypePdf size={16} />} fullWidth>
            {m.drivers.openPdf}
          </Button>
        ) : (
          <Anchor href={doc.url} target="_blank" rel="noreferrer">
            <Image src={doc.url} alt={typeLabel} h={160} fit="contain" bg="gray.1" radius="sm" fallbackSrc="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='120'><rect width='100%' height='100%' fill='%23f1f3f5'/><text x='50%' y='50%' text-anchor='middle' fill='%23868e96' font-family='sans-serif' font-size='12'>Preview unavailable</text></svg>" />
          </Anchor>
        )
      ) : (
        <Text size="sm" c="dimmed">
          {m.drivers.noPreview}
        </Text>
      )}
      <Text size="xs" c="dimmed" mt="xs">
        {m.drivers.uploaded} {formatDateTime(doc.createdAt)}
        {doc.reviewedAt ? ` · ${m.common.updated} ${formatDateTime(doc.reviewedAt)}` : ''}
      </Text>
      {doc.notes && (
        <Text size="sm" mt={4}>
          {m.common.notes}: {doc.notes}
        </Text>
      )}
      {canReview && (
        <Group mt="sm" grow>
          <Button size="xs" color="teal" variant={doc.status === 'approved' ? 'filled' : 'light'} leftSection={<IconCheck size={14} />} onClick={() => onReview(doc, 'approved')} disabled={doc.status === 'approved'}>
            {m.drivers.approveDoc}
          </Button>
          <Button size="xs" color="red" variant={doc.status === 'rejected' ? 'filled' : 'light'} leftSection={<IconX size={14} />} onClick={() => onReview(doc, 'rejected')} disabled={doc.status === 'rejected'}>
            {m.drivers.rejectDoc}
          </Button>
        </Group>
      )}
    </Card>
  );
}

export default function DriverDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['driver', id], queryFn: () => api.drivers.get(id) });
  const wallet = useQuery({ queryKey: ['driver-wallet', id], queryFn: () => api.drivers.wallet(id), enabled: can('wallet.view') });
  const [action, setAction] = useState<DriverAction | null>(null);
  const [review, setReview] = useState<{ doc: DriverDocument; status: 'approved' | 'rejected' } | null>(null);
  const [adjust, setAdjust] = useState(false);
  // From the payouts queue: "Deduct from wallet" opens the adjustment pre-filled for that withdrawal.
  const [params, setParams] = useSearchParams();
  const deductPayout = params.get('deductPayout');
  const deductAmount = Number(params.get('amount') ?? 0);
  const deductReason = params.get('reason') ?? '';
  const closeDeduct = () => {
    params.delete('deductPayout');
    params.delete('amount');
    params.delete('reason');
    setParams(params, { replace: true });
  };
  const d = q.data;

  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ['driver', id] }), qc.invalidateQueries({ queryKey: ['drivers'] }), qc.invalidateQueries({ queryKey: ['overview'] }), qc.invalidateQueries({ queryKey: ['fleet'] })]);

  // Latest document per type first; older submissions follow.
  const docs = d ? [...d.documents].sort((a, b) => a.type.localeCompare(b.type) || b.createdAt.localeCompare(a.createdAt)) : [];

  const actionMeta: Record<DriverAction, { title: string; body?: string; color: string; reason: boolean; label: string }> = {
    approve: { title: m.drivers.approveTitle, body: m.drivers.approveBody, color: 'teal', reason: false, label: m.drivers.approve },
    reject: { title: m.drivers.rejectTitle, color: 'red', reason: true, label: m.drivers.reject },
    suspend: { title: m.drivers.suspendTitle, body: m.drivers.suspendBody, color: 'orange', reason: true, label: m.drivers.suspend },
    reinstate: { title: m.drivers.reinstateTitle, color: 'teal', reason: false, label: m.drivers.reinstate },
  };

  return (
    <QueryState isPending={q.isPending} error={q.error} refetch={q.refetch}>
      {d && (
        <>
          <PageHeader
            title={
              <Group gap="sm">
                {d.name ?? d.phone}
                <StatusBadge value={d.status} labels={m.enums.driverStatus} />
                <Badge variant="dot" color={d.online ? 'teal' : 'gray'}>
                  {d.online ? m.drivers.online : m.drivers.offline}
                </Badge>
              </Group>
            }
            subtitle={`${d.phone} · ${m.drivers.lastSeen} ${timeAgo(d.lastSeenAt)}`}
            actions={
              <>
                {can('orders.view') && (
                  <Button component={Link} to={`/orders?driverId=${d.id}`} variant="default">
                    {m.customers.viewOrders}
                  </Button>
                )}
                {can('drivers.approve') &&
                  availableActions(d).map((a) => (
                    <Button key={a} color={actionMeta[a].color} variant="light" onClick={() => setAction(a)} data-testid={`driver-${a}`}>
                      {actionMeta[a].label}
                    </Button>
                  ))}
              </>
            }
          />
          {d.rejectReason && (
            <Alert color="orange" mb="md" title={m.drivers.reasonOnFile}>
              {d.rejectReason}
            </Alert>
          )}
          <Grid>
            <Grid.Col span={{ base: 12, lg: 8 }}>
              <Stack>
                <Card withBorder>
                  <InfoGrid
                    items={[
                      [m.common.phone, d.phone],
                      [m.common.created, formatDateTime(d.createdAt)],
                      [m.drivers.rating, d.ratingCount ? `★ ${d.ratingAvg.toFixed(2)} (${d.ratingCount})` : '—'],
                      [m.common.status, <StatusBadge key="a" value={d.accountStatus} />],
                      [m.drivers.lastSeen, formatDateTime(d.lastSeenAt)],
                      ['GPS', d.location?.lng != null ? `${d.location.lat.toFixed(5)}, ${d.location.lng.toFixed(5)}` : '—'],
                    ]}
                  />
                </Card>
                <Card withBorder>
                  <Title order={5} mb="sm">
                    {m.drivers.documents}
                  </Title>
                  {docs.length === 0 ? (
                    <Empty>{m.drivers.noDocuments}</Empty>
                  ) : (
                    <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }}>
                      {docs.map((doc) => (
                        <DocumentCard key={doc.id} doc={doc} canReview={can('drivers.approve')} onReview={(dd, status) => setReview({ doc: dd, status })} />
                      ))}
                    </SimpleGrid>
                  )}
                </Card>
                {can('wallet.view') && (
                  <Card withBorder>
                    <Group justify="space-between" mb="sm">
                      <Title order={5}>{m.drivers.ledger}</Title>
                      {can('wallet.adjust') && (
                        <Button size="xs" variant="light" onClick={() => setAdjust(true)}>
                          {m.drivers.adjust}
                        </Button>
                      )}
                    </Group>
                    <LedgerTable walletId={d.wallet.id} />
                  </Card>
                )}
              </Stack>
            </Grid.Col>
            <Grid.Col span={{ base: 12, lg: 4 }}>
              <Stack>
                {can('wallet.view') && (
                  <Card withBorder data-testid="driver-wallet">
                    <Title order={5} mb="xs">
                      {m.drivers.wallet}
                    </Title>
                    <Money toea={wallet.data?.balanceToea ?? d.wallet.balanceToea} fz={28} fw={700} />
                    {wallet.data && (
                      <Stack gap={4} mt="sm">
                        {wallet.data.blocked && <Badge color="red">{m.drivers.blocked}</Badge>}
                        <Group justify="space-between">
                          <Text size="sm">{m.drivers.minBalance}</Text>
                          <Money toea={wallet.data.minBalanceToea} size="sm" />
                        </Group>
                        {wallet.data.shortfallToea > 0 && (
                          <Group justify="space-between">
                            <Text size="sm">{m.drivers.shortfall}</Text>
                            <Money toea={wallet.data.shortfallToea} size="sm" c="red" />
                          </Group>
                        )}
                        <Group justify="space-between">
                          <Text size="sm">{m.drivers.withdrawable}</Text>
                          <Money toea={wallet.data.withdrawableToea} size="sm" />
                        </Group>
                        <Group justify="space-between">
                          <Text size="sm">{m.drivers.pendingTopups}</Text>
                          <Text size="sm">
                            {wallet.data.pendingTopups.count} · <Money toea={wallet.data.pendingTopups.amountToea} size="sm" />
                          </Text>
                        </Group>
                      </Stack>
                    )}
                  </Card>
                )}
                <Card withBorder>
                  <Title order={5} mb="xs">
                    {m.drivers.trucks}
                  </Title>
                  {d.trucks.length === 0 ? (
                    <Empty />
                  ) : (
                    d.trucks.map((t) => (
                      <Stack key={t.id} gap={4}>
                        <Group justify="space-between">
                          <Text fw={600} ff="monospace">
                            {t.plate}
                          </Text>
                          <StatusBadge value={t.active ? 'active' : 'disabled'} />
                        </Group>
                        <Text size="sm">{t.capacityLitres.toLocaleString('en')} L</Text>
                        {t.photoUrl && <Image src={t.photoUrl} alt={t.plate} h={140} fit="contain" radius="sm" />}
                      </Stack>
                    ))
                  )}
                </Card>
                <Card withBorder>
                  <Title order={5} mb="xs">
                    {m.drivers.orderCounts}
                  </Title>
                  {Object.keys(d.orderCounts).length === 0 ? (
                    <Empty />
                  ) : (
                    <Group gap="sm">
                      {Object.entries(d.orderCounts).map(([s, n]) => (
                        <Group key={s} gap={4}>
                          <OrderStatusBadge status={s} /> <Text fw={600}>{n}</Text>
                        </Group>
                      ))}
                    </Group>
                  )}
                </Card>
              </Stack>
            </Grid.Col>
          </Grid>

          {action && (
            <ActionModal
              opened
              onClose={() => setAction(null)}
              title={fmt(actionMeta[action].title, { name: d.name ?? d.phone })}
              body={actionMeta[action].body}
              color={actionMeta[action].color}
              confirmLabel={actionMeta[action].label}
              fields={actionMeta[action].reason ? [{ name: 'reason', label: m.common.reason, type: 'textarea', required: true, maxLength: 500 }] : []}
              successMessage={m.drivers.statusChanged}
              onSubmit={async (v) => {
                await api.drivers.setStatus(d.id, action, v.reason);
                await refresh();
              }}
            />
          )}
          {review && (
            <ActionModal
              opened
              onClose={() => setReview(null)}
              title={fmt(review.status === 'approved' ? m.drivers.docApproveTitle : m.drivers.docRejectTitle, { type: label(m.enums.documentType, review.doc.type) })}
              color={review.status === 'approved' ? 'teal' : 'red'}
              confirmLabel={review.status === 'approved' ? m.drivers.approveDoc : m.drivers.rejectDoc}
              fields={[
                {
                  name: 'notes',
                  label: review.status === 'approved' ? m.drivers.docApproveNotes : m.common.notes,
                  description: review.status === 'rejected' ? m.drivers.docNotesRequired : undefined,
                  type: 'textarea',
                  required: review.status === 'rejected',
                  maxLength: 500,
                },
              ]}
              successMessage={m.drivers.docReviewed}
              onSubmit={async (v) => {
                await api.drivers.reviewDocument(review.doc.id, { status: review.status, notes: v.notes || undefined });
                await refresh();
              }}
            />
          )}
          {deductPayout && can('wallet.adjust') && Number.isSafeInteger(deductAmount) && deductAmount > 0 && (
            <WalletAdjustModal
              walletId={d.wallet.id}
              opened
              onClose={closeDeduct}
              payoutId={deductPayout}
              initialAmount={toeaToKinaInput(-deductAmount)}
              initialReason={deductReason}
              note={fmt(m.payouts.deductHint, { amount: formatKina(deductAmount), driver: d.name ?? d.phone })}
              invalidate={[['driver', id], ['driver-wallet', id], ['drivers'], ['payouts']]}
            />
          )}
          {adjust && (
            <WalletAdjustModal
              walletId={d.wallet.id}
              opened
              onClose={() => setAdjust(false)}
              invalidate={[
                ['driver', id],
                ['driver-wallet', id],
                ['drivers'],
              ]}
            />
          )}
        </>
      )}
    </QueryState>
  );
}
