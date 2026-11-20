import { Anchor, Badge, Button, Card, Group, Rating, SegmentedControl, SimpleGrid, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconChevronLeft, IconChevronRight, IconDownload } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/api';
import { PageHeader } from '@/components/PageHeader';
import { Empty, QueryState } from '@/components/QueryState';
import { OrderStatusBadge } from '@/components/StatusBadge';
import { fmt, m } from '@/i18n';
import { filenameFromDisposition, saveBlob } from '@/lib/download';
import { formatKina } from '@/lib/money';
import { notifyError } from '@/lib/notify';
import { addDaysYmd, formatTime, localYmd, pickerDateToYmd, ymdToPickerDate } from '@/lib/time';

type By = 'ordered' | 'delivered';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card withBorder>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Title order={3}>{value}</Title>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Card>
  );
}

/**
 * Day report: every order of ONE chosen day (Port Moresby time) — order and delivery times, customer,
 * driver and truck, water, money, the customer's feedback, disputes and the receipt — with CSV export.
 */
export default function DayReportPage() {
  const [date, setDate] = useState(localYmd());
  const [by, setBy] = useState<By>('ordered');
  const [downloading, setDownloading] = useState(false);
  const report = useQuery({ queryKey: ['reports', 'day', date, by], queryFn: () => api.reports.day(date, by) });
  const today = localYmd();

  const download = async () => {
    setDownloading(true);
    try {
      const res = await api.reports.dayCsv(date, by);
      saveBlob(await res.blob(), filenameFromDisposition(null, `cooper-waters-${date}${by === 'delivered' ? '-delivered' : ''}.csv`));
    } catch (err) {
      notifyError(err);
    } finally {
      setDownloading(false);
    }
  };

  const s = report.data?.summary;
  const rows = report.data?.orders ?? [];

  return (
    <>
      <PageHeader
        title={m.dayReport.title}
        subtitle={m.dayReport.subtitle}
        actions={
          <Button variant="light" leftSection={<IconDownload size={16} />} loading={downloading} onClick={() => void download()} data-testid="day-csv">
            {m.dayReport.csv}
          </Button>
        }
      />
      <Card withBorder mb="md">
        <Group align="flex-end" wrap="wrap">
          <Button variant="default" onClick={() => setDate(addDaysYmd(date, -1))} aria-label={m.dayReport.prev}>
            <IconChevronLeft size={16} />
          </Button>
          <DatePickerInput
            label={m.dayReport.date}
            value={ymdToPickerDate(date)}
            onChange={(d) => d && setDate(pickerDateToYmd(d))}
            valueFormat="dddd, DD MMM YYYY"
            maxDate={new Date()}
            w={240}
          />
          <Button variant="default" onClick={() => setDate(addDaysYmd(date, 1))} disabled={date >= today} aria-label={m.dayReport.next}>
            <IconChevronRight size={16} />
          </Button>
          <Button variant="subtle" onClick={() => setDate(today)} disabled={date === today}>
            {m.dayReport.today}
          </Button>
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              {m.dayReport.by}
            </Text>
            <SegmentedControl
              value={by}
              onChange={(v) => setBy(v as By)}
              data={[
                { value: 'ordered', label: m.dayReport.byOrdered },
                { value: 'delivered', label: m.dayReport.byDelivered },
              ]}
            />
          </Stack>
        </Group>
      </Card>
      <QueryState isPending={report.isPending} error={report.error} refetch={report.refetch}>
        {s && (
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} mb="md">
            <Stat label={m.dayReport.orders} value={String(s.orders)} hint={fmt(m.dayReport.cancelledHint, { count: s.cancelled })} />
            <Stat label={m.dayReport.delivered} value={String(s.delivered)} hint={`${s.litres.toLocaleString('en-US')} L`} />
            <Stat label={m.dayReport.sales} value={formatKina(s.salesToea)} hint={fmt(m.dayReport.commissionHint, { amount: formatKina(s.commissionToea) })} />
            <Stat label={m.dayReport.avgTime} value={s.averageMinutesToDeliver !== null ? fmt(m.dayReport.minutes, { n: s.averageMinutesToDeliver }) : '—'} />
            <Stat label={m.dayReport.feedback} value={s.averageStars !== null ? `${s.averageStars} ★` : '—'} hint={fmt(m.dayReport.ratingsHint, { count: s.ratings })} />
            <Stat label={m.dayReport.disputes} value={String(s.disputes)} />
          </SimpleGrid>
        )}
        <Card withBorder p={0}>
          {rows.length === 0 ? (
            <Empty>{m.dayReport.none}</Empty>
          ) : (
            <Table.ScrollContainer minWidth={1500}>
              <Table striped highlightOnHover verticalSpacing="xs" fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{m.dayReport.colOrder}</Table.Th>
                    <Table.Th>{m.dayReport.colOrdered}</Table.Th>
                    <Table.Th>{m.dayReport.colDelivered}</Table.Th>
                    <Table.Th>{m.dayReport.colStatus}</Table.Th>
                    <Table.Th>{m.dayReport.colCustomer}</Table.Th>
                    <Table.Th>{m.dayReport.colDriver}</Table.Th>
                    <Table.Th>{m.dayReport.colWater}</Table.Th>
                    <Table.Th>{m.dayReport.colAddress}</Table.Th>
                    <Table.Th>{m.dayReport.colAmount}</Table.Th>
                    <Table.Th>{m.dayReport.colFeedback}</Table.Th>
                    <Table.Th>{m.dayReport.colReceipt}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((o) => (
                    <Table.Tr key={o.id}>
                      <Table.Td>
                        <Anchor component={Link} to={`/orders/${o.id}`} fw={600}>
                          {o.shortCode}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>{formatTime(o.orderedAt)}</Table.Td>
                      <Table.Td>
                        {o.deliveredAt ? (
                          <>
                            {formatTime(o.deliveredAt)}
                            {o.minutesToDeliver !== null && (
                              <Text size="xs" c="dimmed">
                                {fmt(m.dayReport.minutes, { n: o.minutesToDeliver })}
                              </Text>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </Table.Td>
                      <Table.Td>
                        <OrderStatusBadge status={o.status} />
                        {o.cancelReason && (
                          <Text size="xs" c="dimmed" lineClamp={2}>
                            {o.cancelReason}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {o.customer.name ?? '—'}
                        <Text size="xs" c="dimmed">
                          {o.customer.phone}
                        </Text>
                        {o.company && (
                          <Badge size="xs" variant="light">
                            {o.company}
                          </Badge>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {o.driver?.name ?? '—'}
                        {o.truck && (
                          <Text size="xs" c="dimmed">
                            {o.truck.plate} · {o.truck.capacityLitres.toLocaleString('en-US')} L
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {o.quantity} × {o.package}
                        <Text size="xs" c="dimmed">
                          {o.litres.toLocaleString('en-US')} L
                        </Text>
                      </Table.Td>
                      <Table.Td maw={220}>
                        <Text size="sm" lineClamp={2}>
                          {o.address}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {formatKina(o.paidToea)}
                        <Text size="xs" c="dimmed">
                          {m.enums.paymentMethod[o.paymentMethod] ?? o.paymentMethod}
                        </Text>
                      </Table.Td>
                      <Table.Td maw={260}>
                        {o.rating ? (
                          <>
                            <Rating value={o.rating.stars} readOnly size="xs" />
                            {o.rating.comment && (
                              <Text size="xs" lineClamp={3}>
                                “{o.rating.comment}”
                              </Text>
                            )}
                          </>
                        ) : (
                          <Text size="xs" c="dimmed">
                            {m.dayReport.noFeedback}
                          </Text>
                        )}
                        {o.dispute && (
                          <Tooltip label={o.dispute.description} multiline w={260}>
                            <Badge size="xs" color="red" variant="light" mt={4}>
                              {fmt(m.dayReport.dispute, { status: o.dispute.status })}
                            </Badge>
                          </Tooltip>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {o.receiptEmail ? (
                          <Tooltip label={o.receiptEmail}>
                            <Badge size="xs" variant="light" color="teal">
                              {m.dayReport.emailed}
                            </Badge>
                          </Tooltip>
                        ) : (
                          '—'
                        )}
                        {o.signedBy && (
                          <Text size="xs" c="dimmed">
                            {fmt(m.dayReport.signed, { name: o.signedBy })}
                          </Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Card>
      </QueryState>
    </>
  );
}
