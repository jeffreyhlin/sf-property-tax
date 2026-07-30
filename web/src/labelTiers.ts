/**
 * Progressive-disclosure map labels.
 *
 * The map currently encodes everything in a color ramp, which needs a legend to
 * read. Labels put the number on the map instead, but 206,771 of them cannot all
 * be drawn, so the label unit changes with zoom:
 *
 *   neighborhood   below z12      41 of them, centroids already in the data
 *   assessor block z12 to z15.5   derived from the APN's first four digits
 *   parcel         above z15.5    individual, decluttered hard
 *
 * Decluttering runs on the GPU via CollisionFilterExtension rather than a fixed
 * cap, so a wide-open viewport in the Sunset and a tight one downtown both end
 * up showing as many labels as actually fit. MAX_LABELS is only a backstop for
 * the case where far too many would fit to be worth reading.
 *
 * The pill shows share-of-value-taxed at every tier. Dollars are not comparable
 * across tiers, since a neighborhood's figure is a sum and a parcel's is its
 * own, and swapping the unit mid-zoom breaks the one comparison the map makes.
 */

export type LabelTier = 'neighborhood' | 'block' | 'parcel';

export const TIER_BREAKS = { block: 12, parcel: 15.5 } as const;

/** A backstop, not the mechanism. Collision filtering does the real work. */
export const MAX_LABELS = 28;

export function tierForZoom(zoom: number): LabelTier {
  if (zoom >= TIER_BREAKS.parcel) return 'parcel';
  if (zoom >= TIER_BREAKS.block) return 'block';
  return 'neighborhood';
}

export type MapLabel = {
  key: string;
  text: string;
  position: [number, number];
  /** 0..1 share of estimated market value actually taxed */
  ratio: number | null;
  /** annual dollars kept, for the tooltip and for savings-weighted priority */
  dollars: number;
  /** how many parcels this label speaks for; 1 at parcel tier */
  count: number;
};

/**
 * Which labels win when they collide.
 *
 * "spread" ranks by how far a block sits from its neighbourhood's median, so the
 * map points at inequality between comparable houses. "savings" ranks by dollars
 * kept, which surfaces individual households by name. Both are arguments; the
 * second one is an argument about people.
 */
export type LabelBias = 'spread' | 'savings';

/**
 * Priority for CollisionFilterExtension, clamped to its -1000..1000 range.
 * The selected parcel always wins, otherwise someone searches their own address
 * and watches a neighbour's label take its place.
 */
export function labelPriority(
  l: MapLabel,
  bias: LabelBias,
  selectedKey: string | null,
  medianRatio: number,
): number {
  if (selectedKey && l.key === selectedKey) return 1000;
  if (bias === 'savings') {
    // log-scaled: raw dollars would let one $600k parcel outrank everything.
    return Math.min(900, Math.round(Math.log10(Math.max(l.dollars, 1)) * 150));
  }
  // spread: distance below the local median, so an ordinary house scores 0
  const r = l.ratio ?? medianRatio;
  return Math.min(900, Math.round(Math.max(0, medianRatio - r) * 1200));
}

export const fmtPct = (r: number | null) => (r == null ? '' : `${Math.round(r * 100)}%`);

/**
 * Compact dollars for a pill. At parcel tier this is one household's annual
 * amount; at block and neighbourhood tier it is a sum, which is a different
 * kind of quantity even though the units match. Worth keeping in mind when
 * reading a block's $4.1M next to a house's $65k.
 */
export function fmtUsd(d: number): string {
  if (!Number.isFinite(d) || d <= 0) return '';
  if (d >= 1e9) return `$${(d / 1e9).toFixed(1)}B`;
  if (d >= 1e6) return `$${(d / 1e6).toFixed(d >= 1e7 ? 0 : 1)}M`;
  if (d >= 1e3) return `$${Math.round(d / 1e3)}k`;
  // Everything else is thousands, so a bare "$131" sitting next to "$19k" reads
  // as 131 thousand at a glance. Collapse the small tail instead.
  return '<$1k';
}

export type LabelText = 'pct' | 'usd';

/** Roll parcels up to their assessor block. APN 2765001 -> block 2765. */
export function blockOf(apn: string): string {
  return String(apn).replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 4);
}

type ParcelLike = {
  id: string;
  ratio?: number | null;
  savings?: number | null;
};

/**
 * Aggregate loaded parcels into block labels. Centroid comes from the mean of
 * member parcel positions, which is close enough for a label anchor and avoids
 * shipping block geometry we do not have.
 */
export function blockLabels(
  parcels: Array<{ props: ParcelLike; lon: number; lat: number }>,
): MapLabel[] {
  const acc = new Map<string, { lon: number; lat: number; n: number; ratios: number[]; dollars: number }>();
  for (const { props, lon, lat } of parcels) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const b = blockOf(props.id);
    let e = acc.get(b);
    if (!e) acc.set(b, (e = { lon: 0, lat: 0, n: 0, ratios: [], dollars: 0 }));
    e.lon += lon;
    e.lat += lat;
    e.n += 1;
    e.dollars += props.savings ?? 0;
    if (props.ratio != null) e.ratios.push(props.ratio);
  }
  const out: MapLabel[] = [];
  for (const [b, e] of acc) {
    if (!e.n) continue;
    const sorted = e.ratios.sort((x, y) => x - y);
    out.push({
      key: `block-${b}`,
      text: sorted.length ? fmtPct(sorted[Math.floor(sorted.length / 2)]) : '—',
      position: [e.lon / e.n, e.lat / e.n],
      ratio: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      dollars: e.dollars,
      count: e.n,
    });
  }
  return out;
}
