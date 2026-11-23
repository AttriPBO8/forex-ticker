// Buy-signal section: runs FXModels on X/INR history and draws the summary, charts and explanations.
(function () {
  "use strict";
  const M = window.FXModels;
  const NS = "http://www.w3.org/2000/svg";
  const fmt = (x, d = 2) => x == null || isNaN(x) ? "n/a" : x.toFixed(d);
  // Prices: 2 decimals for currencies, whole rupees (Indian grouping) for gold
  const px = x => x == null || isNaN(x) ? "n/a" : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-IN") : Math.abs(x) >= 1 ? x.toFixed(2) : Math.abs(x) >= 0.01 || x === 0 ? x.toFixed(5) : x.toPrecision(3);
  // Quote mode for CAD/USD panels: "inr" = rupees per unit (lower is better), "fx" = units per rupee (higher is better)
  let quote = "inr";
  // INR/CAD and INR/USD (buying rupees) are always shown flipped: rupees per CAD/USD, higher is better.
  const inv = pair => (INFO[pair] && INFO[pair].rev) || (quote === "fx" && pair !== "XAU/INR");
  const T = (pair, x) => (x == null ? x : inv(pair) ? 1 / x : x);
  const cur = (pair, x) => INFO[pair] && INFO[pair].rev ? `₹${px(1 / x)}` : inv(pair) ? `${px(T(pair, x))} ${INFO_CODE(pair)}` : `₹${px(x)}`;
  const INFO_CODE = pair => pair.split("/")[0];
  // Horizon = how far back "cheap vs expensive" is judged, and how much the chart shows.
  const RANGES = { "6M": [126, "6 months"], "1Y": [252, "1 year"], "2Y": [504, "2 years"] };
  let range = "1Y";
  let lastHistory = null;
  const INFO = {
    "CAD/INR": { code: "CAD", title: "Buy CAD with INR", sub: "Canadian Dollar price in rupees, lower is better", unit: "CAD" },
    "USD/INR": { code: "USD", title: "Buy USD with INR", sub: "US Dollar price in rupees, lower is better", unit: "USD" },
    "XAU/INR": { code: "XAU", title: "Buy gold with INR", sub: "Price of 10 g in rupees (international spot, before duty and GST), lower is better", unit: "g", perUnit: 10 },
    // Buying rupees: models run on the rupee's price in CAD/USD (lower = cheaper rupees), shown as ₹ per CAD/USD.
    "INR/CAD": { code: "CAD", rev: true, title: "Buy INR with CAD", sub: "Rupees you get for 1 CAD, higher is better", unit: "CAD" },
    "INR/USD": { code: "USD", rev: true, title: "Buy INR with USD", sub: "Rupees you get for 1 USD, higher is better", unit: "USD" },
  };
  const FX_AMOUNT = 1000;
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
      ["Kalman trend", `${i.kalmanSlope >= 0 ? "+" : "−"}${a.pair && a.pair.startsWith("INR/") ? "" : "₹"}${px(Math.abs(i.kalmanSlope * 21))}${a.pair && a.pair.startsWith("INR/") ? " " + a.pair.slice(4) : ""}/month`,
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
    const id = "sig-" + (info.rev ? "inr-" : "") + info.code.toLowerCase();
    const iv = inv(pair), rv = !!info.rev;
    const title = rv ? info.title : iv ? `Convert INR to ${info.code}` : info.title;
    const sub = rv ? info.sub : iv ? `${info.code} you get for ₹1, higher is better` : info.sub;
    const cmp = iv ? "at or above" : "at or below";
    const show = x => cur(pair, x);
    return `<section class="sig glass" id="${id}" data-pair="${pair}">
      <div class="sig-head">
        <div class="pair"><span class="chips">${rv ? chip("INR") + chip(info.code) : chip(info.code) + chip("INR")}</span>
          <span>${title}<small>${sub}</small></span></div>
        <div class="verdict-wrap">${gauge(a.score)}<div><div class="verdict ${v.key}">${v.label}</div><div class="muted small">${v.tip}</div></div></div>
      </div>
      <div class="levels">
        <div class="lv"><span>Now</span><b>${show(a.now)}</b><small>${rv ? `better than ${Math.round((1 - i.pctH) * 100)}% of the past ${hName}` : iv ? `₹${px(a.now)} per ${info.code}` : `${Math.round(i.pctH * 100)}th percentile of ${hName}`}</small></div>
        <div class="lv good"><span>Good buy ${cmp}</span><b>${show(L.good)}</b><small>${iv ? "best" : "cheapest"} 25% of the past ${hName}</small></div>
        <div class="lv great"><span>Great buy ${cmp}</span><b>${show(L.great)}</b><small>${iv ? "best" : "cheapest"} 10% of the past ${hName}</small></div>
        <div class="lv"><span>5-day forecast (Holt)</span><b>${show(fc)}</b><small>${rv ? `${1 / fc >= 1 / a.now ? "+" : "−"}₹${fmt(Math.abs(1 / fc - 1 / a.now), 2)} vs now, trend only` : iv ? `₹${px(fc)} per ${info.code}, trend only` : `${fcDelta >= 0 ? "+" : "−"}${px(Math.abs(fcDelta))} vs now, trend only`}</small></div>
      </div>
      <div class="chart-wrap"><div class="chart" data-pair="${pair}"></div><div class="tip" hidden></div></div>
      <div class="legend">
        <span><i class="sw price"></i>Price</span><span><i class="sw kal"></i>Kalman trend</span><span><i class="sw sma"></i>50-day average</span>
        <span><i class="sw band"></i>Bollinger band</span><span><i class="sw zone"></i>Strong buy zone (score ≥ 70)</span><span><i class="sw zone2"></i>Good (55 to 70)</span>
      </div>
      <p class="explain">${rv ? `${FX_AMOUNT.toLocaleString()} ${info.code} gets <b>₹${Math.round(FX_AMOUNT / a.now).toLocaleString("en-IN")}</b> today.
        At the good level it would get ₹${Math.round(FX_AMOUNT / L.good).toLocaleString("en-IN")} (${FX_AMOUNT / L.good >= FX_AMOUNT / a.now ? "+" : "−"}₹${Math.round(Math.abs(FX_AMOUNT / L.good - FX_AMOUNT / a.now)).toLocaleString("en-IN")}${FX_AMOUNT / L.good < FX_AMOUNT / a.now ? ": today is already better" : ""}).
        Past ${hName}: best ${show(L.lowH)}, median ${show(L.median)}, worst ${show(L.highH)} per ${info.code}.</p>` : `₹${INR_AMOUNT.toLocaleString("en-IN")} buys <b>${fmt(buysNow, d)} ${info.unit}</b> today.
        At the good-buy level it would buy ${fmt(buysGood, d)} ${info.unit} (${buysGood >= buysNow ? "+" : ""}${fmt(buysGood - buysNow, d)}).
        Past ${hName}: ${iv ? `best ${show(L.lowH)}, median ${show(L.median)}, worst ${show(L.highH)} per ₹1` : `low ₹${px(L.lowH)}, median ₹${px(L.median)}, high ₹${px(L.highH)}`}.</p>`}
      <details class="why"><summary>Why this score? The numbers behind it${rv ? ` (models read the rupee's price in ${info.code}: lower means cheaper rupees)` : iv ? " (in ₹ per " + info.code + ")" : ""}</summary>
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

  function drawChart(box, a0) {
    box.innerHTML = "";
    // In "units per rupee" mode, draw everything as 1/x so higher means a better deal.
    const iv = inv(a0.pair), f = x => (x == null ? null : iv ? 1 / x : x);
    const a = iv ? { ...a0, values: a0.values.map(f), sma50: a0.sma50.map(f), kalman: a0.kalman.map(f), now: f(a0.now),
      bb: { ...a0.bb, upper: a0.bb.lower.map(f), lower: a0.bb.upper.map(f) },
      levels: { ...a0.levels, good: f(a0.levels.good), great: f(a0.levels.great) } } : a0;
    const rv = !!(INFO[a0.pair] && INFO[a0.pair].rev);
    const unit = iv && !rv ? " " + a0.pair.split("/")[0] : "";
    const pfx = iv && !rv ? "" : "₹";
    const W = Math.max(280, box.clientWidth), small = W < 520;
    const H1 = small ? 210 : 270, gap = 18, H2 = small ? 60 : 72, padL = 8, padR = small ? 52 : 64, padT = 10;
    const H = padT + H1 + gap + H2 + 22;
    const n = a.values.length, show = Math.min(a.horizon, n), s0 = n - show;
    const idx = [...Array(show).keys()].map(k => s0 + k);
    const vals = idx.map(i => a.values[i]);
    const lows = idx.map(i => a.bb.lower[i]).filter(x => x != null), highs = idx.map(i => a.bb.upper[i]).filter(x => x != null);
    let lo = Math.min(...vals, ...lows, a.levels.great), hi = Math.max(...vals, ...highs, a.levels.great);
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
      el("text", { x: padL + 4, y: Y(v) - 4, class: "lvl-t " + cls }, svg).textContent = `${lbl} ${iv ? "≥" : "≤"} ${px(v)}`;
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
        ${iv ? "Rate" : "Price"} ${pfx}${px(a.values[i])}${unit}<br>${s ? `Score ${Math.round(s.total)}: ${M.verdict(s.total).label}` : "Score: not enough history"}`;
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
      const href = "#sig-" + (info.rev ? "inr-" : "") + info.code.toLowerCase();
      const name = info.rev ? `INR with ${info.code}` : info.code === "XAU" ? "Gold" : info.code;
      const price = info.rev ? `₹${px(1 / a.now)} per ${info.code}` : `₹${px(a.now)}${info.perUnit ? " per 10 g" : ""}`;
      return `<a class="mini" href="${href}">${info.rev ? chip(info.code) : chip(info.code)}<span><b>${name}</b>
        <span class="verdict ${a.verdict.key}">${Math.round(a.score)} · ${a.verdict.label}</span><small>${price}</small></span></a>`;
    };
    // Buying rupees with CAD or USD
    const ri = [res["INR/CAD"], res["INR/USD"]].filter(a => a && a.score != null);
    let inrRow = "";
    if (ri.length) {
      const b2 = ri.reduce((x, y) => (y.score > x.score ? y : x)), o2 = ri.find(a => a !== b2);
      const even = o2 && Math.abs(b2.score - o2.score) < 5;
      inrRow = `<div class="sum-row2">
        <div class="sum-main">${gauge(b2.score)}
          <div><div class="sum-kicker">Buying INR (sending money to India)</div>
            <div class="sum-head sm">${even ? "CAD and USD are about even" : `Better to pay with <b>${INFO[b2.pair].code}</b>`}</div>
            <div class="muted small">${M.verdict(b2.score).label}: score ${Math.round(b2.score)}${o2 ? `, against ${Math.round(o2.score)} with ${INFO[o2.pair].code}` : ""}.</div></div></div>
        <div class="sum-list">${ri.map(mini).join("")}</div></div>`;
    }
    host.innerHTML = `<section class="summary glass">
      <div class="sum-main">${gauge(best.score, "lg")}
        <div><div class="sum-kicker">Converting INR · judged over ${hName}</div>
          <div class="sum-head">${headline}</div>
          <div class="muted small">${close ? `Scores ${Math.round(c.score)} (CAD) and ${Math.round(u.score)} (USD).` : `${M.verdict(best.score).label}: score ${Math.round(best.score)} of 100${other ? `, against ${Math.round(other.score)} for ${INFO[other.pair].code}` : ""}.`}</div>
        </div></div>
      <div class="sum-list">${[c, u, g].filter(a => a && a.score != null).map(mini).join("")}</div>
      ${inrRow}
      <a class="sum-link" href="#signals">See the details and charts ↓</a>
    </section>`;
  }

  function render(history) {
    lastHistory = history;
    const host = document.getElementById("signals");
    if (!host) return;
    const [horizon, hName] = RANGES[range];
    const pairs = ["CAD/INR", "USD/INR", "XAU/INR", "INR/CAD", "INR/USD"].filter(p => history[p] && history[p].length > 120);
    if (!pairs.length) { host.innerHTML = ""; summary({}, hName); api.results = {}; return; }
    const res = {};
    pairs.forEach(p => { res[p] = M.analyse(history[p], horizon); res[p].pair = p; });
    summary(res, hName);
    const days = Math.max(...pairs.map(p => history[p].length));
    host.innerHTML = `
      <div class="sig-title">
        <div><h2>When to buy CAD, USD, gold or INR</h2>
        <p class="muted">Five statistical models scored on up to ${days} trading days of prices. The horizon sets how far back
        "cheap" is judged (percentile, good and great levels) and how much of the chart is shown.
        Green on the charts marks days the combined score said "buy".</p></div>
        <div class="seg-wrap"><span class="muted small">Show as</span>
        <div class="seg" role="group" aria-label="Quote">
          <button type="button" data-q="inr" aria-pressed="${quote === "inr"}">₹ per CAD/USD</button>
          <button type="button" data-q="fx" aria-pressed="${quote === "fx"}">CAD/USD per ₹</button></div></div>
        <div class="seg-wrap"><span class="muted small">Judge over</span>
        <div class="seg" role="group" aria-label="Scoring horizon">${Object.keys(RANGES).map(r =>
          `<button type="button" data-r="${r}" aria-pressed="${r === range}">${r}</button>`).join("")}</div></div>
      </div>
      <div class="sig-grid">${pairs.filter(p => !INFO[p].rev).map(p => panel(p, res[p], hName)).join("")}</div>
      ${pairs.some(p => INFO[p].rev) ? `<h3 class="sig-sub" id="buy-inr">Buying INR with CAD or USD</h3>
      <p class="muted sig-subp">For sending money to India or converting savings back to rupees. Same five models, run on the rupee's price
        in CAD or USD, so a high score means rupees are cheap (you get more ₹ per dollar). Shown as ₹ per CAD/USD.</p>
      <div class="sig-grid">${pairs.filter(p => INFO[p].rev).map(p => panel(p, res[p], hName)).join("")}</div>` : ""}
      <div class="disclaimer glass"><b>Not financial advice.</b> These signals are statistical summaries of past
        prices and cannot predict the future. Reference rates differ from what your bank, transfer service or jeweller
        charges (currency margins are often 1% to 3%; Indian retail gold adds import duty and GST), and those costs can
        outweigh these differences. For large amounts, buying in parts over several weeks reduces the risk of bad timing.
        Check with a licensed advisor before making significant financial decisions.</div>`;
    host.querySelectorAll(".chart").forEach(box => drawChart(box, res[box.dataset.pair]));
    host.querySelectorAll(".seg button[data-r]").forEach(b => b.addEventListener("click", () => { range = b.dataset.r; render(lastHistory); }));
    host.querySelectorAll(".seg button[data-q]").forEach(b => b.addEventListener("click", () => { quote = b.dataset.q; render(lastHistory); }));
    api.results = res; api.horizonName = hName;
    if (typeof window.renderConverter === "function") window.renderConverter();
  }

  let rt, lastW = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastW) return;  // ignore mobile address-bar height changes
    lastW = window.innerWidth;
    clearTimeout(rt); rt = setTimeout(() => lastHistory && render(lastHistory), 200);
  });
  const api = { render, results: {}, horizonName: "" };
  window.FXSignals = api;
})();
