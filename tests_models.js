const M = require('./models.js');
const assert = require('assert');
// RSI: monotonic up -> 100, down -> 0
assert.strictEqual(M.rsi([...Array(30).keys()], 14)[29], 100);
assert.strictEqual(M.rsi([...Array(30).keys()].map(x => -x), 14)[29], 0);
// Bollinger mid == SMA, symmetric bands
const v = Array.from({length: 40}, (_, i) => 10 + Math.sin(i));
const bb = M.bollinger(v); assert(Math.abs((bb.upper[39] + bb.lower[39]) / 2 - bb.mid[39]) < 1e-9);
// Kalman tracks a linear trend
const lin = Array.from({length: 300}, (_, i) => 60 + 0.01 * i + 0.05 * Math.sin(i * 1.7));
const k = M.kalman(lin); assert(Math.abs(k.slope[299] - 0.01) < 0.005, 'kalman slope ' + k.slope[299]);
const h = M.holt(lin); assert(Math.abs(h.trend - 0.01) < 0.005);
// Scenario: series that ends at a 2-year low -> high score; ends at high -> low score
const mk = end => { const s = Array.from({length: 500}, (_, i) => 62 + Math.sin(i / 25) + 0.1 * Math.sin(i * 1.3)); for (let i = 0; i < 15; i++) s.push(s[s.length - 1] + end * 0.12); return s; };
const pts = s => s.map((x, i) => [new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10), x]);
const lo = M.analyse(pts(mk(-1))), hi = M.analyse(pts(mk(+1)));
console.log('low-end score', lo.score.toFixed(1), lo.verdict.label, lo.parts);
console.log('high-end score', hi.score.toFixed(1), hi.verdict.label);
assert(lo.score > 60 && hi.score < 40);
assert(lo.levels.great < lo.levels.good && lo.levels.good < lo.levels.median);
const all = lo.scores.filter(Boolean).map(s => s.total); assert(Math.min(...all) >= 0 && Math.max(...all) <= 100);
console.log('all model tests passed');
