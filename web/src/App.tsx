import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer, IconLayer } from '@deck.gl/layers';
import { CollisionFilterExtension } from '@deck.gl/extensions';
import {
  FlyToInterpolator,
  WebMercatorViewport,
  type MapViewState,
  type PickingInfo,
} from '@deck.gl/core';
import { Map } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';
import { FAQ } from './faq';
import { SankeyView } from './SankeyView';
import { narrate, narrateText, stopNarration, primeNarration } from './narrator';
import {
  tierForZoom, blockLabels, labelPriority, fmtPct, fmtUsd, MAX_LABELS,
  cullToScreen,
  type MapLabel, type LabelBias, type LabelText,
} from './labelTiers';
// PMTiles overview layer (pipeline/tiles.py builds data/parcels.pmtiles) is staged
// but not wired: MVTLayer needs a data source to activate tiling; see docs/proposals.md.
// import { PMTilesLayer } from './pmtilesLayer';

// Two states, not four tabs. The story is a one-way funnel that releases you
// into the map, and the map is where you stay. Breakdown is now a chapter
// inside the story; compare is a tool layered over the map.
type ViewMode = 'story' | 'explore';

// Minimal lucide-style line icons (stroke = currentColor, no fill).
const ICON_PATHS: Record<string, string> = {
  map: 'M9 6 3 4v14l6 2 6-2 6 2V6l-6-2-6 2zm0 0v14M15 4v14',
  story: 'M4 5a2 2 0 0 1 2-2h6v16H6a2 2 0 0 0-2 2V5zm16 0a2 2 0 0 0-2-2h-6v16h6a2 2 0 0 1 2 2V5z',
  breakdown: 'M4 5h5a4 4 0 0 1 4 4v10M4 12h6a4 4 0 0 0 4-4V5m0 14h6M4 19h4',
  compare: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  home: 'M3 10.5 12 3l9 7.5M5 9.5V20h14V9.5',
  building: 'M4 21V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v17M15 21V9h4a1 1 0 0 1 1 1v11M8 7h2M8 11h2M8 15h2',
  transfer: 'M7 4 3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8',
  cube: 'M12 2 3 7v10l9 5 9-5V7l-9-5zM3 7l9 5 9-5M12 12v10',
  play: 'M6 4l14 8-14 8V4z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.4-3.4',
};

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

const BASEMAP = 'https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json';
// Shared by the picker and the comparison table, so hoisted out of App.
const MAX_COMPARE = 6;
const PARCEL_ZOOM = 13; // below this, show neighborhood bubbles instead of parcels

// Set to your Ko-fi / GitHub Sponsors / Stripe payment link to show a Donate button.
const DONATE_URL = '';

// Backend that looks up a parcel's recorded documents by APN from the SF Recorder
// public index and caches them (see worker/records-worker.mjs). The index is open
// — no login, no CAPTCHA on search — so the worker retrieves the full record set
// on demand, one parcel at a time, and caches it. Set VITE_RECORDS_API to point at
// a deployed worker; empty string forces demo mode (sample rows, clearly labeled).
// Where deed records come from, in precedence order:
//   1. VITE_RECORDS_API   a running worker, if one is configured
//   2. static files       /records/<apn>.json, from worker/export-static.mjs
//   3. /api/records       a serverless lookup against the county index
//
// Only a few hundred parcels are seeded as static files. Step 3 is what makes
// the other ~206,600 clickable: the static file is tried first because it is
// instant and costs the county nothing, and only a genuine miss escalates to a
// live lookup. Set VITE_RECORDS_LIVE=0 to turn that off and go back to a purely
// static site.
const RECORDS_API =
  import.meta.env.VITE_RECORDS_API ?? (import.meta.env.DEV ? 'http://localhost:8788/records' : '');
const RECORDS_STATIC = import.meta.env.VITE_RECORDS_STATIC ?? '/records';
const RECORDS_LIVE = import.meta.env.VITE_RECORDS_LIVE === '0' ? '' : '/api/records';
const RECORDS_DEMO = import.meta.env.VITE_RECORDS_DEMO === '1';

type DeedRecord = {
  date: string;        // recording date YYYY-MM-DD
  docType: string;     // e.g. "DEED", "TRUST TRANSFER DEED", "DEED OF TRUST"
  grantor?: string | null;  // (R) party/parties, joined
  grantee?: string | null;  // (E) party/parties, joined
  grantors?: string[];
  grantees?: string[];
  docNumber?: string;
  kind?: 'market' | 'relational' | 'other'; // transfer classification from doc type
  transferTax?: number | null; // $0 => exempt (family/trust); >0 => arm's-length
};

type RecordsState =
  | { status: 'idle' }
  // `live` distinguishes reading a seeded file from querying the county, which
  // is slow enough that the reader should be told which one is happening.
  | { status: 'loading'; live?: boolean }
  | { status: 'error'; message: string; busy?: boolean }
  | { status: 'done'; demo: boolean; records: DeedRecord[]; fetchedAt: string; miss?: boolean };

// The recorder joins a document's filing codes with literal <br/>, and 401
// parcels were exported before the worker started splitting them. Normalizing
// at display time fixes the already-published files without re-querying the
// county for every one of them.
function docLabel(docType: string | null | undefined): string {
  if (!docType) return 'Deed';
  return docType
    .split(/<br\s*\/?>/i)
    .map((s) => tidy(s))
    .filter(Boolean)
    .join(' \u00b7 ') || 'Deed';
}

// The county's own records carry stray runs of whitespace ("ORIDE TAD S &
// MASUMI"). Collapse them for reading only: the published JSON stays a
// faithful copy of what the recorder holds.
function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function partyName(name: string | null | undefined): string {
  const t = name ? tidy(name) : '';
  return t || '\u2014';
}

// Demo fallback: turn our inferred transfer events into plausible deed rows so the
// on-demand UX is demonstrable. Labeled as sample data, NOT real recorder output.
function demoRecords(sel: ParcelProps): DeedRecord[] {
  const kindToDoc: Record<string, { docType: string; tax: number | null }> = {
    reset: { docType: 'Grant Deed', tax: 1 },
    market: { docType: 'Grant Deed', tax: 1 },
    excluded: { docType: 'Trust Transfer Deed', tax: 0 },
    relational: { docType: 'Trust Transfer Deed', tax: 0 },
    partial: { docType: 'Deed', tax: null },
  };
  return [...sel.events]
    .reverse()
    .map(([yr, kind]) => {
      const d = kindToDoc[kind] ?? { docType: 'Deed', tax: null };
      return { date: `${yr}-01-01`, docType: d.docType, transferTax: d.tax, grantor: '—', grantee: '—' };
    });
}

// ---- map label pills -------------------------------------------------------
// TextLayer's background is a plain quad with no corner radius, so the price
// labels rendered as rectangles. Each label is drawn once to a small canvas as
// a proper pill and shown through an IconLayer; the cache is keyed by text and
// state, and the culled label set tops out around 224, so this stays cheap.
const PILL_H = 22; // CSS px on screen; sprites are drawn at 2x for retina
type PillSprite = { url: string; width: number; height: number };
const pillCache = new globalThis.Map<string, PillSprite>();

function pillSprite(text: string, on: boolean): PillSprite {
  const key = (on ? 's:' : 'n:') + text;
  const hit = pillCache.get(key);
  if (hit) return hit;
  const S = 2;
  const padX = 8;
  const h = PILL_H;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `600 ${12 * S}px "Avenir Next", Avenir, -apple-system, system-ui, sans-serif`;
  ctx.font = font;
  const tw = Math.ceil(ctx.measureText(text).width / S);
  const w = tw + padX * 2;
  canvas.width = w * S;
  canvas.height = h * S;
  ctx.scale(S, S);
  ctx.font = `600 12px "Avenir Next", Avenir, -apple-system, system-ui, sans-serif`;
  const r = h / 2 - 0.5;
  ctx.beginPath();
  ctx.roundRect(0.75, 0.75, w - 1.5, h - 1.5, r);
  ctx.fillStyle = on
    ? (BRAND_V3 ? '#1f1e1b' : '#b25007')
    : (BRAND_V3 ? 'rgba(250,249,246,0.95)' : 'rgba(255,253,248,0.95)');
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = on
    ? (BRAND_V3 ? '#1f1e1b' : '#b25007')
    : (BRAND_V3 ? '#c8c5bb' : '#cdc3ad');
  ctx.stroke();
  ctx.fillStyle = on ? (BRAND_V3 ? '#faf9f6' : '#fffdf8') : (BRAND_V3 ? '#1f1e1b' : '#2c2418');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 0.5);
  const sprite = { url: canvas.toDataURL(), width: w * S, height: h * S };
  pillCache.set(key, sprite);
  return sprite;
}

const INITIAL_VIEW: MapViewState = {
  longitude: -122.4425,
  latitude: 37.758,
  zoom: 11.6,
  // Flat and top-down. The old opening pitched 42 degrees into a fully
  // extruded neighborhood model, which read as tall blocks hiding the city.
  // Height is now opt-in through the 3D toggle; the citywide numbers arrive
  // as label pills instead.
  pitch: 0,
  bearing: 0,
};

type HistEntry = [number, number, number | null]; // [year, assessed, est market | null]

type ParcelProps = {
  id: string;
  addr: string;
  nbhd: string;
  use: string;
  cls: 'sfh' | 'multi' | 'commercial';
  built: string | null;
  units: number | null;
  area: number | null;
  assessed: number;
  estMarket: number | null;
  ratio: number | null;
  taxEst: number;
  savings: number | null;
  basisYear: number | null;
  saleDate: string | null;
  transferType: 'none' | 'market' | 'relational' | 'partial';
  transferYear: number | null;
  avoidedSince: number | null;
  events: [number, 'reset' | 'excluded' | 'partial'][];
  periods: [number, number, 'initial' | 'market' | 'relational' | 'partial', number | null][];
  street: string | null;
  hist: HistEntry[];
};

type Feature = {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: ParcelProps;
};

type LeaderRow = {
  id: string;
  addr: string;
  nbhd: string;
  cls: 'sfh' | 'multi';
  assessed: number;
  estMarket: number;
  savings: number;
  basisYear: number | null;
  transferType: string;
  transferYear: number | null;
  avoidedSince: number | null;
};

type Boards = Record<'sfh' | 'multi', { topSavings: LeaderRow[]; topRelational: LeaderRow[] }>;

type Neighborhood = {
  name: string;
  slug: string;
  center: [number, number] | null;
  parcels: number;
  transfers: number;
  relational: number;
  totalSavings: number;
  relationalSavings: number;
  savingsPerParcel: number;
  medianRatio: number | null;
  ppsfByYear: Record<string, number>;
  savingsByYear: Record<string, number>;
  trend5y: number | null;
  trendYears: number | null;
};

type Chunk = { slug: string; name: string; count: number; bbox: [number, number, number, number] | null; bytes: number };

type PropType = 'all' | 'sfh' | 'multi' | 'commercial';

type NbTypeStat = {
  parcels: number;
  relational: number;
  totalSavings: number;
  savingsPerParcel: number;
  savingsByYear: Record<string, number>;
  parcelsByYear: Record<string, number>;
};

type NbFeatureProps = {
  name: string;
  slug: string;
  center: [number, number] | null;
  medianRatio: number | null;
  trend5y: number | null;
  byType: Record<PropType, NbTypeStat>;
};

type NbFeature = { type: 'Feature'; geometry: { type: string; coordinates: unknown }; properties: NbFeatureProps };

const TYPE_LABEL: Record<PropType, string> = {
  all: 'All property',
  sfh: 'Single-family',
  multi: 'Multi-family',
  commercial: 'Commercial',
};

// annual est. savings for a neighborhood in a given type + year (year null = latest)
function nbSavings(p: NbFeatureProps, type: PropType, year: number | null, rollYear: number): number {
  const t = p.byType[type];
  if (!t) return 0;
  const y = String(year ?? rollYear);
  return t.savingsByYear[y] ?? (year == null ? t.totalSavings : 0);
}

// loaded chunk cache entry. `filtered` memoizes the visible subset per
// (transfersOnly, typeFilter) combo so each layer's `data` array keeps a stable
// reference across re-renders and deck.gl never re-tessellates old chunks.
type ChunkEntry = { all: Feature[]; transfers: Feature[]; filtered: Map<string, Feature[]>; touched: number };

const MAX_LOADED_CHUNKS = 12;

function chunkData(entry: ChunkEntry, transfersOnly: boolean, typeFilter: PropType): Feature[] {
  const key = `${transfersOnly ? 't' : 'a'}|${typeFilter}`;
  let cached = entry.filtered.get(key);
  if (!cached) {
    const base = transfersOnly ? entry.transfers : entry.all;
    cached = typeFilter === 'all' ? base : base.filter((f) => f.properties.cls === typeFilter);
    entry.filtered.set(key, cached);
  }
  return cached;
}

type SankeyFlow = { cls: 'sfh' | 'multi'; origin: 'prehold' | 'market' | 'relational'; savings: number; count: number };

// §408.1 transfer-list overlay (pipeline/deeds.py). Real recorded-transfer rows
// keyed by parcel; feeds the records lookup below as the authoritative source.
type OverlayDeed = {
  date: string;
  docType: string | null;
  docNum: string | null;
  grantor: string | null;
  grantee: string | null;
  consideration: number | null;
  kind: 'relational' | 'market' | 'other';
};
type DeedStore = { source: string; byParcel: Record<string, { verified: boolean; transfers: OverlayDeed[] }> };

// The SF Recorder index is searchable by APN (block + lot). The worker retrieves
// records automatically; this link is the manual "verify it yourself" path — its
// hash-router SPA can't be reliably pre-filled via URL, so we open the search and
// copy the exact block-lot to the clipboard for the user to paste.
const RECORDER_SEARCH_URL = 'https://recorder.sfgov.org/#/search';

function blockLot(blklot: string): { block: string; lot: string } {
  return { block: blklot.slice(0, 4).replace(/^0+/, '') || blklot.slice(0, 4), lot: blklot.slice(4) };
}

type Meta = {
  generatedAt: string | null;
  sourceDataAsOf: string | null;
  rollYear: number;
  taxRate: number;
  parcelCount: number;
  sankey: SankeyFlow[];
  totalEstAnnualSavings: number;
  relationalTransferCount: number;
  medianRatio: Record<string, Record<string, number>>;
  savingsByYear: Record<string, number>;
  estimatedParcelsByYear: Record<string, number>;
  neighborhoods: Neighborhood[];
  chunks: Chunk[];
};

type SearchIndex = {
  nbhds: string[];
  id: string[];
  addr: string[];
  nb: number[];
  x: (number | null)[];
  y: (number | null)[];
};

const fmt$ = (n: number) => '$' + Math.round(n).toLocaleString();
const fmt$k = (n: number) =>
  n >= 1_000_000_000
    ? '$' + (n / 1_000_000_000).toFixed(1) + 'B'
    : n >= 1_000_000
      ? '$' + (n / 1_000_000).toFixed(1) + 'M'
      : '$' + Math.round(n / 1000) + 'k';

// ratio 1 = assessed at market (pastel yellow) -> ratio ~0 = deep subsidy (burnt orange)
const RAMP_DEFAULT: [number, number, number][] = [
  [252, 240, 197],
  [247, 210, 120],
  [238, 166, 72],
  [214, 116, 32],
  [178, 80, 7],
];
// v3: the encoding is unchanged, only the hue. Keeping the same lightness steps
// means the map still reads as a heat map rather than a flat wash.
const RAMP_V3: [number, number, number][] = [
  [248, 245, 239],
  [236, 214, 194],
  [216, 171, 139],
  [192, 122, 81],
  [164, 71, 31],
];
// Read at module scope: it is a URL flag that cannot change during a session,
// and doing it in an effect meant the first paint used the wrong ramp.
const BRAND_V3 =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('brand') === 'v3';
const activeRamp = BRAND_V3 ? RAMP_V3 : RAMP_DEFAULT;
if (BRAND_V3 && typeof document !== 'undefined') {
  document.documentElement.classList.add('brand-v3');
}

function ratioColor(ratio: number | null, relational: boolean): [number, number, number, number] {
  if (ratio == null) return [213, 209, 199, 150];
  // gamma 1.5 spreads the palette across the real distribution (median ratio
  // ~0.43): near-market homes read pale, only genuine deep-subsidy homes go dark
  const lin = Math.max(0, Math.min(1, (1 - ratio) / 0.9));
  const t = Math.pow(lin, 1.5);
  const stops = activeRamp;
  const x = t * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f)) as [number, number, number];
  return [c[0], c[1], c[2], relational ? 240 : 210];
}

// ratio (assessed / est. market) for a parcel in a given year, or null if that
// year has no market estimate. year === null means "use the current-year ratio".
function ratioAtYear(p: ParcelProps, year: number | null): number | null {
  if (year == null) return p.ratio;
  for (const [yr, assessed, est] of p.hist) {
    if (yr === year) return est && est > 0 ? Math.min(assessed / est, 1) : null;
  }
  return null;
}

function centroidOf(geom: { type: string; coordinates: unknown }): [number, number] {
  let ring: number[][] = [];
  if (geom.type === 'Polygon') ring = (geom.coordinates as number[][][])[0];
  else if (geom.type === 'MultiPolygon') ring = (geom.coordinates as number[][][][])[0][0];
  if (!ring?.length) return [INITIAL_VIEW.longitude, INITIAL_VIEW.latitude];
  const [sx, sy] = ring.reduce(([ax, ay], [x, y]) => [ax + x, ay + y], [0, 0]);
  return [sx / ring.length, sy / ring.length];
}

// Wording note (2026-07): these labels used to say "family/trust transfer".
// Checking real recorded deeds against this inference showed that roughly 84% of
// the parcels we flagged that way were actually arm's-length events (foreclosures,
// developer sales, corporate relocations, affordable-housing partnerships), not
// families passing property down. Assessment data alone can only tell us that a
// transfer happened WITHOUT a reassessment, so that is all these labels now claim.
// Deed-level parties, where we have them, appear in the Recorded documents panel.
// See docs/recorder-validation-findings.md.
const TRANSFER_LABEL: Record<string, string> = {
  relational: 'Transferred without reassessment',
  market: 'Market sale (reassessed)',
  partial: 'Partial reassessment',
  none: 'No transfer on record since 2007',
};

const EVENT_LABEL: Record<string, string> = {
  excluded: 'transfer, no reassessment',
  reset: 'market sale',
  partial: 'partial reassessment',
};

function gapLabel(parcelRatio: number, medianR: number | undefined): string | null {
  if (!medianR) return null;
  const rel = parcelRatio / medianR;
  if (rel <= 0.75) return 'well above average';
  if (rel <= 0.95) return 'above average';
  if (rel < 1.1) return 'about average';
  return 'below average';
}

function DeltaChart({
  hist,
  events,
  nbhd,
  meta,
}: {
  hist: HistEntry[];
  events: [number, 'reset' | 'excluded' | 'partial'][];
  nbhd: string;
  meta: Meta | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 292, h = 150, padX = 10, padTop = 14, padBot = 18;
  const years = hist.map((d) => d[0]);
  const maxV = Math.max(...hist.map((d) => Math.max(d[1], d[2] ?? 0)), 1);
  const minY = Math.min(...years), maxY = Math.max(...years);
  const x = (yr: number) => padX + ((yr - minY) / Math.max(1, maxY - minY)) * (w - 2 * padX);
  const y = (v: number) => h - padBot - (v / maxV) * (h - padTop - padBot);
  const eventByYear = new globalThis.Map(events.map(([yr, k]) => [yr, k]));

  const hovered = hover != null ? hist[hover] : null;
  const hoverInfo = (() => {
    if (!hovered) return null;
    const [year, assessed, est] = hovered;
    const event = eventByYear.get(year);
    if (est == null) return { year, assessed, est: null, delta: null, taxDelta: null, label: null, event };
    const delta = est - assessed;
    const taxDelta = delta * (meta?.taxRate ?? 0.0118);
    const label = gapLabel(assessed / est, meta?.medianRatio?.[nbhd]?.[String(year)]);
    return { year, assessed, est, delta, taxDelta, label, event };
  })();

  return (
    <div className="chart">
      <svg
        width={w}
        height={h}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const mx = e.clientX - rect.left;
          let best = 0, bestD = Infinity;
          hist.forEach(([yr], i) => {
            const d = Math.abs(x(yr) - mx);
            if (d < bestD) { bestD = d; best = i; }
          });
          setHover(best);
        }}
      >
        {hovered && (
          <rect
            x={x(hovered[0]) - 6}
            y={padTop - 4}
            width={12}
            height={h - padTop - padBot + 8}
            className="chart-hoverband"
          />
        )}
        {events.map(([yr, kind]) => (
          <g key={'ev' + yr}>
            <line x1={x(yr)} x2={x(yr)} y1={padTop - 4} y2={h - padBot + 4} className={`event-line event-${kind}`} />
            <path
              d={`M${x(yr) - 4},${padTop - 6} L${x(yr) + 4},${padTop - 6} L${x(yr)},${padTop} Z`}
              className={`event-flag event-${kind}`}
            />
          </g>
        ))}
        {hist.map(([yr, assessed, est], i) => (
          <g key={yr}>
            {est != null && (
              <line x1={x(yr)} x2={x(yr)} y1={y(assessed)} y2={y(est)}
                className={i === hover ? 'delta-line hot' : 'delta-line'} />
            )}
            {est != null && <circle cx={x(yr)} cy={y(est)} r={i === hover ? 4 : 2.5} className="dot-market" />}
            <circle cx={x(yr)} cy={y(assessed)} r={i === hover ? 4 : 2.5} className="dot-assessed" />
          </g>
        ))}
        <text x={padX} y={h - 4} className="chart-label">{minY}</text>
        <text x={w - padX} y={h - 4} textAnchor="end" className="chart-label">{maxY}</text>
      </svg>
      <div className="chart-key">
        <span><i className="key-dot key-market" /> market</span>
        <span><i className="key-dot key-assessed" /> taxed</span>
        {events.some(([, k]) => k === 'excluded') && <span className="key-event event-excluded-text">▼ transfer, no reassessment</span>}
        {events.some(([, k]) => k === 'reset') && <span className="key-event event-reset-text">▼ sale</span>}
      </div>
      <div className="chart-info">
        {hoverInfo ? (
          <>
            <b>{hoverInfo.year}</b>
            {hoverInfo.event && (
              <span className={`event-chip event-${hoverInfo.event}`}>{EVENT_LABEL[hoverInfo.event]}</span>
            )}
            {hoverInfo.est != null ? (
              <>
                {' '}gap {fmt$k(hoverInfo.delta!)} ≈ {fmt$(hoverInfo.taxDelta!)}/yr in tax
                {hoverInfo.label && <span className="chart-verdict"> · {hoverInfo.label}</span>}
              </>
            ) : (
              <> taxed {fmt$k(hoverInfo.assessed)} · no market estimate</>
            )}
          </>
        ) : (
          <span className="chart-hint">hover a year · ▼ marks a change of hands</span>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [searchIdx, setSearchIdx] = useState<SearchIndex | null>(null);
  const [leaders, setLeaders] = useState<Boards | null>(null);
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW);
  const [selected, setSelected] = useState<ParcelProps | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ViewMode>('explore');
  const [boardTab, setBoardTab] = useState<'relational' | 'all'>('relational');
  const [boardCls, setBoardCls] = useState<'sfh' | 'multi'>('sfh');
  const [compareTab, setCompareTab] = useState<'neighborhoods' | 'parcels'>('neighborhoods');
  // Rankings moved out of the old Compare tab: it is discovery, not comparison.
  const [showRankings, setShowRankings] = useState(false);
  // Compare is now a mode over the map. While it is on, clicking a parcel adds
  // or removes it from the set instead of opening the detail panel.
  const [compareMode, setCompareMode] = useState(false);
  const [comparePicks, setComparePicks] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareFull, setCompareFull] = useState(false);
  const [compareData, setCompareData] = useState<Record<string, DeedRecord[]>>({});
  const [audioOn, setAudioOn] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [typeFilter, setTypeFilter] = useState<PropType>('all');
  const [nbhdRank, setNbhdRank] = useState<'total' | 'perParcel' | 'relational'>('total');
  const [transfersOnly, setTransfersOnly] = useState(true);
  const [extrude, setExtrude] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showCsvGate, setShowCsvGate] = useState(false);
  const [year, setYear] = useState<number | null>(null); // null = current roll year
  const [chunkVersion, setChunkVersion] = useState(0); // bumped when a chunk loads
  const [loadingChunks, setLoadingChunks] = useState(0);

  const embed = useMemo(() => new URLSearchParams(window.location.search).get('embed') === '1', []);
  // Label-tier prototype. Dev builds only, behind ?labels=1, so it cannot ship
  // by accident while we are still deciding whether it holds up.
  const labelProto = useMemo(
    () => import.meta.env.DEV && new URLSearchParams(window.location.search).get('labels') === '1',
    [],
  );
  // The pills themselves ship for everyone in explore; labelsOn above now
  // gates only the dev readout and its bias/unit switches.
  const labelsOn = view === 'explore';
  const [labelBias, setLabelBias] = useState<LabelBias>('savings');
  // The screen-space cull needs the real surface size. Memoising it off view
  // state alone meant a result computed before first layout stuck around, and
  // a window resize never invalidated it.
  const [mapSize, setMapSize] = useState<[number, number]>([0, 0]);
  const [chromeRects, setChromeRects] = useState<Array<[number, number, number, number]>>([]);
  // Bumped by the ResizeObserver so the post-paint measurement re-runs on
  // resize as well as on state that opens or closes a panel.
  const [chromeTick, setChromeTick] = useState(0);
  useEffect(() => {
    const el = document.querySelector('.map-pane');
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setChromeTick((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [labelText, setLabelText] = useState<LabelText>('usd');

  // the year sweep only lives in the Story; leaving it snaps back to current
  useEffect(() => {
    if (view !== 'story') setYear(null);
  }, [view]);

  // On parcel select, look up its recorded documents by APN — cache-first, so
  // each parcel hits the county index at most once and the result is saved.
  useEffect(() => {
    const sel = selected;
    if (!sel) {
      setRecords({ status: 'idle' });
      return;
    }
    // Real data is cached across sessions; demo rows never are, since a stale
    // demo entry would shadow real records.
    const cached = RECORDS_DEMO ? undefined : recordsCache.current.get(sel.id);
    if (cached) {
      setRecords({ status: 'done', demo: false, records: cached, fetchedAt: 'cached' });
      return;
    }
    let cancelled = false;
    setRecords({ status: 'loading' });
    const finish = (recs: DeedRecord[], miss = false) => {
      if (cancelled) return;
      if (!RECORDS_DEMO && !miss) {
        recordsCache.current.set(sel.id, recs);
        localStorage.setItem('sfptg-records-v2', JSON.stringify([...recordsCache.current]));
      }
      setRecords({ status: 'done', demo: RECORDS_DEMO, records: recs, fetchedAt: new Date().toISOString().slice(0, 10), miss });
    };
    if (RECORDS_DEMO) {
      const t = setTimeout(() => finish(demoRecords(sel)), 1100); // simulate the lookup
      return () => { cancelled = true; clearTimeout(t); };
    }
    const apn = encodeURIComponent(sel.id.toUpperCase());

    // A seeded parcel answers from a static file. Anything else is looked up
    // live, which takes a second or two, so say so rather than showing an
    // empty record list while it runs.
    const lookUpLive = () => {
      if (!RECORDS_LIVE) return finish([], true);
      if (!cancelled) setRecords({ status: 'loading', live: true });
      return fetch(`${RECORDS_LIVE}?apn=${apn}`)
        .then((r) => (r.ok ? r.json() : r.json().catch(() => ({})).then((b) => Promise.reject(
          Object.assign(new Error(b.busy ? 'busy' : `HTTP ${r.status}`), { busy: !!b.busy }),
        ))))
        .then((d) => finish(d.records ?? [], false));
    };

    const primary = RECORDS_API
      ? fetch(`${RECORDS_API}?apn=${apn}`).then((r) => {
          if (r.status === 404) return null;
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
      : fetch(`${RECORDS_STATIC}/${apn}.json`).then((r) => {
          // The SPA catch-all can answer a missing file with index.html and a
          // 200, so a non-JSON body counts as a miss too.
          if (r.status === 404) return null;
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          if (!(r.headers.get('content-type') || '').includes('json')) return null;
          return r.json();
        });

    primary
      .then((d) => (d ? finish(d.records ?? [], !!d.miss) : lookUpLive()))
      .catch((e) => !cancelled && setRecords({ status: 'error', message: String(e.message || e), busy: !!e.busy }));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  // First visit: show the live map for a beat, then fade into the scroll story.
  // Skipped for embeds, deep links, and returning visitors. We mark it seen when
  // the auto-intro fires, so it never forces itself again (manual Story nav is
  // always available from the sidebar).
  useEffect(() => {
    if (embed) return;
    if (/[#&]p=/.test(window.location.hash)) return;
    if (localStorage.getItem('sfptg-story-seen')) return;
    const t = setTimeout(() => {
      setView('story');
      localStorage.setItem('sfptg-story-seen', '1');
    }, 1300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // recorded-documents lookup cache (persisted so each APN is fetched once, ever)
  const [records, setRecords] = useState<RecordsState>({ status: 'idle' });
  const recordsCache = useRef<globalThis.Map<string, DeedRecord[]>>(
    new globalThis.Map(RECORDS_API ? JSON.parse(localStorage.getItem('sfptg-records-v2') || '[]') : []),
  );

  const chunksRef = useRef<globalThis.Map<string, ChunkEntry>>(new globalThis.Map());
  const fetchingRef = useRef<Set<string>>(new Set());
  const byId = useRef<globalThis.Map<string, Feature>>(new globalThis.Map());
  const pendingSelect = useRef<string | null>(null);
  const selectedSlug = useRef<string | null>(null);
  const hasSelectedOnce = useRef(false);

  const [nbGeo, setNbGeo] = useState<NbFeature[]>([]);
  const [deeds, setDeeds] = useState<DeedStore | null>(null);
  useEffect(() => {
    fetch('data/meta.json').then((r) => r.json()).then(setMeta);
    fetch('data/search-index.json').then((r) => r.json()).then(setSearchIdx);
    fetch('data/leaderboard.json').then((r) => r.json()).then(setLeaders);
    fetch('data/neighborhoods.geojson').then((r) => r.json()).then((fc) => setNbGeo(fc.features));
    fetch('data/deeds.json').then((r) => r.json()).then(setDeeds).catch(() => {});
  }, []);

  // fixed reference so 3D bar heights are comparable across years (bars visibly
  // grow as the gap widens) rather than re-normalizing every frame
  const savingsRef = useMemo(() => {
    let max = 1;
    for (const f of nbGeo) max = Math.max(max, f.properties.byType.all.totalSavings);
    return max;
  }, [nbGeo]);

  // Shareable URLs: #p=ID&v=lng,lat,zoom,pitch,bearing&f=1&y=2015 — every part
  // optional. Written debounced so panning doesn't spam history. Never touch the
  // URL before the first interaction, or we'd wipe an incoming deep link before
  // the restore effect reads it.
  const restoredFromHash = useRef(false);
  useEffect(() => {
    if (selected || year != null) hasSelectedOnce.current = true;
    if (!hasSelectedOnce.current || !restoredFromHash.current) return;
    const t = setTimeout(() => {
      const parts: string[] = [];
      if (selected) parts.push(`p=${selected.id}`);
      const v = viewState;
      parts.push(
        `v=${v.longitude.toFixed(4)},${v.latitude.toFixed(4)},${v.zoom.toFixed(1)},` +
          `${Math.round(v.pitch ?? 0)},${Math.round(v.bearing ?? 0)}`,
      );
      if (!transfersOnly) parts.push('f=0');
      if (year != null) parts.push(`y=${year}`);
      window.history.replaceState(null, '', '#' + parts.join('&'));
    }, 400);
    return () => clearTimeout(t);
  }, [selected, viewState, transfersOnly, year]);

  // Hydrate from the hash once search data is available.
  useEffect(() => {
    if (restoredFromHash.current || !searchIdx) return;
    restoredFromHash.current = true;
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const v = params.get('v');
    if (v) {
      const [lng, lat, zoom, pitch, bearing] = v.split(',').map(Number);
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        setViewState((s) => ({ ...s, longitude: lng, latitude: lat, zoom, pitch: pitch || 0, bearing: bearing || 0 }));
      }
    }
    if (params.get('f') === '0') setTransfersOnly(false);
    const y = params.get('y');
    if (y && Number.isFinite(Number(y))) setYear(Number(y));
    const pid = params.get('p');
    if (pid) {
      const i = searchIdx.id.indexOf(pid);
      if (i >= 0) {
        flyToMatch({
          id: searchIdx.id[i],
          nbhd: searchIdx.nbhds[searchIdx.nb[i]],
          x: searchIdx.x[i],
          y: searchIdx.y[i],
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchIdx]);


  const loadChunk = useCallback((slug: string) => {
    if (chunksRef.current.has(slug) || fetchingRef.current.has(slug)) return;
    fetchingRef.current.add(slug);
    setLoadingChunks((n) => n + 1);
    fetch(`data/nbhd/${slug}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`chunk ${slug}: HTTP ${r.status}`);
        return r.json();
      })
      .then((fc) => {
        if (!Array.isArray(fc?.features)) throw new Error(`chunk ${slug}: bad payload`);
        const all = fc.features as Feature[];
        chunksRef.current.set(slug, {
          all,
          transfers: all.filter((f) => f.properties.transferType !== 'none'),
          filtered: new globalThis.Map(),
          touched: Date.now(),
        });
        fetchingRef.current.delete(slug);
        for (const f of all) byId.current.set(f.properties.id, f);
        if (pendingSelect.current && byId.current.has(pendingSelect.current)) {
          const f = byId.current.get(pendingSelect.current)!;
          setSelected(f.properties);
          selectedSlug.current = slug;
          const [lng, lat] = centroidOf(f.geometry);
          setViewState((v) => ({
            ...v,
            longitude: lng,
            latitude: lat,
            zoom: Math.max(v.zoom, 16.5),
            transitionDuration: 700,
            transitionInterpolator: new FlyToInterpolator(),
          }));
          pendingSelect.current = null;
        }
        setChunkVersion((v) => v + 1);
      })
      .catch((err) => {
        console.warn(err);
        fetchingRef.current.delete(slug);
      })
      .finally(() => setLoadingChunks((n) => n - 1));
  }, []);

  // keep memory bounded: evict least-recently-viewed chunks beyond the cap,
  // never the one holding the current selection or a pending one
  const evictStaleChunks = useCallback(() => {
    const store = chunksRef.current;
    if (store.size <= MAX_LOADED_CHUNKS) return false;
    const entries = [...store.entries()].sort((a, b) => a[1].touched - b[1].touched);
    let evicted = false;
    for (const [slug, entry] of entries) {
      if (store.size <= MAX_LOADED_CHUNKS) break;
      if (slug === selectedSlug.current) continue;
      store.delete(slug);
      for (const f of entry.all) byId.current.delete(f.properties.id);
      evicted = true;
    }
    return evicted;
  }, []);

  // Viewport-driven chunk loading (debounced)
  useEffect(() => {
    if (!meta || viewState.zoom < PARCEL_ZOOM) return;
    const t = setTimeout(() => {
      const vp = new WebMercatorViewport({
        ...viewState,
        width: window.innerWidth,
        height: window.innerHeight,
      } as never);
      // getBounds handles pitch and bearing; corner unprojection does not
      const [west, south, east, north] = vp.getBounds();
      for (const c of meta.chunks) {
        if (!c.bbox) continue;
        const [minx, miny, maxx, maxy] = c.bbox;
        if (minx <= east && maxx >= west && miny <= north && maxy >= south) {
          const entry = chunksRef.current.get(c.slug);
          if (entry) entry.touched = Date.now();
          else loadChunk(c.slug);
        }
      }
      if (evictStaleChunks()) setChunkVersion((v) => v + 1);
    }, 250);
    return () => clearTimeout(t);
  }, [meta, viewState, loadChunk, evictStaleChunks]);

  const shownCounts = useMemo(() => {
    void chunkVersion;
    let shown = 0, total = 0;
    for (const entry of chunksRef.current.values()) {
      total += entry.all.length;
      shown += chunkData(entry, transfersOnly, typeFilter).length;
    }
    return { shown, total };
  }, [chunkVersion, transfersOnly, typeFilter]);

  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (q.length < 3 || !searchIdx) return [];
    const out: { id: string; addr: string; nbhd: string; x: number | null; y: number | null }[] = [];
    for (let i = 0; i < searchIdx.addr.length && out.length < 8; i++) {
      if (searchIdx.addr[i].includes(q)) {
        out.push({
          id: searchIdx.id[i],
          addr: searchIdx.addr[i],
          nbhd: searchIdx.nbhds[searchIdx.nb[i]],
          x: searchIdx.x[i],
          y: searchIdx.y[i],
        });
      }
    }
    return out;
  }, [query, searchIdx]);

  const slugByName = useMemo(() => {
    const m = new globalThis.Map<string, string>();
    meta?.neighborhoods.forEach((n) => m.set(n.name, n.slug));
    return m;
  }, [meta]);

  // Turning compare on clears any open parcel so the map reads as a picker.
  // Turning it off drops the selection and closes the report.
  const toggleCompareMode = () => {
    setCompareMode((on) => {
      const next = !on;
      if (next) setSelected(null);
      else {
        setComparePicks([]);
        setCompareOpen(false);
        setCompareFull(false);
      }
      return next;
    });
    setShowRankings(false);
  };

  // Pull deed records for anything in the compare set, reusing the same cache
  // the parcel panel fills so a parcel is never fetched twice.
  useEffect(() => {
    if (!compareOpen) return;
    let cancelled = false;
    for (const id of comparePicks) {
      if (compareData[id]) continue;
      const cached = recordsCache.current.get(id);
      if (cached) {
        setCompareData((d) => ({ ...d, [id]: cached }));
        continue;
      }
      const url = RECORDS_API
        ? `${RECORDS_API}?apn=${encodeURIComponent(id)}`
        : `${RECORDS_STATIC}/${encodeURIComponent(id.toUpperCase())}.json`;
      fetch(url)
        .then((r) => (r.status === 404 ? { records: [] } : r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => {
          if (cancelled) return;
          const recs: DeedRecord[] = d.records ?? [];
          recordsCache.current.set(id, recs);
          setCompareData((prev) => ({ ...prev, [id]: recs }));
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareOpen, comparePicks.join()]);

  // Audio guide. Museum-style narration that follows what you are looking at.
  // Story beats play a recorded voice; parcel readouts are generated text and
  // fall back to speech synthesis. See narrator.ts.
  const speakBeat = useCallback((id: string) => {
    if (!audioOn) return;
    void narrate(id);
  }, [audioOn]);

  useEffect(() => {
    if (!audioOn) stopNarration();
    // In the story, switching audio on should pick up the beat you are reading
    // rather than announce itself; StoryScroller handles that.
    else if (view !== 'story') void narrate('guide-on');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioOn]);

  // A trust is only nameable when a recorded document actually says so. The
  // assessment roll shows that a property was not reassessed, never why.
  const trustDeed = useMemo(() => {
    if (records.status !== 'done' || records.demo) return null;
    return (
      records.records.find(
        (r) => r.kind === 'relational' && /\bTRUST\b|\bTR\b|LIVING|REVOC/i.test(r.grantee ?? ''),
      ) ?? null
    );
  }, [records]);

  // Narrate a parcel when it is opened.
  useEffect(() => {
    if (!audioOn || !selected) return;
    const p = selected;
    const pct = p.ratio != null ? `${Math.round(p.ratio * 100)} percent of its estimated value` : 'an unknown share of its value';
    narrateText(
      `${p.addr}. Taxed at ${pct}. About ${fmt$(p.savings ?? 0)} a year less than a new buyer would owe.` +
        (p.transferYear ? ` Its taxable value was set in ${p.transferYear}.` : ''),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, audioOn]);

  // Measure the UI furniture after paint, so a panel that just opened is
  // actually in the DOM when we read it. rAF gets us past layout; the same-rect
  // check keeps this from looping through state updates forever.
  useEffect(() => {
    if (!labelsOn) return;
    const SELECTORS =
      '.topbar, .legend, .dock, .panel, .labelproto, .year-slider, .cmp-tray, .board, .rankings, .about-overlay';
    let raf = 0;
    const measure = () => {
      const pane = document.querySelector('.map-pane') as HTMLElement | null;
      if (pane) {
        const pr = pane.getBoundingClientRect();
        const w = Math.round(pr.width);
        const h = Math.round(pr.height);
        setMapSize(([pw, ph]) => (Math.abs(pw - w) > 8 || Math.abs(ph - h) > 8 ? [w, h] : [pw, ph]));
      }
      const next: Array<[number, number, number, number]> = [];
      document.querySelectorAll(SELECTORS).forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width > 2 && r.height > 2) next.push([r.left, r.top, r.right, r.bottom]);
      });
      setChromeRects((prev) => {
        const same =
          prev.length === next.length &&
          prev.every((p, i) => p.every((v, j) => Math.abs(v - next[i][j]) < 2));
        return same ? prev : next;
      });
    };
    raf = requestAnimationFrame(() => {
      measure();
      // panels animate in, so take a second reading once the transition lands
      raf = requestAnimationFrame(measure);
    });
    const t = setTimeout(measure, 420);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelsOn, selected?.id, showRankings, compareOpen, compareFull, showAbout, chromeTick, view]);

  // Fetch the manifest up front, both so the first beat does not wait on it
  // and to decide whether to offer the guide at all.
  const [hasVoice, setHasVoice] = useState(false);
  useEffect(() => { primeNarration().then(setHasVoice); }, []);

  const replayStory = () => {
    setCompareMode(false);
    setComparePicks([]);
    setCompareOpen(false);
    setShowRankings(false);
    setSelected(null);
    setYear(null);
    setView('story');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const flyToMatch = (m: {
    id: string;
    nbhd: string;
    x: number | null;
    y: number | null;
    knownTransfer?: boolean;
  }) => {
    // note: does NOT switch view — callers that need Explore (compare cards,
    // leaderboard rows) set it themselves; the Story selects parcels in place.
    if (m.x != null && m.y != null) {
      setViewState((v) => ({
        ...v,
        longitude: m.x!,
        latitude: m.y!,
        zoom: 17,
        transitionDuration: 900,
        transitionInterpolator: new FlyToInterpolator(),
      }));
    }
    const f = byId.current.get(m.id);
    if (f) {
      pendingSelect.current = null;
      if (f.properties.transferType === 'none') setTransfersOnly(false);
      selectedSlug.current = slugByName.get(f.properties.nbhd) ?? null;
      setSelected(f.properties);
    } else {
      pendingSelect.current = m.id;
      const slug = slugByName.get(m.nbhd);
      if (slug) loadChunk(slug);
      // a searched parcel may not have a transfer; don't hide it behind the
      // filter — unless we already know it IS a transfer (leaderboard rows)
      if (!m.knownTransfer) setTransfersOnly(false);
    }
    setQuery('');
  };

  const flyToNbhd = (n: Neighborhood) => {
    if (!n.center) return;
    setViewState((v) => ({
      ...v,
      longitude: n.center![0],
      latitude: n.center![1],
      zoom: 14.2,
      transitionDuration: 900,
      transitionInterpolator: new FlyToInterpolator(),
    }));
    loadChunk(n.slug);
  };

  const rankedNbhds = useMemo(() => {
    if (!meta) return [];
    const arr = [...meta.neighborhoods];
    if (nbhdRank === 'perParcel') arr.sort((a, b) => b.savingsPerParcel - a.savingsPerParcel);
    else if (nbhdRank === 'relational') arr.sort((a, b) => b.relational - a.relational);
    else arr.sort((a, b) => b.totalSavings - a.totalSavings);
    return arr;
  }, [meta, nbhdRank]);

  const showParcels = viewState.zoom >= PARCEL_ZOOM;

  // one layer per loaded chunk: each layer's `data` array identity is stable
  // per (chunk, filter), so panning into new chunks never re-tessellates the
  // already-loaded ones
  const parcelLayers = useMemo(() => {
    void chunkVersion;
    const layers: GeoJsonLayer<ParcelProps>[] = [];
    for (const [slug, entry] of chunksRef.current) {
      layers.push(
        new GeoJsonLayer<ParcelProps>({
          id: `parcels-${slug}-${typeFilter}`,
          data: chunkData(entry, transfersOnly, typeFilter) as never,
          visible: showParcels,
          filled: true,
          stroked: true,
          extruded: extrude,
          getElevation: (f) => (extrude ? Math.sqrt(Math.max(f.properties.savings ?? 0, 0)) * 3 : 0),
          getFillColor: (f) =>
            ratioColor(ratioAtYear(f.properties, year), f.properties.transferType === 'relational'),
          getLineColor: (f) =>
            comparePicks.includes(f.properties.id)
              ? [178, 80, 7, 255]
              : selected && f.properties.id === selected.id
                ? [61, 42, 20, 255]
                : [120, 100, 70, 45],
          getLineWidth: (f) =>
            comparePicks.includes(f.properties.id)
              ? 4
              : selected && f.properties.id === selected.id
                ? 3
                : 0.5,
          lineWidthUnits: 'pixels',
          pickable: showParcels,
          autoHighlight: true,
          highlightColor: [90, 60, 20, 70],
          onClick: (info: PickingInfo) => {
            pendingSelect.current = null;
            const f = info.object as Feature | null;
            // In compare mode every parcel is a toggle rather than a selection.
            if (compareMode) {
              if (!f) return;
              const id = f.properties.id;
              setComparePicks((cur) =>
                cur.includes(id)
                  ? cur.filter((x) => x !== id)
                  : cur.length >= MAX_COMPARE
                    ? cur
                    : [...cur, id],
              );
              return;
            }
            selectedSlug.current = f ? slug : null;
            setSelected(f?.properties ?? null);
          },
          updateTriggers: {
            getFillColor: [year],
            getLineColor: [selected?.id, comparePicks.join()],
            getLineWidth: [selected?.id, comparePicks.join()],
            getElevation: [extrude],
          },
        }),
      );
    }
    return layers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunkVersion, transfersOnly, typeFilter, showParcels, extrude, selected?.id, year]);

  // ---- label tiers (prototype) --------------------------------------------
  const labelTier = tierForZoom(viewState.zoom);

  const labelData = useMemo((): MapLabel[] => {
    if (!labelsOn) return [];

    if (labelTier === 'neighborhood') {
      return nbGeo
        .filter((f) => f.properties.center)
        .map((f) => ({
          key: `nb-${f.properties.slug}`,
          text: fmtPct(f.properties.medianRatio),
          position: f.properties.center as [number, number],
          ratio: f.properties.medianRatio,
          dollars: nbSavings(f.properties, typeFilter, year, meta?.rollYear ?? 2025),
          count: 0,
        }));
    }

    // Both lower tiers read from whichever chunks are loaded, which is exactly
    // the set a reader can currently see.
    const rows: Array<{ props: ParcelProps; lon: number; lat: number }> = [];
    for (const [, entry] of chunksRef.current) {
      for (const f of chunkData(entry, transfersOnly, typeFilter)) {
        const g = f.geometry as { type: string; coordinates: number[][][] | number[][][][] };
        const first =
          g.type === 'MultiPolygon'
            ? (g.coordinates as number[][][][])[0]?.[0]?.[0]
            : (g.coordinates as number[][][])[0]?.[0];
        if (!first) continue;
        rows.push({ props: f.properties, lon: first[0], lat: first[1] });
      }
    }

    if (labelTier === 'block') return blockLabels(rows);

    return rows.map(({ props, lon, lat }) => ({
      key: props.id,
      text: fmtPct(props.ratio ?? null),
      position: [lon, lat] as [number, number],
      ratio: props.ratio ?? null,
      dollars: props.savings ?? 0,
      count: 1,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelsOn, labelTier, nbGeo, chunkVersion, transfersOnly, typeFilter, year, meta?.rollYear]);

  // median of whatever is on screen, so "spread" scores deviation from local
  // normal rather than from a citywide number that means nothing on this block
  const labelMedian = useMemo(() => {
    const rs = labelData.map((l) => l.ratio).filter((r): r is number => r != null).sort((a, b) => a - b);
    return rs.length ? rs[Math.floor(rs.length / 2)] : 0.6;
  }, [labelData]);

  // Quantised so panning recomputes at roughly 200m steps rather than every
  // frame. Without this the label set is stable while you move, which reads as
  // labels that refuse to update.
  const viewKey = `${viewState.longitude.toFixed(3)},${viewState.latitude.toFixed(3)},${Math.round(viewState.zoom * 4) / 4}`;

  const viewportBounds = useMemo((): [number, number, number, number] | null => {
    if (!labelsOn) return null;
    // No trustworthy size means no culling, rather than culling everything.
    if (mapSize[0] < 240 || mapSize[1] < 240) return null;
    try {
      const vp = new WebMercatorViewport({
        width: mapSize[0],
        height: mapSize[1],
        longitude: viewState.longitude,
        latitude: viewState.latitude,
        zoom: viewState.zoom,
        // A pitched viewport's far plane runs to the horizon, which would put
        // half the city "in bounds". Bounds are only for culling, so read them
        // flat and pad instead.
        pitch: 0,
        bearing: viewState.bearing ?? 0,
      });
      // Flat [minLng, minLat, maxLng, maxLat]. Destructuring this as nested
      // pairs throws, and swallowing that in a catch silently disabled culling
      // for the whole prototype, which looked like labels refusing to update.
      const b = vp.getBounds();
      if (!Array.isArray(b) || b.length !== 4 || b.some((v) => !Number.isFinite(v))) {
        console.warn('[labels] unexpected getBounds shape, culling off:', b);
        return null;
      }
      const [w, sth, e, n] = b as [number, number, number, number];
      const padX = (e - w) * 0.15;
      const padY = (n - sth) * 0.15;
      return [w - padX, sth - padY, e + padX, n + padY];
    } catch (err) {
      console.warn('[labels] viewport bounds failed, culling off:', err);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelsOn, viewKey, mapSize]);

  // Collision filtering decides what is legible. This narrows the candidates to
  // what is actually on screen first, then keeps the highest priority ones, so
  // zooming into a block re-picks winners from that block rather than from
  // every chunk in memory.
  const labelStats = useRef({ all: 0, inView: 0, afterChrome: 0, rects: 0 });
  const labelShown = useMemo(() => {
    let pool = labelData;
    labelStats.current.all = pool.length;
    if (viewportBounds) {
      const [w, sth, e, n] = viewportBounds;
      pool = pool.filter(
        (l) => l.position[0] >= w && l.position[0] <= e && l.position[1] >= sth && l.position[1] <= n,
      );
    }

    // CollisionFilterExtension only knows about other GPU features, so on its
    // own it will happily place a label under the search bar or the legend.
    // Project each candidate and drop the ones landing on chrome. Reading the
    // rects from the DOM means this tracks panels opening and closing rather
    // than hard-coding where the furniture sits.
    // Measure the surface deck actually draws to, not the window: they differ
    // in embeds and in panes that get collapsed. A zero-size or absurdly small
    // viewport means layout has not settled, and culling against it would drop
    // every label, so skip the pass rather than blank the map.
    labelStats.current.inView = pool.length;
    labelStats.current.rects = chromeRects.length;
    if (labelsOn && pool.length && mapSize[0] >= 240) {
      try {
        const vp = new WebMercatorViewport({
          width: mapSize[0],
          height: mapSize[1],
          longitude: viewState.longitude,
          latitude: viewState.latitude,
          zoom: viewState.zoom,
          pitch: viewState.pitch ?? 0,
          bearing: viewState.bearing ?? 0,
        });
        pool = cullToScreen(pool, (pos) => vp.project(pos) as [number, number], {
          size: mapSize,
          rects: chromeRects,
        });
      } catch (err) {
        console.warn('[labels] screen-space cull failed, chrome overlap possible:', err);
      }
    }
    labelStats.current.afterChrome = pool.length;
    if (pool.length <= MAX_LABELS * 8) return pool;
    return [...pool]
      .sort(
        (a, b) =>
          labelPriority(b, labelBias, selected?.id ?? null, labelMedian) -
          labelPriority(a, labelBias, selected?.id ?? null, labelMedian),
      )
      .slice(0, MAX_LABELS * 8);
    // viewKey covers pan and zoom; selected covers the parcel panel opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelData, viewportBounds, viewKey, mapSize, chromeRects, labelsOn, labelBias, selected?.id, labelMedian]);

  const labelText4 = useCallback(
    (d: MapLabel) => (labelText === 'usd' ? fmtUsd(d.dollars) : fmtPct(d.ratio)),
    [labelText],
  );

  const labelLayer = useMemo(
    () =>
      new IconLayer<MapLabel>({
        id: `labels-${labelTier}`,
        // fmtUsd returns '' for zero-dollar labels; an empty sprite would still
        // claim collision space, so drop them before the layer sees them
        // fmtUsd returns '' for zero-dollar labels; an empty sprite would still
        // claim collision space, so drop them before the layer sees them
        data: labelShown.filter((d) => labelText4(d) !== ''),
        visible: labelsOn,
        pickable: false,
        getPosition: (d) => d.position,
        getIcon: (d) => {
          const t = labelText4(d);
          const s = pillSprite(t, d.key === selected?.id);
          return { url: s.url, width: s.width, height: s.height, id: (d.key === selected?.id ? 's:' : 'n:') + t };
        },
        onError: (err: Error) => console.error('[labels] IconLayer error:', err),
        getSize: PILL_H,
        sizeUnits: 'pixels',
        // The neighbourhood model is extruded, so ground-level sprites end up
        // inside the geometry. Drawing without depth testing floats them
        // over the model instead of being buried by it.
        parameters: { depthCompare: 'always' },
        billboard: true,
        updateTriggers: {
          getCollisionPriority: [labelBias, selected?.id, labelMedian],
          getIcon: [labelText, selected?.id],
        },
        extensions: [new CollisionFilterExtension()],
        ...({
          collisionGroup: 'labels',
          // pad the hit box so survivors are not drawn shoulder to shoulder
          collisionTestProps: { sizeScale: 2.4 },
          getCollisionPriority: (d: MapLabel) =>
            labelPriority(d, labelBias, selected?.id ?? null, labelMedian),
        } as object),
      }),
    [labelShown, labelTier, labelsOn, labelBias, labelText4, labelText, selected?.id, labelMedian],
  );

  // 3D extruded neighborhood model: height + color both encode annual est. tax
  // savings for the active property type + year, so the timeline animates the
  // gap growing and neighborhoods read as comparable 3D bars.
  const MAX_HEIGHT = 3800;
  const rollYear = meta?.rollYear ?? 2025;
  const nbLayer = new GeoJsonLayer<NbFeatureProps>({
    id: 'nbhd-3d',
    data: { type: 'FeatureCollection', features: nbGeo } as never,
    visible: !showParcels,
    extruded: extrude,
    wireframe: extrude,
    material: { ambient: 0.6, diffuse: 0.5, shininess: 20 },
    // height = total annual savings (magnitude); color = how deep the subsidy
    // runs (median assessed/market), same ramp as the parcels for consistency
    getElevation: (f) =>
      extrude ? (nbSavings(f.properties, typeFilter, year, rollYear) / savingsRef) * MAX_HEIGHT : 0,
    getFillColor: (f) => {
      const [r, g, b] = ratioColor(f.properties.medianRatio, false);
      return [r, g, b, 235];
    },
    getLineColor: [120, 80, 40, 90],
    lineWidthUnits: 'pixels',
    getLineWidth: 1,
    pickable: !showParcels,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 40],
    onClick: (info: PickingInfo) => {
      const f = info.object as NbFeature | null;
      if (f?.properties.center) {
        setViewState((v) => ({
          ...v,
          longitude: f.properties.center![0],
          latitude: f.properties.center![1],
          zoom: 14.2,
          transitionDuration: 900,
          transitionInterpolator: new FlyToInterpolator(),
        }));
        loadChunk(f.properties.slug);
      }
    },
    updateTriggers: {
      getElevation: [typeFilter, year, savingsRef, extrude],
      getFillColor: [typeFilter, year, savingsRef],
    },
    // smoothly tween heights + colors between years instead of hard-cutting
    transitions: {
      getElevation: { duration: 750, easing: (t: number) => t * t * (3 - 2 * t) },
      getFillColor: { duration: 750 },
    },
  });

  const sel = selected;
  return (
    <div className={`app view-${view}${compareMode ? ' comparing' : ''}`}>
      {/* No rail. Once the story releases you into the map, one dock carries
          everything, and there is no way back into the funnel except Replay. */}
      {!embed && view === 'explore' && (
        <nav className="dock">
          <button className="dock-primary" onClick={() => searchRef.current?.focus()}>
            <Icon name="search" size={15} /> Search
          </button>
          <button className={compareMode ? 'on' : ''} onClick={() => toggleCompareMode()}>
            <Icon name="compare" size={15} /> Compare
          </button>
          <button className={showRankings ? 'on' : ''} onClick={() => setShowRankings((v) => !v)}>
            <Icon name="breakdown" size={15} /> Rankings
          </button>
          {hasVoice && (
            <>
              <span className="dock-sep" />
              <button
                className={audioOn ? 'on audio' : 'audio'}
                onClick={() => setAudioOn((v) => !v)}
                title={audioOn ? 'Turn the audio guide off' : 'Read parcels aloud as you explore'}
              >
                <span className="audio-dot" /> Audio
              </button>
            </>
          )}
          <span className="dock-sep" />
          <button onClick={() => setShowAbout(true)} title="About & FAQ" aria-label="About">
            <Icon name="info" size={15} />
          </button>
          <button onClick={replayStory} title="Replay the story" aria-label="Replay the story">↺</button>
        </nav>
      )}

      <div className="map-pane">
      <DeckGL
        viewState={viewState}
        onViewStateChange={(e) => setViewState(e.viewState as MapViewState)}
        controller={true}
        layers={[nbLayer, ...parcelLayers, ...(labelsOn ? [labelLayer] : [])]}
        getTooltip={({ object, layer }: PickingInfo) => {
          if (!object) return null;
          if (layer?.id === 'nbhd-3d') {
            const p = (object as NbFeature).properties;
            const sav = nbSavings(p, typeFilter, year, rollYear);
            return {
              html: `<b>${p.name}</b><br/>${TYPE_LABEL[typeFilter]} · ${year ?? rollYear}<br/>≈ ${fmt$k(sav)}/yr in tax savings · ${p.byType[typeFilter].relational.toLocaleString()} kept an older taxable value<br/>click to zoom in`,
              style: { background: '#fffdf8', color: '#3a3226', fontSize: '12px', borderRadius: '6px', border: '1px solid #e0d8c4' },
            };
          }
          const p = (object as Feature).properties;
          return {
            html: `<b>${p.addr}</b><br/>assessed ${fmt$(p.assessed)}${
              p.estMarket ? ` · est. market ${fmt$(p.estMarket)}` : ''
            }${p.savings && p.savings > 0 ? `<br/>≈ ${fmt$(p.savings)}/yr tax savings` : ''}`,
            style: { background: '#fffdf8', color: '#3a3226', fontSize: '12px', borderRadius: '6px', border: '1px solid #e0d8c4' },
          };
        }}
      >
        <Map mapStyle={BASEMAP} />
      </DeckGL>
      </div>

      {view === 'story' && meta && (
        <StoryScroller
          meta={meta}
          onFly={(v) => setViewState((s) => ({ ...s, ...v, transitionDuration: 1400, transitionInterpolator: new FlyToInterpolator() }))}
          onSelectParcel={(id, nbhd) => {
            const idx = searchIdx;
            if (!idx) return;
            const i = idx.id.indexOf(id);
            if (i >= 0) flyToMatch({ id, nbhd, x: idx.x[i], y: idx.y[i] });
          }}
          onSetTransfersOnly={setTransfersOnly}
          onSetYear={setYear}
          onNarrate={speakBeat}
          audioOn={audioOn}
          hasVoice={hasVoice}
          onToggleAudio={() => setAudioOn((v) => !v)}
          onExplore={() => {
            setYear(null);
            setView('explore');
          }}
        />
      )}

      {/* Breakdown is no longer a destination. The Sankey is a chapter inside
          the story, rendered by StoryScroller at the "where it sits" beat. */}

      {view === 'explore' && (
      <header className="topbar">
        <div className="title">
          <h1>SF Property Tax Gap</h1>
          <span className="sub">
            {meta
              ? `est. ${fmt$k(meta.totalEstAnnualSavings)}/yr in Prop 13 savings across ${meta.parcelCount.toLocaleString()} parcels`
              : 'loading…'}
          </span>
        </div>
        <div className="search">
          <input
            ref={searchRef}
            placeholder="Search address… (e.g. 500 CHURCH)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {matches.length > 0 && (
            <ul className="results">
              {matches.map((m) => (
                <li
                  key={m.id}
                  onClick={() => {
                    // While comparing, search adds to the set instead of
                    // opening the parcel. Still fly there so you see it land.
                    if (compareMode) {
                      setComparePicks((c) =>
                        c.includes(m.id) || c.length >= MAX_COMPARE ? c : [...c, m.id],
                      );
                      setQuery('');
                      // The report reads parcels out of byId, which is only
                      // filled once a neighborhood chunk loads. Request it
                      // explicitly rather than waiting for the viewport to.
                      if (!byId.current.has(m.id)) {
                        const slug = slugByName.get(m.nbhd);
                        if (slug) loadChunk(slug);
                      }
                      if (m.x != null && m.y != null) {
                        setViewState((v) => ({
                          ...v,
                          longitude: m.x!,
                          latitude: m.y!,
                          zoom: Math.max(v.zoom, 15),
                          transitionDuration: 700,
                          transitionInterpolator: new FlyToInterpolator(),
                        }));
                      }
                      return;
                    }
                    flyToMatch(m);
                  }}
                >
                  <b>{m.addr}</b> <span>{m.nbhd}</span>
                  {compareMode && <em className="res-add">add</em>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="filters">
          <select
            className="nbhd-select"
            aria-label="Jump to neighborhood"
            value=""
            onChange={(e) => {
              const n = meta?.neighborhoods.find((x) => x.slug === e.target.value);
              if (n) flyToNbhd(n);
            }}
          >
            <option value="">All neighborhoods…</option>
            {(meta?.neighborhoods ?? [])
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((n) => (
                <option key={n.slug} value={n.slug}>{n.name}</option>
              ))}
          </select>
          <div className="segmented iconseg" role="group" aria-label="Property type">
            <button className={typeFilter === 'all' ? 'on' : ''} onClick={() => setTypeFilter('all')} title="All property">
              All
            </button>
            <button className={typeFilter === 'sfh' ? 'on' : ''} onClick={() => setTypeFilter('sfh')} title="Single-family homes">
              <Icon name="home" size={15} /> Single
            </button>
            <button className={typeFilter === 'multi' ? 'on' : ''} onClick={() => setTypeFilter('multi')} title="Multi-family">
              <Icon name="building" size={15} /> Multi
            </button>
          </div>
          <button
            className={`chip ${transfersOnly ? 'on' : ''}`}
            title="Show only parcels that changed hands since 2007"
            onClick={() => setTransfersOnly(!transfersOnly)}
          >
            <Icon name="transfer" size={15} /> Transfers
          </button>
          <div className="segmented iconseg" role="group" aria-label="Dimension">
            <button
              className={!extrude ? 'on' : ''}
              title="Flat 2D view"
              onClick={() => {
                setViewState((v) => ({ ...v, pitch: 0, transitionDuration: 400 }));
                setExtrude(false);
              }}
            >
              2D
            </button>
            <button
              className={extrude ? 'on' : ''}
              title="3D extruded view"
              onClick={() => {
                setViewState((v) => ({ ...v, pitch: 45, transitionDuration: 400 }));
                setExtrude(true);
              }}
            >
              <Icon name="cube" size={15} /> 3D
            </button>
          </div>
        </div>
      </header>
      )}


      {showAbout && (
        <div className="about-overlay" onClick={() => setShowAbout(false)}>
          <div className="about-modal" onClick={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setShowAbout(false)}>×</button>
            <h2>About this map</h2>
            <p>
              An open-data look at who benefits from Prop 13 in San Francisco: every parcel's taxed
              value against its estimated market value, the transfers that passed tax discounts along,
              and what that adds up to, block by block.
            </p>
            <p className="about-me">
              Built by Jeff Lin. {/* TODO(jeff): add a sentence or two about yourself and why you made this */}
              Questions or corrections: see the FAQ below.
            </p>
            {DONATE_URL && (
              <a className="donate" href={DONATE_URL} target="_blank" rel="noreferrer">
                Support this project
              </a>
            )}
            <h2>FAQ</h2>
            {FAQ.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                {item.a.split('\n\n').map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </details>
            ))}
            <p className="note">
              Data: DataSF assessor secured roll (wv5m-vpq2) and active parcels (acdm-wktn). Basemap ©
              CARTO, © OpenStreetMap contributors. Model accuracy: median absolute error ~18% on ~11,000
              held-out 2022–2025 sales.
            </p>
          </div>
        </div>
      )}

      {labelProto && (
        <div className="labelproto">
          <span className="lp-tier">{labelTier}</span>
          <span className="lp-count">
            {labelShown.length} labels
            <em>
              {' '}· {labelStats.current.all}→{labelStats.current.inView} in view →{' '}
              {labelStats.current.afterChrome} clear of {chromeRects.length} panels · pane{' '}
              {mapSize[0]}×{mapSize[1]}
            </em>
          </span>
          <div className="lp-bias">
            <button className={labelBias === 'spread' ? 'on' : ''} onClick={() => setLabelBias('spread')}>
              spread
            </button>
            <button className={labelBias === 'savings' ? 'on' : ''} onClick={() => setLabelBias('savings')}>
              savings
            </button>
          </div>
          <div className="lp-bias">
            <button className={labelText === 'pct' ? 'on' : ''} onClick={() => setLabelText('pct')}>
              %
            </button>
            <button className={labelText === 'usd' ? 'on' : ''} onClick={() => setLabelText('usd')}>
              $
            </button>
          </div>
        </div>
      )}
      {view === 'explore' && (
      <div className="legend">
        <div className="legend-title">how far below market it's taxed</div>
        <div className="legend-bar" />
        <div className="legend-ends">
          <span>taxed far below</span>
          <span>near market</span>
        </div>
        {!showParcels && (
          <div className="legend-note">
            {extrude
              ? 'Taller blocks keep more each year. Darker is taxed further below market. Click one to zoom in.'
              : 'Each label is what that neighborhood keeps per year. Darker is taxed further below market. Click one to zoom in.'}
          </div>
        )}
        {showParcels && <div className="legend-note">Gray parcels have no market estimate.</div>}
        {showParcels && transfersOnly && (
          <div className="legend-note">
            showing only parcels that changed hands since 2007
            {shownCounts.total > 0 &&
              ` (${shownCounts.shown.toLocaleString()} of ${shownCounts.total.toLocaleString()} loaded)`}
          </div>
        )}
        {loadingChunks > 0 && <div className="legend-note">loading parcels…</div>}
        {year != null && <div className="legend-note">viewing {year} assessments</div>}
        {meta?.sourceDataAsOf && (
          <div className="legend-stamp">data as of {meta.sourceDataAsOf} · roll {meta.rollYear}</div>
        )}
      </div>
      )}

      {showRankings && meta && view === 'explore' && (
        <div className="rankings">
          <button className="rankings-close" onClick={() => setShowRankings(false)} aria-label="Close rankings">&times;</button>
          <div className="compare-head">
            <div className="compare-tabs">
              <button className={compareTab === 'neighborhoods' ? 'on' : ''} onClick={() => setCompareTab('neighborhoods')}>
                Neighborhoods
              </button>
              <button className={compareTab === 'parcels' ? 'on' : ''} onClick={() => setCompareTab('parcels')}>
                Top parcels
              </button>
            </div>
            {compareTab === 'neighborhoods' && (
              <div className="compare-controls">
                <span className="filter-label">Rank by</span>
                <div className="segmented">
                  <button className={nbhdRank === 'total' ? 'on' : ''} onClick={() => setNbhdRank('total')}>Total</button>
                  <button className={nbhdRank === 'perParcel' ? 'on' : ''} onClick={() => setNbhdRank('perParcel')}>Per home</button>
                  <button className={nbhdRank === 'relational' ? 'on' : ''} onClick={() => setNbhdRank('relational')}>Kept older value</button>
                </div>
                <button className="chip" onClick={() => setShowCsvGate(true)}>↓ CSV</button>
              </div>
            )}
            {compareTab === 'parcels' && (
              <div className="compare-controls">
                <div className="segmented">
                  <button className={boardCls === 'sfh' ? 'on' : ''} onClick={() => setBoardCls('sfh')}>Single-family</button>
                  <button className={boardCls === 'multi' ? 'on' : ''} onClick={() => setBoardCls('multi')}>Multi-family</button>
                </div>
                <div className="segmented">
                  <button className={boardTab === 'relational' ? 'on' : ''} onClick={() => setBoardTab('relational')}>Kept older value</button>
                  <button className={boardTab === 'all' ? 'on' : ''} onClick={() => setBoardTab('all')}>All savings</button>
                </div>
              </div>
            )}
          </div>

          {compareTab === 'neighborhoods' ? (
            <div className="compare-grid">
              {rankedNbhds.map((n, i) => (
                <button
                  key={n.slug}
                  className="nb-card"
                  onClick={() => {
                    setShowRankings(false);
                    flyToNbhd(n);
                  }}
                >
                  <div className="nb-rank">{i + 1}</div>
                  <div className="nb-name">{n.name}</div>
                  <div className="nb-big">
                    {nbhdRank === 'perParcel'
                      ? `${fmt$(n.savingsPerParcel)}`
                      : nbhdRank === 'relational'
                        ? n.relational.toLocaleString()
                        : fmt$k(n.totalSavings)}
                    <span className="nb-unit">
                      {nbhdRank === 'perParcel' ? '/home/yr' : nbhdRank === 'relational' ? ' transfers' : '/yr'}
                    </span>
                  </div>
                  <div className="nb-sub">{n.parcels.toLocaleString()} homes · {n.relational.toLocaleString()} kept an older taxable value</div>
                </button>
              ))}
            </div>
          ) : (
            leaders && (
              <div className="compare-list">
                {(boardTab === 'relational' ? leaders[boardCls].topRelational : leaders[boardCls].topSavings)
                  .slice(0, 60)
                  .map((r, i) => (
                    <button
                      key={r.id}
                      className="parcel-row"
                      onClick={() => {
                        setShowRankings(false);
                        flyToMatch({
                          id: r.id,
                          nbhd: r.nbhd,
                          knownTransfer: r.transferType !== 'none',
                          ...centroidFromLoaded(byId.current.get(r.id)),
                        });
                      }}
                    >
                      <span className="pr-rank">{i + 1}</span>
                      <span className="pr-addr">{r.addr}<em>{r.nbhd}</em></span>
                      <span className="pr-save">
                        {fmt$(r.savings)}/yr
                        {r.transferType === 'relational' && r.avoidedSince != null && (
                          <em>{fmt$k(r.avoidedSince)} since '{String(r.transferYear).slice(2)}</em>
                        )}
                      </span>
                    </button>
                  ))}
              </div>
            )
          )}
        </div>
      )}

      {/* Compare tool: a tray over the map while picking, then a report that
          docks to the side and can expand to full screen. */}
      {view === 'explore' && compareMode && !embed && (
        <div className="cmp-tray">
          <span className="cmp-mode"><span className="dot" /> Compare</span>
          <span className="cmp-count">{comparePicks.length} of {MAX_COMPARE}</span>
          <div className="cmp-chips">
            {comparePicks.map((id) => {
              const p = byId.current.get(id)?.properties;
              return (
                <span className="cmp-chip" key={id}>
                  {p?.addr ?? id}
                  <button
                    onClick={() => setComparePicks((c) => c.filter((x) => x !== id))}
                    aria-label={`Remove ${p?.addr ?? id}`}
                  >
                    &times;
                  </button>
                </span>
              );
            })}
            {!comparePicks.length && <span className="cmp-hint">Tap parcels on the map, or search an address</span>}
          </div>
          <button
            className="cmp-go"
            disabled={comparePicks.length < 2}
            onClick={() => setCompareOpen(true)}
          >
            {comparePicks.length >= 2 ? `Compare ${comparePicks.length}` : 'Pick two or more'}
          </button>
          <button className="cmp-exit" onClick={toggleCompareMode} aria-label="Leave compare mode">&times;</button>
        </div>
      )}

      {view === 'explore' && compareOpen && comparePicks.length >= 2 && (
        <CompareReport
          ids={comparePicks}
          byId={byId.current}
          records={compareData}
          full={compareFull}
          onToggleFull={() => setCompareFull((v) => !v)}
          onClose={() => setCompareOpen(false)}
          onRemove={(id) => setComparePicks((c) => c.filter((x) => x !== id))}
        />
      )}

      {view === 'explore' && sel && !compareMode && (
        <aside className="panel">
          <button
            className="close"
            onClick={() => {
              pendingSelect.current = null;
              selectedSlug.current = null;
              setSelected(null);
            }}
          >
            ×
          </button>
          <h2>{sel.addr}</h2>
          <div className="muted">
            {sel.nbhd} · {sel.use}
            {sel.built ? ` · built ${sel.built}` : ''}
            {sel.units ? ` · ${sel.units} unit${sel.units > 1 ? 's' : ''}` : ''}
            {sel.area ? ` · ${sel.area.toLocaleString()} sqft` : ''}
          </div>

          <p className="panel-explain">
            San Francisco taxes this property as if it's valued at <b>{fmt$k(sel.assessed)}</b>.
            {sel.estMarket ? (
              <> However we estimate it would sell today for about <b>{fmt$k(sel.estMarket)}</b>.</>
            ) : (
              <> We have no market estimate for this one, so the gap is not shown below.</>
            )}{' '}
            {/* The mechanism has to be per parcel. Naming a trust on every
                property would be false on the ones that simply sold, and the
                assessment roll cannot tell a trust from any other unreassessed
                transfer, which is the ~84% error in recorder-validation-findings.
                So: name a trust only where a recorded deed shows one, otherwise
                say the narrower thing we can actually support. */}
            {sel.transferType === 'relational' ? (
              trustDeed ? (
                <>
                  Instead it was transferred into <b>{trustDeed.grantee}</b> in{' '}
                  {String(trustDeed.date).slice(0, 4)}, which carries the old taxed value forward.
                </>
              ) : (
                <>
                  Instead it changed hands{sel.transferYear ? ` in ${sel.transferYear}` : ''} without
                  being reassessed, so the older taxed value carried forward.
                </>
              )
            ) : sel.transferType === 'market' ? (
              <>
                It was reassessed{sel.transferYear ? ` in ${sel.transferYear}` : ''} when it last
                sold, so there is little gap to show.
              </>
            ) : (
              <>
                It has not changed hands since before 2007, so its taxed value has only risen with
                the 2% a year Prop 13 allows.
              </>
            )}
          </p>

          <span
            className={`badge badge-${sel.transferType}`}
            title="Inferred from the tax roll, not from a deed. We can see that the value was never reassessed. We cannot see why. Parent-child and grandparent-grandchild transfers (Prop 58/193/19), spousal transfers and trust transfers all look the same from here."
          >
            {TRANSFER_LABEL[sel.transferType]}
            {sel.transferYear ? ` · ${sel.transferYear}` : ''}
          </span>

          {sel.savings != null && sel.savings > 0 ? (
            <div className="headline">
              <div className="headline-num">{fmt$(sel.savings)}/yr</div>
              <div className="headline-sub">less property tax than a new buyer of this home would owe</div>
              {sel.transferType === 'relational' && sel.avoidedSince != null && sel.avoidedSince > 0 && (
                <div className="headline-since">
                  ≈ {fmt$(sel.avoidedSince)} kept since the {sel.transferYear} transfer
                </div>
              )}
            </div>
          ) : (
            <div className="headline">
              <div className="headline-sub">
                {sel.estMarket != null ? 'Taxed at close to what a new buyer would owe.' : 'No market estimate for this property.'}
              </div>
            </div>
          )}

          {sel.estMarket != null && (
            <p
              className="plain"
              title="Est. worth is our own estimate, not a third party: the median price per square foot of similar recently-sold properties in this neighborhood, times this building's size. Typically within ~18% of real sale prices."
            >
              Taxed as if worth <b>{fmt$k(sel.assessed)}</b>, but we estimate it's really worth about{' '}
              <b>{fmt$k(sel.estMarket)}</b> ⓘ. So the yearly tax is <b>{fmt$k(sel.taxEst)}</b>, not the{' '}
              <b>{fmt$k(Math.round(sel.estMarket * (meta?.taxRate ?? 0.0118)))}</b> a new buyer would owe.
            </p>
          )}

          <DeltaChart hist={sel.hist} events={sel.events} nbhd={sel.nbhd} meta={meta} />

          {sel.periods.length > 0 && (
            <>
              <h3>Who benefited</h3>
              <ul className="periods">
                {[...sel.periods].reverse().map(([start, end, kind, saved], i) => (
                  <li key={start} className={i === 0 ? 'current' : ''}>
                    <span className="period-range">
                      {i === 0 ? `${start}–now` : start === end ? String(start) : `${start}–${end}`}
                    </span>
                    <span className={`period-kind pk-${kind}`}>
                      {kind === 'initial'
                        ? 'owner as of 2007'
                        : kind === 'relational'
                          ? 'transfer kept the older taxable value'
                          : kind === 'market'
                            ? 'bought at market'
                            : 'partial reassessment'}
                    </span>
                    <span className="period-saved">{saved ? `≈ ${fmt$k(saved)} saved` : '—'}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <StreetComparison sel={sel} chunkVersion={chunkVersion} chunks={chunksRef.current} />

          {(() => {
            // Prefer real §408.1 overlay data for this parcel if we have it;
            // otherwise use the on-demand records lookup, which retrieves the full
            // set of recorded documents (names included) from the open public index
            // via the worker (demo rows until a worker URL is configured).
            const overlay = deeds?.byParcel[sel.id];
            if (overlay && overlay.transfers.length) {
              return (
                <>
                  <h3>Recorded transfers (verified)</h3>
                  <ul className="rec-list">
                    {[...overlay.transfers].reverse().map((r, i) => (
                      <li key={i}>
                        <span className="rec-date">{r.date.slice(0, 4)}</span>
                        <span className="rec-doc">
                          {docLabel(r.docType)}
                          {r.kind === 'relational' && <em className="rec-exempt"> · family/trust</em>}
                          {r.consideration === 0 && <em className="rec-exempt"> · $0 tax</em>}
                          {r.grantee && <em> · to {partyName(r.grantee)}</em>}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="est-source">Source: SF Assessor-Recorder §408.1 transfer list.</p>
                </>
              );
            }
            return (
              <>
                <h3>Recorded documents (public)</h3>
                {records.status === 'loading' && (
                  <div className="rec-loading">
                    <span className="rec-spinner" />{' '}
                    {records.live
                      ? `Pulling this parcel's deeds from the county index…`
                      : `Checking SF recorded documents for parcel ${sel.id}…`}
                  </div>
                )}
                {records.status === 'error' && (
                  <p className="est-source">
                    {records.busy
                      ? 'The county index is busy right now. Try again in a moment, or search it directly below.'
                      : `Couldn't reach the county index (${records.message}). You can search it directly below.`}
                  </p>
                )}
                {records.status === 'done' && (
                  <>
                    {records.demo ? (
                      <p className="rec-demo">
                        Sample rows from our inferred transfers. Real deed types, names, and transfer tax
                        come from the §408.1 list (see docs) or the recorder. Look this parcel up yourself:
                      </p>
                    ) : (
                      <p className="est-source">
                        {records.records.length
                          ? `${records.records.length} document${records.records.length === 1 ? '' : 's'} from the SF Assessor-Recorder public index.`
                          : records.miss
                            ? 'This parcel has not been looked up yet. Search it directly in the county index below.'
                            : 'Nothing recorded against this parcel since 1990 in the public index.'}
                      </p>
                    )}
                    <ul className="rec-list">
                      {records.records.map((r, i) => {
                        const hasNames =
                          (r.grantor && r.grantor !== '—') || (r.grantee && r.grantee !== '—');
                        return (
                          <li key={r.docNumber ?? i}>
                            <span className="rec-date">{r.date.slice(0, 4)}</span>
                            <span className="rec-doc">
                              <span className="rec-doctype">
                                {docLabel(r.docType)}
                                {r.kind === 'market' && <em className="rec-tag rec-market"> transfer</em>}
                                {r.kind === 'relational' && (
                                  <em className="rec-tag rec-exempt"> family/trust</em>
                                )}
                                {r.transferTax === 0 && <em className="rec-exempt"> · $0 tax</em>}
                              </span>
                              {hasNames && (
                                <span className="rec-names">
                                  <span className="rec-party">{partyName(r.grantor)}</span>
                                  <span className="rec-arrow"> → </span>
                                  <span className="rec-party">{partyName(r.grantee)}</span>
                                </span>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                    <a
                      className="rec-lookup"
                      href={RECORDER_SEARCH_URL}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => {
                        const { block, lot } = blockLot(sel.id);
                        navigator.clipboard?.writeText(`${block}-${lot}`).catch(() => {});
                      }}
                    >
                      ↗ Verify block {blockLot(sel.id).block} lot {blockLot(sel.id).lot} in the official records
                      <em>Block-lot copied. Paste it into the APN search.</em>
                    </a>
                  </>
                )}
              </>
            );
          })()}

          <button
            className="share-btn"
            onClick={() => downloadShareCard(sel, streetContextFor(sel, chunksRef.current), meta)}
          >
            ↗ Share this parcel (image)
          </button>

          {sel.transferType === 'relational' && (
            <p className="caveat">
              &ldquo;Transferred without reassessment&rdquo; is inferred from assessment
              behavior, not from the deed. It means the taxable value did not reset when
              the property changed hands. It does <strong>not</strong> establish that the
              transfer was between family members. Check the recorded documents above for
              the actual parties.
            </p>
          )}

          <p
            className="note"
            title="Market value = neighborhood median $/sqft of same-class properties reassessed in the last 3 years, times building area. Tax = 1.1805% of assessed value net of exemptions. Sources: DataSF assessor roll (wv5m-vpq2) and parcels (acdm-wktn)."
          >
            Estimates from DataSF open data · names from the SF Recorder public index
          </p>
        </aside>
      )}

      {showCsvGate && meta && (
        <div className="about-overlay" onClick={() => setShowCsvGate(false)}>
          <div className="about-modal csv-modal" onClick={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setShowCsvGate(false)}>×</button>
            <h2>Download the neighborhood data</h2>
            <p>
              This is a free, open project. Assembling and cleaning nine million rows of assessment
              history into these numbers takes real compute and time, and keeping it current costs money
              every year. If the data is useful to you, a contribution on any scale helps keep it free
              and up to date. No pressure, the download works either way.
            </p>
            <div className="csv-give">
              {['$5', '$25', '$100', 'Other'].map((amt) => (
                <a
                  key={amt}
                  className="give-pill"
                  href={DONATE_URL || undefined}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => {
                    if (!DONATE_URL) e.preventDefault();
                  }}
                >
                  {amt}
                </a>
              ))}
            </div>
            {!DONATE_URL && <p className="note">Donations open soon, the link will appear here.</p>}
            <a
              className="donate"
              href="data/neighborhoods.csv"
              download="sf-property-tax-neighborhoods.csv"
              onClick={() => setShowCsvGate(false)}
            >
              Download CSV ({meta.neighborhoods.length} neighborhoods)
            </a>
            <p className="note">
              Neighborhood aggregates only (no per-parcel data). Data as of {meta.sourceDataAsOf ?? '—'}.
            </p>
          </div>
        </div>
      )}

    </div>
  );
}

function centroidFromLoaded(f: Feature | undefined): { x: number | null; y: number | null } {
  if (!f) return { x: null, y: null };
  const [x, y] = centroidOf(f.geometry);
  return { x, y };
}

function median(sorted: number[]): number {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

type StreetContext = { street: string; n: number; medianPct: number; rank: number | null; avgSavings: number } | null;

function streetContextFor(sel: ParcelProps, chunks: globalThis.Map<string, ChunkEntry>): StreetContext {
  if (!sel.street) return null;
  let feats: Feature[] | null = null;
  for (const entry of chunks.values()) {
    if (entry.all.length && entry.all[0].properties.nbhd === sel.nbhd) {
      feats = entry.all;
      break;
    }
  }
  if (!feats) return null;
  const mine = feats
    .map((f) => f.properties)
    .filter((p) => p.street === sel.street && p.ratio != null);
  if (mine.length < 3) return null;
  const med = median(mine.map((p) => p.ratio!).sort((a, b) => a - b));
  const avg = mine.reduce((s, p) => s + (p.savings ?? 0), 0) / mine.length;
  const rank = sel.ratio != null ? mine.filter((p) => p.ratio! < sel.ratio!).length + 1 : null;
  return { street: sel.street, n: mine.length, medianPct: Math.round(med * 100), rank, avgSavings: avg };
}

// Render a 1200x630 social-share card to a PNG download, entirely client-side.
function downloadShareCard(sel: ParcelProps, street: StreetContext, meta: Meta | null) {
  const W = 1200, H = 630;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f7f3ea';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#b25007';
  g.fillRect(0, 0, W, 12);

  g.fillStyle = '#2c2418';
  g.font = 'bold 52px Helvetica, Arial, sans-serif';
  g.fillText(sel.addr, 60, 110);
  g.fillStyle = '#8a8070';
  g.font = '26px Helvetica, Arial, sans-serif';
  g.fillText(`${sel.nbhd} · ${sel.use ?? ''}`, 60, 152);

  if (sel.savings != null && sel.savings > 0) {
    g.fillStyle = '#b25007';
    g.font = 'bold 96px Helvetica, Arial, sans-serif';
    g.fillText(`${fmt$(sel.savings)}/yr`, 60, 280);
    g.fillStyle = '#3a3226';
    g.font = '30px Helvetica, Arial, sans-serif';
    g.fillText('less property tax than a new buyer would pay', 60, 326);
  }
  if (sel.transferType === 'relational' && sel.avoidedSince != null && sel.transferYear) {
    g.fillStyle = '#2c2418';
    g.font = 'bold 34px Helvetica, Arial, sans-serif';
    g.fillText(`≈ ${fmt$(sel.avoidedSince)} avoided since the ${sel.transferYear} transfer`, 60, 400);
  }
  if (street) {
    g.fillStyle = '#5a5142';
    g.font = '26px Helvetica, Arial, sans-serif';
    const rankTxt = street.rank ? `#${street.rank} lowest of ${street.n} on ${street.street}` : street.street;
    g.fillText(`On this block: ${rankTxt}, median taxed at ${street.medianPct}% of value`, 60, 460);
  }

  // mini dumbbell of assessed vs market over the years
  const chartX = 60, chartY = 500, chartW = W - 120, chartH = 80;
  const hist = sel.hist;
  const maxV = Math.max(...hist.map((d) => Math.max(d[1], d[2] ?? 0)), 1);
  const minY = hist[0][0], maxY = hist[hist.length - 1][0];
  const px = (yr: number) => chartX + ((yr - minY) / Math.max(1, maxY - minY)) * chartW;
  const py = (v: number) => chartY + chartH - (v / maxV) * chartH;
  for (const [yr, av, est] of hist) {
    if (est != null) {
      g.strokeStyle = '#d8c9ae';
      g.beginPath();
      g.moveTo(px(yr), py(av));
      g.lineTo(px(yr), py(est));
      g.stroke();
      g.fillStyle = '#b25007';
      g.beginPath();
      g.arc(px(yr), py(est), 4, 0, 7);
      g.fill();
    }
    g.fillStyle = '#4a4238';
    g.beginPath();
    g.arc(px(yr), py(av), 4, 0, 7);
    g.fill();
  }

  g.fillStyle = '#8a8070';
  g.font = '22px Helvetica, Arial, sans-serif';
  g.fillText(`SF Property Tax Gap · data as of ${meta?.sourceDataAsOf ?? ''} · estimates from open data`, 60, H - 28);

  c.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sf-tax-gap-${sel.id}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

type StoryStep = {
  kicker: string;
  title: string;
  body: string;
  view: Partial<MapViewState>;
  parcel?: { id: string; nbhd: string };
  transfersOnly?: boolean;
  year?: number | null;
  play?: boolean;   // auto-animate 2007 -> latest with a live metric
  sankey?: boolean; // render the breakdown inline, as a chapter
  skip?: boolean;   // offer the escape hatch under this step's copy
  voice?: string;   // id in narration.json; what the audio guide reads here
};

const STORY_STEPS: StoryStep[] = [
  {
    kicker: 'SF Property Tax Gap',
    title: 'Two homes on one block, ten times the tax',
    voice: 'opening',
    body: 'One family bought decades ago. Their neighbor bought last year. For nearly identical houses, the newer owner can owe ten times more property tax. This is a map of that gap across all 207,000 parcels in San Francisco.',
    view: { longitude: -122.4425, latitude: 37.758, zoom: 11.4, pitch: 42, bearing: 0 },
    skip: true,
  },
  {
    kicker: 'How Prop 13 works',
    title: 'Taxed on what you paid, not what it is worth',
    voice: 'how-prop-13-works',
    body: 'Since 1978, California taxes a home on its purchase price, rising at most 2% a year, until it sells again. Prices have far outrun 2%. Hold a home for thirty years and the difference between your bill and a new buyer’s bill grows very large.',
    view: { longitude: -122.4425, latitude: 37.758, zoom: 11.6, pitch: 45, bearing: 15 },
    skip: true,
  },
  {
    kicker: 'The citywide picture',
    title: 'About $2 billion a year',
    voice: 'citywide',
    body: 'Each block is a neighborhood, and taller and darker means a bigger gap. The Sunset, the Richmond, and West of Twin Peaks tower over the rest: older, long-held, single-family areas where the gap has compounded for decades.',
    view: { longitude: -122.4525, latitude: 37.752, zoom: 11.7, pitch: 50, bearing: -10 },
  },
  {
    kicker: 'It compounds',
    title: 'The gap since 2007',
    voice: 'compounding',
    body: 'Fifteen years ago the market sat closer to what people were taxed on. As values climbed and owners stayed put, the yearly savings grew with them. The blocks rise in real time.',
    view: { longitude: -122.4525, latitude: 37.752, zoom: 11.7, pitch: 50, bearing: -10 },
    play: true,
  },
  {
    kicker: 'Where the $2B sits',
    title: 'Mostly people who never left',
    voice: 'where-it-sits',
    body: 'Three quarters of the gap belongs to owners who have simply held since before 2007. Long ownership is the subsidy. A much smaller slice traces to transfers that changed hands without triggering a reassessment.',
    view: { longitude: -122.4525, latitude: 37.752, zoom: 11.5, pitch: 35, bearing: 0 },
    sankey: true,
  },
  {
    kicker: 'One house',
    title: '247 Lansdale Ave',
    voice: 'one-house',
    body: 'This West of Twin Peaks house changed hands in 2011 without a reassessment, and is still taxed on 29% of what it is worth. That is about $65,000 a year less than a new buyer would owe, and roughly $690,000 kept since. The county recorder lists every deed on it, names included.',
    view: { longitude: -122.4594, latitude: 37.7366, zoom: 16.5, pitch: 30, bearing: 0 },
    parcel: { id: '2992059', nbhd: 'West of Twin Peaks' },
    year: null,
  },
  {
    kicker: 'Your turn',
    title: 'Now look up your street',
    voice: 'your-turn',
    body: 'The map is yours from here. Search an address, tap any parcel to see two decades of its taxes and every recorded deed, or turn on Compare to line up your block against a neighbor’s.',
    view: { longitude: -122.4425, latitude: 37.758, zoom: 12, pitch: 40, bearing: 0 },
    transfersOnly: true,
  },
];

// Two-column scrollytelling: text steps scroll on the left, the live 3D map is
// pinned on the right (via .app.view-story layout). Each step, when it scrolls
// into view, drives the shared map's camera, filters, and year.
function StoryScroller({
  meta,
  onFly,
  onSelectParcel,
  onSetTransfersOnly,
  onSetYear,
  onExplore,
  onNarrate,
  audioOn,
  hasVoice,
  onToggleAudio,
}: {
  meta: Meta;
  onFly: (v: Partial<MapViewState>) => void;
  onSelectParcel: (id: string, nbhd: string) => void;
  onSetTransfersOnly: (v: boolean) => void;
  onSetYear: (y: number | null) => void;
  onExplore: () => void;
  onNarrate: (voiceId: string) => void;
  audioOn: boolean;
  hasVoice: boolean;
  onToggleAudio: () => void;
}) {
  const [active, setActive] = useState(0);
  const [playYear, setPlayYear] = useState<number | null>(null);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(0);
  const rollYear = meta.rollYear;

  const applyStep = useCallback(
    (i: number) => {
      const s = STORY_STEPS[i];
      onFly(s.view);
      onSetTransfersOnly(s.transfersOnly ?? false);
      if (!s.play && 'year' in s) onSetYear(s.year ?? null);
      if (s.voice) onNarrate(s.voice);
      if (s.parcel) {
        const p = s.parcel;
        setTimeout(() => onSelectParcel(p.id, p.nbhd), 900);
      }
    },
    [onFly, onSelectParcel, onSetTransfersOnly, onSetYear, onNarrate],
  );

  // deterministic active-step detection: whichever step's center is nearest the
  // container's vertical center wins. Robust across programmatic + real scroll.
  const onScroll = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const mid = sc.scrollTop + sc.clientHeight / 2;
    let best = 0, bestD = Infinity;
    refs.current.forEach((el, i) => {
      if (!el) return;
      const c = el.offsetTop + el.clientHeight / 2;
      const d = Math.abs(c - mid);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best !== activeRef.current) {
      activeRef.current = best;
      setActive(best);
      applyStep(best);
    }
  }, [applyStep]);

  useEffect(() => {
    applyStep(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Turning the guide on mid-story starts from whatever beat is on screen.
  useEffect(() => {
    if (!audioOn) return;
    const v = STORY_STEPS[activeRef.current]?.voice;
    if (v) onNarrate(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioOn]);

  // when the play step is active, sweep 2007 -> latest and loop; the layer's own
  // 750ms transition tweens the heights/colors so the sweep looks continuous
  const playing = STORY_STEPS[active]?.play ?? false;
  useEffect(() => {
    if (!playing) {
      setPlayYear(null);
      return;
    }
    let y = 2007;
    setPlayYear(y);
    onSetYear(y);
    const id = setInterval(() => {
      y = y >= rollYear ? 2007 : y + 1;
      setPlayYear(y);
      onSetYear(y >= rollYear ? null : y);
    }, 850);
    return () => clearInterval(id);
  }, [playing, rollYear, onSetYear]);

  const metricYear = playYear ?? rollYear;
  const metricVal = meta.savingsByYear[String(metricYear)] ?? 0;

  return (
    <div className={`story2 ${playing ? 'playing' : ''}`} ref={scrollRef} onScroll={onScroll}>
      {playing && (
        <div className="story-metric">
          <div className="sm-year">{metricYear}</div>
          <div className="sm-val">{fmt$k(metricVal)}<span>/yr in tax savings</span></div>
          <div className="sm-bar"><span style={{ width: `${(metricVal / (meta.savingsByYear[String(rollYear)] || 1)) * 100}%` }} /></div>
        </div>
      )}
      <div className="story2-scroll">
        {STORY_STEPS.map((s, i) => (
          <div
            key={i}
            data-i={i}
            ref={(el) => { refs.current[i] = el; }}
            className={`story2-step ${active === i ? 'on' : ''} ${i < active ? 'past' : ''}`}
          >
            {/* No card: the copy sits straight on the page background and
                cross-fades, so the map reads as one continuous surface. */}
            <div className="story2-card">
              <div className="story2-kicker">{s.kicker}</div>
              <h2>{s.title}</h2>
              <p>{s.body}</p>
              {s.sankey && (
                <div className="story-sankey">
                  <SankeyView flows={meta.sankey} compact />
                </div>
              )}
              {s.skip && (
                <div className="story2-choices">
                  <button className="skiplink" onClick={onExplore}>
                    Skip to the map <span className="arr">↓</span>
                  </button>
                  {/* The dock only exists in explore, so without this there is
                      no way to start the narration while reading. Hidden until
                      recorded takes exist; see primeNarration. */}
                  {hasVoice && <button
                    className={audioOn ? 'skiplink listen on' : 'skiplink listen'}
                    onClick={onToggleAudio}
                    aria-pressed={audioOn}
                  >
                    {audioOn ? 'Stop listening' : 'Listen as you read'}
                    <span className="arr">{audioOn ? '■' : '▶'}</span>
                  </button>}
                </div>
              )}
              {i === STORY_STEPS.length - 1 && (
                <button className="story-next" onClick={onExplore}>Open the map →</button>
              )}
            </div>
          </div>
        ))}
        <div className="story2-end">
          <p>{meta.parcelCount.toLocaleString()} parcels · data as of {meta.sourceDataAsOf ?? '—'}</p>
        </div>
      </div>
    </div>
  );
}

// Generated comparison report. Leads with the spread, explains each parcel's
// mechanism, then surfaces what the deed records make notable. Written to avoid
// the patterns in petergyang/no-ai-slop: no "not X but Y", no colon reveals,
// no dramatic fragments, no closing aphorism.
function CompareReport({
  ids,
  byId,
  records,
  full,
  onToggleFull,
  onClose,
  onRemove,
}: {
  ids: string[];
  byId: globalThis.Map<string, Feature>;
  records: Record<string, DeedRecord[]>;
  full: boolean;
  onToggleFull: () => void;
  onClose: () => void;
  onRemove: (id: string) => void;
}) {
  // Parcels only live in byId once their neighborhood chunk has loaded. Say so
  // rather than quietly dropping a pick the reader deliberately made.
  const items = ids.map((id) => byId.get(id)?.properties).filter(Boolean) as ParcelProps[];
  const pending = ids.length - items.length;
  if (items.length < 2) {
    return (
      <div className="cmp-result cmp-side">
        <div className="cmp-head">
          <h2>Comparison</h2>
          <button className="cmp-close" onClick={onClose} aria-label="Close comparison">&times;</button>
        </div>
        <div className="cmp-body">
          <p className="cmp-note" style={{ marginTop: 16 }}>
            Loading {pending} parcel{pending === 1 ? '' : 's'}. Pan the map near them and they will
            appear here.
          </p>
        </div>
      </div>
    );
  }

  const bySav = [...items].sort((a, b) => (b.savings ?? 0) - (a.savings ?? 0));
  const top = bySav[0];
  const bot = bySav[bySav.length - 1];
  const gap = (top.savings ?? 0) - (bot.savings ?? 0);
  const sameStreet = new Set(items.map((i) => i.street)).size === 1 && !!top.street;

  const basisOf = (p: ParcelProps) => p.transferYear ?? p.basisYear ?? null;
  // One clause covering both the year and the cause, so a parcel with no
  // recorded reset does not read as "set in 2007 by ownership since before 2007".
  const originOf = (p: ParcelProps) => {
    const y = basisOf(p);
    if (p.transferType === 'relational')
      return `Still taxed on its ${y} value: it changed hands that year without being reassessed.`;
    if (p.transferType === 'market') return `Reassessed in ${y} when it last sold.`;
    if (p.transferType === 'partial') return `Partly reassessed in ${y}.`;
    // Careful here: this is a statement about the assessment roll, not the deed
    // index. A parcel can sit on a pre-2007 basis and still have recorded deeds
    // since, which is exactly what "From the records" below may go on to cite.
    // "No reset on record" read as though the recorder showed nothing.
    return 'Taxed on a value set before 2007, with no reassessment since.';
  };

  // Only claim what the recorded documents actually support.
  const notes: string[] = [];
  for (const p of items) {
    const recs = records[p.id];
    if (!recs?.length) continue;
    const fam = recs.find((r) => r.kind === 'relational');
    if (fam && fam.grantor && fam.grantee) {
      notes.push(
        `${p.addr}: the recorder shows ${fam.grantor} to ${fam.grantee} in ${String(fam.date).slice(0, 4)}, a transfer between related parties.`,
      );
    }
  }
  if (sameStreet && gap > 0) {
    notes.push(`${top.addr} and ${bot.addr} sit on the same street and are ${fmt$(gap)} a year apart.`);
  }

  const deeds = (p: ParcelProps) => {
    const recs = records[p.id];
    if (!recs) return <p className="cmp-nodeeds">Open this parcel to load its recorded documents.</p>;
    if (!recs.length) return <p className="cmp-nodeeds">No documents recorded since 1990.</p>;
    return (
      <ul className="rec-list">
        {recs.slice(0, 8).map((r, i) => (
          <li key={r.docNumber ?? i}>
            <span className="rec-date">{String(r.date).slice(0, 4)}</span>
            <span className="rec-doc">
              <span className="rec-doctype">
                {docLabel(r.docType)}
                {r.kind === 'market' && <em className="rec-tag rec-market"> transfer</em>}
                {r.kind === 'relational' && <em className="rec-tag rec-exempt"> related parties</em>}
              </span>
              {(r.grantor || r.grantee) && (
                <span className="rec-names">
                  <span className="rec-party">{partyName(r.grantor)}</span>
                  <span className="rec-arrow"> → </span>
                  <span className="rec-party">{partyName(r.grantee)}</span>
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className={`cmp-result ${full ? 'cmp-fullscreen' : 'cmp-side'}`}>
      <div className="cmp-head">
        <h2>Comparison</h2>
        <div className="segmented cmp-seg">
          <button className={!full ? 'on' : ''} onClick={() => full && onToggleFull()}>Panel</button>
          <button className={full ? 'on' : ''} onClick={() => !full && onToggleFull()}>Full screen</button>
        </div>
        <button className="cmp-close" onClick={onClose} aria-label="Close comparison">&times;</button>
      </div>

      <div className="cmp-body">
        <div className="cmp-report">
          <div className="cmp-meta">
            Comparison report · {items.length} parcels
            {pending > 0 && ` · ${pending} still loading`}
          </div>
          <p className="cmp-lede">
            <b>{top.addr}</b> keeps <b>{fmt$(top.savings ?? 0)} a year</b> that a new buyer would owe.{' '}
            {bot.addr} keeps {fmt$(bot.savings ?? 0)}.{' '}
            {gap > 0 && (
              <>
                The {fmt$(gap)} difference sits between properties this model values at{' '}
                {fmt$k(top.estMarket ?? 0)} and {fmt$k(bot.estMarket ?? 0)}.
              </>
            )}
          </p>

          <h4>Why each pays what it pays</h4>
          <ul className="cmp-why">
            {bySav.map((p) => (
              <li key={p.id}>
                <b>{p.addr}.</b> {originOf(p)}{' '}
                Taxed at {p.ratio != null ? Math.round(p.ratio * 100) : '—'}% of estimated value,{' '}
                {fmt$(p.taxEst ?? 0)} against {fmt$((p.taxEst ?? 0) + (p.savings ?? 0))} for a new buyer.
              </li>
            ))}
          </ul>

          {notes.length > 0 && (
            <>
              <h4>From the records</h4>
              {notes.map((n, i) => <p key={i} className="cmp-note">{n}</p>)}
            </>
          )}
        </div>

        {/* One row per attribute with the labels in a left gutter, so the eye
            travels sideways across comparable numbers. Stacking each property
            in its own column repeated every label and left the reader to do
            the matching. */}
        <div className="cmp-matrix-wrap">
          <table className="cmp-matrix">
            <thead>
              <tr>
                <th scope="col"><span className="vh">Attribute</span></th>
                {bySav.map((p) => (
                  <th scope="col" key={p.id}>
                    {p.addr}
                    <button onClick={() => onRemove(p.id)} aria-label={`Remove ${p.addr}`}>&times;</button>
                  </th>
                ))}
                {items.length < MAX_COMPARE && <th scope="col" className="cmp-slot">+ add a property</th>}
              </tr>
            </thead>
            <tbody>
              {([
                ['Kept per year', (p: ParcelProps) => fmt$(p.savings ?? 0), true],
                ['Share taxed', (p: ParcelProps) => (p.ratio != null ? `${Math.round(p.ratio * 100)}%` : '—'), false],
                ['Tax today', (p: ParcelProps) => fmt$(p.taxEst ?? 0), false],
                ['A new buyer pays', (p: ParcelProps) => fmt$((p.taxEst ?? 0) + (p.savings ?? 0)), false],
                ['Assessed', (p: ParcelProps) => fmt$k(p.assessed), false],
                ['Est. market', (p: ParcelProps) => (p.estMarket ? fmt$k(p.estMarket) : '—'), false],
                ['Taxed on its value from', (p: ParcelProps) => String(basisOf(p) ?? 'before 2007'), false],
              ] as Array<[string, (p: ParcelProps) => string, boolean]>).map(([label, get, lead]) => (
                <tr key={label} className={lead ? 'cmp-lead' : undefined}>
                  <th scope="row">{label}</th>
                  {bySav.map((p) => <td key={p.id}>{get(p)}</td>)}
                  {items.length < MAX_COMPARE && <td className="cmp-slot" />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="cmp-cols">
          {bySav.map((p) => (
            <div className="cmp-col" key={p.id}>
              <div className="cmp-col-head">
                <div>
                  <h3>{p.addr}</h3>
                  <div className="cmp-sub">{p.nbhd} · {p.use}</div>
                </div>
                <button onClick={() => onRemove(p.id)} aria-label={`Remove ${p.addr}`}>&times;</button>
              </div>
              <h4 className="cmp-deedhead">Recorded documents</h4>
              {deeds(p)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StreetComparison({
  sel,
  chunkVersion,
  chunks,
}: {
  sel: ParcelProps;
  chunkVersion: number;
  chunks: globalThis.Map<string, ChunkEntry>;
}) {
  const stats = useMemo(() => {
    void chunkVersion;
    if (!sel.street) return null;
    let feats: Feature[] | null = null;
    for (const entry of chunks.values()) {
      if (entry.all.length && entry.all[0].properties.nbhd === sel.nbhd) {
        feats = entry.all;
        break;
      }
    }
    if (!feats) return null;
    const byStreet = new globalThis.Map<string, ParcelProps[]>();
    for (const f of feats) {
      const st = f.properties.street;
      if (!st || f.properties.ratio == null) continue;
      let a = byStreet.get(st);
      if (!a) {
        a = [];
        byStreet.set(st, a);
      }
      a.push(f.properties);
    }
    const mine = byStreet.get(sel.street) ?? [];
    if (mine.length < 3) return null;
    const med = median(mine.map((p) => p.ratio!).sort((a, b) => a - b));
    const avgSav = mine.reduce((s, p) => s + (p.savings ?? 0), 0) / mine.length;
    const rank = sel.ratio != null ? mine.filter((p) => p.ratio! < sel.ratio!).length + 1 : null;
    const nearby: { street: string; median: number; n: number }[] = [];
    for (const [st, arr] of byStreet) {
      if (st === sel.street || arr.length < 5) continue;
      nearby.push({ street: st, median: median(arr.map((p) => p.ratio!).sort((a, b) => a - b)), n: arr.length });
    }
    nearby.sort((a, b) => a.median - b.median);
    return { n: mine.length, median: med, avgSav, rank, deepest: nearby.slice(0, 3) };
  }, [sel, chunkVersion, chunks]);

  if (!stats || !sel.street) return null;
  return (
    <>
      <h3>Your street</h3>
      <div className="street-box">
        <div>
          <b>{sel.street}</b>: {stats.n} properties · median taxed at {Math.round(stats.median * 100)}% of
          value · avg ≈ {fmt$k(stats.avgSav)}/yr saved
        </div>
        {stats.rank != null && (
          <div className="street-rank">
            this property has the #{stats.rank} lowest tax basis of {stats.n} on the street
          </div>
        )}
        {stats.deepest.length > 0 && (
          <div className="street-nearby">
            deepest-subsidy streets in {sel.nbhd}:{' '}
            {stats.deepest.map((d) => `${d.street} (${Math.round(d.median * 100)}%)`).join(' · ')}
          </div>
        )}
      </div>
    </>
  );
}

