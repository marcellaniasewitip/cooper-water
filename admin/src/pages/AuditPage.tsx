import { ActionIcon, Autocomplete, Badge, Card, Code, Collapse, Group, Table, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { api, type AuditLog } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { LoadMore } from '@/components/CursorList';
import { useCursorList } from '@/components/useCursorList';
import { JsonDiff } from '@/components/JsonDiff';
import { PageHeader } from '@/components/PageHeader';
import { Empty, QueryState } from '@/components/QueryState';
import { m } from '@/i18n';
import { formatDateTime } from '@/lib/time';

const ENTITIES = ['order', 'user', 'driver', 'driver_document', 'truck', 'depot', 'package', 'setting', 'topup_request', 'payment', 'payout', 'wallet', 'dispute', 'notification_template', 'broadcast', 'role', 'admin_user'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function AuditPage() {
  const { can } = useAuth();
  const [entity, setEntity] = useState('');
  const [entityId, setEntityId] = useState('');
  const [actorId, setActorId] = useState('');
  const [action, setAction] = useState('');
  const [filters] = useDebouncedValue({ entity: entity.trim(), entityId: entityId.trim(), actorId: actorId.trim(), action: action.trim() }, 400);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const admins = useQuery({ queryKey: ['admins'], queryFn: api.access.admins, enabled: can('admins.manage'), staleTime: 300_000 });
  const names = new Map((admins.data ?? []).map((a) => [a.id, a.name]));

  const actorOk = !filters.actorId || UUID_RE.test(filters.actorId);
  const query = {
    entity: filters.entity || undefined,
    entityId: filters.entityId || undefined,
    actorId: actorOk ? filters.actorId || undefined : undefined,
    action: filters.action || undefined,
  };
  const list = useCursorList<AuditLog>(['audit', query], (p) => api.audit({ ...query, ...p }));
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <>
      <PageHeader title={m.audit.title} />
      <Card withBorder mb="md">
        <Group align="flex-end" wrap="wrap">
          <Autocomplete label={m.audit.entity} data={ENTITIES} value={entity} onChange={setEntity} w={200} clearable />
          <TextInput label={m.audit.entityId} value={entityId} onChange={(e) => setEntityId(e.currentTarget.value)} w={300} />
          <TextInput label={m.audit.action} placeholder="e.g. order. / wallet.adjust" value={action} onChange={(e) => setAction(e.currentTarget.value)} w={220} />
          <TextInput label={m.audit.actorId} value={actorId} onChange={(e) => setActorId(e.currentTarget.value)} w={300} error={!actorOk ? 'UUID' : undefined} />
        </Group>
      </Card>
      <Card withBorder>
        <QueryState isPending={list.isPending} error={list.error} refetch={list.refetch}>
          {list.items.length === 0 ? (
            <Empty />
          ) : (
            <Table.ScrollContainer minWidth={900}>
              <Table fz="sm" data-testid="audit-table">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={30} />
                    <Table.Th>{m.common.created}</Table.Th>
                    <Table.Th>{m.audit.actor}</Table.Th>
                    <Table.Th>{m.common.actions}</Table.Th>
                    <Table.Th>{m.audit.entity}</Table.Th>
                    <Table.Th>{m.audit.ip}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.items.map((r) => {
                    const isOpen = open.has(r.id);
                    const hasData = r.before != null || r.after != null;
                    return (
                      <Fragment key={r.id}>
                        <Table.Tr style={{ cursor: hasData ? 'pointer' : undefined }} onClick={() => hasData && toggle(r.id)}>
                          <Table.Td>
                            {hasData && <ActionIcon variant="subtle" size="sm" aria-label={m.audit.diff}>{isOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}</ActionIcon>}
                          </Table.Td>
                          <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.createdAt)}</Table.Td>
                          <Table.Td>
                            <Text size="sm">{(r.actorId && names.get(r.actorId)) ?? r.actorType}</Text>
                            {r.actorId && (
                              <Text size="xs" c="dimmed" ff="monospace">
                                {r.actorId.slice(0, 8)}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td>
                            <Badge variant="light" tt="none">
                              {r.action}
                            </Badge>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm">{r.entity}</Text>
                            {r.entityId && (
                              <Code fz="xs" onClick={(e) => { e.stopPropagation(); setEntity(r.entity); setEntityId(r.entityId!); }} style={{ cursor: 'pointer' }}>
                                {r.entityId}
                              </Code>
                            )}
                          </Table.Td>
                          <Table.Td ff="monospace">{r.ip ?? '—'}</Table.Td>
                        </Table.Tr>
                        {hasData && (
                          <Table.Tr>
                            <Table.Td colSpan={6} p={0} style={{ borderTop: 'none' }}>
                              <Collapse in={isOpen}>
                                <div style={{ padding: 12 }}>{isOpen && <JsonDiff before={r.before} after={r.after} />}</div>
                              </Collapse>
                            </Table.Td>
                          </Table.Tr>
                        )}
                      </Fragment>
                    );
                  })}
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
