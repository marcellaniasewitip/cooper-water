import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer } from 'react-leaflet';
import { useEffect, useState, type ReactNode } from 'react';
import { config } from '@/config';

interface GoogleSession {
  session: string;
  /** Unix seconds. */
  expiry: number;
}

const SESSION_KEY = 'cw.googleTiles.session';
const pending: Record<'light' | 'dark', Promise<GoogleSession | null> | null> = { light: null, dark: null };

/** Near-black dispatcher map: dark land, grey roads, muted labels, no shop/POI clutter. */
export const DARK_MAP_STYLES = [
  { elementType: 'geometry', stylers: [{ color: '#121417' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8a9099' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#121417' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#3a3f45' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#b0b6bd' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ visibility: 'on' }, { color: '#16201a' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a2e33' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#7d838a' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#33383e' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#40464d' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#a0a6ad' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0a0f17' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4b5560' }] },
];

/**
 * Google Map Tiles API session (roadmap, English, PNG region). One session is reused for ~2 weeks
 * (cached in localStorage); on any error we fall back to OpenStreetMap so the maps never go blank.
 */
function googleSession(key: string, dark: boolean): Promise<GoogleSession | null> {
  const variant = dark ? 'dark' : 'light';
  const storeKey = dark ? `${SESSION_KEY}.dark` : SESSION_KEY;
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) ?? 'null') as GoogleSession | null;
    if (saved && saved.expiry * 1000 - Date.now() > 3_600_000) return Promise.resolve(saved);
  } catch {
    /* storage unavailable */
  }
  pending[variant] ??= fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType: 'roadmap', language: 'en-US', region: 'PG', ...(dark ? { styles: DARK_MAP_STYLES } : {}) }),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error(`Map Tiles session ${r.status}`);
      const j = (await r.json()) as { session: string; expiry: string };
      const s = { session: j.session, expiry: Number(j.expiry) };
      try {
        localStorage.setItem(storeKey, JSON.stringify(s));
      } catch {
        /* ignore */
      }
      return s;
    })
    .catch((err) => {
      console.warn('Google map tiles unavailable, using OpenStreetMap', err);
      pending[variant] = null;
      return null;
    });
  return pending[variant]!;
}

/** Tile layer: Google Maps when VITE_GOOGLE_MAPS_KEY is set (and works), otherwise OpenStreetMap. */
function useTiles(dark: boolean): { url: string; attribution: string; maxZoom: number; google: boolean } | null {
  const key = config.map.googleKey;
  const [google, setGoogle] = useState<GoogleSession | null | undefined>(key ? undefined : null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    setGoogle(undefined);
    void googleSession(key, dark).then((s) => alive && setGoogle(s));
    return () => {
      alive = false;
    };
  }, [key, dark]);
  if (google === undefined) return null; // still asking Google
  if (google) {
    return {
      url: `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(google.session)}&key=${encodeURIComponent(key)}`,
      attribution: 'Map data &copy; Google',
      maxZoom: 22,
      google: true,
    };
  }
  return { url: config.map.tileUrl, attribution: config.map.attribution, maxZoom: 19, google: false };
}

/**
 * Map with Google Maps (when configured) or OpenStreetMap tiles.
 * `dark`: near-black dispatcher style (Google styled tiles; OpenStreetMap tiles are darkened with a filter).
 */
export function MapBase({
  children,
  height = 520,
  center = config.map.center,
  zoom = config.map.zoom,
  dark = false,
}: {
  children?: ReactNode;
  height?: number | string;
  center?: [number, number];
  zoom?: number;
  dark?: boolean;
}) {
  const tiles = useTiles(dark);
  return (
    <MapContainer
      center={center}
      zoom={zoom}
      maxZoom={tiles?.maxZoom ?? 19}
      className={dark ? 'cw-map-dark' : undefined}
      style={{ height, width: '100%', borderRadius: 8 }}
      scrollWheelZoom
    >
      {tiles && (
        <TileLayer
          key={tiles.url}
          url={tiles.url}
          attribution={tiles.attribution}
          maxZoom={tiles.maxZoom}
          className={dark && !tiles.google ? 'cw-tiles-darken' : undefined}
        />
      )}
      {children}
    </MapContainer>
  );
}
