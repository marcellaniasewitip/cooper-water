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
let pending: Promise<GoogleSession | null> | null = null;

/**
 * Google Map Tiles API session (roadmap, English, PNG region). One session is reused for ~2 weeks
 * (cached in localStorage); on any error we fall back to OpenStreetMap so the maps never go blank.
 */
function googleSession(key: string): Promise<GoogleSession | null> {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as GoogleSession | null;
    if (saved && saved.expiry * 1000 - Date.now() > 3_600_000) return Promise.resolve(saved);
  } catch {
    /* storage unavailable */
  }
  pending ??= fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType: 'roadmap', language: 'en-US', region: 'PG' }),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error(`Map Tiles session ${r.status}`);
      const j = (await r.json()) as { session: string; expiry: string };
      const s = { session: j.session, expiry: Number(j.expiry) };
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      } catch {
        /* ignore */
      }
      return s;
    })
    .catch((err) => {
      console.warn('Google map tiles unavailable, using OpenStreetMap', err);
      pending = null;
      return null;
    });
  return pending;
}

/** Tile layer: Google Maps when VITE_GOOGLE_MAPS_KEY is set (and works), otherwise OpenStreetMap. */
function useTiles(): { url: string; attribution: string; maxZoom: number } | null {
  const key = config.map.googleKey;
  const [google, setGoogle] = useState<GoogleSession | null | undefined>(key ? undefined : null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    void googleSession(key).then((s) => alive && setGoogle(s));
    return () => {
      alive = false;
    };
  }, [key]);
  if (google === undefined) return null; // still asking Google
  if (google) {
    return {
      url: `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(google.session)}&key=${encodeURIComponent(key)}`,
      attribution: 'Map data &copy; Google',
      maxZoom: 22,
    };
  }
  return { url: config.map.tileUrl, attribution: config.map.attribution, maxZoom: 19 };
}

/** Map with Google Maps (when configured) or OpenStreetMap tiles. */
export function MapBase({
  children,
  height = 520,
  center = config.map.center,
  zoom = config.map.zoom,
}: {
  children?: ReactNode;
  height?: number | string;
  center?: [number, number];
  zoom?: number;
}) {
  const tiles = useTiles();
  return (
    <MapContainer center={center} zoom={zoom} maxZoom={tiles?.maxZoom ?? 19} style={{ height, width: '100%', borderRadius: 8 }} scrollWheelZoom>
      {tiles && <TileLayer key={tiles.url} url={tiles.url} attribution={tiles.attribution} maxZoom={tiles.maxZoom} />}
      {children}
    </MapContainer>
  );
}
