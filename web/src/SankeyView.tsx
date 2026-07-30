// "Breakdown" view: a Sankey of where the total est. annual tax gap flows —
// total -> property type -> how the low taxable value arose. Pure SVG, no lib.

type SankeyFlow = { cls: 'sfh' | 'multi'; origin: 'prehold' | 'market' | 'relational'; savings: number; count: number };

const fmtB = (n: number) => (n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : '$' + Math.round(n / 1e6) + 'M');

const TYPE_NAME: Record<string, string> = { sfh: 'Single-family', multi: 'Multi-family' };
const ORIGIN_NAME: Record<string, string> = {
  prehold: 'Owned since before 2007',
  market: 'Bought & held since 2007',
  relational: 'Family or trust transfer',
};
const ORIGIN_NOTE: Record<string, string> = {
  prehold: 'Long-time owners whose low taxable value predates our data. The bulk of the gap.',
  market: 'Bought at market since 2007 and holding as values kept climbing.',
  relational: 'Passed within a family or into a trust without resetting the tax. A small slice, and a floor, since pre-2007 transfers are invisible to us.',
};
const ORDER = ['prehold', 'market', 'relational'] as const;

export function SankeyView({
  flows,
  onExplore,
  compact = false,
}: {
  flows: SankeyFlow[];
  onExplore?: () => void;
  compact?: boolean;
}) {
  const W = 1040, H = 520, padY = 46, colGap = 8;
  const total = flows.reduce((s, f) => s + f.savings, 0);
  if (!total) return null;
  const usableH = H - 2 * padY;
  const scale = usableH / total; // px per dollar (shared so column heights match)

  // column x positions (leave room for the right-column labels)
  const x0 = 20, xw = 22; // node width
  const x1 = W * 0.38;
  const x2 = W * 0.66;

  // build nodes with stacked y positions
  type Node = { key: string; label: string; value: number; x: number; y0: number; y1: number };
  const totalNode: Node = { key: 'total', label: 'Total tax gap', value: total, x: x0, y0: padY, y1: padY + total * scale };

  const typeVals: Record<string, number> = {};
  for (const f of flows) typeVals[f.cls] = (typeVals[f.cls] ?? 0) + f.savings;
  const typeNodes: Node[] = [];
  let ty = padY;
  for (const cls of ['multi', 'sfh']) {
    const v = typeVals[cls] ?? 0;
    typeNodes.push({ key: cls, label: TYPE_NAME[cls], value: v, x: x1, y0: ty, y1: ty + v * scale });
    ty += v * scale + colGap;
  }

  const originVals: Record<string, number> = {};
  for (const f of flows) originVals[f.origin] = (originVals[f.origin] ?? 0) + f.savings;
  const originNodes: Node[] = [];
  let oy = padY;
  for (const origin of ORDER) {
    const v = originVals[origin] ?? 0;
    originNodes.push({ key: origin, label: ORIGIN_NAME[origin], value: v, x: x2, y0: oy, y1: oy + v * scale });
    oy += v * scale + colGap;
  }

  const byKey = (nodes: Node[], k: string) => nodes.find((n) => n.key === k)!;

  // ribbon link between two node bands
  function ribbon(ax: number, ay0: number, ay1: number, bx: number, by0: number, by1: number, color: string, key: string) {
    const mx = (ax + bx) / 2;
    return (
      <path
        key={key}
        d={`M${ax},${ay0} C${mx},${ay0} ${mx},${by0} ${bx},${by0} L${bx},${by1} C${mx},${by1} ${mx},${ay1} ${ax},${ay1} Z`}
        fill={color}
        opacity={0.5}
      />
    );
  }

  // total -> type links (consume total node band top-down)
  const links: React.ReactNode[] = [];
  let totCursor = totalNode.y0;
  for (const cls of ['multi', 'sfh']) {
    const tn = byKey(typeNodes, cls);
    const h = (typeVals[cls] ?? 0) * scale;
    links.push(
      ribbon(totalNode.x + xw, totCursor, totCursor + h, tn.x, tn.y0, tn.y1, cls === 'multi' ? '#e8973a' : '#f0b968', `t-${cls}`),
    );
    totCursor += h;
  }

  // type -> origin links; track cursors on both type (right edge) and origin (left edge)
  const typeCursor: Record<string, number> = {};
  typeNodes.forEach((n) => (typeCursor[n.key] = n.y0));
  const originCursor: Record<string, number> = {};
  originNodes.forEach((n) => (originCursor[n.key] = n.y0));
  // draw in origin order so origin bands stack cleanly
  for (const origin of ORDER) {
    for (const cls of ['multi', 'sfh']) {
      const f = flows.find((x) => x.cls === cls && x.origin === origin);
      if (!f || f.savings <= 0) continue;
      const h = f.savings * scale;
      const tn = byKey(typeNodes, cls);
      const on = byKey(originNodes, origin);
      links.push(
        ribbon(
          tn.x + xw, typeCursor[cls], typeCursor[cls] + h,
          on.x, originCursor[origin], originCursor[origin] + h,
          origin === 'relational' ? '#b25007' : origin === 'market' ? '#d67420' : '#eea648',
          `${cls}-${origin}`,
        ),
      );
      typeCursor[cls] += h;
      originCursor[origin] += h;
    }
  }

  const node = (n: Node, align: 'total' | 'mid' | 'right') => (
    <g key={n.key}>
      <rect x={n.x} y={n.y0} width={xw} height={Math.max(n.y1 - n.y0, 1)} rx={3} fill="#6b3608" />
      {align === 'total' && (
        <text x={n.x} y={n.y0 - 12} className="sk-node-label">
          Total gap · {fmtB(n.value)}
        </text>
      )}
      {align === 'mid' && (
        <text x={n.x + xw + 8} y={n.y0 + 15} className="sk-node-label">
          {n.label}
          <tspan className="sk-node-amt"> {fmtB(n.value)}</tspan>
        </text>
      )}
      {align === 'right' && (
        <text x={n.x + xw + 8} y={(n.y0 + n.y1) / 2} className="sk-node-label" dominantBaseline="middle">
          {n.label}
          <tspan className="sk-node-amt"> {fmtB(n.value)}</tspan>
        </text>
      )}
    </g>
  );

  return (
    <div className={`sankey-view${compact ? ' compact' : ''}`}>
      {!compact && <div className="sankey-head">
        <h2>Where the ${(total / 1e9).toFixed(1)} billion a year goes</h2>
        <p>
          Every dollar of estimated annual property-tax savings, traced from the citywide total, to the kind
          of property, to how that low taxable value came to be. Commercial property is excluded (no reliable
          market estimate).
        </p>
      </div>}
      <div className="sankey-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} className="sankey-svg" preserveAspectRatio="xMidYMid meet">
          {links}
          {node(totalNode, 'total')}
          {typeNodes.map((n) => node(n, 'mid'))}
          {originNodes.map((n) => node(n, 'right'))}
        </svg>
      </div>
      <div className="sankey-legend">
        {ORDER.map((o) => (
          <div key={o} className="sk-card">
            <div className="sk-card-h">
              <span className={`sk-dot sk-${o}`} />
              <b>{ORIGIN_NAME[o]}</b>
              <span className="sk-amt">{fmtB(originVals[o] ?? 0)}/yr</span>
            </div>
            <div className="sk-card-b">{ORIGIN_NOTE[o]}</div>
          </div>
        ))}
      </div>
      {!compact && onExplore && <button className="story-next sankey-explore" onClick={onExplore}>
        Explore the map →
      </button>}
    </div>
  );
}
