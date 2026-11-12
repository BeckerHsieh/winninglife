#!/usr/bin/env node
// Grid search for 0_NO6_MV_Cross3 v2 under the 0_NO6 rules (two windows 0845~2400 + 0000~0500, pExitWin=1).
//   long  stage: node mv3-ls-opt.js long  <bars.csv> <out.json> [workers]
//   short stage: node mv3-ls-opt.js short|short1 <bars.csv> <out.json> [workers] '<longCfgJSON>'   (short signal runs together
//                with the fixed long signal on one chart; results are the combined strategy)
// Train 2021~2024 picks, test 2025~ looked at once. Uses child processes (4 cores ~ 4x).
'use strict';
const fs = require('fs'), path = require('path'), { fork } = require('child_process');
const E = require('./mv3-engine');
const YEARS = [2021, 2022, 2023, 2024];
const WINS = { B: [845, 2400, 0, 500], N: [915, 2400, 0, 450], D: [915, 2400, 0, 0] };

function grid(stage) {
  const out = [];
  if (stage === 'long') {
    for (const w of Object.keys(WINS)) for (const fa of [20, 40, 80]) for (const sa of [240, 360, 720]) for (const af of [480, 960, 1440])
      for (const ls of [20, 40, 80]) for (const be of [2, 30]) for (const st of [50, 100, 200]) for (const tp of [50, 100, 200]) for (const sp of [0, 400])
        out.push({ win: w, tradeSignal: 1, pExitWin: 1, FastAvg: fa, SlowAvg: sa, AvgFitr: af, LoseAvg: 6, LoseScope: ls, pBEntryLen: be, lTrailStart: st, lTrailPt: tp, lStopPt: sp });
  } else if (stage === 'long400') {            // long with MC built-in Stop Loss 20000 (= lStopPt 400) kept on the chart
    for (const fa of [40, 80, 120]) for (const sa of [240, 360, 480]) for (const af of [480, 720, 960, 1440])
      for (const ls of [40, 80, 120]) for (const be of [2, 30]) for (const st of [30, 50, 75, 100]) for (const tp of [150, 200, 300])
        out.push({ win: 'B', tradeSignal: 1, pExitWin: 1, FastAvg: fa, SlowAvg: sa, AvgFitr: af, LoseAvg: 6, LoseScope: ls, pBEntryLen: be, lTrailStart: st, lTrailPt: tp, lStopPt: 400 });
  } else if (stage === 'short1') {             // breakdown short entry (sEntryMode = 1)
    for (const fa of [20, 40, 80, 160]) for (const sa of [120, 240, 360, 720, 1440]) { if (sa <= fa) continue;
      for (const af of [480, 960, 1440, 2880]) for (const ls of [20, 40, 80]) for (const be of [2, 30]) for (const st of [50, 100, 200]) for (const tp of [50, 100, 200]) for (const sp of [0, 300])
        out.push({ tradeSignal: -1, pExitWin: 1, sEntryMode: 1, FastAvg: fa, SlowAvg: sa, AvgFitr: af, LoseAvg: 6, LoseScope: ls, pBEntryLen: be, sTrailStart: st, sTrailPt: tp, sStopPt: sp });
    }
  } else {
    for (const fa of [10, 20, 40, 80]) for (const sa of [60, 120, 240, 480]) { if (sa <= fa) continue;
      for (const af of [240, 480, 960, 1440]) for (const ls of [10, 20, 40]) for (const be of [2, 30]) for (const st of [50, 100, 200]) for (const tp of [50, 100, 200]) for (const sp of [0, 300])
        out.push({ tradeSignal: -1, pExitWin: 1, FastAvg: fa, SlowAvg: sa, AvgFitr: af, LoseAvg: 6, LoseScope: ls, pBEntryLen: be, sTrailStart: st, sTrailPt: tp, sStopPt: sp });
    }
  }
  return out;
}
const withWin = c => { const w = WINS[c.win || 'B']; const { win, ...r } = c; return { ...r, pSTime: w[0], pETime: w[1], pSTime2: w[2], pETime2: w[3] }; };
function evalOne(P, cfgs) {
  const r = E.run(P, cfgs), y = E.yearly(r.trades);
  return { tr: E.stats(r.trades, 0, 20241231), te: E.stats(r.trades, 20250101, 20991231), all: E.stats(r.trades),
    yr: YEARS.map(Y => Math.round((y[Y] || { net: 0 }).net)), y25: Math.round((y[2025] || { net: 0 }).net), y26: Math.round((y[2026] || { net: 0 }).net) };
}

if (process.argv[2] === '--worker') {
  process.on('message', ({ bars, stage, list, longCfg }) => {
    const P = E.prep(E.loadBars(bars)); const res = [];
    for (const c of list) {
      const cfgs = stage.startsWith('long') ? [withWin(c)] : [longCfg, { ...c, pSTime: longCfg.pSTime, pETime: longCfg.pETime, pSTime2: longCfg.pSTime2, pETime2: longCfg.pETime2 }];
      res.push({ c, ...evalOne(P, cfgs) });
    }
    process.send(res); process.exit(0);
  });
} else {
  const [stage, bars, outF, nw = '4', longJ] = process.argv.slice(2);
  const longCfg = longJ ? JSON.parse(longJ) : null;
  const all = grid(stage), W = +nw, t0 = Date.now(); let done = 0; const res = [];
  console.error(stage, 'combos', all.length);
  for (let k = 0; k < W; k++) {
    const ch = fork(__filename, ['--worker']);
    ch.on('message', r => { res.push(...r); if (++done === W) finish(); });
    ch.send({ bars, stage, list: all.filter((_, i) => i % W === k), longCfg });
  }
  function finish() {
    fs.writeFileSync(outF, JSON.stringify(res));
    const ok = res.filter(x => x.yr.every(v => v > 0) && x.tr.n >= 40).sort((a, b) => b.tr.net / (b.tr.mdd + 20000) - a.tr.net / (a.tr.mdd + 20000));
    console.log(stage, 'combos', res.length, 'all-train-years>0', ok.length, ((Date.now() - t0) / 1000).toFixed(0) + 's');
    for (const x of ok.slice(0, 25)) console.log(JSON.stringify(x.c), 'TR', x.tr.net, x.tr.mdd, x.tr.pf, x.tr.n, 'yr', x.yr.join('/'), '| TE', x.te.net, x.te.mdd, x.te.pf, x.te.n);
  }
}
module.exports = { WINS, withWin, evalOne };
