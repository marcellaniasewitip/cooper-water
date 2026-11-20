import { ActionIcon, Alert, Badge, Button, Card, Grid, Group, NavLink, SimpleGrid, Stack, Switch, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { IconBuilding, IconCash, IconDownload, IconPlus, IconTrash, IconUserPlus } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorMessage, type CompanyDetail, type CompanyInput, type CompanyMonth } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { QueryState } from '@/components/QueryState';
import { fmt, m } from '@/i18n';
import { filenameFromDisposition, saveBlob } from '@/lib/download';
import { formatKina, parseKinaToToea, toeaToKinaInput } from '@/lib/money';
import { notifyError, notifySuccess } from '@/lib/notify';
import { formatDateTime } from '@/lib/time';

interface Form {
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  creditLimit: string;
  active: boolean;
}

const EMPTY: Form = { name: '', contactName: '', contactEmail: '', contactPhone: '', creditLimit: '0', active: true };

const toForm = (c: CompanyDetail): Form => ({
  name: c.name,
  contactName: c.contactName,
  contactEmail: c.contactEmail,
  contactPhone: c.contactPhone,
  creditLimit: toeaToKinaInput(c.creditLimitToea),
  active: c.active,
});

function monthLabel(month: string): string {
  const [y, mo] = month.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-PG', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function MonthRow({ s, onCsv, busy }: { s: CompanyMonth & { emailedTo?: string | null }; onCsv: () => void; busy: boolean }) {
  return (
    <Table.Tr>
      <Table.Td>{monthLabel(s.month)}</Table.Td>
      <Table.Td>{s.orderCount}</Table.Td>
      <Table.Td>{s.litres.toLocaleString('en-US')} L</Table.Td>
      <Table.Td>{formatKina(s.chargedToea)}</Table.Td>
      <Table.Td>{formatKina(s.paymentsToea)}</Table.Td>
      <Table.Td fw={600} c={s.closingBalanceToea < 0 ? 'red' : undefined}>
        {formatKina(s.closingBalanceToea)}
      </Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap">
          {s.emailedTo && (
            <Tooltip label={fmt(m.companies.emailed, { email: s.emailedTo })}>
              <Badge size="xs" variant="light">
                {m.companies.sent}
              </Badge>
            </Tooltip>
          )}
          <Tooltip label={m.companies.csv}>
            <ActionIcon variant="subtle" onClick={onCsv} loading={busy} aria-label={m.companies.csv}>
              <IconDownload size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

/**
 * Corporate accounts: a company's employees order "on account"; each order is debited to the company's balance
 * (up to its credit limit), payments are recorded here, and a statement with the month's totals is made
 * automatically (and emailed to the contact) after each month ends.
 */
export default function CompaniesPage() {
  const { can } = useAuth();
  const editable = can('wallet.adjust');
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['companies'], queryFn: api.companies.list });
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const detail = useQuery({ queryKey: ['company', selected], queryFn: () => api.companies.get(selected as string), enabled: !!selected && selected !== 'new' });
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payRef, setPayRef] = useState('');
  const [payKey, setPayKey] = useState(() => crypto.randomUUID());
  const [csvBusy, setCsvBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!selected && list.data && list.data.length > 0) setSelected(list.data[0].id);
  }, [list.data, selected]);
  useEffect(() => {
    if (selected === 'new') setForm(EMPTY);
    else if (detail.data) setForm(toForm(detail.data));
    setError(null);
  }, [selected, detail.data]);

  const refresh = async (id?: string) => {
    await qc.invalidateQueries({ queryKey: ['companies'] });
    if (id) await qc.invalidateQueries({ queryKey: ['company', id] });
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const limit = parseKinaToToea(form.creditLimit);
      if (limit === null || limit < 0) throw new Error(m.common.invalidAmount);
      const body: CompanyInput = {
        name: form.name.trim(),
        contactName: form.contactName.trim(),
        contactEmail: form.contactEmail.trim(),
        contactPhone: form.contactPhone.trim(),
        creditLimitToea: limit,
        active: form.active,
      };
      if (selected === 'new') {
        const c = await api.companies.create(body);
        notifySuccess(m.companies.created);
        await refresh();
        setSelected(c.id);
      } else if (selected) {
        await api.companies.update(selected, body);
        notifySuccess(m.companies.updated);
        await refresh(selected);
      }
    });

  const addEmployee = () =>
    run(async () => {
      if (!selected || selected === 'new' || !phone.trim()) return;
      await api.companies.addEmployee(selected, phone.trim());
      setPhone('');
      notifySuccess(m.companies.employeeAdded);
      await refresh(selected);
    });

  const removeEmployee = (userId: string) =>
    run(async () => {
      if (!selected || selected === 'new') return;
      await api.companies.removeEmployee(selected, userId);
      await refresh(selected);
    });

  const recordPayment = () =>
    run(async () => {
      if (!selected || selected === 'new') return;
      const toea = parseKinaToToea(payAmount);
      if (!toea || toea <= 0) throw new Error(m.common.invalidAmount);
      await api.companies.recordPayment(selected, { amountToea: toea, reference: payRef.trim() || undefined }, payKey);
      setPayAmount('');
      setPayRef('');
      setPayKey(crypto.randomUUID());
      notifySuccess(fmt(m.companies.paymentRecorded, { amount: formatKina(toea) }));
      await refresh(selected);
    });

  const downloadCsv = async (month: string) => {
    if (!selected || selected === 'new') return;
    setCsvBusy(month);
    try {
      const res = await api.companies.monthCsv(selected, month);
      const name = (detail.data?.name ?? 'company').replace(/[^\w-]+/g, '-').toLowerCase();
      saveBlob(await res.blob(), filenameFromDisposition(null, `${name}-${month}.csv`));
    } catch (err) {
      notifyError(err);
    } finally {
      setCsvBusy(null);
    }
  };

  const d = selected !== 'new' ? detail.data : undefined;

  return (
    <>
      <PageHeader
        title={m.companies.title}
        subtitle={m.companies.subtitle}
        actions={
          editable && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setSelected('new')}>
              {m.companies.add}
            </Button>
          )
        }
      />
      <QueryState isPending={list.isPending} error={list.error} refetch={list.refetch}>
        <Grid>
          <Grid.Col span={{ base: 12, md: 3 }}>
            <Card withBorder p="xs">
              {(list.data ?? []).length === 0 && (
                <Text c="dimmed" size="sm" p="sm">
                  {m.companies.none}
                </Text>
              )}
              {(list.data ?? []).map((c) => (
                <NavLink
                  key={c.id}
                  active={selected === c.id}
                  label={c.name}
                  description={c.owedToea > 0 ? fmt(m.companies.owes, { amount: formatKina(c.owedToea) }) : m.companies.nothingOwed}
                  leftSection={<IconBuilding size={16} />}
                  rightSection={!c.active && <Badge size="xs" color="gray">{m.companies.off}</Badge>}
                  onClick={() => setSelected(c.id)}
                />
              ))}
            </Card>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 9 }}>
            {!selected ? (
              <Card withBorder>
                <Text c="dimmed">{m.companies.pick}</Text>
              </Card>
            ) : (
              <Stack>
                {d && (
                  <SimpleGrid cols={{ base: 2, sm: 4 }}>
                    <Card withBorder>
                      <Text size="xs" c="dimmed">{m.companies.owed}</Text>
                      <Title order={3} c={d.owedToea > 0 ? 'red' : undefined}>{formatKina(d.owedToea)}</Title>
                    </Card>
                    <Card withBorder>
                      <Text size="xs" c="dimmed">{m.companies.available}</Text>
                      <Title order={3}>{formatKina(Math.max(0, d.availableToea))}</Title>
                    </Card>
                    <Card withBorder>
                      <Text size="xs" c="dimmed">{fmt(m.companies.thisMonth, { month: monthLabel(d.currentMonth.month) })}</Text>
                      <Title order={3}>{formatKina(d.currentMonth.chargedToea)}</Title>
                      <Text size="xs" c="dimmed">{fmt(m.companies.orders, { count: d.currentMonth.orderCount })}</Text>
                    </Card>
                    <Card withBorder>
                      <Text size="xs" c="dimmed">{m.companies.employees}</Text>
                      <Title order={3}>{d.employees.length}</Title>
                    </Card>
                  </SimpleGrid>
                )}

                <Card withBorder>
                  <Title order={5} mb="sm">{selected === 'new' ? m.companies.add : m.companies.details}</Title>
                  <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    <TextInput label={m.companies.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} disabled={!editable} required />
                    <TextInput
                      label={m.companies.creditLimit}
                      description={m.companies.creditLimitHelp}
                      value={form.creditLimit}
                      onChange={(e) => setForm({ ...form, creditLimit: e.currentTarget.value })}
                      disabled={!editable}
                      leftSection="K"
                    />
                    <TextInput label={m.companies.contactName} value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.currentTarget.value })} disabled={!editable} />
                    <TextInput
                      label={m.companies.contactEmail}
                      description={m.companies.contactEmailHelp}
                      value={form.contactEmail}
                      onChange={(e) => setForm({ ...form, contactEmail: e.currentTarget.value })}
                      disabled={!editable}
                    />
                    <TextInput label={m.companies.contactPhone} value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.currentTarget.value })} disabled={!editable} />
                    <Switch mt="xl" label={m.companies.active} checked={form.active} onChange={(e) => setForm({ ...form, active: e.currentTarget.checked })} disabled={!editable} />
                  </SimpleGrid>
                  {error && (
                    <Alert color="red" mt="sm">
                      {error}
                    </Alert>
                  )}
                  {editable && (
                    <Group mt="md">
                      <Button onClick={() => void save()} loading={busy} disabled={!form.name.trim()} data-testid="company-save">
                        {m.common.save}
                      </Button>
                    </Group>
                  )}
                </Card>

                {d && (
                  <>
                    <Card withBorder>
                      <Title order={5} mb="xs">{m.companies.employees}</Title>
                      <Text size="xs" c="dimmed" mb="sm">{m.companies.employeesHelp}</Text>
                      {editable && (
                        <Group align="flex-end" mb="sm">
                          <TextInput label={m.companies.phone} placeholder="7xxx xxxx" value={phone} onChange={(e) => setPhone(e.currentTarget.value)} w={220} />
                          <Button leftSection={<IconUserPlus size={16} />} variant="light" onClick={() => void addEmployee()} loading={busy} disabled={!phone.trim()}>
                            {m.companies.addEmployee}
                          </Button>
                        </Group>
                      )}
                      {d.employees.length === 0 ? (
                        <Text size="sm" c="dimmed">{m.companies.noEmployees}</Text>
                      ) : (
                        <Table>
                          <Table.Tbody>
                            {d.employees.map((e) => (
                              <Table.Tr key={e.id}>
                                <Table.Td>{e.name ?? '—'}</Table.Td>
                                <Table.Td>{e.phone}</Table.Td>
                                <Table.Td>{e.email ?? ''}</Table.Td>
                                <Table.Td w={40}>
                                  {editable && (
                                    <ActionIcon variant="subtle" color="red" onClick={() => void removeEmployee(e.id)} aria-label={m.companies.removeEmployee}>
                                      <IconTrash size={16} />
                                    </ActionIcon>
                                  )}
                                </Table.Td>
                              </Table.Tr>
                            ))}
                          </Table.Tbody>
                        </Table>
                      )}
                    </Card>

                    {editable && (
                      <Card withBorder>
                        <Title order={5} mb="sm">{m.companies.recordPayment}</Title>
                        <Group align="flex-end">
                          <TextInput label={m.companies.amount} leftSection="K" value={payAmount} onChange={(e) => setPayAmount(e.currentTarget.value)} w={160} />
                          <TextInput label={m.companies.reference} placeholder="BSP transfer 1234" value={payRef} onChange={(e) => setPayRef(e.currentTarget.value)} w={260} />
                          <Button leftSection={<IconCash size={16} />} onClick={() => void recordPayment()} loading={busy} disabled={!payAmount.trim()}>
                            {m.companies.record}
                          </Button>
                        </Group>
                        {d.payments.length > 0 && (
                          <Table mt="sm">
                            <Table.Tbody>
                              {d.payments.map((p) => (
                                <Table.Tr key={p.id}>
                                  <Table.Td>{formatDateTime(p.createdAt)}</Table.Td>
                                  <Table.Td>{p.description}</Table.Td>
                                  <Table.Td fw={600}>{formatKina(p.amountToea)}</Table.Td>
                                </Table.Tr>
                              ))}
                            </Table.Tbody>
                          </Table>
                        )}
                      </Card>
                    )}

                    <Card withBorder>
                      <Title order={5} mb="xs">{m.companies.statements}</Title>
                      <Text size="xs" c="dimmed" mb="sm">{m.companies.statementsHelp}</Text>
                      <Table.ScrollContainer minWidth={640}>
                        <Table>
                          <Table.Thead>
                            <Table.Tr>
                              <Table.Th>{m.companies.month}</Table.Th>
                              <Table.Th>{m.companies.ordersCol}</Table.Th>
                              <Table.Th>{m.companies.water}</Table.Th>
                              <Table.Th>{m.companies.charged}</Table.Th>
                              <Table.Th>{m.companies.paid}</Table.Th>
                              <Table.Th>{m.companies.balance}</Table.Th>
                              <Table.Th />
                            </Table.Tr>
                          </Table.Thead>
                          <Table.Tbody>
                            <MonthRow s={d.currentMonth} onCsv={() => void downloadCsv(d.currentMonth.month)} busy={csvBusy === d.currentMonth.month} />
                            {d.statements.map((s) => (
                              <MonthRow key={s.id} s={s} onCsv={() => void downloadCsv(s.month)} busy={csvBusy === s.month} />
                            ))}
                          </Table.Tbody>
                        </Table>
                      </Table.ScrollContainer>
                    </Card>
                  </>
                )}
              </Stack>
            )}
          </Grid.Col>
        </Grid>
      </QueryState>
    </>
  );
}
