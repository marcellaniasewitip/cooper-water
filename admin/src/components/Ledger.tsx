import { Alert, Button, Group, Modal, SegmentedControl, Stack, Table, Text, TextInput, Textarea } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, errorMessage, type LedgerEntry } from '@/api';
import { fmt, label, m } from '@/i18n';
import { formatKina, parseKinaToToea } from '@/lib/money';
import { formatDateTime } from '@/lib/time';
import { IdempotencyKeeper } from '@/lib/idempotency';
import { notifyError, notifySuccess } from '@/lib/notify';
import { LoadMore } from './CursorList';
import { useCursorList } from './useCursorList';
import { Money } from './Money';
import { Empty, QueryState } from './QueryState';

export function LedgerTable({ walletId }: { walletId: string }) {
  const list = useCursorList<LedgerEntry>(['ledger', walletId], (q) => api.wallets.entries(walletId, q));
  return (
    <QueryState isPending={list.isPending} error={list.error} refetch={list.refetch}>
      {list.items.length === 0 ? (
        <Empty />
      ) : (
        <Table.ScrollContainer minWidth={700}>
          <Table striped highlightOnHover fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{m.common.created}</Table.Th>
                <Table.Th>{m.common.type}</Table.Th>
                <Table.Th>{m.common.description}</Table.Th>
                <Table.Th ta="right">{m.common.amount}</Table.Th>
                <Table.Th ta="right">{m.wallet.balanceAfter}</Table.Th>
                <Table.Th>{m.wallet.createdBy}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.items.map((e) => (
                <Table.Tr key={e.id}>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(e.createdAt)}</Table.Td>
                  <Table.Td>{label(m.enums.ledgerType, e.type)}</Table.Td>
                  <Table.Td>
                    <Text size="sm">{e.description ?? '—'}</Text>
                    <Text size="xs" c="dimmed">
                      {e.referenceType}:{e.referenceId.slice(0, 8)}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Money toea={e.amountToea} signed colored />
                  </Table.Td>
                  <Table.Td ta="right">
                    <Money toea={e.balanceAfter} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {e.createdBy}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <LoadMore hasNextPage={list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} fetchNextPage={list.fetchNextPage} />
    </QueryState>
  );
}

/**
 * Manual wallet adjustment (needs wallet.adjust). Two steps: enter, then confirm.
 * One Idempotency-Key per action; retrying the same amount + reason reuses it.
 */
export function WalletAdjustModal({
  walletId,
  opened,
  onClose,
  invalidate = [],
  initialAmount = '',
  initialReason = '',
  payoutId,
  note,
}: {
  walletId: string;
  opened: boolean;
  onClose: () => void;
  invalidate?: string[][];
  initialAmount?: string;
  initialReason?: string;
  /** Deduct this withdrawal: links the entry to the payout so it can only be deducted once. */
  payoutId?: string;
  note?: string;
}) {
  const qc = useQueryClient();
  const keeper = useMemo(() => new IdempotencyKeeper(), []);
  // Prefilled negative amounts (e.g. deducting a withdrawal) open in Deduct mode.
  const [mode, setMode] = useState<'credit' | 'debit'>(initialAmount.trim().startsWith('-') ? 'debit' : 'credit');
  const [amount, setAmount] = useState(initialAmount.trim().replace(/^-/, ''));
  const [reason, setReason] = useState(initialReason);
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abs = parseKinaToToea(amount);
  const toea = abs === null ? null : mode === 'debit' ? -abs : abs;
  const amountError = amount && toea === null ? m.common.invalidAmount : toea === 0 ? m.wallet.zero : null;
  const reasonError = reason.trim().length > 0 && reason.trim().length < 3 ? m.wallet.reasonMin : null;
  const valid = toea !== null && toea !== 0 && reason.trim().length >= 3 && reason.trim().length <= 300;

  const close = () => {
    if (busy) return;
    setAmount('');
    setReason('');
    setMode('credit');
    setStep('edit');
    setError(null);
    keeper.reset();
    onClose();
  };

  const submit = async () => {
    if (!valid || toea === null) return;
    const body = { amountToea: toea, reason: reason.trim(), ...(payoutId ? { payoutId } : {}) };
    setBusy(true);
    setError(null);
    try {
      await api.wallets.adjust(walletId, body, keeper.keyFor({ walletId, ...body }));
      notifySuccess(m.wallet.adjusted);
      keeper.reset();
      await Promise.all([qc.invalidateQueries({ queryKey: ['ledger', walletId] }), ...invalidate.map((k) => qc.invalidateQueries({ queryKey: k }))]);
      setBusy(false);
      close();
    } catch (err) {
      setError(errorMessage(err));
      notifyError(err);
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={close} title={<Text fw={600}>{m.wallet.adjustTitle}</Text>} centered size="lg">
      <Stack>
        <Text size="sm">{m.wallet.adjustBody}</Text>
        {note && (
          <Alert color="blue" variant="light">
            {note}
          </Alert>
        )}
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v as 'credit' | 'debit')}
          disabled={step === 'confirm' || !!payoutId}
          data={[
            { value: 'credit', label: m.wallet.topUp },
            { value: 'debit', label: m.wallet.deduct },
          ]}
          color={mode === 'debit' ? 'red' : 'teal'}
          data-testid="wallet-adjust-mode"
        />
        <TextInput
          label={m.wallet.amount}
          leftSection="K"
          inputMode="decimal"
          placeholder="25.00"
          value={amount}
          disabled={step === 'confirm'}
          onChange={(e) => setAmount(e.currentTarget.value)}
          error={amountError}
          withAsterisk
          data-autofocus
        />
        <Textarea
          label={m.common.reason}
          placeholder={m.wallet.reasonPlaceholder}
          value={reason}
          disabled={step === 'confirm'}
          onChange={(e) => setReason(e.currentTarget.value)}
          error={reasonError}
          maxLength={300}
          autosize
          minRows={2}
          withAsterisk
        />
        {step === 'confirm' && toea !== null && (
          <Alert color={toea < 0 ? 'red' : 'teal'} variant="light">
            {fmt(toea < 0 ? m.wallet.deductConfirm : m.wallet.topUpConfirm, { amount: formatKina(Math.abs(toea)) })}
          </Alert>
        )}
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={step === 'confirm' ? () => setStep('edit') : close} disabled={busy}>
            {step === 'confirm' ? m.common.edit : m.common.cancel}
          </Button>
          {step === 'edit' ? (
            <Button disabled={!valid} onClick={() => setStep('confirm')}>
              {m.common.confirm}
            </Button>
          ) : (
            <Button color={toea !== null && toea < 0 ? 'red' : 'teal'} loading={busy} onClick={submit}>
              {toea !== null && toea < 0 ? m.wallet.deduct : m.wallet.topUp}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
