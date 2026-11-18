// Buy-signal section: runs FXModels on X/INR history and draws the charts and explanations.
(function () {
  "use strict";
  const M = window.FXModels;
  const NS = "http://www.w3.org/2000/svg";
  const fmt = (x, d = 2) => x == null || isNaN(x) ? "n/a" : x.toFixed(d);
  const inr = x => "₹" + Math.round(x).toLocaleString("en-IN");
  const RANGES = { "6M": 126, "1Y": 252, "2Y": 520 };
  let range = "1Y";
  let lastHistory = null;
  const NAMES = { CAD: "Canadian Dollar", USD: "US Dollar" };
  const INR_AMOUNT = 100000;

  function verdictClass(score) { return M.verdict(score).key; }

  function readings(a) {
    const i = a.ind, p = a.parts;
    const pctTxt = v => `${Math.round(v * 100)}%`;
    return [
      ["1-year percentile", pctTxt(i.pct1y),
        i.pct1y <= 0.25 ? "Cheaper than 3 in 4 days of the past year" : i.pct1y >= 0.75 ? "Dearer than 3 in 4 days of the past year" : "Middle of the past year's range",
        p.percentile, 30],
      ["Bollinger %B (20-day, 2σ)", fmt(i.pctB),
        i.pctB <= 0 ? "Below the lower band: unusually cheap short term" : i.pctB < 0.2 ? "Near the lower band: cheap short term" : i.pctB > 0.8 ? "Near the upper band: expensive short term" : "Inside the bands",
        p.bollinger, 20],
      ["Z-score vs 50-day mean", fmt(i.z50),
        i.z50 <= -1.5 ? "Far below its 50-day average" : i.z50 < -0.5 ? "Below its 50-day average" : i.z50 > 0.5 ? "Above its 50-day average" : "Close to its 50-day average",
        p.zscore, 20],
      ["RSI (14-day)", fmt(i.rsi14, 0),
        i.rsi14 < 30 ? "Oversold: the pair has fallen fast, bounce risk" : i.rsi14 < 45 ? "Weak momentum (falling)" : i.rsi14 > 70 ? "Overbought: rose fast" : "Neutral momentum",
        p.rsi, 15],
      ["Kalman trend", `${i.kalmanSlope >= 0 ? "+" : ""}${fmt(i.kalmanSlope * 21, 3)} ₹/month`,
        i.kalmanSlope > 0 ? "Rising: waiting may cost more" : "Falling: waiting may get a better rate",
        p.trend, 15],
    ];
  }

  function gauge(score) {
    const cls = verdictClass(score);
    return `<div class="gauge ${cls}" style="--s:${score.toFixed(1)}"><div><b>${Math.round(score)}</b><small>/100</small></div></div>`;
  }

  function panel(pair, a) {
    const [b] = pair.split("/");
    const v = a.verdict, L = a.levels, i = a.ind;
    const buysNow = INR_AMOUNT / a.now, buysGood = INR_AMOUNT / L.good;
    const rows = readings(a).map(([name, val, txt, pts, max]) => `
      <tr><td>${name}</td><td class="num">${val}</td><td>${txt}</td>
      <td class="num"><span class="bar"><span style="width:${(pts / max * 100).toFixed(0)}%"></span></span>${pts.toFixed(1)}/${max}</td></tr>`).join("");
    const fc = i.holt.forecast, fcDelta = fc - a.now;
    return `<section class="sig glass" data-pair="${pair}">
      <div class="sig-head">
        <div>
          <div class="pair"><span class="chips"><span class="chip ${b}">${b}</span><span class="chip INR">INR</span></span>
            <span>Buy ${b} with INR<small>${NAMES[b]} price in rupees, lower is better</small></span></div>
        </div>
        <div class="verdict-wrap">${gauge(a.score)}<div><div class="verdict ${v.key}">${v.label}</div><div class="muted small">${v.tip}</div></div></div>
      </div>
      <div class="levels">
        <div class="lv"><span>Now</span><b>₹${fmt(a.now, 2)}</b><small>${Math.round(i.pct1y * 100)}th percentile of 1 year</small></div>
        <div class="lv good"><span>Good buy at or below</span><b>₹${fmt(L.good, 2)}</b><small>cheapest 25% of the past year</small></div>
        <div class="lv great"><span>Great buy at or below</span><b>₹${fmt(L.great, 2)}</b><small>cheapest 10% of the past year</small></div>
        <div class="lv"><span>5-day forecast (Holt)</span><b>₹${fmt(fc, 2)}</b><small>${fcDelta >= 0 ? "+" : ""}${fmt(fcDelta, 2)} vs now, trend only</small></div>
      </div>
      <div class="chart-wrap"><div class="chart" data-pair="${pair}"></div><div class="tip" hidden></div></div>
      <div class="legend">
        <span><i class="sw price"></i>Rate</span><span><i class="sw kal"></i>Kalman trend</span><span><i class="sw sma"></i>50-day average</span>
        <span><i class="sw band"></i>Bollinger band</span><span><i class="sw zone"></i>Strong buy zone (score ≥ 70)</span><span><i class="sw zone2"></i>Good (55 to 70)</span>
      </div>
      <p class="explain">${INR_AMOUNT.toLocaleString("en-IN")} INR buys <b>${fmt(buysNow, 2)} ${b}</b> today.
        At the good-buy level it would buy ${fmt(buysGood, 2)} ${b} (${buysGood >= buysNow ? "+" : ""}${fmt(buysGood - buysNow, 2)}).
        Past year: low ₹${fmt(L.low1y, 2)}, median ₹${fmt(L.median, 2)}, high ₹${fmt(L.high1y, 2)}.</p>
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
    const H1 = small ? 210 : 270, gap = 18, H2 = small ? 60 : 72, padL = 8, padR = small ? 46 : 58, padT = 10;
    const H = padT + H1 + gap + H2 + 22;
    const n = a.values.length, show = Math.min(RANGES[range], n), s0 = n - show;
    const idx = [...Array(show).keys()].map(k => s0 + k);
    const vals = idx.map(i => a.values[i]);
    const lows = idx.map(i => a.bb.lower[i]).filter(x => x != null), highs = idx.map(i => a.bb.upper[i]).filter(x => x != null);
    let lo = Math.min(...vals, ...lows, a.levels.great), hi = Math.max(...vals, ...highs);
    const padY = (hi - lo) * 0.06; lo -= padY; hi += padY;
    const X = k => padL + k * (W - padL - padR) / (show - 1);
    const Y = v => padT + (hi - v) / (hi - lo) * H1;
    const Y2 = s => padT + H1 + gap + (100 - s) / 100 * H2;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "big", role: "img",
      "aria-label": `${range} chart of ${a.pair} with buy zones` }, box);

    // buy zones (merge consecutive days)
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

    // grid + y labels
    for (let t = 0; t <= 4; t++) {
      const v = lo + (hi - lo) * t / 4, y = Y(v);
      el("line", { x1: padL, x2: W - padR, y1: y, y2: y, class: "grid" }, svg);
      el("text", { x: W - padR + 6, y: y + 4, class: "ax" }, svg).textContent = v.toFixed(2);
    }
    // month labels
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

    // Bollinger band
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

    // target levels
    [["good", a.levels.good, "Good"], ["great", a.levels.great, "Great"]].forEach(([cls, v, lbl]) => {
      if (v < lo || v > hi) return;
      el("line", { x1: padL, x2: W - padR, y1: Y(v), y2: Y(v), class: "lvl " + cls }, svg);
      el("text", { x: padL + 4, y: Y(v) - 4, class: "lvl-t " + cls }, svg).textContent = `${lbl} ≤ ${v.toFixed(2)}`;
    });

    // current point
    const lastK = show - 1;
    el("circle", { cx: X(lastK), cy: Y(a.now), r: 7, class: "now-halo" }, svg);
    el("circle", { cx: X(lastK), cy: Y(a.now), r: 3.6, class: "now" }, svg);

    // score panel
    el("text", { x: padL, y: padT + H1 + gap - 4, class: "ax" }, svg).textContent = "Buy score (0 to 100)";
    [55, 70].forEach(s => el("line", { x1: padL, x2: W - padR, y1: Y2(s), y2: Y2(s), class: "grid dash" }, svg));
    el("text", { x: W - padR + 6, y: Y2(70) + 4, class: "ax" }, svg).textContent = "70";
    el("text", { x: W - padR + 6, y: Y2(55) + 4, class: "ax" }, svg).textContent = "55";
    const sp = idx.map((i, k) => [k, a.scores[i] && a.scores[i].total]).filter(p => p[1] != null);
    if (sp.length > 1) el("path", { d: "M" + sp.map(([k, s]) => `${X(k).toFixed(1)},${Y2(s).toFixed(1)}`).join(" L"), class: "score" }, svg);

    // hover
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
        Rate ₹${a.values[i].toFixed(3)}<br>${s ? `Score ${Math.round(s.total)}: ${M.verdict(s.total).label}` : "Score: not enough history"}`;
      const tx = X(k) + 14, tw = tip.offsetWidth;
      tip.style.left = (tx + tw > W ? X(k) - tw - 14 : tx) + "px";
      tip.style.top = Math.max(0, Y(a.values[i]) - 30) + "px";
    };
    const leave = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("touchmove", move, { passive: true });
    hit.addEventListener("pointerleave", leave);
  }

  function compareLine(res) {
    const [c, u] = [res["CAD/INR"], res["USD/INR"]];
    if (!c || !u || c.score == null || u.score == null) return "";
    const better = c.score >= u.score ? ["CAD", c, "USD", u] : ["USD", u, "CAD", c];
    const diff = Math.abs(c.score - u.score);
    return `<div class="compare glass">
      <div class="cmp-item">${gauge(c.score)}<div><b>CAD</b><div class="verdict ${c.verdict.key}">${c.verdict.label}</div></div></div>
      <div class="cmp-text">${diff < 5
        ? `CAD and USD are about equally priced versus their own history right now (scores ${Math.round(c.score)} and ${Math.round(u.score)}).`
        : `Versus its own history, <b>${better[0]}</b> is the better buy right now: score ${Math.round(better[1].score)} against ${Math.round(better[3].score)} for ${better[2]}.`}
        <span class="muted"> If you need one specific currency, use its own panel below.</span></div>
      <div class="cmp-item">${gauge(u.score)}<div><b>USD</b><div class="verdict ${u.verdict.key}">${u.verdict.label}</div></div></div>
    </div>`;
  }

  function render(history) {
    lastHistory = history;
    const host = document.getElementById("signals");
    if (!host) return;
    const pairs = ["CAD/INR", "USD/INR"].filter(p => history[p] && history[p].length > 120);
    if (!pairs.length) { host.innerHTML = ""; return; }
    const res = {};
    pairs.forEach(p => { res[p] = M.analyse(history[p]); res[p].pair = p; });
    host.innerHTML = `
      <div class="sig-title">
        <div><h2>When to buy CAD or USD with rupees</h2>
        <p class="muted">Five statistical models scored on ${history[pairs[0]].length} days of European Central Bank rates.
        Green on the charts marks days the combined score said "buy".</p></div>
        <div class="seg" role="group" aria-label="Chart range">${Object.keys(RANGES).map(r =>
          `<button type="button" data-r="${r}" aria-pressed="${r === range}">${r}</button>`).join("")}</div>
      </div>
      ${compareLine(res)}
      <div class="sig-grid">${pairs.map(p => panel(p, res[p])).join("")}</div>
      <div class="disclaimer glass"><b>Not financial advice.</b> These signals are statistical summaries of past
        exchange rates and cannot predict the future. ECB reference rates differ from the rate your bank or transfer
        service gives you (their margin is often 1% to 3%, which can outweigh these differences). For large amounts,
        converting in parts over several weeks reduces the risk of bad timing. Check with a licensed advisor before
        making significant financial decisions.</div>`;
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
