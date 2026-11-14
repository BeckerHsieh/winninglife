// kd-engine (skill mc-strategy-ops). Local replica of 0_NO5_MV_Cross_KD / 0_NO6_MV_Cross_KD
// (MA cross + KD filter whose look-back grows with the losing streak; market orders + optional trailing / fixed stop).
// Bar-close evaluation; orders filled at next bar open. First maxBarsBack bars are not evaluated.
// Usage: const K = require('./kd-engine'); const P = K.prep(bars); K.run(P, cfg) or K.run(P, [cfgLong, cfgShort])
'use strict';
const M = require('./mv3-engine');

const DEFAULT = {
  tradeSignal: 1, pSTime: 950, pETime: 2400, pBEntryLen: 47,
  FastAvg: 10, SlowAvg: 50, KdHighFilter: 80, KdLowFilter: 20, KdMulti: 1, loseCntFilter: 2,
  // 0_NO6 additions (all 0 = behave exactly like 0_NO5_MV_Cross_KD)
  lTrailStart: 0, lTrailPt: 0, sTrailStart: 0, sTrailPt: 0, lStopPt: 0, sStopPt: 0,
  pSTime2: 0, pETime2: 0, pExitWin: 0,
  lcCap: 0,        // cap on the loseCnt used for the KD look-back (0 = no cap)
  pFlatOnly: 0,    // 1 = enter only when flat (no reversal of the other signal's position)
  bpv: 50, commission: 200, slippagePts: 0, maxBarsBack: 6000,
};

function prep(bars) { const P = M.prep(bars); P.roll = new Map(); return P; }
function sma(P, len) { if (P.smaC.size > 40) P.smaC.clear(); return smaRaw(P, len); }
function smaRaw(P, len) {
  if (P.smaC.has(len)) return P.smaC.get(len);
  const a = new Float64Array(P.n);
  for (let i = 0; i < P.n; i++) { const s = Math.max(0, i - len + 1); a[i] = (P.cum[i + 1] - P.cum[s]) / len; }
  P.smaC.set(len, a); return a;
}
// rolling max of high / min of low over len bars incl. current (monotonic deque), cached
function roll(P, isMax, len) {
  const key = (isMax ? 'H' : 'L') + len;
  if (P.roll.has(key)) return P.roll.get(key);
  if (P.roll.size > 60) P.roll.clear();
  const src = isMax ? P.h : P.l, n = P.n, a = new Float32Array(n), q = new Int32Array(n); let hd = 0, tl = 0;
  for (let i = 0; i < n; i++) {
    if (isMax) while (tl > hd && src[q[tl - 1]] <= src[i]) tl--; else while (tl > hd && src[q[tl - 1]] >= src[i]) tl--;
    q[tl++] = i; if (q[hd] <= i - len) hd++;
    a[i] = src[q[hd]];
  }
  P.roll.set(key, a); return a;
}

function run(P, cfgIn = {}) {
  const cfgs = (Array.isArray(cfgIn) ? cfgIn : [cfgIn]).map(x => ({ ...DEFAULT, ...x }));
  const g = cfgs[0];
  const { n, c, o, h, l, t, d } = P;
  const S = cfgs.map(cfg => ({ cfg, fma: sma(P, cfg.FastAvg), sma2: sma(P, cfg.SlowAvg), K: 0, D: 0, rsv: 0, loseCnt: 0, own: true, inPrev: false, trail: 0, hiA: new Map(), loA: new Map() }));
  const slip = g.slippagePts, trades = [];
  let mp = 0, ePx = 0, eI = -1, eName = '', lastExitI = -1, total = 0, pend = null, best = 0, lastPnl = 0, conflicts = 0, maxLen = 0;
  const close = (i, px, name) => {
    const pnl = (px - ePx) * mp * g.bpv - 2 * g.commission - 2 * slip * g.bpv;
    trades.push({ dir: mp, eDate: d[eI], eT: t[eI], ePx, xDate: d[i], xT: t[i], xPx: px, eName, name, pnl });
    mp = 0; lastExitI = i; total++; lastPnl = pnl;
  };
  const inWin = (cfg, ti) => (ti > cfg.pSTime && ti < cfg.pETime) || (ti > cfg.pSTime2 && ti < cfg.pETime2);
  for (let i = g.maxBarsBack; i < n; i++) {
    if (pend) {                                     // fills at open of bar i
      if (pend.exit && mp !== 0) close(i, o[i], pend.exit);
      if (pend.entry) {
        if (mp === -pend.entry.dir) close(i, o[i], pend.entry.name);
        if (mp === 0) { mp = pend.entry.dir; ePx = o[i]; eI = i; eName = pend.entry.name; }
      }
      pend = null;
    }
    if (mp !== 0 && eI < i) {                       // stop orders for a position held since before this bar
      let px = 0;
      for (const s of S) if (s.trail) px = px ? (mp > 0 ? Math.max(px, s.trail) : Math.min(px, s.trail)) : s.trail;
      if (px) {
        if (mp > 0 && l[i] <= px) close(i, Math.min(o[i], px), 'Bc_tr');
        else if (mp < 0 && h[i] >= px) close(i, Math.max(o[i], px), 'Sc_tr');
      }
    }
    const ti = t[i];
    if (mp > 0) best = (eI === i) ? h[i] : Math.max(best, h[i]);
    if (mp < 0) best = (eI === i) ? l[i] : Math.min(best, l[i]);
    let entry = null, exit = null;
    for (const s of S) {
      const cfg = s.cfg, inT = inWin(cfg, ti);
      if (mp !== 0 && eI === i) {                   // BarsSinceEntry = 0
        if (lastPnl > 0) s.loseCnt = 0; else s.loseCnt++;          // PositionProfit(1): previous closed trade (0 if none)
        s.own = s.inPrev && (mp > 0 ? cfg.tradeSignal !== -1 : cfg.tradeSignal !== 1);
      }
      s.inPrev = inT;
      // KD with look-back scaled by the losing streak
      let v = cfg.KdMulti;
      if (s.loseCnt > cfg.loseCntFilter) v = cfg.KdMulti * (cfg.lcCap > 0 ? Math.min(s.loseCnt, cfg.lcCap) : s.loseCnt);
      const hl = Math.round(cfg.FastAvg * v), ll = Math.round(cfg.SlowAvg * v);
      if (ll > maxLen) maxLen = ll; if (hl > maxLen) maxLen = hl;
      let ha = s.hiA.get(hl); if (!ha) { ha = roll(P, true, hl); s.hiA.set(hl, ha); }
      let la = s.loA.get(ll); if (!la) { la = roll(P, false, ll); s.loA.set(ll, la); }
      const hv = ha[i], lv = la[i];
      if (hv !== lv) s.rsv = 100 * (c[i] - lv) / (hv - lv);
      s.K = s.rsv / 3 + 2 * s.K / 3;
      s.D = s.K / 3 + 2 * s.D / 3;
      const c1 = s.K > cfg.KdHighFilter && s.D > cfg.KdLowFilter, c2 = s.K < cfg.KdHighFilter && s.D < cfg.KdLowFilter;
      const exOK = cfg.pExitWin ? s.own : true, exT = cfg.pExitWin ? s.own : inT;
      s.trail = 0;
      if (exOK && mp > 0) { if (cfg.lTrailPt > 0 && best - ePx >= cfg.lTrailStart) s.trail = best - cfg.lTrailPt; if (cfg.lStopPt > 0) s.trail = Math.max(s.trail, ePx - cfg.lStopPt); }
      if (exOK && mp < 0) { if (cfg.sTrailPt > 0 && ePx - best >= cfg.sTrailStart) s.trail = best + cfg.sTrailPt; if (cfg.sStopPt > 0) s.trail = s.trail ? Math.min(s.trail, ePx + cfg.sStopPt) : ePx + cfg.sStopPt; }
      const up = s.fma[i] > s.sma2[i], dn = s.fma[i] < s.sma2[i];
      const bse = total === 0 || (i - lastExitI) > cfg.pBEntryLen;
      const flatOK = !cfg.pFlatOnly || mp === 0;
      if (inT && cfg.tradeSignal !== -1 && bse && flatOK && up && c1) { if (entry && entry.dir === -1) conflicts++; entry = { dir: 1, name: 'Bc' }; }
      if (exT && mp > 0 && dn) exit = exit || 'Bc_s';
      if (inT && cfg.tradeSignal !== 1 && bse && flatOK && dn && c2) { if (entry && entry.dir === 1) conflicts++; entry = { dir: -1, name: 'Sc' }; }
      if (exT && mp < 0 && up) exit = exit || 'Sc_b';
    }
    if (entry && entry.dir === mp) entry = null;    // no pyramiding
    if (entry || exit) pend = { exit, entry };
  }
  return { trades, open: mp ? { dir: mp, ePx, eDate: d[eI], eT: t[eI] } : null, conflicts, maxLen };
}

module.exports = { loadBars: M.loadBars, prep, run, stats: M.stats, yearly: M.yearly, eqDD: M.eqDD, DEFAULT };

if (require.main === module) {
  const [f, cfgJ] = process.argv.slice(2);
  const P = prep(M.loadBars(f));
  const cfg = cfgJ ? JSON.parse(cfgJ) : {};
  const r = run(P, cfg);
  console.log(M.stats(r.trades), M.yearly(r.trades), r.open, 'conflicts', r.conflicts, 'maxLen', r.maxLen, M.eqDD(P, r.trades, Array.isArray(cfg) ? cfg[0] : cfg));
}
