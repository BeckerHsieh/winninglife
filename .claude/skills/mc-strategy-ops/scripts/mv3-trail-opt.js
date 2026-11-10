#!/usr/bin/env node
// Grid search for 0_NO6_MV_Cross3 (MV_Cross3 + trailing stop) on 1-min bars.
// Train 2021~2024 picks params; test 2025~ looked at once. Usage: node mv3-trail-opt.js <bars.csv> [out.json]
'use strict';
const fs = require('fs'); const E = require('./mv3-engine');
const [f, outF] = process.argv.slice(2);
const P = E.prep(E.loadBars(f));
const YEARS = [2021, 2022, 2023, 2024];
const res = [];
for (const ts of [1, 0]) for (const fa of [20, 40, 80, 160]) for (const sa of [120, 240, 360, 720]) {
  if (sa <= fa) continue;
  for (const af of [480, 960, 1440]) for (const ls of [10, 20, 40]) for (const be of [2, 30])
    for (const st of [0, 100, 200, 400]) for (const tp of [50, 100, 200, 400]) {
      const cfg = { tradeSignal: ts, pSTime: 915, pETime: 2400, pBEntryLen: be, FastAvg: fa, SlowAvg: sa, AvgFitr: af, LoseAvg: 6, LoseScope: ls,
        lTrailStart: st, lTrailPt: tp, sTrailStart: ts === 0 ? st : 0, sTrailPt: ts === 0 ? tp : 0 };
      const r = E.run(P, cfg), y = E.yearly(r.trades);
      res.push({ c: cfg, tr: E.stats(r.trades, 0, 20241231), te: E.stats(r.trades, 20250101, 20991231),
        yr: YEARS.map(Y => Math.round((y[Y] || { net: 0 }).net)), all: E.stats(r.trades) });
    }
}
const ok = res.filter(x => x.yr.every(v => v > 0) && x.tr.n >= 40).sort((a, b) => b.tr.net / (b.tr.mdd + 20000) - a.tr.net / (a.tr.mdd + 20000));
console.log('combos', res.length, 'all-train-years>0', ok.length);
for (const x of ok.slice(0, 20)) console.log(JSON.stringify(x.c), 'TR', x.tr.net, x.tr.mdd, x.tr.pf, x.tr.n, 'yr', x.yr.join('/'), '| TE', x.te.net, x.te.mdd, x.te.pf, x.te.n);
if (outF) fs.writeFileSync(outF, JSON.stringify(res));
