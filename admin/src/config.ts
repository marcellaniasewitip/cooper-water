/** Build-time configuration (Vite env). Everything deployment-specific lives here. */
const env = import.meta.env;

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export const config = {
  apiBaseUrl: trimSlash((env.VITE_API_BASE_URL as string | undefined) || 'http://localhost:3100'),
  apiPrefix: '/api/v1',
  realtimeNamespace: '/realtime',
  /** Business time zone. PNG has no daylight saving, so the offset is fixed. */
  timeZone: 'Pacific/Port_Moresby',
  utcOffset: '+10:00',
  /** The map provider is an open decision [CONFIRM]; tiles are isolated here. */
  map: {
    tileUrl: (env.VITE_MAP_TILE_URL as string | undefined) || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: (env.VITE_MAP_ATTRIBUTION as string | undefined) || '&copy; OpenStreetMap contributors',
    /**
     * Google Maps Platform key for the dashboard (Map Tiles API), set at build time (VITE_GOOGLE_MAPS_KEY).
     * Restrict it in Google Cloud to this site's address and the Map Tiles API. Empty = OpenStreetMap.
     */
    googleKey: ((env.VITE_GOOGLE_MAPS_KEY as string | undefined) || '').trim(),
    /** Port Moresby. */
    center: [-9.4438, 147.1803] as [number, number],
    zoom: 12,
  },
  /** Fallback polling when the realtime socket is down. */
  pollMs: { fleet: 15_000, orders: 30_000, overview: 30_000 },
  pageSize: 25,
} as const;
