import { Alert, Badge, Button, Card, Group, Modal, NumberInput, SegmentedControl, Stack, Switch, Table, Text, TextInput } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage, type PromoCode } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Empty, QueryState } from '@/components/QueryState';
import { StatusBadge } from '@/components/StatusBadge';
import { fmt, m } from '@/i18n';
import { formatKina, parseKinaToToea, toeaToKinaInput } from '@/lib/money';
import { notifyError, notifySuccess } from '@/lib/notify';
import { formatDateTime } from '@/lib/time';

/** "10%" (capped at K…) or "K5.00". */
function discountLabel(p: Pick<PromoCode, 'discountType' | 'discountValue' | 'maxDiscountToea'>): string {
  if (p.discountType === 'flat') return formatKina(p.discountValue);
  return p.maxDiscountToea ? `${p.discountValue}% (max ${formatKina(p.maxDiscountToea)})` : `${p.discountValue}%`;
}

/** yyyy-mm-dd for <input type="date"> from an ISO timestamp. */
const toDateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
/** Start of day / end of day (local time) as ISO. */
const fromDateInput = (d: string, endOfDay: boolean) => (d ? new Date(`${d}T${endOfDay ? '23:59:59' : '00:00:00'}`).toISOString() : null);

function PromoForm({ promo, onClose }: { promo: PromoCode | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState(promo?.code ?? '');
  const [description, setDescription] = useState(promo?.description ?? '');
  const [type, setType] = useState<'percent' | 'flat'>(promo?.discountType ?? 'percent');
  const [percent, setPercent] = useState<number | string>(promo?.discountType === 'percent' ? promo.discountValue : 10);
  const [flat, setFlat] = useState(promo?.discountType === 'flat' ? toeaToKinaInput(promo.discountValue) : '');
  const [maxDiscount, setMaxDiscount] = useState(promo?.maxDiscountToea ? toeaToKinaInput(promo.maxDiscountToea) : '');
  const [minOrder, setMinOrder] = useState(promo?.minOrderToea ? toeaToKinaInput(promo.minOrderToea) : '');
  const [startsAt, setStartsAt] = useState(toDateInput(promo?.startsAt));
  const [expiresAt, setExpiresAt] = useState(toDateInput(promo?.expiresAt));
  const [maxUses, setMaxUses] = useState<number | string>(promo?.maxUses ?? '');
  const [perCustomer, setPerCustomer] = useState<number | string>(promo?.perCustomerLimit ?? 1);
  const [isPublic, setIsPublic] = useState(promo?.public ?? true);
  const [active, setActive] = useState(promo?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flatToea = parseKinaToToea(flat);
  const maxToea = maxDiscount ? parseKinaToToea(maxDiscount) : null;
  const minToea = minOrder ? parseKinaToToea(minOrder) : 0;
  const codeOk = /^[A-Za-z0-9_-]{3,30}$/.test(code.trim());
  const valueOk = type === 'percent' ? typeof percent === 'number' && percent >= 1 && percent <= 100 && Number.isInteger(percent) : flatToea !== null && flatToea >= 1;
  const valid =
    codeOk &&
    valueOk &&
    (!maxDiscount || (maxToea !== null && maxToea >= 1)) &&
    minToea !== null &&
    (maxUses === '' || (typeof maxUses === 'number' && maxUses >= 1)) &&
    typeof perCustomer === 'number' &&
    perCustomer >= 1;

  const save = async () => {
    if (!valid) return;
    const body = {
      description: description.trim(),
      discountType: type,
      discountValue: type === 'percent' ? (percent as number) : (flatToea as number),
      maxDiscountToea: type === 'percent' && maxToea ? maxToea : null,
      minOrderToea: minToea ?? 0,
      startsAt: fromDateInput(startsAt, false),
      expiresAt: fromDateInput(expiresAt, true),
      maxUses: maxUses === '' ? null : (maxUses as number),
      perCustomerLimit: perCustomer as number,
      public: isPublic,
      active,
    };
    setBusy(true);
    setError(null);
    try {
      if (promo) await api.promos.update(promo.id, body);
      else await api.promos.create({ ...body, code: code.trim() });
      notifySuccess(promo ? m.promos.updated : m.promos.created);
      await qc.invalidateQueries({ queryKey: ['promos'] });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened onClose={onClose} title={<Text fw={600}>{promo ? fmt(m.promos.editTitle, { code: promo.code }) : m.promos.new}</Text>} centered size="lg">
      <Stack>
        <TextInput
          label={m.promos.code}
          description={m.promos.codeHint}
          value={code}
          onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
          disabled={!!promo}
          withAsterisk
          maxLength={30}
          data-autofocus
          data-testid="promo-code"
        />
        <TextInput label={m.promos.description} value={description} onChange={(e) => setDescription(e.currentTarget.value)} maxLength={200} />
        <div>
          <Text size="sm" fw={500} mb={4}>
            {m.promos.type}
          </Text>
          <SegmentedControl
            value={type}
            onChange={(v) => setType(v as 'percent' | 'flat')}
            data={[
              { value: 'percent', label: m.promos.typePercent },
              { value: 'flat', label: m.promos.typeFlat },
            ]}
          />
        </div>
        {type === 'percent' ? (
          <Group grow>
            <NumberInput label={m.promos.percent} value={percent} onChange={setPercent} min={1} max={100} allowDecimal={false} suffix="%" withAsterisk />
            <TextInput label={m.promos.maxDiscount} leftSection="K" inputMode="decimal" value={maxDiscount} onChange={(e) => setMaxDiscount(e.currentTarget.value)} error={maxDiscount && maxToea === null ? m.common.invalidAmount : undefined} />
          </Group>
        ) : (
          <TextInput
            label={m.promos.flatAmount}
            leftSection="K"
            inputMode="decimal"
            value={flat}
            onChange={(e) => setFlat(e.currentTarget.value)}
            error={flat && flatToea === null ? m.common.invalidAmount : undefined}
            withAsterisk
          />
        )}
        <TextInput label={m.promos.minOrder} leftSection="K" inputMode="decimal" value={minOrder} onChange={(e) => setMinOrder(e.currentTarget.value)} error={minOrder && minToea === null ? m.common.invalidAmount : undefined} />
        <Group grow>
          <TextInput type="date" label={m.promos.startsAt} value={startsAt} onChange={(e) => setStartsAt(e.currentTarget.value)} />
          <TextInput type="date" label={m.promos.expiresAt} value={expiresAt} onChange={(e) => setExpiresAt(e.currentTarget.value)} />
        </Group>
        <Group grow>
          <NumberInput label={m.promos.maxUses} value={maxUses} onChange={setMaxUses} min={1} allowDecimal={false} />
          <NumberInput label={m.promos.perCustomer} value={perCustomer} onChange={setPerCustomer} min={1} max={100} allowDecimal={false} withAsterisk />
        </Group>
        <Switch label={m.promos.public} checked={isPublic} onChange={(e) => setIsPublic(e.currentTarget.checked)} />
        <Switch label={m.common.active} checked={active} onChange={(e) => setActive(e.currentTarget.checked)} />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {m.common.cancel}
          </Button>
          <Button onClick={save} loading={busy} disabled={!valid}>
            {m.common.save}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export default function PromosPage() {
  const { can } = useAuth();
  const editable = can('pricing.edit');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['promos'], queryFn: api.promos.list });
  const [editing, setEditing] = useState<PromoCode | 'new' | null>(null);

  const toggle = async (p: PromoCode, active: boolean) => {
    try {
      await api.promos.update(p.id, { active });
      await qc.invalidateQueries({ queryKey: ['promos'] });
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <>
      <PageHeader
        title={m.promos.title}
        subtitle={m.promos.subtitle}
        actions={
          editable && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing('new')}>
              {m.promos.new}
            </Button>
          )
        }
      />
      <Card withBorder>
        <QueryState isPending={q.isPending} error={q.error} refetch={q.refetch}>
          {!q.data?.length ? (
            <Empty />
          ) : (
            <Table.ScrollContainer minWidth={900}>
              <Table striped highlightOnHover fz="sm" data-testid="promos-table">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{m.promos.code}</Table.Th>
                    <Table.Th>{m.promos.description}</Table.Th>
                    <Table.Th>{m.promos.discount}</Table.Th>
                    <Table.Th ta="right">{m.promos.uses}</Table.Th>
                    <Table.Th>{m.promos.expiresAt}</Table.Th>
                    <Table.Th>{m.promos.publicShort}</Table.Th>
                    <Table.Th>{m.common.status}</Table.Th>
                    {editable && <Table.Th />}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {q.data.map((p) => (
                    <Table.Tr key={p.id}>
                      <Table.Td fw={600} ff="monospace">
                        {p.code}
                      </Table.Td>
                      <Table.Td>{p.description || '—'}</Table.Td>
                      <Table.Td>
                        {discountLabel(p)}
                        {p.minOrderToea > 0 && (
                          <Text size="xs" c="dimmed">
                            {m.promos.minOrder}: {formatKina(p.minOrderToea)}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td ta="right">
                        {p.uses}
                        {p.maxUses != null ? ` / ${p.maxUses}` : ''}
                      </Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{p.expiresAt ? formatDateTime(p.expiresAt) : m.promos.noExpiry}</Table.Td>
                      <Table.Td>
                        <Badge size="sm" variant="light" color={p.public ? 'teal' : 'gray'}>
                          {p.public ? m.promos.publicShort : m.promos.private}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        {editable ? (
                          <Switch size="sm" checked={p.active} onChange={(e) => toggle(p, e.currentTarget.checked)} aria-label={m.common.active} />
                        ) : (
                          <StatusBadge value={p.active ? 'active' : 'disabled'} />
                        )}
                      </Table.Td>
                      {editable && (
                        <Table.Td>
                          <Button size="xs" variant="light" onClick={() => setEditing(p)}>
                            {m.common.edit}
                          </Button>
                        </Table.Td>
                      )}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </QueryState>
      </Card>
      {editing && <PromoForm promo={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
