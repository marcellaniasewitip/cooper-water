import { Alert, Badge, Button, Card, Group, Modal, Paper, SegmentedControl, SimpleGrid, Stack, Table, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { IconBell, IconSend } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage, type Broadcast, type BroadcastAudience } from '@/api';
import { LoadMore } from '@/components/CursorList';
import { useCursorList } from '@/components/useCursorList';
import { PageHeader } from '@/components/PageHeader';
import { Empty, QueryState } from '@/components/QueryState';
import { fmt, m } from '@/i18n';
import { notifyError, notifySuccess } from '@/lib/notify';
import { formatDateTime } from '@/lib/time';

const TITLE_MAX = 65;
const BODY_MAX = 500;

function audienceLabel(b: Pick<Broadcast, 'audience' | 'user'>): string {
  if (b.audience === 'drivers') return m.broadcasts.toDrivers;
  if (b.audience === 'customers') return m.broadcasts.toCustomers;
  if (b.audience === 'all') return m.broadcasts.toAll;
  if (!b.user) return m.broadcasts.toUser;
  return `${b.user.name ?? b.user.phone} (${b.user.role === 'driver' ? m.broadcasts.driver : m.broadcasts.customer})`;
}

/** What the notification looks like on the phone. */
function PhonePreview({ title, body }: { title: string; body: string }) {
  return (
    <Paper withBorder radius="md" p="sm" bg="var(--mantine-color-gray-0)">
      <Text size="xs" c="dimmed" mb={6}>
        {m.broadcasts.preview}
      </Text>
      <Paper radius="md" p="sm" shadow="xs">
        <Group gap={8} wrap="nowrap" align="flex-start">
          <IconBell size={18} color="var(--mantine-color-blue-6)" style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ minWidth: 0 }}>
            <Text size="sm" fw={600} lineClamp={1}>
              {title || m.broadcasts.msgTitle}
            </Text>
            <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {body || m.broadcasts.msgBody}
            </Text>
          </div>
        </Group>
      </Paper>
    </Paper>
  );
}

function Composer() {
  const qc = useQueryClient();
  const [audience, setAudience] = useState<BroadcastAudience>('drivers');
  const [phone, setPhone] = useState('');
  const [lookupPhone, setLookupPhone] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isUser = audience === 'user';
  const count = useQuery({
    queryKey: ['broadcast-count', audience, isUser ? lookupPhone : ''],
    queryFn: () => api.broadcasts.count(audience, isUser ? lookupPhone : undefined),
    enabled: !isUser || lookupPhone.length > 0,
    retry: false,
  });
  const recipients = count.data?.recipients ?? 0;
  const userFound = isUser && !!count.data && lookupPhone === phone.trim();
  const valid = title.trim().length > 0 && body.trim().length > 0 && (isUser ? userFound : recipients > 0);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.broadcasts.send({ audience, phone: isUser ? phone.trim() : undefined, title: title.trim(), body: body.trim() });
      notifySuccess(fmt(m.broadcasts.sent, { count: r.recipients }));
      setTitle('');
      setBody('');
      setConfirming(false);
      await qc.invalidateQueries({ queryKey: ['broadcasts'] });
    } catch (err) {
      setError(errorMessage(err));
      notifyError(err);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card withBorder mb="md">
      <Text fw={600} mb="sm">
        {m.broadcasts.new}
      </Text>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Stack>
          <div>
            <Text size="sm" fw={500} mb={4}>
              {m.broadcasts.audience}
            </Text>
            <SegmentedControl
              fullWidth
              value={audience}
              onChange={(v) => {
                setAudience(v as BroadcastAudience);
                setError(null);
              }}
              data={[
                { value: 'drivers', label: m.broadcasts.toDrivers },
                { value: 'customers', label: m.broadcasts.toCustomers },
                { value: 'all', label: m.broadcasts.toAll },
                { value: 'user', label: m.broadcasts.toUser },
              ]}
              data-testid="broadcast-audience"
            />
          </div>
          {isUser && (
            <Group align="flex-end" wrap="nowrap">
              <TextInput
                label={m.broadcasts.phone}
                placeholder={m.broadcasts.phoneHint}
                value={phone}
                onChange={(e) => setPhone(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && setLookupPhone(phone.trim())}
                inputMode="tel"
                style={{ flex: 1 }}
                error={lookupPhone && count.error && lookupPhone === phone.trim() ? errorMessage(count.error) : undefined}
              />
              <Button variant="default" onClick={() => setLookupPhone(phone.trim())} disabled={!phone.trim()} loading={count.isFetching}>
                {m.broadcasts.lookup}
              </Button>
            </Group>
          )}
          {userFound && count.data && (
            <Text size="sm" c="teal">
              {fmt(m.broadcasts.found, { name: count.data.name ?? phone.trim(), role: count.data.role === 'driver' ? m.broadcasts.driver : m.broadcasts.customer })}
            </Text>
          )}
          <TextInput
            label={m.broadcasts.msgTitle}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value.slice(0, TITLE_MAX))}
            description={`${title.length}/${TITLE_MAX}`}
            withAsterisk
            data-testid="broadcast-title"
          />
          <Textarea
            label={m.broadcasts.msgBody}
            value={body}
            onChange={(e) => setBody(e.currentTarget.value.slice(0, BODY_MAX))}
            description={`${body.length}/${BODY_MAX}`}
            autosize
            minRows={4}
            withAsterisk
            data-testid="broadcast-body"
          />
        </Stack>
        <Stack justify="space-between">
          <PhonePreview title={title.trim()} body={body.trim()} />
          <Stack gap="xs">
            {count.data && !count.data.pushEnabled && (
              <Alert color="yellow" variant="light" data-testid="broadcast-push-off">
                <Text size="sm">{m.broadcasts.pushOff}</Text>
              </Alert>
            )}
            {!isUser && count.data && <Text size="sm">{fmt(m.broadcasts.reach, { count: recipients })}</Text>}
            {userFound && <Text size="sm">{m.broadcasts.reachOne}</Text>}
            {error && <Alert color="red">{error}</Alert>}
            <Group justify="flex-end">
              <Button leftSection={<IconSend size={16} />} onClick={() => setConfirming(true)} disabled={!valid} data-testid="broadcast-send">
                {m.broadcasts.send}
              </Button>
            </Group>
          </Stack>
        </Stack>
      </SimpleGrid>

      <Modal opened={confirming} onClose={() => setConfirming(false)} title={<Text fw={600}>{m.broadcasts.confirmTitle}</Text>} centered>
        <Stack>
          <Text size="sm">{fmt(m.broadcasts.confirmBody, { count: isUser ? 1 : recipients })}</Text>
          <PhonePreview title={title.trim()} body={body.trim()} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirming(false)}>
              {m.common.cancel}
            </Button>
            <Button onClick={send} loading={busy} leftSection={<IconSend size={16} />}>
              {m.broadcasts.send}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Card>
  );
}

export default function BroadcastsPage() {
  const list = useCursorList<Broadcast>(['broadcasts'], (p) => api.broadcasts.list(p));
  return (
    <>
      <PageHeader title={m.broadcasts.title} subtitle={m.broadcasts.subtitle} />
      <Composer />
      <Card withBorder>
        <Text fw={600} mb="sm">
          {m.broadcasts.history}
        </Text>
        <QueryState isPending={list.isPending} error={list.error} refetch={list.refetch}>
          {list.items.length === 0 ? (
            <Empty />
          ) : (
            <Table.ScrollContainer minWidth={800}>
              <Table fz="sm" verticalSpacing="sm" data-testid="broadcasts-table">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{m.broadcasts.sentAt}</Table.Th>
                    <Table.Th>{m.broadcasts.to}</Table.Th>
                    <Table.Th>{m.broadcasts.msgBody}</Table.Th>
                    <Table.Th>
                      <Tooltip label={m.broadcasts.deliveredHint} multiline w={260}>
                        <span>{m.broadcasts.delivered}</span>
                      </Tooltip>
                    </Table.Th>
                    <Table.Th>{m.broadcasts.by}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.items.map((b) => (
                    <Table.Tr key={b.id}>
                      <Table.Td style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>{formatDateTime(b.createdAt)}</Table.Td>
                      <Table.Td style={{ verticalAlign: 'top' }}>
                        <Badge variant="light" tt="none">
                          {audienceLabel(b)}
                        </Badge>
                      </Table.Td>
                      <Table.Td style={{ maxWidth: 420, verticalAlign: 'top' }}>
                        <Text size="sm" fw={600}>
                          {b.title}
                        </Text>
                        <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                          {b.body}
                        </Text>
                      </Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                        {b.pushed ?? 0} / {b.recipients}
                      </Table.Td>
                      <Table.Td style={{ verticalAlign: 'top' }}>{b.sentBy ?? '—'}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
          <LoadMore hasNextPage={list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} fetchNextPage={list.fetchNextPage} />
        </QueryState>
      </Card>
    </>
  );
}
