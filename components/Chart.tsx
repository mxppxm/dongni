"use client";

/**
 * 图表：自己用 SVG 画，不引三方库。配色跟着主题走（柔和），细网格线，圆角柱子。
 * 认三种：line（折线）、bar（柱状）、pie（环形饼图）。
 */

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const W = 720;
const H = 250;
const PAD = { l: 44, r: 16, t: 22, b: 30 };

type RawSeries = { name?: unknown; values?: unknown };
type Spec = { type?: unknown; title?: unknown; labels?: unknown; series?: unknown; values?: unknown };

const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
const nums = (v: unknown) => (Array.isArray(v) ? v.map(num).filter((x) => Number.isFinite(x)) : []);
const short = (n: number) => (Math.abs(n) >= 10000 ? `${Math.round(n / 1000) / 10}万` : `${Math.round(n * 10) / 10}`);

function niceStep(raw: number) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export default function Chart({ spec }: { spec: unknown }) {
  const s = (spec ?? {}) as Spec;
  const labels = Array.isArray(s.labels) ? s.labels.map((x) => String(x)) : [];
  const series = (Array.isArray(s.series) ? (s.series as RawSeries[]) : [])
    .map((x, i) => {
      const o = (x ?? {}) as RawSeries;
      return { name: typeof o.name === "string" && o.name.trim() ? o.name : `系列 ${i + 1}`, values: nums(o.values) };
    })
    .filter((x) => x.values.length);
  const flat = nums(s.values);
  const kind: "line" | "bar" | "pie" = s.type === "bar" ? "bar" : s.type === "pie" ? "pie" : "line";
  const title = typeof s.title === "string" ? s.title : "";

  if (kind === "pie") {
    const values = series[0]?.values.length ? series[0].values : flat;
    if (!values.length) return null;
    const total = values.reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
    const cx = W / 2;
    const cy = H / 2;
    const r = 78;
    const c = 2 * Math.PI * r;
    let offset = 0;
    const arcs = values.map((v, i) => {
      const len = (Math.max(0, v) / total) * c;
      const dash = Math.max(0, len - 3);
      const el = (
        <circle
          key={i}
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={COLORS[i % COLORS.length]}
          strokeWidth={26}
          strokeDasharray={`${dash} ${c - dash}`}
          strokeDashoffset={-offset}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      );
      offset += len;
      return el;
    });
    return (
      <div className="chart">
        {title && <div className="chart-title">{title}</div>}
        <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img">
          {arcs}
        </svg>
        <div className="chart-legend">
          {values.map((v, i) => (
            <span key={i}>
              <i style={{ background: COLORS[i % COLORS.length] }} />
              {labels[i] ?? `第 ${i + 1} 项`}
              <em>{Math.round((Math.max(0, v) / total) * 100)}%</em>
            </span>
          ))}
        </div>
      </div>
    );
  }

  // 只给了 values 没给 series 也认
  const list = series.length ? series : flat.length ? [{ name: typeof s.title === "string" ? s.title : "", values: flat }] : [];
  const all = list.flatMap((x) => x.values);
  if (!all.length) return null;
  const count = Math.max(labels.length, ...list.map((x) => x.values.length));
  let hi = Math.max(...all, 0);
  let lo = Math.min(...all, 0);
  if (hi === lo) hi = lo + 1;
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + innerH - ((v - lo) / (hi - lo || 1)) * innerH;
  const band = innerW / Math.max(1, count);
  const xAt = (i: number) => (kind === "bar" ? PAD.l + band * (i + 0.5) : PAD.l + (count > 1 ? (i * innerW) / (count - 1) : innerW / 2));

  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 1000; v += step) ticks.push(v);

  return (
    <div className="chart">
      {title && <div className="chart-title">{title}</div>}
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={PAD.l - 8} y={y(t) + 3.5} textAnchor="end" className="chart-axis">
              {short(t)}
            </text>
          </g>
        ))}
        {labels.slice(0, count).map((l, i) =>
          count <= 8 || i % 2 === 0 ? (
            <text key={i} x={xAt(i)} y={H - 8} textAnchor="middle" className="chart-axis">
              {l.length > 6 ? `${l.slice(0, 5)}…` : l}
            </text>
          ) : null,
        )}
        {list.map((sr, si) => {
          const color = COLORS[si % COLORS.length];
          if (kind === "bar") {
            const bw = Math.max(4, Math.min(30, (band * 0.62) / list.length));
            return sr.values.map((v, i) => {
              const x = xAt(i) - (bw * list.length) / 2 + si * bw;
              const top = y(v);
              const h = Math.max(1, y(Math.min(lo, 0)) - top);
              return (
                <rect
                  key={`${si}-${i}`}
                  x={x}
                  y={v >= 0 ? top : y(0)}
                  width={bw - 2}
                  height={v >= 0 ? h : Math.max(1, y(v) - y(0))}
                  rx={Math.min(5, bw / 3)}
                  fill={color}
                  opacity={0.9}
                />
              );
            });
          }
          const pts = sr.values.map((v, i) => `${xAt(i)},${y(v)}`).join(" ");
          return (
            <g key={si}>
              <polyline points={pts} fill="none" stroke={color} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
              {sr.values.map((v, i) =>
                count <= 14 ? <circle key={i} cx={xAt(i)} cy={y(v)} r={3} fill="var(--chart-dot)" stroke={color} strokeWidth={2} /> : null,
              )}
            </g>
          );
        })}
      </svg>
      {list.length > 1 && (
        <div className="chart-legend">
          {list.map((sr, i) => (
            <span key={i}>
              <i style={{ background: COLORS[i % COLORS.length] }} />
              {sr.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}