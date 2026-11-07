#!/usr/bin/env node
// Compare a local mc-bt-engine run against an MC trade list CSV (paired trades).
// Usage: node mc-bt-compare.js <bars18.csv> <mcTrades.csv> [config.json]
//   bars18.csv : chart bars exported from MC (Date,Time,O,H,L,C,V; bar END time)
//   mcTrades.csv: TradeNo,Direction,Qty,EntryDateTime,EntrySignal,EntryPrice,ExitDateTime,ExitSignal,ExitPrice,...,NetPnL(col 13)
//   config.json : engine cfg overrides (omit = original MXF-18 setup)
'use strict';
const fs = require('fs');
const E = require('./mc-bt-engine');
const [barsF, mcF, cfgF] = process.argv.slice(2);
if (!barsF || !mcF) { console.error('usage: node mc-bt-compare.js <bars.csv> <mcTrades.csv> [config.json]'); process.exit(1); }
const cfg = cfgF ? JSON.parse(fs.readFileSync(cfgF, 'utf8')) : {};
const mine = E.run(E.loadBars(barsF), cfg).trades;
const mc = fs.readFileSync(mcF, 'utf8').trim().split(/\r?\n/).slice(1).map(l => l.split(','));
const k = (d, t) => `${d} ${String(t).padStart(4, '0')}`;
const mk = s => s.replace(/[-:]/g, '').replace(/^(\d{8})[ T](\d{4}).*/, '$1 $2');
const sum = a => a.reduce((s, x) => s + x, 0);
console.log('local', mine.length, 'net', Math.round(sum(mine.map(t => t.pnl))), '| MC', mc.length, 'net', sum(mc.map(r => +r[12])));
let diffs = 0, priceDiffs = 0;
for (let i = 0; i < Math.max(mine.length, mc.length); i++) {
  const a = mine[i], m = mc[i];
  const core = a ? `${a.dir > 0 ? 'Long' : 'Short'} ${k(a.eDate, a.eT)} ${a.ePx} ${k(a.xDate, a.xT)} ${Math.round(a.xPx)}` : '-';
  const coreM = m ? `${m[1]} ${mk(m[3])} ${Math.round(+m[5])} ${mk(m[6])} ${Math.round(+m[8])}` : '-';
  const nameDiff = a && m && a.name !== m[7];
  if (core !== coreM || nameDiff) {
    diffs++; if (core !== coreM) priceDiffs++;
    if (diffs <= 10) console.log(`#${i + 1}${core === coreM ? ' (exit label only)' : ''}\n  local: ${core} ${a ? a.name : ''}\n  MC   : ${coreM} ${m ? m[7] : ''}`);
  }
}
console.log('rows differing:', diffs, '| of which time/price differs:', priceDiffs);
process.exit(priceDiffs ? 2 : 0);
