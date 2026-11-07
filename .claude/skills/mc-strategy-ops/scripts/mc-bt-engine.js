// mc-bt-engine (skill mc-strategy-ops). MXF-18 backtester: replicates MC bar-close evaluation of
// 0_NO3_setTopProfit + 0_NO5_MV_Cross_BB x2 + 0_NO5_Stop_Loss + Stop Loss (built-in) on 18-min bars.
// Orders generated at bar i close are filled on bar i+1 (market @ open, stop @ max/min(open, stop)).
'use strict';
const fs = require('fs');

function loadBars(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const bars = [];
  for (const ln of lines) {
    const c = ln.split(/[,\t;]/).map(s => s.trim());
    if (!/^\d/.test(c[0])) continue;          // header
    // Date formats: YYYY/MM/DD, YYYY-MM-DD, MM/DD/YYYY, YYYYMMDD ; Time HH:MM[:SS] or HHMM
    let d = c[0], y, m, dd;
    if (/^\d{8}$/.test(d)) { y = +d.slice(0, 4); m = +d.slice(4, 6); dd = +d.slice(6, 8); }
    else {
      const p = d.split(/[\/\-.]/).map(Number);
      if (p[0] > 1900) [y, m, dd] = p; else [m, dd, y] = p;
    }
    const tp = c[1].includes(':') ? c[1].split(':').map(Number) : [Math.floor(+c[1] / 100), +c[1] % 100];
    const t = tp[0] * 100 + tp[1];
    bars.push({ date: y * 10000 + m * 100 + dd, t, o: +c[2], h: +c[3], l: +c[4], c: +c[5], v: +(c[6] || 0) });
  }
  return bars;
}

// aggregate 1-min bars (end-time stamped) into N-min bars, session-aligned like MC (BreakOnSession)
// sessions: day 08:45-13:45, night 15:00-05:00 (next day)
function sessionStart(t) { return (t > 845 && t <= 1345) ? 845 : 1500; }
function minutesOf(t) { return Math.floor(t / 100) * 60 + (t % 100); }
function aggregate(bars1, n) {
  const out = []; let cur = null, key = null;
  for (const b of bars1) {
    const ss = sessionStart(b.t);
    let mins = minutesOf(b.t) - minutesOf(ss); if (mins <= 0) mins += 1440;
    const idx = Math.ceil(mins / n);
    let endM = (minutesOf(ss) + idx * n) % 1440;
    // clip to session end
    const sessEnd = ss === 845 ? minutesOf(1345) : minutesOf(500);
    if (ss === 845 && endM > sessEnd) endM = sessEnd;
    if (ss === 1500 && endM > sessEnd && endM < minutesOf(1500)) endM = sessEnd;
    const tEnd = Math.floor(endM / 60) * 100 + endM % 60;
    const k = b.date + '-' + ss + '-' + idx;
    if (k !== key) { if (cur) out.push(cur); cur = { date: b.date, t: tEnd, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; key = k; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; cur.date = b.date; }
  }
  if (cur) out.push(cur);
  return out;
}

const DEFAULT = {
  bpv: 50, commission: 200, slippagePts: 0, ppComm: 400,
  // two BB copies (as in MXF-18.wsp)
  copies: [
    { tradeSignal: 1, pSTime: 950, pETime: 2400, pBEntryLen: 47, FastAvg: 10, SlowAvg: 60, AvgFitr: 120, hLFitr: 120, bbStd: 1, loseCntFilter: 2 },
    { tradeSignal: 1, pSTime: 1, pETime: 400, pBEntryLen: 47, FastAvg: 10, SlowAvg: 60, AvgFitr: 120, hLFitr: 40, bbStd: 1, loseCntFilter: 2 },
  ],
  topProfit: { on: true, pProfit: 400, pTopPoint: 50 },
  stopLossSig: { on: true, EntryLen: 30, EntryLossPoint: 10 },
  builtinStopPts: 400,          // Stop Loss Amount 20000 / bpv 50
  maxBarsBack: 2000,            // BarReference; referencing more aborts the strategy (MC error)
  // --- optimization extensions (default off = original behaviour) ---
  loseCntCap: 0,                // >0: cap loseCnt used for Highest/Lowest lookback & band switch
  loseCntResetBars: 0,          // >0: reset loseCnt when flat for N bars
  symExit: false,
  sepLoseCnt: false,            // true: long & short keep their own loseCnt (updated by their own previous trade)
  short: null,                  // overrides for short positions: {builtinStopPts, pProfit, pTopPoint, EntryLen, EntryLossPoint}
  pct: false,
  deploy: false,                // true: realistic MC deployment (see below)
  baseExitsOnShort: true,       // deploy: setTopProfit/NO5_Stop_Loss also act on shorts (pType/tradeSign = 0)
  sMod: null,                   // deploy: BB2 short-copy exits {stopPct, trailStartPct, trailBackPct} (x100 = 1%), next-bar stop orders                   // true: builtinStopPts/pProfit/pTopPoint/EntryLossPoint are % of entry price (x100 = 1%)               // true: short exits on fastMA>slowMA (mirror of Bc_s) instead of requiring Condition1
};

// cached indicator helpers (prefix sums + sparse tables), keyed on the bars array
const CACHE = new WeakMap();
function prep(bars) {
  let c = CACHE.get(bars); if (c) return c;
  const C = bars.map(b => b.c), N = C.length;
  const P = new Float64Array(N + 1), Q = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) { P[i + 1] = P[i] + C[i]; Q[i + 1] = Q[i] + C[i] * C[i]; }
  const LOG = new Uint8Array(N + 2); for (let i = 2; i <= N + 1; i++) LOG[i] = LOG[i >> 1] + 1;
  const mx = [Float64Array.from(C)], mn = [Float64Array.from(C)];
  for (let k = 1; (1 << k) <= N; k++) {
    const a = new Float64Array(N), b = new Float64Array(N), pa = mx[k - 1], pb = mn[k - 1], h = 1 << (k - 1);
    for (let i = 0; i + (1 << k) <= N; i++) { a[i] = Math.max(pa[i], pa[i + h]); b[i] = Math.min(pb[i], pb[i + h]); }
    mx.push(a); mn.push(b);
  }
  c = { C, P, Q, LOG, mx, mn }; CACHE.set(bars, c); return c;
}
function rq(T, LOG, lo, hi, isMax) { const k = LOG[hi - lo + 1]; const a = T[k][lo], b = T[k][hi - (1 << k) + 1]; return isMax ? Math.max(a, b) : Math.min(a, b); }

function run(bars, cfgIn = {}) {
  const cfg = { ...DEFAULT, ...cfgIn };
  const X = prep(bars), C = X.C;
  const N = bars.length;
  const sma = (i, n) => i + 1 < n ? NaN : (X.P[i + 1] - X.P[i + 1 - n]) / n;
  const sdev = (i, n, m) => Math.sqrt(Math.max(0, (X.Q[i + 1] - X.Q[i + 1 - n]) / n - m * m));
  const highest = (i, n) => rq(X.mx, X.LOG, Math.max(0, i - n + 1), i, true);
  const lowest = (i, n) => rq(X.mn, X.LOG, Math.max(0, i - n + 1), i, false);
  let pos = 0, entryPx = 0, entryBar = -1, entryT = 0, lastExitBar = -1, total = 0, mfePts = 0;
  let lastPosProfit = 0, lastProfDir = { 1: 0, '-1': 0 }, lcDir = { 1: 0, '-1': 0 }, loseCnt = 0, wins = 0, losses = 0, aborted = null;
  const trades = [];
  let pend = [];   // orders for next bar: {type:'buy'|'sell'|'short'|'cover', kind:'mkt'|'stop', px, name}
  const warm = cfg.maxBarsBack;
  const slip = cfg.slippagePts;

  function close(i, px, name) {
    const pts = (px - entryPx) * pos - 2 * slip;
    const pnl = pts * cfg.bpv - 2 * cfg.commission;
    trades.push({ dir: pos, eDate: bars[entryBar].date, eT: bars[entryBar].t, ePx: entryPx, xDate: bars[i].date, xT: bars[i].t, xPx: px, name, pts, pnl, bars: i - entryBar });
    lastPosProfit = pts * cfg.bpv - cfg.ppComm;  // positionprofit(1)
    lastProfDir[pos] = lastPosProfit;
    pos = 0; lastExitBar = i; total++;
  }
  const par = (key, dir) => { if (cfg.deploy) return key in cfg.topProfit ? cfg.topProfit[key] : key in cfg.stopLossSig ? cfg.stopLossSig[key] : cfg[key];
    const v = (dir === -1 && cfg.short && cfg.short[key] !== undefined) ? cfg.short[key] : (key in cfg.topProfit ? cfg.topProfit[key] : key in cfg.stopLossSig ? cfg.stopLossSig[key] : cfg[key]); return v; };
  const pts = (v, dir = pos) => (cfg.pct || (dir === -1 && cfg.short && cfg.short.pct)) ? entryPx * v / 10000 : v;
  function open(i, dir, px) { pos = dir; entryPx = px; entryBar = i; entryT = bars[i].t; mfePts = 0; }

  for (let i = 0; i < N; i++) {
    const b = bars[i];
    // ---- fills on bar i ----
    if (pend.length) {
      // market exits first, then market entries, then stops
      const isEx = o => o.type === 'sell' || o.type === 'cover';
      for (const o of [...pend.filter(o => o.kind === 'mkt' && isEx(o)), ...pend.filter(o => o.kind === 'mkt' && !isEx(o))]) {
        if ((o.type === 'sell' && pos === 1) || (o.type === 'cover' && pos === -1)) close(i, b.o, o.name);
        else if (o.type === 'buy' && pos <= 0) { if (pos === -1) close(i, b.o, o.name); open(i, 1, b.o); }
        else if (o.type === 'short' && pos >= 0) { if (pos === 1) close(i, b.o, o.name); open(i, -1, b.o); }
      }
      // built-in Stop Loss competes with signal stops: include it so the price hit first wins
      if (pos !== 0 && entryBar < i && par('builtinStopPts', pos) > 0) pend.push({ type: pos === 1 ? 'sell' : 'cover', kind: 'stop', px: entryPx - pos * pts(par('builtinStopPts', pos)), name: 'Stop Loss' });
      for (const o of pend.filter(o => o.kind === 'stop').sort((a, b) => (a.type === 'cover' ? a.px - b.px : b.px - a.px))) {
        if (o.type === 'sell' && pos === 1 && entryBar < i && b.l <= o.px) close(i, Math.min(b.o, o.px), o.name);
        else if (o.type === 'cover' && pos === -1 && entryBar < i && b.h >= o.px) close(i, Math.max(b.o, o.px), o.name);
      }
      pend = [];
    }
    // built-in Stop Loss (intrabar, active on entry bar too)
    if (pos !== 0 && par('builtinStopPts', pos) > 0) {
      const sp = entryPx - pos * pts(par('builtinStopPts', pos));
      if (pos === 1 && b.l <= sp) close(i, entryBar === i ? sp : Math.min(b.o, sp), 'Stop Loss');
      else if (pos === -1 && b.h >= sp) close(i, entryBar === i ? sp : Math.max(b.o, sp), 'Stop Loss');
    }
    if (pos !== 0) mfePts = Math.max(mfePts, (pos === 1 ? b.h - entryPx : entryPx - b.l) - cfg.commission / cfg.bpv);  // MC MaxPositionProfit: intrabar high/low, net of entry commission
    if (i < warm) continue;

    // ---- bar-close evaluation ----
    const t = b.t;
    const bse = pos !== 0 ? i - entryBar : -1;
    // loseCnt bookkeeping (each BB copy does it; they see the same state, so once)
    if (pos !== 0 && bse === 0) {
      if (lastPosProfit > 0) { wins++; loseCnt = 0; } else { losses++; loseCnt++; }
      if (lastProfDir[pos] > 0) lcDir[pos] = 0; else lcDir[pos]++;
    }
    if (cfg.loseCntResetBars > 0 && pos === 0 && lastExitBar >= 0 && i - lastExitBar === cfg.loseCntResetBars) loseCnt = 0;
    const lc = cfg.loseCntCap > 0 ? Math.min(loseCnt, cfg.loseCntCap) : loseCnt;

    // 0_NO3_setTopProfit
    if (cfg.topProfit.on && pos !== 0 && !(cfg.deploy && pos === -1 && !cfg.baseExitsOnShort) && par('pProfit', pos) > 0 && mfePts >= pts(par('pProfit', pos))) {
      pend.push({ type: pos === 1 ? 'sell' : 'cover', kind: 'stop', px: Math.round(entryPx + pos * (mfePts - pts(par('pTopPoint', pos)))), name: pos === 1 ? 'BtO' : 'StO' });
    }
    // BB copies
    for (const p of cfg.copies) {
      const lcc0 = cfg.sepLoseCnt ? lcDir[p.tradeSignal === -1 ? -1 : 1] : loseCnt;
      const lcc = cfg.loseCntCap > 0 ? Math.min(lcc0, cfg.loseCntCap) : lcc0;
      const look = lcc * p.hLFitr;
      if (look > cfg.maxBarsBack && !aborted) { aborted = { i, date: b.date, t, loseCnt, look }; }
      const fast = sma(i, p.FastAvg), slow = sma(i, p.SlowAvg), filt = sma(i, p.AvgFitr);
      const sd = sdev(i, p.AvgFitr, filt);
      const k = (p.loseCntFilter >= lcc) ? p.bbStd : p.bbStd * 2;
      const trOK = !p.trendLen || (p.tradeSignal === -1 ? b.c < sma(i, p.trendLen) : b.c > sma(i, p.trendLen));
      const up = filt + k * sd, dn = filt - k * sd;
      const hh = look > 0 ? highest(i, look) : b.c;   // MC Extremes(len 0) returns Price itself
      const ll = look > 0 ? lowest(i, look) : b.c;
      const c1 = b.c > filt && b.c > up && b.c >= hh;
      const c2 = b.c < filt && b.c < dn && b.c <= ll;
      const inT = t > p.pSTime && t < p.pETime;
      const canEnter = (lastExitBar >= 0 ? (i - lastExitBar) > p.pBEntryLen : true) || total === 0;
      if (p.tradeSignal !== -1 && inT && canEnter && trOK && fast > slow && c1) pend.push({ type: 'buy', kind: 'mkt', name: 'Bc' });
      if (p.tradeSignal !== -1 && inT && fast < slow && pos === 1) pend.push({ type: 'sell', kind: 'mkt', name: 'Bc_s' });
      if (p.tradeSignal !== 1 && inT && canEnter && trOK && fast < slow && c2) pend.push({ type: 'short', kind: 'mkt', name: 'Sc' });
      if (p.tradeSignal !== 1 && inT && fast > slow && (cfg.symExit || c1) && pos === -1) pend.push({ type: 'cover', kind: 'mkt', name: 'Sc_b' });
    }
    // BB2 short-copy own exits (deploy)
    if (cfg.deploy && cfg.sMod && pos === -1) {
      const m = cfg.sMod;
      if (m.stopPct > 0) pend.push({ type: 'cover', kind: 'stop', px: Math.round(entryPx * (1 + m.stopPct / 10000)), name: 'S2_SL' });
      if (m.trailStartPct > 0 && mfePts >= entryPx * m.trailStartPct / 10000)
        pend.push({ type: 'cover', kind: 'stop', px: Math.round(entryPx - (mfePts - entryPx * m.trailBackPct / 10000)), name: 'S2_TS' });
    }
    // 0_NO5_Stop_Loss
    const sl = cfg.stopLossSig;
    if (sl.on && pos !== 0 && !(cfg.deploy && pos === -1 && !cfg.baseExitsOnShort) && bse > par('EntryLen', pos) && t !== entryT) {
      if (pos === 1 && b.c < entryPx - pts(sl.EntryLossPoint)) pend.push({ type: 'sell', kind: 'mkt', name: 'Los_B' });
      if (pos === -1 && b.c > entryPx + pts(par('EntryLossPoint', -1))) pend.push({ type: 'cover', kind: 'mkt', name: 'Los_S' });
    }
    // pyramiding off: drop same-direction entries
    const exL = pend.some(o => o.kind === 'mkt' && o.type === 'sell'), exS = pend.some(o => o.kind === 'mkt' && o.type === 'cover');
    pend = pend.filter(o => !((o.type === 'buy' && pos === 1 && !exL) || (o.type === 'short' && pos === -1 && !exS)));
    // de-dup entries: keep first
    const seen = new Set(); pend = pend.filter(o => { const kk = o.type + o.kind; if (o.kind === 'mkt' && seen.has(kk)) return false; seen.add(kk); return true; });
  }
  return { trades, aborted, openPos: pos ? { dir: pos, entryPx, date: bars[entryBar].date, t: entryT } : null, loseCnt };
}

function stats(trades, from = 0, to = 99999999) {
  const tr = trades.filter(x => x.xDate >= from && x.xDate <= to);
  let net = 0, peak = 0, mdd = 0, gp = 0, gl = 0, w = 0;
  for (const x of tr) { net += x.pnl; peak = Math.max(peak, net); mdd = Math.max(mdd, peak - net); if (x.pnl > 0) { gp += x.pnl; w++; } else gl -= x.pnl; }
  return { n: tr.length, net: Math.round(net), mdd: Math.round(mdd), pf: gl ? +(gp / gl).toFixed(2) : (gp ? 99 : 0), win: tr.length ? +(w / tr.length * 100).toFixed(1) : 0 };
}

module.exports = { loadBars, aggregate, run, stats, DEFAULT };
