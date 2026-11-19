import L from 'leaflet';

/**
 * Small top-down car icon for the fleet map, coloured by status (green free, orange busy…).
 * Icons are cached per colour/size so the map doesn't rebuild DOM on every position update.
 */
const cache = new Map<string, L.DivIcon>();

export function carSvg(color: string, size = 24, outline = '#ffffff'): string {
  // 24×24 viewBox, car pointing up: body, windscreen, rear window, wheels.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
  <rect x="5.2" y="3.6" width="1.6" height="4" rx="0.6" fill="#212529"/>
  <rect x="17.2" y="3.6" width="1.6" height="4" rx="0.6" fill="#212529"/>
  <rect x="5.2" y="15.6" width="1.6" height="4" rx="0.6" fill="#212529"/>
  <rect x="17.2" y="15.6" width="1.6" height="4" rx="0.6" fill="#212529"/>
  <rect x="6.3" y="1.5" width="11.4" height="21" rx="3.6" fill="${color}" stroke="${outline}" stroke-width="1.2"/>
  <path d="M8.2 7.2 Q12 5.6 15.8 7.2 L15 9.8 Q12 9 9 9.8 Z" fill="#e7f5ff" opacity="0.9"/>
  <path d="M9 16.4 Q12 17.2 15 16.4 L15.6 18.6 Q12 19.8 8.4 18.6 Z" fill="#e7f5ff" opacity="0.75"/>
  <rect x="9.2" y="10.6" width="5.6" height="5" rx="1" fill="#000" opacity="0.12"/>
</svg>`;
}

export function carIcon(color: string, opts: { selected?: boolean; dimmed?: boolean } = {}): L.DivIcon {
  const size = opts.selected ? 32 : 24;
  const key = `${color}|${size}|${opts.dimmed ? 1 : 0}`;
  let icon = cache.get(key);
  if (!icon) {
    icon = L.divIcon({
      className: `cw-car${opts.selected ? ' cw-car--selected' : ''}${opts.dimmed ? ' cw-car--dimmed' : ''}`,
      html: carSvg(color, size),
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
      tooltipAnchor: [size / 2, 0],
    });
    cache.set(key, icon);
  }
  return icon;
}
