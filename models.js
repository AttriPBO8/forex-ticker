// Statistical models for "is now a good time to buy CAD/USD with INR?"
//
// Input is a daily close series of an X/INR pair (how many rupees one unit costs).
// For someone converting INR into CAD or USD, LOWER is better.
// Everything here is plain math so it can run in the browser and be unit tested in Node.
(function (root) {
  "use strict";

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function sma(v, n) {
    const out = new Array(v.length).fill(null);
    let sum = 0;
    for (let i = 0; i < v.length; i++) {
      sum += v[i];
      if (i >= n) sum -= v[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function rollingStd(v, n) {
    const out = new Array(v.length).fill(null);
    for (let i = n - 1; i < v.length; i++) {
      let s = 0, s2 = 0;
      for (let j = i - n + 1; j <= i; j++) { s += v[j]; s2 += v[j] * v[j]; }
      const m = s / n;
      out[i] = Math.sqrt(Math.max(0, s2 / n - m * m));
    }
    return out;
  }

  // Bollinger Bands (n-day SMA +/- k standard deviations)
  function bollinger(v, n = 20, k = 2) {
    const mid = sma(v, n), sd = rollingStd(v, n);
    return {
      mid,
      upper: mid.map((m, i) => (m == null ? null : m + k * sd[i])),
      lower: mid.map((m, i) => (m == null ? null : m - k * sd[i])),
      pctB: v.map((x, i) => (mid[i] == null || sd[i] === 0 ? null : (x - (mid[i] - k * sd[i])) / (2 * k * sd[i]))),
    };
  }

  // z-score of the price against its n-day mean
  function zscore(v, n = 50) {
    const m = sma(v, n), sd = rollingStd(v, n);
    return v.map((x, i) => (m[i] == null || !sd[i] ? null : (x - m[i]) / sd[i]));
  }

  // Wilder's RSI
  function rsi(v, n = 14) {
    const out = new Array(v.length).fill(null);
    if (v.length <= n) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = v[i] - v[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = n + 1; i < v.length; i++) {
      const d = v[i] - v[i - 1];
      gain = (gain * (n - 1) + Math.max(d, 0)) / n;
      loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  // Share of the last n closes that were at or below today's close (0 = cheapest, 1 = dearest)
  function percentile(v, n = 252) {
    return v.map((x, i) => {
      const start = Math.max(0, i - n + 1);
      const len = i - start + 1;
      if (len < 60) return null;
      let c = 0;
      for (let j = start; j <= i; j++) if (v[j] <= x) c++;
      return c / len;
    });
  }

  function quantile(arr, q) {
    const s = [...arr].sort((a, b) => a - b);
    const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  // Kalman filter, local linear trend model: state = [level, slope].
  // Noise is scaled to the series' own daily volatility, so it works for any pair.
  function kalman(v) {
    const diffs = v.slice(1).map((x, i) => x - v[i]);
    const dv = diffs.reduce((a, b) => a + b * b, 0) / Math.max(1, diffs.length) || 1e-8;
    const R = dv * 1.0, qL = dv * 0.05, qS = dv * 0.0005;
    let x0 = v[0], x1 = 0;
    let P = [[dv * 10, 0], [0, dv]];
    const level = [], slope = [];
    for (const z of v) {
      // predict
      const p0 = x0 + x1, p1 = x1;
      let P00 = P[0][0] + P[0][1] + P[1][0] + P[1][1] + qL;
      let P01 = P[0][1] + P[1][1];
      let P10 = P[1][0] + P[1][1];
      let P11 = P[1][1] + qS;
      // update
      const S = P00 + R, K0 = P00 / S, K1 = P10 / S, y = z - p0;
      x0 = p0 + K0 * y; x1 = p1 + K1 * y;
      P = [[(1 - K0) * P00, (1 - K0) * P01], [P10 - K1 * P00, P11 - K1 * P01]];
      level.push(x0); slope.push(x1);
    }
    return { level, slope };
  }

  // Holt's linear exponential smoothing, with an h-day-ahead forecast
  function holt(v, alpha = 0.3, beta = 0.1, h = 5) {
    let l = v[0], b = v.length > 1 ? v[1] - v[0] : 0;
    for (let i = 1; i < v.length; i++) {
      const prevL = l;
      l = alpha * v[i] + (1 - alpha) * (l + b);
      b = beta * (l - prevL) + (1 - beta) * b;
    }
    return { level: l, trend: b, forecast: l + h * b, h };
  }

  // Combined 0-100 "buy attractiveness" score for each day. Higher = better time to buy.
  // Weights: percentile over the chosen horizon 30, Bollinger %B 20, 50-day z-score 20, RSI 15, Kalman trend 15.
  // `horizon` (trading days) is how far back "cheap vs expensive" is judged: 126 = 6M, 252 = 1Y, 504 = 2Y.
  function buyScores(v, horizon = 252) {
    const pct = percentile(v, horizon);
    const bb = bollinger(v, 20, 2);
    const z = zscore(v, 50);
    const r = rsi(v, 14);
    const k = kalman(v);
    const slopeSd = Math.sqrt(k.slope.reduce((a, s) => a + s * s, 0) / k.slope.length) || 1e-9;
    return v.map((_, i) => {
      if (pct[i] == null || bb.pctB[i] == null || z[i] == null || r[i] == null) return null;
      const parts = {
        percentile: (1 - pct[i]) * 30,
        bollinger: clamp(1 - bb.pctB[i], 0, 1) * 20,
        zscore: clamp(-z[i] / 2, 0, 1) * 20,
        rsi: clamp((50 - r[i]) / 20, 0, 1) * 15,
        // rising trend -> buying now beats waiting; falling trend -> waiting may be cheaper
        trend: clamp(0.5 + k.slope[i] / (2 * slopeSd), 0, 1) * 15,
      };
      const total = Object.values(parts).reduce((a, b) => a + b, 0);
      return { total, parts };
    });
  }

  function verdict(score) {
    if (score >= 70) return { key: "strong", label: "Strong buy zone", tip: "Rate is low versus its own history on most measures." };
    if (score >= 55) return { key: "good", label: "Good time to buy", tip: "Rate is below average; a reasonable time to convert." };
    if (score >= 40) return { key: "neutral", label: "Fair / neutral", tip: "Nothing stands out. Consider converting in parts over a few weeks." };
    return { key: "wait", label: "Expensive, consider waiting", tip: "Rate is high versus its history. If you can wait, a better rate is statistically likely." };
  }

  // Full analysis for one X/INR series: points = [[isoDate, rate], ...] sorted ascending.
  function analyse(points, horizon = 252) {
    const dates = points.map(p => p[0]);
    const v = points.map(p => p[1]);
    const n = v.length, last = n - 1;
    const bb = bollinger(v, 20, 2);
    const s50 = sma(v, 50), s200 = sma(v, 200);
    const z = zscore(v, 50);
    const r = rsi(v, 14);
    const pctH = percentile(v, horizon), pct3m = percentile(v, 63);
    const k = kalman(v);
    const h = holt(v);
    const scores = buyScores(v, horizon);
    const yr = v.slice(Math.max(0, n - horizon));
    const now = v[last];
    const sc = scores[last];
    const slopeDay = k.slope[last];
    return {
      horizon, dates, values: v, bb, sma50: s50, sma200: s200, kalman: k.level, scores,
      now,
      score: sc ? sc.total : null,
      parts: sc ? sc.parts : null,
      verdict: sc ? verdict(sc.total) : null,
      levels: {
        great: quantile(yr, 0.10),
        good: quantile(yr, 0.25),
        median: quantile(yr, 0.50),
        lowH: Math.min(...yr), highH: Math.max(...yr),
        bbLower: bb.lower[last], bbUpper: bb.upper[last],
      },
      ind: {
        pctH: pctH[last], pct3m: pct3m[last],
        pctB: bb.pctB[last], z50: z[last], rsi14: r[last],
        sma50: s50[last], sma200: s200[last],
        kalmanLevel: k.level[last], kalmanSlope: slopeDay,
        holt: h,
      },
    };
  }

  const api = { sma, rollingStd, bollinger, zscore, rsi, percentile, quantile, kalman, holt, buyScores, verdict, analyse };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FXModels = api;
})(typeof window !== "undefined" ? window : globalThis);
