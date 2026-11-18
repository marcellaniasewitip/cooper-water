import { Alert, Button, Group, Modal, SegmentedControl, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '@/api';
import { fmt, label, m } from '@/i18n';
import { formatKina, parseKinaToToea } from '@/lib/money';
import { IdempotencyKeeper } from '@/lib/idempotency';
import { notifyError, notifySuccess } from '@/lib/notify';

type OwnerType = 'driver' | 'customer';
type Method = 'cash' | 'bank_transfer' | 'cellmoney';

/** Search box value that settles after typing stops (keeps the list API calls down). */
function useDebounced(value: string, ms = 300): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Top up a driver's or customer's wallet directly: pick the person, type the amount received.
 * Shows in Wallet top-ups as an approved top-up. Two steps (enter → confirm); one Idempotency-Key per action.
 */
export function AdminTopupModal({ opened, onClose, onDone }: { opened: boolean; onClose: () => void; onDone: () => Promise<unknown> | void }) {
  const qc = useQueryClient();
  const keeper = useMemo(() => new IdempotencyKeeper(), []);
  const [ownerType, setOwnerType] = useState<OwnerType>('driver');
  const [search, setSearch] = useState('');
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [ownerLabel, setOwnerLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>('cash');
  const [reference, setReference] = useState('');
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = useDebounced(search.trim());
  const people = useQuery({
    queryKey: ['topup-owner-search', ownerType, q],
    enabled: opened,
    queryFn: async () => {
      if (ownerType === 'driver') {
        const r = await api.drivers.list({ q: q || undefined, limit: 20 });
        return r.items.map((d) => ({ value: d.id, label: `${d.name ?? '—'} · ${d.phone} · ${formatKina(d.balanceToea)}` }));
      }
      const r = await api.customers.list({ q: q || undefined, limit: 20 });
      return r.items.map((c) => ({ value: c.id, label: `${c.name ?? '—'} · ${c.phone}` }));
    },
  });
  // Keep the chosen person in the list even when a new search no longer matches them.
  const options = useMemo(() => {
    const list = people.data ?? [];
    return ownerId && !list.some((o) => o.value === ownerId) ? [{ value: ownerId, label: ownerLabel }, ...list] : list;
  }, [people.data, ownerId, ownerLabel]);

  const toea = parseKinaToToea(amount);
  const amountError = amount.trim() && (toea === null || toea <= 0) ? m.common.invalidAmount : toea !== null && toea > 10_000_000 ? m.topups.adminMax : null;
  const valid = !!ownerId && toea !== null && toea > 0 && toea <= 10_000_000;

  const reset = () => {
    setOwnerType('driver');
    setSearch('');
    setOwnerId(null);
    setOwnerLabel('');
    setAmount('');
    setMethod('cash');
    setReference('');
    setStep('edit');
    setError(null);
    keeper.reset();
  };
  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async () => {
    if (!valid || !ownerId || toea === null) return;
    const body = { ownerType, ownerId, amountToea: toea, method, ...(reference.trim() ? { referenceText: reference.trim() } : {}) };
    setBusy(true);
    setError(null);
    try {
      await api.topups.create(body, keeper.keyFor(body));
      notifySuccess(fmt(m.topups.adminDone, { amount: formatKina(toea), who: ownerLabel.split(' · ')[0] }));
      await Promise.all([onDone(), qc.invalidateQueries({ queryKey: ['ledger'] }), qc.invalidateQueries({ queryKey: [ownerType === 'driver' ? 'driver' : 'customer', ownerId] })]);
      setBusy(false);
      reset();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      notifyError(err);
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={close} title={<Text fw={600}>{m.topups.adminTitle}</Text>} centered size="lg">
      <Stack>
        <Text size="sm">{m.topups.adminBody}</Text>
        <SegmentedControl
          value={ownerType}
          onChange={(v) => {
            setOwnerType(v as OwnerType);
            setOwnerId(null);
            setOwnerLabel('');
            setSearch('');
          }}
          disabled={step === 'confirm'}
          data={[
            { value: 'driver', label: m.topups.ownerDriver },
            { value: 'customer', label: m.topups.ownerCustomer },
          ]}
          data-testid="admin-topup-owner-type"
        />
        <Select
          label={ownerType === 'driver' ? m.topups.adminPickDriver : m.topups.adminPickCustomer}
          placeholder={m.topups.adminSearch}
          searchable
          clearable
          data={options}
          value={ownerId}
          onChange={(v, o) => {
            setOwnerId(v);
            setOwnerLabel(o?.label ?? '');
          }}
          searchValue={search}
          onSearchChange={setSearch}
          filter={({ options: opts }) => opts}
          nothingFoundMessage={people.isFetching ? '…' : m.topups.adminNoMatch}
          disabled={step === 'confirm'}
          data-testid="admin-topup-owner"
        />
        <TextInput
          label={m.wallet.amount}
          leftSection="K"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.currentTarget.value)}
          error={amountError}
          disabled={step === 'confirm'}
          data-testid="admin-topup-amount"
        />
        <Select
          label={m.topups.method}
          data={(['cash', 'bank_transfer', 'cellmoney'] as Method[]).map((v) => ({ value: v, label: label(m.enums.topupMethod, v) }))}
          value={method}
          onChange={(v) => v && setMethod(v as Method)}
          allowDeselect={false}
          disabled={step === 'confirm'}
        />
        <TextInput
          label={m.topups.reference}
          description={m.topups.adminReferenceHelp}
          maxLength={100}
          value={reference}
          onChange={(e) => setReference(e.currentTarget.value)}
          disabled={step === 'confirm'}
        />
        {step === 'confirm' && toea !== null && (
          <Alert color="teal" variant="light" data-testid="admin-topup-confirm">
            {fmt(m.topups.adminConfirm, { amount: formatKina(toea), who: ownerLabel })}
          </Alert>
        )}
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          {step === 'confirm' ? (
            <>
              <Button variant="default" onClick={() => setStep('edit')} disabled={busy}>
                {m.common.edit}
              </Button>
              <Button color="teal" onClick={submit} loading={busy} data-testid="admin-topup-submit">
                {m.topups.adminCredit}
              </Button>
            </>
          ) : (
            <>
              <Button variant="default" onClick={close}>
                {m.common.cancel}
              </Button>
              <Button color="teal" onClick={() => setStep('confirm')} disabled={!valid} data-testid="admin-topup-next">
                {m.topups.adminReview}
              </Button>
            </>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
