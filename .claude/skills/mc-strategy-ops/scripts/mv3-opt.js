#!/usr/bin/env node
// Grid search for 0_NO5_MV_Cross3 on 1-min bars. Train 2021~2024 (pick), test 2025~ (look once).
// Usage: node mv3-opt.js <bars1m.csv> [out.json]
'use strict';
const fs = require('fs');
const E = require('./mv3-engine');
const [f, outF] = process.argv.slice(2);
const P = E.prep(E.loadBars(f));
const lastC = P.c[P.n - 1];
const TR = [20210101, 20241231], TE = [20250101, 20991231];
const YEARS = [2021, 2022, 2023, 2024];

const grid = {
  tradeSignal: [0, 1, -1],
  win: [[915, 2400], [0, 2400], [850, 1340]],
  FastAvg: [5, 10, 20, 40, 80],
  SlowAvg: [30, 60, 120, 240, 480, 960],
  AvgFitr: [60, 120, 240, 480, 960, 1440],
  LoseAvg: [3, 6, 12],
  LoseScope: [5, 10, 20, 40],
  pBEntryLen: [2, 30],
};
function* combos() {
  for (const ts of grid.tradeSignal) for (const w of grid.win) for (const fa of grid.FastAvg) for (const sa of grid.SlowAvg) {
    if (sa <= fa) continue;
    for (const af of grid.AvgFitr) for (const la of grid.LoseAvg) for (const ls of grid.LoseScope) for (const be of grid.pBEntryLen)
      yield { tradeSignal: ts, pSTime: w[0], pETime: w[1], FastAvg: fa, SlowAvg: sa, AvgFitr: af, LoseAvg: la, LoseScope: ls, pBEntryLen: be };
  }
}
const res = [];
let k = 0; const t0 = Date.now();
for (const cfg of combos()) {
  const r = E.run(P, cfg);
  const tr = E.stats(r.trades, ...TR), te = E.stats(r.trades, ...TE);
  const y = E.yearly(r.trades);
  const yr = YEARS.map(Y => Math.round((y[Y] || { net: 0 }).net));
  const openPnl = r.open ? Math.round((lastC - r.open.ePx) * r.open.dir * 50) : 0;
  res.push({ cfg, tr, te, yr, openPnl, open: r.open });
  if (++k % 2000 === 0) console.error(k, ((Date.now() - t0) / 1000).toFixed(0) + 's');
}
// selection uses TRAIN only: every train year > 0, >= 40 train trades; rank by net/mdd then net
const ok = res.filter(x => x.yr.every(v => v > 0) && x.tr.n >= 40);
ok.sort((a, b) => (b.tr.net / (b.tr.mdd + 20000)) - (a.tr.net / (a.tr.mdd + 20000)));
console.log('combos', res.length, 'pass all-train-years', ok.length);
for (const x of ok.slice(0, 25)) console.log(JSON.stringify(x.cfg), 'TR', x.tr, 'yrs', x.yr.join('/'), '| TE', x.te, 'open', x.openPnl);
if (outF) fs.writeFileSync(outF, JSON.stringify(res.map(x => ({ c: x.cfg, tr: x.tr, te: x.te, yr: x.yr, op: x.openPnl }))));
