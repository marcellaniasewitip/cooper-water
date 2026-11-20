import { Alert, Badge, Button, Card, Grid, Group, NavLink, Stack, Switch, Text, TextInput } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import L from 'leaflet';
import { useEffect, useMemo, useState } from 'react';
import { Marker, Polygon, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { api, errorMessage, type Zone } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { ActionModal } from '@/components/ActionModal';
import { MapBase } from '@/components/MapBase';
import { PageHeader } from '@/components/PageHeader';
import { QueryState } from '@/components/QueryState';
import { m } from '@/i18n';
import { latLngsToPolygon, polygonToLatLngs, type LatLng } from '@/lib/geo';
import { notifyError, notifySuccess } from '@/lib/notify';

interface Draft {
  id: string | null;
  name: string;
  active: boolean;
  points: LatLng[];
}

const vertexIcon = L.divIcon({ className: 'cw-vertex', iconSize: [12, 12], iconAnchor: [6, 6] });
const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599'];

const toDraft = (z: Zone): Draft => ({ id: z.id, name: z.name, active: z.active, points: polygonToLatLngs(z.polygon) });

function ClickToAdd({ enabled, onAdd }: { enabled: boolean; onAdd: (p: LatLng) => void }) {
  useMapEvents({
    click(e) {
      if (enabled) onAdd([e.latlng.lat, e.latlng.lng]);
    },
  });
  return null;
}

/** Zooms to the selected zone when another one is picked. */
function FitZone({ points, token }: { points: LatLng[]; token: string }) {
  const map = useMap();
  useEffect(() => {
    if (points.length >= 3) map.fitBounds(points, { padding: [30, 30], maxZoom: 16 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  return null;
}

/**
 * Service zones (e.g. Gerehu, Waigani, Boroko). An order inside a zone is only offered to drivers whose live
 * location is inside the same zone; orders outside every zone go to any nearby driver.
 */
export default function ZonesPage() {
  const { can } = useAuth();
  const editable = can('depots.manage');
  const qc = useQueryClient();
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones.list });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!draft && zones.data && zones.data.length > 0) setDraft(toDraft(zones.data[0]));
  }, [zones.data, draft]);

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const validation = useMemo(() => {
    if (!draft) return null;
    if (!draft.name.trim()) return `${m.zones.name}: ${m.common.required}`;
    if (draft.points.length < 3) return m.zones.tooSmall;
    return null;
  }, [draft]);

  const save = async () => {
    if (!draft || validation) return;
    const body = { name: draft.name.trim(), active: draft.active, polygon: latLngsToPolygon(draft.points) };
    setBusy(true);
    setError(null);
    try {
      const saved = draft.id ? await api.zones.update(draft.id, body) : await api.zones.create(body);
      notifySuccess(draft.id ? m.zones.updated : m.zones.created);
      await qc.invalidateQueries({ queryKey: ['zones'] });
      setDraft(toDraft(saved));
      setDrawing(false);
    } catch (err) {
      setError(errorMessage(err));
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={m.zones.title}
        subtitle={m.zones.subtitle}
        actions={
          editable && (
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={() => {
                setDraft({ id: null, name: '', active: true, points: [] });
                setDrawing(true);
                setError(null);
              }}
            >
              {m.zones.add}
            </Button>
          )
        }
      />
      <QueryState isPending={zones.isPending} error={zones.error} refetch={zones.refetch}>
        <Grid>
          <Grid.Col span={{ base: 12, md: 3 }}>
            <Card withBorder p="xs">
              {(zones.data ?? []).length === 0 && (
                <Text c="dimmed" size="sm" p="sm">
                  {m.zones.none}
                </Text>
              )}
              {(zones.data ?? []).map((z, i) => (
                <NavLink
                  key={z.id}
                  active={draft?.id === z.id}
                  label={z.name}
                  leftSection={<span style={{ width: 12, height: 12, borderRadius: 3, background: COLORS[i % COLORS.length], display: 'inline-block' }} />}
                  rightSection={!z.active && <Badge size="xs" color="gray">{m.zones.off}</Badge>}
                  onClick={() => {
                    setDraft(toDraft(z));
                    setDrawing(false);
                    setError(null);
                  }}
                />
              ))}
            </Card>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 9 }}>
            {draft ? (
              <Stack>
                <Card withBorder>
                  <Group align="flex-end" wrap="wrap">
                    <TextInput label={m.zones.name} placeholder="e.g. Gerehu" value={draft.name} onChange={(e) => patch({ name: e.currentTarget.value })} disabled={!editable} w={260} />
                    <Switch label={m.zones.active} checked={draft.active} onChange={(e) => patch({ active: e.currentTarget.checked })} disabled={!editable} />
                    {editable && (
                      <>
                        <Button variant={drawing ? 'filled' : 'light'} color="orange" onClick={() => setDrawing((v) => !v)}>
                          {drawing ? m.zones.stopDrawing : m.zones.draw}
                        </Button>
                        <Button variant="subtle" color="gray" onClick={() => patch({ points: [] })} disabled={draft.points.length === 0}>
                          {m.zones.clear}
                        </Button>
                        <Button onClick={save} loading={busy} disabled={!!validation} data-testid="zone-save">
                          {m.common.save}
                        </Button>
                        {draft.id && (
                          <Button variant="light" color="red" leftSection={<IconTrash size={16} />} onClick={() => setConfirmDelete(true)}>
                            {m.common.delete}
                          </Button>
                        )}
                      </>
                    )}
                  </Group>
                  <Text size="xs" c="dimmed" mt="xs">
                    {m.zones.help}
                  </Text>
                  {validation && draft.points.length > 0 && (
                    <Text size="xs" c="orange" mt={4}>
                      {validation}
                    </Text>
                  )}
                  {error && (
                    <Alert color="red" mt="sm">
                      {error}
                    </Alert>
                  )}
                </Card>
                <Card withBorder p={0} style={{ cursor: drawing ? 'crosshair' : undefined }}>
                  <MapBase height={520}>
                    <FitZone points={draft.points} token={draft.id ?? 'new'} />
                    <ClickToAdd enabled={editable && drawing} onAdd={(p) => patch({ points: [...draft.points, p] })} />
                    {(zones.data ?? []).map((z, i) =>
                      z.id === draft.id ? null : (
                        <Polygon key={z.id} positions={polygonToLatLngs(z.polygon)} pathOptions={{ color: COLORS[i % COLORS.length], weight: 1, fillOpacity: z.active ? 0.12 : 0.03, dashArray: z.active ? undefined : '4 4' }}>
                          <Tooltip>{z.name}</Tooltip>
                        </Polygon>
                      ),
                    )}
                    {draft.points.length >= 2 && <Polygon positions={draft.points} pathOptions={{ color: '#e8590c', weight: 3, fillOpacity: 0.2 }} />}
                    {draft.points.map((p, i) => (
                      <Marker
                        key={`${i}-${p[0]}-${p[1]}`}
                        position={p}
                        icon={vertexIcon}
                        draggable={editable}
                        eventHandlers={{
                          dragend: (e) => {
                            const ll = (e.target as L.Marker).getLatLng();
                            patch({ points: draft.points.map((q, j) => (j === i ? ([ll.lat, ll.lng] as LatLng) : q)) });
                          },
                          click: () => editable && patch({ points: draft.points.filter((_, j) => j !== i) }),
                        }}
                      />
                    ))}
                  </MapBase>
                </Card>
              </Stack>
            ) : (
              <Card withBorder>
                <Text c="dimmed">{m.zones.pick}</Text>
              </Card>
            )}
          </Grid.Col>
        </Grid>
      </QueryState>
      {draft?.id && (
        <ActionModal
          opened={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          title={m.zones.deleteTitle}
          body={m.zones.deleteBody}
          color="red"
          confirmLabel={m.common.delete}
          successMessage={m.zones.deleted}
          onSubmit={async () => {
            await api.zones.remove(draft.id!);
            await qc.invalidateQueries({ queryKey: ['zones'] });
            setDraft(null);
          }}
        />
      )}
    </>
  );
}
