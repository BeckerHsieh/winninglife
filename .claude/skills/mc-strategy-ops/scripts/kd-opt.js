#!/usr/bin/env node
// Grid search for 0_NO6_MV_Cross_KD on MXF 1-min (two windows 0845~2400 + 0000~0500, pExitWin=1, maxBarsBack 6000).
//   node kd-opt.js long|short <bars.csv> <out.json> [workers]            standalone long / short signal
//   node kd-opt.js combo <bars.csv> <out.json> [workers] '<fixedCfgJSON>' '<gridStage>'   grid signal + fixed signal on one chart
// Train 2021~2024 picks (every train year > 0), test 2025~ looked at once.
'use strict';
const fs = require('fs'), { fork } = require('child_process');
const K = require('./kd-engine');
const YEARS = [2021, 2022, 2023, 2024];
const WIN = { pSTime: 845, pETime: 2400, pSTime2: 0, pETime2: 500, pExitWin: 1 };
const MA = [];
for (const fa of [60, 120, 240, 480]) for (const sa of [240, 480, 960, 1920]) if (sa > fa) MA.push([fa, sa]);

const MA2 = [];                                   // slower MAs (stage long2 / short2), need maxBarsBack 12000
for (const fa of [480, 720, 960, 1440]) for (const sa of [1920, 2880, 3840, 5760]) MA2.push([fa, sa]);

function grid(stage) {
  const out = [];
  const L = stage.startsWith('long'), slow = /2$/.test(stage);
  const kh = L ? [50, 65, 80] : (slow ? [20, 35, 50] : [20, 35, 50, 80]), kl = L ? (slow ? [20] : [20, 50]) : (slow ? [20, 80] : [20, 50, 80]);
  for (const [fa, sa] of (slow ? MA2 : MA)) for (const h of kh) for (const lo of kl) for (const be of [30, 120]) for (const lf of [2, 99])
    for (const [ts, tp] of [[0, 0], [100, 300], [100, 600]]) for (const sp of [0, 400]) for (const fo of [0, 1]) {
      if (fo && stage !== 'comboGrid') continue;
      const c = { ...WIN, tradeSignal: L ? 1 : -1, FastAvg: fa, SlowAvg: sa, KdHighFilter: h, KdLowFilter: lo, pBEntryLen: be, loseCntFilter: lf, lcCap: slow ? 2 : 3, pFlatOnly: fo, maxBarsBack: slow ? 12000 : 6000 };
      if (L) Object.assign(c, { lTrailStart: ts, lTrailPt: tp, lStopPt: sp }); else Object.assign(c, { sTrailStart: ts, sTrailPt: tp, sStopPt: sp });
      out.push(c);
    }
  return out;
}
function evalOne(P, cfgs) {
  const r = K.run(P, cfgs), y = K.yearly(r.trades);
  return { tr: K.stats(r.trades, 0, 20241231), te: K.stats(r.trades, 20250101, 20991231), all: K.stats(r.trades), conf: r.conflicts,
    yr: YEARS.map(Y => Math.round((y[Y] || { net: 0 }).net)), y25: Math.round((y[2025] || { net: 0 }).net), y26: Math.round((y[2026] || { net: 0 }).net) };
}

if (process.argv[2] === '--worker') {
  process.on('message', ({ bars, list, fixed }) => {
    const P = K.prep(K.loadBars(bars)); const res = [];
    for (const c of list) res.push({ c, ...evalOne(P, fixed ? (fixed.tradeSignal === 1 ? [fixed, c] : [c, fixed]) : c) });
    process.send(res); process.exit(0);
  });
} else if (require.main === module) {
  const [stage, bars, outF, nw = '4', fixedJ, gStage] = process.argv.slice(2);
  const fixed = fixedJ ? JSON.parse(fixedJ) : null;
  let all = grid(stage === 'combo' ? gStage : stage);
  if (stage === 'combo') { const a2 = []; for (const c of all) { a2.push(c); a2.push({ ...c, pFlatOnly: 1 }); } all = a2; }
  const W = +nw, t0 = Date.now(); let done = 0; const res = [];
  console.error(stage, 'combos', all.length);
  for (let k = 0; k < W; k++) {
    const ch = fork(__filename, ['--worker']);
    ch.on('message', r => { res.push(...r); if (++done === W) finish(); });
    ch.send({ bars, list: all.filter((_, i) => i % W === k), fixed });
  }
  function finish() {
    fs.writeFileSync(outF, JSON.stringify(res));
    const score = x => x.tr.net / (x.tr.mdd + 20000);
    const ok = res.filter(x => x.yr.every(v => v > 0) && x.tr.n >= 40).sort((a, b) => score(b) - score(a));
    const pos = res.filter(x => x.tr.net > 0).length;
    console.log(stage, 'combos', res.length, 'train net>0', pos, 'all-train-years>0', ok.length, ((Date.now() - t0) / 1000).toFixed(0) + 's');
    const show = ok.length ? ok : res.slice().sort((a, b) => b.tr.net - a.tr.net);
    const brief = c => [c.FastAvg, c.SlowAvg, 'K' + c.KdHighFilter + '/' + c.KdLowFilter, 'be' + c.pBEntryLen, 'lf' + c.loseCntFilter, 'tr' + (c.lTrailStart || c.sTrailStart || 0) + '/' + (c.lTrailPt || c.sTrailPt || 0), 'sp' + (c.lStopPt || c.sStopPt || 0), 'fo' + c.pFlatOnly].join(' ');
    for (const x of show.slice(0, 20)) console.log(brief(x.c), '| TR', x.tr.net, x.tr.mdd, x.tr.pf, x.tr.n, 'yr', x.yr.join('/'));
  }
}
module.exports = { WIN, evalOne, grid };
