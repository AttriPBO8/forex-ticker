// Buy-signal section: runs FXModels on X/INR history and draws the summary, charts and explanations.
(function () {
  "use strict";
  const M = window.FXModels;
  const NS = "http://www.w3.org/2000/svg";
  const fmt = (x, d = 2) => x == null || isNaN(x) ? "n/a" : x.toFixed(d);
  // Prices: 2 decimals for currencies, whole rupees (Indian grouping) for gold
  const px = x => x == null || isNaN(x) ? "n/a" : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-IN") : x.toFixed(2);
  // Horizon = how far back "cheap vs expensive" is judged, and how much the chart shows.
  const RANGES = { "6M": [126, "6 months"], "1Y": [252, "1 year"], "2Y": [504, "2 years"] };
  let range = "1Y";
  let lastHistory = null;
  const INFO = {
    "CAD/INR": { code: "CAD", title: "Buy CAD with INR", sub: "Canadian Dollar price in rupees, lower is better", unit: "CAD" },
    "USD/INR": { code: "USD", title: "Buy USD with INR", sub: "US Dollar price in rupees, lower is better", unit: "USD" },
    "XAU/INR": { code: "XAU", title: "Buy gold with INR", sub: "Price of 10 g in rupees (international spot, before duty and GST), lower is better", unit: "g", perUnit: 10 },
  };
  const INR_AMOUNT = 100000;

  function readings(a, hName) {
    const i = a.ind, p = a.parts;
    return [
      [`Percentile over ${hName}`, `${Math.round(i.pctH * 100)}%`,
        i.pctH <= 0.25 ? `Cheaper than 3 in 4 days of the past ${hName}` : i.pctH >= 0.75 ? `Dearer than 3 in 4 days of the past ${hName}` : `Middle of the past ${hName}'s range`,
        p.percentile, 30],
      ["Bollinger %B (20-day, 2σ)", fmt(i.pctB),
        i.pctB <= 0 ? "Below the lower band: unusually cheap short term" : i.pctB < 0.2 ? "Near the lower band: cheap short term" : i.pctB > 0.8 ? "Near the upper band: expensive short term" : "Inside the bands",
        p.bollinger, 20],
      ["Z-score vs 50-day mean", fmt(i.z50),
        i.z50 <= -1.5 ? "Far below its 50-day average" : i.z50 < -0.5 ? "Below its 50-day average" : i.z50 > 0.5 ? "Above its 50-day average" : "Close to its 50-day average",
        p.zscore, 20],
      ["RSI (14-day)", fmt(i.rsi14, 0),
        i.rsi14 < 30 ? "Oversold: the price has fallen fast, bounce risk" : i.rsi14 < 45 ? "Weak momentum (falling)" : i.rsi14 > 70 ? "Overbought: rose fast" : "Neutral momentum",
        p.rsi, 15],
      ["Kalman trend", `${i.kalmanSlope >= 0 ? "+" : "−"}₹${px(Math.abs(i.kalmanSlope * 21))}/month`,
        i.kalmanSlope > 0 ? "Rising: waiting may cost more" : "Falling: waiting may get a better price",
        p.trend, 15],
    ];
  }

  function gauge(score, size = "") {
    return `<div class="gauge ${M.verdict(score).key} ${size}" style="--s:${score.toFixed(1)}"><div><b>${Math.round(score)}</b><small>/100</small></div></div>`;
  }
  const chip = code => `<span class="chip ${code}">${code === "XAU" ? "Au" : code}</span>`;

  function panel(pair, a, hName) {
    const info = INFO[pair], v = a.verdict, L = a.levels, i = a.ind;
    const per = info.perUnit || 1;
    const buysNow = INR_AMOUNT / a.now * per, buysGood = INR_AMOUNT / L.good * per;
    const d = info.unit === "g" ? 2 : 2;
    const rows = readings(a, hName).map(([name, val, txt, pts, max]) => `
      <tr><td>${name}</td><td class="num">${val}</td><td>${txt}</td>
      <td class="num"><span class="bar"><span style="width:${(pts / max * 100).toFixed(0)}%"></span></span>${pts.toFixed(1)}/${max}</td></tr>`).join("");
    const fc = i.holt.forecast, fcDelta = fc - a.now;
    const id = "sig-" + info.code.toLowerCase();
    return `<section class="sig glass" id="${id}" data-pair="${pair}">
      <div class="sig-head">
        <div class="pair"><span class="chips">${chip(info.code)}${chip("INR")}</span>
          <span>${info.title}<small>${info.sub}</small></span></div>
        <div class="verdict-wrap">${gauge(a.score)}<div><div class="verdict ${v.key}">${v.label}</div><div class="muted small">${v.tip}</div></div></div>
      </div>
      <div class="levels">
        <div class="lv"><span>Now</span><b>₹${px(a.now)}</b><small>${Math.round(i.pctH * 100)}th percentile of ${hName}</small></div>
        <div class="lv good"><span>Good buy at or below</span><b>₹${px(L.good)}</b><small>cheapest 25% of the past ${hName}</small></div>
        <div class="lv great"><span>Great buy at or below</span><b>₹${px(L.great)}</b><small>cheapest 10% of the past ${hName}</small></div>
        <div class="lv"><span>5-day forecast (Holt)</span><b>₹${px(fc)}</b><small>${fcDelta >= 0 ? "+" : "−"}${px(Math.abs(fcDelta))} vs now, trend only</small></div>
      </div>
      <div class="chart-wrap"><div class="chart" data-pair="${pair}"></div><div class="tip" hidden></div></div>
      <div class="legend">
        <span><i class="sw price"></i>Price</span><span><i class="sw kal"></i>Kalman trend</span><span><i class="sw sma"></i>50-day average</span>
        <span><i class="sw band"></i>Bollinger band</span><span><i class="sw zone"></i>Strong buy zone (score ≥ 70)</span><span><i class="sw zone2"></i>Good (55 to 70)</span>
      </div>
      <p class="explain">₹${INR_AMOUNT.toLocaleString("en-IN")} buys <b>${fmt(buysNow, d)} ${info.unit}</b> today.
        At the good-buy level it would buy ${fmt(buysGood, d)} ${info.unit} (${buysGood >= buysNow ? "+" : ""}${fmt(buysGood - buysNow, d)}).
        Past ${hName}: low ₹${px(L.lowH)}, median ₹${px(L.median)}, high ₹${px(L.highH)}.</p>
      <details class="why"><summary>Why this score? The numbers behind it</summary>
        <table><thead><tr><th>Model</th><th>Value</th><th>Reading</th><th>Points</th></tr></thead><tbody>${rows}</tbody></table>
      </details>
    </section>`;
  }

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function drawChart(box, a) {
    box.innerHTML = "";
    const W = Math.max(280, box.clientWidth), small = W < 520;
    const H1 = small ? 210 : 270, gap = 18, H2 = small ? 60 : 72, padL = 8, padR = small ? 52 : 64, padT = 10;
    const H = padT + H1 + gap + H2 + 22;
    const n = a.values.length, show = Math.min(a.horizon, n), s0 = n - show;
    const idx = [...Array(show).keys()].map(k => s0 + k);
    const vals = idx.map(i => a.values[i]);
    const lows = idx.map(i => a.bb.lower[i]).filter(x => x != null), highs = idx.map(i => a.bb.upper[i]).filter(x => x != null);
    let lo = Math.min(...vals, ...lows, a.levels.great), hi = Math.max(...vals, ...highs);
    const padY = (hi - lo) * 0.06; lo -= padY; hi += padY;
    const X = k => padL + k * (W - padL - padR) / (show - 1);
    const Y = v => padT + (hi - v) / (hi - lo) * H1;
    const Y2 = s => padT + H1 + gap + (100 - s) / 100 * H2;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "big", role: "img",
      "aria-label": `Chart of ${a.pair} over the chosen horizon, with buy zones` }, box);

    const zones = (min, max, cls) => {
      let start = null;
      for (let k = 0; k <= show; k++) {
        const s = k < show ? a.scores[idx[k]] : null;
        const on = s && s.total >= min && s.total < max;
        if (on && start == null) start = k;
        if (!on && start != null) {
          const x0 = X(Math.max(0, start - 0.5)), x1 = X(Math.min(show - 1, k - 0.5));
          el("rect", { x: x0, y: padT, width: Math.max(2, x1 - x0), height: H1, class: cls }, svg);
          el("rect", { x: x0, y: padT + H1 + gap, width: Math.max(2, x1 - x0), height: H2, class: cls }, svg);
          start = null;
        }
      }
    };
    zones(55, 70, "zone2"); zones(70, 101, "zone");

    for (let t = 0; t <= 4; t++) {
      const v = lo + (hi - lo) * t / 4, y = Y(v);
      el("line", { x1: padL, x2: W - padR, y1: y, y2: y, class: "grid" }, svg);
      el("text", { x: W - padR + 6, y: y + 4, class: "ax" }, svg).textContent = px(v);
    }
    let lastM = "";
    const every = show > 300 ? 3 : show > 150 ? 2 : 1;
    idx.forEach((i, k) => {
      const m = a.dates[i].slice(0, 7);
      if (m !== lastM) {
        lastM = m;
        const mi = +m.slice(5);
        if ((mi - 1) % every === 0 && k > 5 && k < show - 5) {
          el("text", { x: X(k), y: H - 4, class: "ax", "text-anchor": "middle" }, svg).textContent =
            new Date(a.dates[i] + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", year: mi === 1 ? "2-digit" : undefined, timeZone: "UTC" });
        }
      }
    });

    const bandPts = idx.map((i, k) => [k, a.bb.upper[i], a.bb.lower[i]]).filter(p => p[1] != null);
    if (bandPts.length > 1) {
      const top = bandPts.map(([k, u]) => `${X(k)},${Y(u)}`).join(" L");
      const bot = bandPts.slice().reverse().map(([k, , l]) => `${X(k)},${Y(l)}`).join(" L");
      el("path", { d: `M${top} L${bot} Z`, class: "band" }, svg);
    }
    const line = (arr, cls) => {
      const pts = idx.map((i, k) => [k, arr[i]]).filter(p => p[1] != null);
      if (pts.length > 1) el("path", { d: "M" + pts.map(([k, v]) => `${X(k).toFixed(1)},${Y(v).toFixed(1)}`).join(" L"), class: cls }, svg);
    };
    line(a.sma50, "sma"); line(a.kalman, "kal"); line(a.values, "price");

    [["good", a.levels.good, "Good"], ["great", a.levels.great, "Great"]].forEach(([cls, v, lbl]) => {
      if (v < lo || v > hi) return;
      el("line", { x1: padL, x2: W - padR, y1: Y(v), y2: Y(v), class: "lvl " + cls }, svg);
      el("text", { x: padL + 4, y: Y(v) - 4, class: "lvl-t " + cls }, svg).textContent = `${lbl} ≤ ${px(v)}`;
    });

    const lastK = show - 1;
    el("circle", { cx: X(lastK), cy: Y(a.now), r: 7, class: "now-halo" }, svg);
    el("circle", { cx: X(lastK), cy: Y(a.now), r: 3.6, class: "now" }, svg);

    el("text", { x: padL, y: padT + H1 + gap - 4, class: "ax" }, svg).textContent = "Buy score (0 to 100)";
    [55, 70].forEach(s => el("line", { x1: padL, x2: W - padR, y1: Y2(s), y2: Y2(s), class: "grid dash" }, svg));
    el("text", { x: W - padR + 6, y: Y2(70) + 2, class: "ax" }, svg).textContent = "70";
    el("text", { x: W - padR + 6, y: Y2(55) + 10, class: "ax" }, svg).textContent = "55";
    const sp = idx.map((i, k) => [k, a.scores[i] && a.scores[i].total]).filter(p => p[1] != null);
    if (sp.length > 1) el("path", { d: "M" + sp.map(([k, s]) => `${X(k).toFixed(1)},${Y2(s).toFixed(1)}`).join(" L"), class: "score" }, svg);

    const cross = el("line", { y1: padT, y2: padT + H1 + gap + H2, class: "cross", visibility: "hidden" }, svg);
    const dot = el("circle", { r: 4, class: "now", visibility: "hidden" }, svg);
    const tip = box.parentElement.querySelector(".tip");
    const hit = el("rect", { x: padL, y: 0, width: W - padL - padR, height: H, fill: "transparent" }, svg);
    const move = ev => {
      const r = svg.getBoundingClientRect();
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      const k = Math.round((x - padL) / (W - padL - padR) * (show - 1));
      if (k < 0 || k >= show) return;
      const i = idx[k], s = a.scores[i];
      cross.setAttribute("x1", X(k)); cross.setAttribute("x2", X(k)); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", X(k)); dot.setAttribute("cy", Y(a.values[i])); dot.setAttribute("visibility", "visible");
      tip.hidden = false;
      tip.innerHTML = `<b>${new Date(a.dates[i] + "T00:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}</b><br>
        Price ₹${px(a.values[i])}<br>${s ? `Score ${Math.round(s.total)}: ${M.verdict(s.total).label}` : "Score: not enough history"}`;
      const tx = X(k) + 14, tw = tip.offsetWidth;
      tip.style.left = (tx + tw > W ? X(k) - tw - 14 : tx) + "px";
      tip.style.top = Math.max(0, Y(a.values[i]) - 30) + "px";
    };
    const leave = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("touchmove", move, { passive: true });
    hit.addEventListener("pointerleave", leave);
  }

  // Small banner at the top of the page: best of CAD / USD, plus gold, linking to the details.
  function summary(res, hName) {
    const host = document.getElementById("summary");
    if (!host) return;
    const c = res["CAD/INR"], u = res["USD/INR"], g = res["XAU/INR"];
    const fx = [c, u].filter(a => a && a.score != null);
    if (!fx.length) { host.innerHTML = ""; return; }
    const best = fx.reduce((x, y) => (y.score > x.score ? y : x));
    const bestCode = INFO[best.pair].code;
    const other = fx.find(a => a !== best);
    const close = other && Math.abs(best.score - other.score) < 5;
    const headline = close
      ? `CAD and USD are about even right now`
      : `Better buy now: <b>${bestCode}</b>`;
    const mini = a => {
      const info = INFO[a.pair];
      return `<a class="mini" href="#sig-${info.code.toLowerCase()}">${chip(info.code)}<span><b>${info.code === "XAU" ? "Gold" : info.code}</b>
        <span class="verdict ${a.verdict.key}">${Math.round(a.score)} · ${a.verdict.label}</span><small>₹${px(a.now)}${info.perUnit ? " per 10 g" : ""}</small></span></a>`;
    };
    host.innerHTML = `<section class="summary glass">
      <div class="sum-main">${gauge(best.score, "lg")}
        <div><div class="sum-kicker">Converting INR · judged over ${hName}</div>
          <div class="sum-head">${headline}</div>
          <div class="muted small">${close ? `Scores ${Math.round(c.score)} (CAD) and ${Math.round(u.score)} (USD).` : `${M.verdict(best.score).label}: score ${Math.round(best.score)} of 100${other ? `, against ${Math.round(other.score)} for ${INFO[other.pair].code}` : ""}.`}</div>
        </div></div>
      <div class="sum-list">${[c, u, g].filter(a => a && a.score != null).map(mini).join("")}</div>
      <a class="sum-link" href="#signals">See the details and charts ↓</a>
    </section>`;
  }

  function render(history) {
    lastHistory = history;
    const host = document.getElementById("signals");
    if (!host) return;
    const [horizon, hName] = RANGES[range];
    const pairs = ["CAD/INR", "USD/INR", "XAU/INR"].filter(p => history[p] && history[p].length > 120);
    if (!pairs.length) { host.innerHTML = ""; summary({}, hName); return; }
    const res = {};
    pairs.forEach(p => { res[p] = M.analyse(history[p], horizon); res[p].pair = p; });
    summary(res, hName);
    const days = Math.max(...pairs.map(p => history[p].length));
    host.innerHTML = `
      <div class="sig-title">
        <div><h2>When to buy CAD, USD or gold with rupees</h2>
        <p class="muted">Five statistical models scored on up to ${days} trading days of prices. The horizon sets how far back
        "cheap" is judged (percentile, good and great levels) and how much of the chart is shown.
        Green on the charts marks days the combined score said "buy".</p></div>
        <div class="seg-wrap"><span class="muted small">Judge over</span>
        <div class="seg" role="group" aria-label="Scoring horizon">${Object.keys(RANGES).map(r =>
          `<button type="button" data-r="${r}" aria-pressed="${r === range}">${r}</button>`).join("")}</div></div>
      </div>
      <div class="sig-grid">${pairs.map(p => panel(p, res[p], hName)).join("")}</div>
      <div class="disclaimer glass"><b>Not financial advice.</b> These signals are statistical summaries of past
        prices and cannot predict the future. Reference rates differ from what your bank, transfer service or jeweller
        charges (currency margins are often 1% to 3%; Indian retail gold adds import duty and GST), and those costs can
        outweigh these differences. For large amounts, buying in parts over several weeks reduces the risk of bad timing.
        Check with a licensed advisor before making significant financial decisions.</div>`;
    host.querySelectorAll(".chart").forEach(box => drawChart(box, res[box.dataset.pair]));
    host.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => { range = b.dataset.r; render(lastHistory); }));
  }

  let rt, lastW = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastW) return;  // ignore mobile address-bar height changes
    lastW = window.innerWidth;
    clearTimeout(rt); rt = setTimeout(() => lastHistory && render(lastHistory), 200);
  });
  window.FXSignals = { render };
})();
