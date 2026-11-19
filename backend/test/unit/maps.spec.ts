import { MapsService } from '../../src/geo/maps.service';

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: any }> = [];
  const fn = async (url: string, init?: any) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { body: {} };
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  };
  return { fn, calls };
}

describe('MapsService (Google Maps Platform)', () => {
  it('is off without a key (geo_unavailable)', async () => {
    const s = new MapsService();
    s.key = () => undefined;
    expect(s.enabled).toBe(false);
    await expect(s.search('Boroko')).rejects.toMatchObject({ code: 'geo_unavailable' });
  });

  it('searches Places (New) biased to Port Moresby and maps the results', async () => {
    const s = new MapsService();
    s.key = () => 'KEY';
    const f = fakeFetch([{ body: { places: [{ id: 'p1', displayName: { text: 'Vision City' }, formattedAddress: 'Waigani Dr, Port Moresby', location: { latitude: -9.42, longitude: 147.18 } }, { id: 'p2' }] } }]);
    s.fetcher = f.fn as never;
    const r = await s.search('vision city');
    expect(r).toEqual([{ placeId: 'p1', name: 'Vision City', address: 'Waigani Dr, Port Moresby', lat: -9.42, lng: 147.18 }]);
    expect(f.calls[0].url).toContain('places.googleapis.com/v1/places:searchText');
    expect(f.calls[0].init.headers['X-Goog-Api-Key']).toBe('KEY');
    const body = JSON.parse(f.calls[0].init.body);
    expect(body).toMatchObject({ textQuery: 'vision city', regionCode: 'PG' });
    expect(body.locationBias.circle.center).toEqual({ latitude: -9.4438, longitude: 147.1803 });
    // Cached: no second call.
    await s.search('Vision City');
    expect(f.calls).toHaveLength(1);
  });

  it('reverse geocodes a pin to a short name and full address', async () => {
    const s = new MapsService();
    s.key = () => 'KEY';
    const f = fakeFetch([
      {
        body: {
          status: 'OK',
          results: [{ place_id: 'g1', formatted_address: 'Section 101, Gordons, Port Moresby, Papua New Guinea', address_components: [{ long_name: 'Gordons', types: ['sublocality'] }, { long_name: 'Port Moresby', types: ['locality'] }] }],
        },
      },
    ]);
    s.fetcher = f.fn as never;
    expect(await s.reverse(-9.43, 147.2)).toEqual({ placeId: 'g1', name: 'Gordons, Port Moresby', address: 'Section 101, Gordons, Port Moresby, Papua New Guinea', lat: -9.43, lng: 147.2 });
    expect(f.calls[0].url).toContain('latlng=-9.43,147.2');
  });

  it('turns Google errors into geo_unavailable', async () => {
    const s = new MapsService();
    s.key = () => 'KEY';
    s.fetcher = fakeFetch([{ status: 403, body: { error: { message: 'API key not valid' } } }]).fn as never;
    await expect(s.search('Boroko')).rejects.toMatchObject({ code: 'geo_unavailable' });
    s.fetcher = fakeFetch([{ body: { status: 'REQUEST_DENIED', error_message: 'denied' } }]).fn as never;
    await expect(s.reverse(-9.4, 147.1)).rejects.toMatchObject({ code: 'geo_unavailable' });
  });

  it('routes through the depot with live traffic (Routes API) and caches for a minute', async () => {
    const s = new MapsService();
    s.key = () => 'KEY';
    const f = fakeFetch([{ body: { routes: [{ duration: '754s', distanceMeters: 6120 }] } }]);
    s.fetcher = f.fn as never;
    const pts = [{ lat: -9.43, lng: 147.19 }, { lat: -9.42, lng: 147.18 }, { lat: -9.44, lng: 147.2 }];
    expect(await s.route(pts)).toEqual({ durationSec: 754, distanceM: 6120 });
    expect(f.calls[0].url).toContain('routes.googleapis.com/directions/v2:computeRoutes');
    expect(f.calls[0].init.headers['X-Goog-FieldMask']).toBe('routes.duration,routes.distanceMeters');
    const body = JSON.parse(f.calls[0].init.body);
    expect(body).toMatchObject({ travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE' });
    expect(body.intermediates).toHaveLength(1);
    await s.route(pts);
    expect(f.calls).toHaveLength(1);
  });

  it('route returns null (caller estimates) without a key or when Google fails', async () => {
    const s = new MapsService();
    s.key = () => undefined;
    expect(await s.route([{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }])).toBeNull();
    s.key = () => 'KEY';
    s.fetcher = fakeFetch([{ status: 403, body: { error: { message: 'Routes API not enabled' } } }]).fn as never;
    expect(await s.route([{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }])).toBeNull();
  });
});
