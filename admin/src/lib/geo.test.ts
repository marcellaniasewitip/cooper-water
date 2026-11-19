import { describe, expect, it } from 'vitest';
import { circleToLatLngs, latLngsToPolygon, polygonToLatLngs } from './geo';

describe('depot geofence geometry', () => {
  it('builds a closed GeoJSON ring in [lng, lat] order', () => {
    const p = latLngsToPolygon([
      [-9.44, 147.18],
      [-9.44, 147.19],
      [-9.45, 147.19],
    ]);
    expect(p.type).toBe('Polygon');
    expect(p.coordinates[0]).toEqual([
      [147.18, -9.44],
      [147.19, -9.44],
      [147.19, -9.45],
      [147.18, -9.44],
    ]);
  });

  it('round-trips back to open [lat, lng] points', () => {
    const pts: [number, number][] = [
      [-9.44, 147.18],
      [-9.44, 147.19],
      [-9.45, 147.19],
      [-9.45, 147.18],
    ];
    expect(polygonToLatLngs(latLngsToPolygon(pts))).toEqual(pts);
    expect(polygonToLatLngs(null)).toEqual([]);
  });

  it('requires at least three points', () => {
    expect(() => latLngsToPolygon([[0, 0], [1, 1]])).toThrow();
  });

  it('approximates a circle around the depot', () => {
    const pts = circleToLatLngs([-9.4438, 147.1803], 150, 8);
    expect(pts).toHaveLength(8);
    // ~150 m north of the centre is ~0.00135° of latitude
    const north = pts[2];
    expect(Math.abs(north[0] - -9.4438 - 150 / 111_320)).toBeLessThan(1e-5);
  });
});

describe('distanceM', () => {
  it('measures about 1.1 km per 0.01° of latitude near Port Moresby', async () => {
    const { distanceM } = await import('./geo');
    expect(Math.round(distanceM(-9.44, 147.18, -9.43, 147.18))).toBeGreaterThan(1100);
    expect(Math.round(distanceM(-9.44, 147.18, -9.43, 147.18))).toBeLessThan(1120);
    expect(distanceM(-9.44, 147.18, -9.44, 147.18)).toBe(0);
  });
});
