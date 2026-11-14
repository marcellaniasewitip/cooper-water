import { Injectable } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { Errors } from '../common/errors';
import { logger } from '../common/logger';

export interface MapPlace {
  /** Google place id (search results) or null (reverse geocode). */
  placeId: string | null;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

/** Bias searches to Port Moresby / PNG. */
const POM = { lat: -9.4438, lng: 147.1803 };
const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
}>;

/**
 * Google Maps Platform on the server: address search (Places API (New) Text Search) and reverse
 * geocoding (Geocoding API). The key never reaches the apps. Without GOOGLE_MAPS_SERVER_KEY these return
 * 503 `geo_unavailable` and the apps simply hide address search.
 */
@Injectable()
export class MapsService {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  /** Overridable in tests. */
  fetcher: FetchLike = (url, init) => fetch(url, init as RequestInit) as never;
  key: () => string | undefined = () => loadEnv().googleMapsServerKey;

  get enabled(): boolean {
    return !!this.key();
  }

  async search(query: string, near?: { lat: number; lng: number }): Promise<MapPlace[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const key = this.requireKey();
    const center = near ?? POM;
    return this.cached(`s:${q.toLowerCase()}:${center.lat.toFixed(2)},${center.lng.toFixed(2)}`, async () => {
      const res = await this.call(PLACES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
        },
        body: JSON.stringify({
          textQuery: q,
          regionCode: 'PG',
          languageCode: 'en',
          maxResultCount: 8,
          locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: 30000 } },
        }),
      });
      const places: any[] = res?.places ?? [];
      return places
        .filter((p) => p?.location?.latitude != null && p?.location?.longitude != null)
        .map((p) => ({
          placeId: p.id ?? null,
          name: p.displayName?.text ?? p.formattedAddress ?? '',
          address: p.formattedAddress ?? p.displayName?.text ?? '',
          lat: p.location.latitude,
          lng: p.location.longitude,
        }));
    });
  }

  /** Address for a map position (when the customer drops the pin). Null when Google has nothing. */
  async reverse(lat: number, lng: number): Promise<MapPlace | null> {
    const key = this.requireKey();
    return this.cached(`r:${lat.toFixed(5)},${lng.toFixed(5)}`, async () => {
      const url = `${GEOCODE_URL}?latlng=${lat},${lng}&language=en&key=${encodeURIComponent(key)}`;
      const res = await this.call(url, { method: 'GET' });
      if (res?.status && res.status !== 'OK' && res.status !== 'ZERO_RESULTS') {
        logger.warn({ status: res.status, error: res.error_message }, 'Google geocoding refused the request');
        throw Errors.unavailable('geo_unavailable', 'Address lookup is not available right now');
      }
      const r = res?.results?.[0];
      if (!r) return null;
      const short = (r.address_components ?? [])
        .filter((c: any) => (c.types ?? []).some((t: string) => ['premise', 'street_number', 'route', 'neighborhood', 'sublocality', 'locality'].includes(t)))
        .map((c: any) => c.long_name)
        .slice(0, 3)
        .join(', ');
      return { placeId: r.place_id ?? null, name: short || r.formatted_address, address: r.formatted_address ?? short, lat, lng };
    });
  }

  private requireKey(): string {
    const k = this.key();
    if (!k) throw Errors.unavailable('geo_unavailable', 'Address search is not set up yet');
    return k;
  }

  private async call(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<any> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await this.fetcher(url, { ...init, signal: ctrl.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        logger.warn({ status: res.status, error: body?.error?.message }, 'Google Maps API error');
        throw Errors.unavailable('geo_unavailable', 'Address search is not available right now');
      }
      return body;
    } catch (err: any) {
      if (err?.code === 'geo_unavailable') throw err;
      logger.warn({ err: String(err?.message ?? err) }, 'Google Maps API unreachable');
      throw Errors.unavailable('geo_unavailable', 'Address search is not available right now');
    } finally {
      clearTimeout(t);
    }
  }

  /** Small in-memory cache (10 min, 500 entries) to save quota on repeated lookups. */
  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 600_000) return hit.value as T;
    const value = await fn();
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}
