// mv3-engine (skill mc-strategy-ops). Local replica of 0_NO5_MV_Cross3 / 0_NO6_MV_Cross3 (market orders + optional trailing stop).
// Bar-close evaluation; orders filled at next bar open. First maxBarsBack bars are not evaluated.
// Usage: const E = require('./mv3-engine'); const P = E.prep(bars); E.run(P, cfg) -> { trades }
'use strict';
const { loadBars } = require('./mc-bt-engine');

const DEFAULT = {
  tradeSignal: 1, pSTime: 915, pETime: 2400, pBEntryLen: 2,
  FastAvg: 10, SlowAvg: 60, AvgFitr: 120, LoseAvg: 6, LoseScope: 10,
  lTrailStart: 0, lTrailPt: 0, sTrailStart: 0, sTrailPt: 0, lStopPt: 0, sStopPt: 0,   // 0_NO6 trailing stop (0 = off)
  pSTime2: 0, pETime2: 0, pExitWin: 0,                                                 // 0_NO6 v2: 2nd window, exit ownership
  sEntryMode: 0,                                   // 0 = FastMA crosses below SlowMA (original); 1 = breakdown: Close <= Lowest(close,FastAvg) and FastMA < SlowMA
  bpv: 50, commission: 200, slippagePts: 0, maxBarsBack: 1500,
};

// cache of rolling arrays keyed by period
function prep(bars) {
  const n = bars.length, c = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), t = new Int32Array(n), d = new Int32Array(n);
  for (let i = 0; i < n; i++) { c[i] = bars[i].c; o[i] = bars[i].o; h[i] = bars[i].h; l[i] = bars[i].l; t[i] = bars[i].t; d[i] = bars[i].date; }
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + c[i];
  return { n, c, o, h, l, t, d, cum, smaC: new Map(), hiC: new Map() };
}
function sma(P, len) {
  if (P.smaC.has(len)) return P.smaC.get(len);
  const a = new Float64Array(P.n);
  for (let i = 0; i < P.n; i++) { const s = Math.max(0, i - len + 1); a[i] = (P.cum[i + 1] - P.cum[s]) / len; }
  P.smaC.set(len, a); return a;
}
function highest(P, len) {           // Highest(close, len) including current bar (monotonic deque)
  if (P.hiC.has(len)) return P.hiC.get(len);
  const a = new Float64Array(P.n), q = new Int32Array(P.n); let h = 0, tl = 0;
  for (let i = 0; i < P.n; i++) {
    while (tl > h && P.c[q[tl - 1]] <= P.c[i]) tl--;
    q[tl++] = i; if (q[h] <= i - len) h++;
    a[i] = P.c[q[h]];
  }
  P.hiC.set(len, a); return a;
}
function lowest(P, len) {            // Lowest(close, len) including current bar
  P.loC = P.loC || new Map(); if (P.loC.has(len)) return P.loC.get(len);
  const a = new Float64Array(P.n), q = new Int32Array(P.n); let h = 0, tl = 0;
  for (let i = 0; i < P.n; i++) {
    while (tl > h && P.c[q[tl - 1]] >= P.c[i]) tl--;
    q[tl++] = i; if (q[h] <= i - len) h++;
    a[i] = P.c[q[h]];
  }
  P.loC.set(len, a); return a;
}

// Single signal: run(P, cfg). Several signals on ONE chart sharing one position: run(P, [cfgA, cfgB, ...])
// (MC evaluates signals in list order; a later signal's entry replaces an earlier one on the same bar).
// 0_NO6 extras: pSTime2/pETime2 second window (0/0 = off); pExitWin=1 -> exits/stops only for positions this
// signal owns (entered while its window was on at the order bar AND the direction is allowed by its tradeSignal),
// and owned exits are not time-gated. pExitWin=0 = original behaviour (exits gated by window, trail always on).
function run(P, cfgIn = {}) {
  const cfgs = (Array.isArray(cfgIn) ? cfgIn : [cfgIn]).map(x => ({ ...DEFAULT, ...x }));
  const g = cfgs[0];                               // bpv / commission / slippage / maxBarsBack from the first signal
  const { n, c, o, h, l, t, d } = P;
  const S = cfgs.map(cfg => ({
    cfg, fma: sma(P, cfg.FastAvg), sma2: sma(P, cfg.SlowAvg), flt: sma(P, cfg.AvgFitr), lma: sma(P, cfg.LoseAvg), hi: highest(P, cfg.FastAvg), lo: cfg.sEntryMode ? lowest(P, cfg.FastAvg) : null,
    own: true, inPrev: false, trail: 0,
  }));
  const slip = g.slippagePts, trades = [];
  let mp = 0, ePx = 0, eI = -1, eName = '', lastExitI = -1, total = 0, pend = null, best = 0;
  const close = (i, px, name) => {
    const pnl = (px - ePx) * mp * g.bpv - 2 * g.commission - 2 * slip * g.bpv;
    trades.push({ dir: mp, eDate: d[eI], eT: t[eI], ePx, xDate: d[i], xT: t[i], xPx: px, eName, name, pnl });
    mp = 0; lastExitI = i; total++;
  };
  const inWin = (cfg, ti) => (ti > cfg.pSTime && ti < cfg.pETime) || (ti > cfg.pSTime2 && ti < cfg.pETime2);
  for (let i = g.maxBarsBack; i < n; i++) {
    // fills at open of bar i
    if (pend) {
      if (pend.exit && mp !== 0) close(i, o[i], pend.exit);
      if (pend.entry) {
        if (mp === -pend.entry.dir) close(i, o[i], pend.entry.name);     // reversal
        if (mp === 0) { mp = pend.entry.dir; ePx = o[i]; eI = i; eName = pend.entry.name; }
      }
      pend = null;
    }
    if (mp !== 0 && eI < i) {                       // stops placed for the position held since before this bar
      let px = 0;
      for (const s of S) if (s.trail) px = px ? (mp > 0 ? Math.max(px, s.trail) : Math.min(px, s.trail)) : s.trail;
      if (px) {
        if (mp > 0 && l[i] <= px) close(i, Math.min(o[i], px), 'MVc_tr');
        else if (mp < 0 && h[i] >= px) close(i, Math.max(o[i], px), 'MVs_tr');
      }
    }
    const ti = t[i];
    if (mp > 0) best = (eI === i) ? h[i] : Math.max(best, h[i]);
    if (mp < 0) best = (eI === i) ? l[i] : Math.min(best, l[i]);
    let entry = null, exit = null;
    for (const s of S) {
      const cfg = s.cfg, inT = inWin(cfg, ti);
      if (mp !== 0 && eI === i)                     // BarsSinceEntry = 0: decide ownership (order bar = previous bar)
        s.own = s.inPrev && (mp > 0 ? cfg.tradeSignal !== -1 : cfg.tradeSignal !== 1);
      s.inPrev = inT;
      const exOK = cfg.pExitWin ? s.own : true;
      // trailing / fixed stop for next bar
      s.trail = 0;
      if (exOK && mp > 0) { if (cfg.lTrailPt > 0 && best - ePx >= cfg.lTrailStart) s.trail = best - cfg.lTrailPt; if (cfg.lStopPt > 0) s.trail = Math.max(s.trail, ePx - cfg.lStopPt); }
      if (exOK && mp < 0) { if (cfg.sTrailPt > 0 && ePx - best >= cfg.sTrailStart) s.trail = best + cfg.sTrailPt; if (cfg.sStopPt > 0) s.trail = s.trail ? Math.min(s.trail, ePx + cfg.sStopPt) : ePx + cfg.sStopPt; }
      // entries (window-gated) and signal exits (window-gated when pExitWin=0, ownership-gated when 1)
      const exT = cfg.pExitWin ? s.own : inT;
      const { fma, sma2, flt, lma, hi, lo } = s;
      const bse = total === 0 || (i - lastExitI) > cfg.pBEntryLen;
      if (inT && cfg.tradeSignal !== -1 && bse && mp <= 0 && c[i] >= hi[i] && fma[i] > sma2[i] && c[i] > flt[i]) entry = { dir: 1, name: 'MVc' };
      if (exT && mp > 0 && c[i] < ePx && lma[i - 1] - lma[i] > cfg.LoseScope) exit = exit || 'MVc_s';
      if (inT && cfg.tradeSignal !== 1 && bse && mp >= 0 && fma[i] < sma2[i] && (cfg.sEntryMode ? c[i] <= lo[i] : fma[i - 1] >= sma2[i - 1]) && c[i] < flt[i]) entry = { dir: -1, name: 'MVs' };
      if (exT && mp < 0 && c[i] > ePx && c[i] - c[i - 1] > cfg.LoseScope && c[i - 1] - c[i - 2] > cfg.LoseScope && c[i - 2] - c[i - 3] > cfg.LoseScope) exit = exit || 'MVs_b';
    }
    if (entry || exit) pend = { exit, entry };
  }
  return { trades, open: mp ? { dir: mp, ePx, eDate: d[eI], eT: t[eI] } : null };
}

function stats(trades, from = 0, to = 99999999) {
  const tr = trades.filter(x => x.xDate >= from && x.xDate <= to);
  let net = 0, peak = 0, mdd = 0, gp = 0, gl = 0, w = 0;
  for (const x of tr) { net += x.pnl; peak = Math.max(peak, net); mdd = Math.max(mdd, peak - net); if (x.pnl > 0) { gp += x.pnl; w++; } else gl -= x.pnl; }
  return { n: tr.length, net: Math.round(net), mdd: Math.round(mdd), pf: gl ? +(gp / gl).toFixed(2) : (gp ? 99 : 0), win: tr.length ? +(w / tr.length * 100).toFixed(1) : 0 };
}
function yearly(trades) {
  const y = {};
  for (const x of trades) { const k = Math.floor(x.xDate / 10000); (y[k] = y[k] || { n: 0, net: 0 }); y[k].n++; y[k].net += x.pnl; }
  return y;
}

module.exports = { loadBars, prep, run, stats, yearly, DEFAULT };

if (require.main === module) {
  const [f, cfgJ] = process.argv.slice(2);
  const P = prep(loadBars(f));
  const r = run(P, cfgJ ? JSON.parse(cfgJ) : {});
  console.log(stats(r.trades), yearly(r.trades), r.open);
}

// Max strategy drawdown on bar-level equity incl. open position (long marked at low, short at high),
// closer to MC "Max Strategy Drawdown" than closed-trade drawdown. from/to = date range of bars.
function eqDD(P, trades, cfgIn = {}, from = 0, to = 99999999) {
  const cfg = { ...DEFAULT, ...cfgIn }; let k = 0, real = 0, peak = -Infinity, dd = 0, worstOpen = 0;
  const key = (d, t) => d * 10000 + t;
  for (let i = 0; i < P.n; i++) {
    const kk = key(P.d[i], P.t[i]);
    while (k < trades.length && key(trades[k].xDate, trades[k].xT) <= kk) { if (trades[k].xDate >= from) real += trades[k].pnl; k++; }
    if (P.d[i] < from || P.d[i] > to) continue;
    let open = 0; const tr = trades[k];
    if (tr && key(tr.eDate, tr.eT) <= kk && tr.eDate >= from) { const px = tr.dir > 0 ? P.l[i] : P.h[i]; open = (px - tr.ePx) * tr.dir * cfg.bpv - cfg.commission; worstOpen = Math.min(worstOpen, open); }
    const eq = real + open; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
  }
  return { eqMdd: Math.round(dd), worstOpen: Math.round(worstOpen) };
}
module.exports.eqDD = eqDD;
