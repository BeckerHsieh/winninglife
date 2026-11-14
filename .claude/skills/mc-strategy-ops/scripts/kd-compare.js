#!/usr/bin/env node
// Compare kd-engine (0_NO6_MV_Cross_KD) with an MC XML RINA trade export. Usage: node kd-compare.js <bars.csv> <trades.xml> [cfgJSON]
'use strict';
const fs = require('fs'); const E = require('./kd-engine');
const [barsF, xmlF, cfgJ] = process.argv.slice(2);
const cfg = cfgJ ? JSON.parse(cfgJ) : {};
// stream-scan XML for <Trade> blocks (file can be hundreds of MB; trades come before bars)
const fd = fs.openSync(xmlF, 'r'), buf = Buffer.alloc(1 << 24); let txt = '', pos = 0, n;
const rows = [];
while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
  pos += n; txt += buf.toString('latin1', 0, n);
  let m; const re = /<Trade><Date><Year>(\d+)<\/Year><Month>(\d+)<\/Month><Day>(\d+)<\/Day><Hour>(\d+)<\/Hour><Minute>(\d+)<\/Minute>.*?<Type>(\w+)<\/Type>(?:<Profit>(-?[\d.]+)<\/Profit>)?<Quantity>\d+<\/Quantity><Price>([\d.]+)<\/Price><Signal>"([^"]*)"<\/Signal><\/Trade>/g;
  let last = 0; while ((m = re.exec(txt))) { rows.push(m); last = re.lastIndex; }
  txt = txt.slice(last); if (txt.length > 4e6 && rows.length && !/<Trade>/.test(txt)) break;
}
const mc = []; let open = null;
for (const m of rows) {
  const d = +m[1] * 10000 + +m[2] * 100 + +m[3], t = +m[4] * 100 + +m[5], ty = m[6];
  if (ty === 'Buy' || ty === 'Sell' || ty === 'SellShort') { open = { dir: ty === 'Buy' ? 1 : -1, eDate: d, eT: t, ePx: +m[8], eName: m[9] }; }
  else if (open) { mc.push({ ...open, xDate: d, xT: t, xPx: +m[8], name: m[9], pnl: +m[7] }); open = null; }
}
const me = E.run(E.prep(E.loadBars(barsF)), cfg).trades;
const k = x => `${x.dir > 0 ? 'L' : 'S'} ${x.eDate} ${x.eT} ${x.ePx} ${x.xDate} ${x.xT} ${Math.round(x.xPx)}`;
const sum = a => a.reduce((s, x) => s + x.pnl, 0);
console.log('local', me.length, Math.round(sum(me)), '| MC', mc.length, Math.round(sum(mc)));
let diff = 0;
for (let i = 0; i < Math.max(me.length, mc.length); i++) {
  const a = me[i] ? k(me[i]) : '-', b = mc[i] ? k(mc[i]) : '-';
  if (a !== b) { if (++diff <= 8) console.log('#' + (i + 1), '\n  local', a, me[i] && me[i].name, '\n  MC   ', b, mc[i] && mc[i].name); }
}
console.log('diff rows', diff); process.exit(diff ? 2 : 0);
