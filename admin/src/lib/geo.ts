import type { GeoPolygon } from '@/api/types';

export type LatLng = [number, number];

/** GeoJSON outer ring ([lng, lat], closed) → open list of [lat, lng] for Leaflet. */
export function polygonToLatLngs(p: GeoPolygon | null | undefined): LatLng[] {
  const ring = p?.coordinates?.[0];
  if (!ring || ring.length === 0) return [];
  const pts = ring.map(([lng, lat]) => [lat, lng] as LatLng);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length > 1 && first[0] === last[0] && first[1] === last[1]) pts.pop();
  return pts;
}

/** Open list of [lat, lng] → GeoJSON Polygon with a closed [lng, lat] ring. */
export function latLngsToPolygon(points: LatLng[]): GeoPolygon {
  if (points.length < 3) throw new Error('A polygon needs at least 3 points');
  const ring = points.map(([lat, lng]) => [round6(lng), round6(lat)]);
  ring.push([...ring[0]]);
  return { type: 'Polygon', coordinates: [ring] };
}

/** Regular n-gon approximating a circle (good enough at depot scale). */
export function circleToLatLngs(center: LatLng, radiusM: number, n = 12): LatLng[] {
  const [lat, lng] = center;
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [round6(lat + dLat * Math.sin(a)), round6(lng + dLng * Math.cos(a))] as LatLng;
  });
}

export function isValidLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Great-circle distance in metres (haversine). */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}
