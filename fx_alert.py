#!/usr/bin/env python3
"""Hourly FX rate checker with email digests and threshold alerts.

Reads config.yaml, fetches rates, evaluates alert rules, and emails recipients
only inside the configured local-time window. Keeps a small state.json so alerts
are not repeated every hour and emails can show the change since the last email.

Email settings come from environment variables (GitHub secrets):
  SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASSWORD,
  MAIL_FROM (default SMTP_USER), RECIPIENTS (optional, comma separated, overrides config)
Optional: TWELVEDATA_API_KEY for intraday rates.

Usage:
  python fx_alert.py              normal hourly run
  python fx_alert.py --dry-run    print the email instead of sending, don't save state
  python fx_alert.py --force      ignore the time window (useful for a test email)
"""
from __future__ import annotations

import argparse
import json
import operator
import os
import smtplib
import ssl
import sys
import urllib.parse
import urllib.request
from datetime import datetime, time, timedelta, timezone
from email.message import EmailMessage
from html import escape
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

HERE = Path(__file__).resolve().parent
OPS = {"<": operator.lt, "<=": operator.le, ">": operator.gt, ">=": operator.ge}
UA = {"User-Agent": "fx-rate-alerts/1.0"}


# ---------------------------------------------------------------- rates

def _get_json(url: str, timeout: int = 20) -> dict:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _split(pair: str) -> tuple[str, str]:
    base, quote = pair.upper().replace(" ", "").split("/")
    return base, quote


def fetch_twelvedata(pairs: list[str]) -> dict[str, float]:
    key = os.environ.get("TWELVEDATA_API_KEY", "").strip()
    if not key:
        raise RuntimeError("no TWELVEDATA_API_KEY set")
    out = {}
    for pair in pairs:
        q = urllib.parse.urlencode({"symbol": pair, "apikey": key})
        data = _get_json(f"https://api.twelvedata.com/exchange_rate?{q}")
        if "rate" not in data:
            raise RuntimeError(f"twelvedata {pair}: {data.get('message', data)}")
        out[pair] = float(data["rate"])
    return out


def _by_base(pairs, fetch_base):
    """Fetch one table per base currency and pick the quotes we need."""
    out = {}
    bases: dict[str, set[str]] = {}
    for pair in pairs:
        b, q = _split(pair)
        bases.setdefault(b, set()).add(q)
    for base, quotes in bases.items():
        table = fetch_base(base, sorted(quotes))
        for q in quotes:
            if q not in table:
                raise RuntimeError(f"{base}/{q} missing from response")
            out[f"{base}/{q}"] = float(table[q])
    return out


def fetch_frankfurter(pairs: list[str]) -> dict[str, float]:
    def one(base, quotes):
        q = urllib.parse.urlencode({"from": base, "to": ",".join(quotes)})
        return _get_json(f"https://api.frankfurter.dev/v1/latest?{q}")["rates"]
    return _by_base(pairs, one)


def fetch_open_er_api(pairs: list[str]) -> dict[str, float]:
    def one(base, quotes):
        data = _get_json(f"https://open.er-api.com/v6/latest/{base}")
        if data.get("result") != "success":
            raise RuntimeError(f"open.er-api: {data}")
        return data["rates"]
    return _by_base(pairs, one)


PROVIDERS = {
    "twelvedata": fetch_twelvedata,
    "frankfurter": fetch_frankfurter,
    "open_er_api": fetch_open_er_api,
}


def fetch_rates(pairs: list[str], providers: list[str]) -> tuple[dict[str, float], str]:
    errors = []
    for name in providers:
        fn = PROVIDERS.get(name)
        if fn is None:
            errors.append(f"{name}: unknown provider")
            continue
        try:
            return fn(pairs), name
        except Exception as exc:  # try the next provider
            errors.append(f"{name}: {exc}")
    raise RuntimeError("all rate providers failed:\n  " + "\n  ".join(errors))


# ---------------------------------------------------------------- rules / state

def rule_id(rule: dict) -> str:
    return f"{rule['pair'].upper()} {rule['op']} {rule['value']}"


def evaluate_rules(rules, rates, state, now_utc, repeat_hours):
    """Return (rules to alert on now, updated alert state)."""
    prev = state.get("alerts", {})
    new_state, firing = {}, []
    for rule in rules or []:
        pair = rule["pair"].upper()
        rid = rule_id(rule)
        if pair not in rates or rule["op"] not in OPS:
            continue
        active = OPS[rule["op"]](rates[pair], float(rule["value"]))
        old = prev.get(rid, {})
        entry = {"active": active, "last_sent": old.get("last_sent")}
        if active:
            last = old.get("last_sent")
            due = (
                not old.get("active")
                or last is None
                or (repeat_hours and now_utc - datetime.fromisoformat(last)
                    >= timedelta(hours=repeat_hours))
            )
            if due:
                firing.append(rule)
        new_state[rid] = entry
    return firing, new_state


def in_window(now_local: datetime, start: str, end: str) -> bool:
    s = time.fromisoformat(start)
    e = time.fromisoformat(end)
    # Compare at hour granularity so a run delayed to 19:20 still counts as the 7 PM run.
    h = now_local.hour
    return s.hour <= h <= e.hour


# ---------------------------------------------------------------- email

CHART_SITES = {
    "tradingview": ("TradingView", "https://www.tradingview.com/chart/?symbol=FX_IDC:{b}{q}"),
    "google": ("Google Finance", "https://www.google.com/finance/quote/{b}-{q}"),
    "xe": ("XE", "https://www.xe.com/currencycharts/?from={b}&to={q}"),
    "yahoo": ("Yahoo Finance", "https://finance.yahoo.com/quote/{b}{q}%3DX/chart"),
}


def chart_links(pair, sites):
    b, q = _split(pair)
    return [(CHART_SITES[s][0], CHART_SITES[s][1].format(b=b, q=q)) for s in sites if s in CHART_SITES]


def fmt(pair, value, decimals):
    return f"{value:.{decimals.get(pair, 4)}f}"


def fmt_amount(x):
    """Readable money amount: 6,541.23 / 71.23 / 0.7123."""
    if abs(x) >= 100:
        return f"{x:,.2f}"
    if abs(x) >= 1:
        return f"{x:,.2f}"
    return f"{x:.4f}"


# ---------------------------------------------------------------- trends

TREND_PERIODS = [("1D", "points", 1), ("5D", "points", 5), ("1M", "months", 1), ("3M", "months", 3)]


def _shift_months(d, months):
    y, m = divmod(d.month - 1 - months, 12)
    y += d.year
    m += 1
    for day in (d.day, 30, 29, 28):
        try:
            return d.replace(year=y, month=m, day=day)
        except ValueError:
            continue


def fetch_history(pairs, today=None):
    """Daily ECB closes per pair from Frankfurter, about the last 100 days.

    Two requests per base currency: a short range (always daily) for 1D/5D, and a
    long range for 1M/3M, merged. Returns {pair: [(date, rate), ...]} sorted.
    """
    from datetime import date
    today = today or date.today()
    ranges = [today - timedelta(days=14), today - timedelta(days=100)]
    out = {}
    bases = {}
    for p in pairs:
        b, q = _split(p)
        bases.setdefault(b, set()).add(q)
    for base, quotes in bases.items():
        series = {}
        for start in ranges:
            q = urllib.parse.urlencode({"from": base, "to": ",".join(sorted(quotes))})
            data = _get_json(f"https://api.frankfurter.dev/v1/{start.isoformat()}..?{q}")
            for day, vals in data.get("rates", {}).items():
                series.setdefault(day, {}).update(vals)
        for qcur in quotes:
            pts = sorted((date.fromisoformat(d), float(v[qcur])) for d, v in series.items() if qcur in v)
            out[f"{base}/{qcur}"] = pts
    return out


def compute_trends(points, current):
    """Change of `current` vs the close 1 and 5 trading days back and 1 and 3 months back.

    Returns {"1D": (old, diff, pct) or None, ...}.
    """
    res = {}
    if not points:
        return {k: None for k, _, _ in TREND_PERIODS}
    last_date = points[-1][0]
    for label, kind, n in TREND_PERIODS:
        old = None
        if kind == "points":
            if len(points) > n:
                old = points[-1 - n][1]
        else:
            target = _shift_months(last_date, n)
            older = [v for d, v in points if d <= target]
            if older:
                old = older[-1]
        res[label] = None if not old else (old, current - old, (current - old) / old * 100)
    return res


# ---------------------------------------------------------------- email body

def build_email(cfg, rates, provider, firing, last_sent_rates, now_local, trends=None):
    dec = cfg.get("decimals", {}) or {}
    pairs = [p.upper() for p in cfg["pairs"]]
    sites = cfg.get("chart_links", ["tradingview", "google"]) or []
    amount = cfg.get("conversion_amount", 100)
    trends = trends or {}
    stamp = now_local.strftime("%a %b %d, %I:%M %p %Z")
    td = "padding:6px 10px;border-top:1px solid #eee;vertical-align:top"
    up, down, grey = "#0a7a28", "#b00020", "#777"

    def trend_cell(t):
        if not t:
            return f"<td style='{td};color:{grey}'>n/a</td>"
        color = up if t[1] > 0 else down if t[1] < 0 else grey
        return f"<td style='{td};color:{color};font-family:monospace;white-space:nowrap'>{t[2]:+.2f}%</td>"

    rows_txt, rows_html = [], []
    for p in pairs:
        b, q = _split(p)
        r = rates[p]
        change = ""
        if p in last_sent_rates:
            d = r - last_sent_rates[p]
            pct = d / last_sent_rates[p] * 100 if last_sent_rates[p] else 0
            change = f"{d:+.{dec.get(p, 4)}f} ({pct:+.2f}%) since last email"
        tr = trends.get(p, {})
        conv = f"{amount:g} {b} = {fmt_amount(amount * r)} {q}"
        conv_back = f"{amount:g} {q} = {fmt_amount(amount / r)} {b}"
        links = chart_links(p, sites)

        trend_txt = "  ".join(f"{k} {tr[k][2]:+.2f}%" if tr.get(k) else f"{k} n/a" for k, _, _ in TREND_PERIODS)
        rows_txt.append(f"  {b} -> {q}: {fmt(p, r, dec)}" + (f"   ({change})" if change else ""))
        rows_txt.append(f"      Trend: {trend_txt}")
        rows_txt.append(f"      {conv}   |   {conv_back}")
        for name, url in links:
            rows_txt.append(f"      {name} chart: {url}")
        rows_txt.append("")

        links_html = "<br>".join(
            f"<a href='{escape(url)}' style='color:#1a5fb4'>{escape(name)}</a>" for name, url in links)
        change_html = f"<br><span style='color:{grey};font-size:12px'>{escape(change)}</span>" if change else ""
        rows_html.append(
            f"<tr><td style='{td};white-space:nowrap'><b>{b} &rarr; {q}</b></td>"
            f"<td style='{td};text-align:right;font-family:monospace;font-size:15px'><b>{fmt(p, r, dec)}</b>{change_html}</td>"
            + "".join(trend_cell(tr.get(k)) for k, _, _ in TREND_PERIODS)
            + f"<td style='{td};white-space:nowrap'>{escape(conv)}<br><span style='color:{grey}'>{escape(conv_back)}</span></td>"
            f"<td style='{td};white-space:nowrap'>{links_html or '&nbsp;'}</td></tr>"
        )

    alert_txt, alert_html = [], []
    for rule in firing:
        p = rule["pair"].upper()
        line = f"{p} is {fmt(p, rates[p], dec)} ({rule['op']} {rule['value']})"
        if rule.get("note"):
            line += f": {rule['note']}"
        alert_txt.append("  ALERT " + line)
        alert_html.append(f"<li>{escape(line)}</li>")

    if firing:
        subject = "FX ALERT: " + "; ".join(
            f"{r['pair'].upper()} {fmt(r['pair'].upper(), rates[r['pair'].upper()], dec)}" for r in firing
        )
    else:
        subject = "FX rates: " + ", ".join(f"{p} {fmt(p, rates[p], dec)}" for p in pairs)

    note = (f"Trends compare the current rate with European Central Bank closes 1 and 5 working days "
            f"and 1 and 3 months ago. Source: {provider}.")
    text = f"FX rates at {stamp}\n\n"
    if alert_txt:
        text += "\n".join(alert_txt) + "\n\n"
    text += "\n".join(rows_txt)
    text += f"\n{note}\n"

    th = "padding:6px 10px;text-align:left;font-weight:normal"
    html = "<div style='font-family:Arial,sans-serif;font-size:14px;color:#16181d'>"
    html += f"<p>FX rates at <b>{escape(stamp)}</b></p>"
    if alert_html:
        html += ("<div style='background:#fff4e5;border-left:4px solid #e67700;padding:8px 12px;margin-bottom:12px'>"
                 f"<b>Alerts</b><ul style='margin:4px 0'>{''.join(alert_html)}</ul></div>")
    html += (f"<table style='border-collapse:collapse'><tr style='color:{grey}'>"
             f"<th style='{th}'>Pair</th><th style='{th};text-align:right'>Rate</th>"
             + "".join(f"<th style='{th}'>{k}</th>" for k, _, _ in TREND_PERIODS)
             + f"<th style='{th}'>{amount:g} units</th><th style='{th}'>Chart</th></tr>"
             + "".join(rows_html) + "</table>")
    html += f"<p style='color:#888;font-size:12px'>{escape(note)}</p></div>"
    return subject, text, html


def send_email(recipients, subject, text, html):
    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ["SMTP_USER"]
    password = os.environ["SMTP_PASSWORD"]
    sender = os.environ.get("MAIL_FROM") or user

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = sender
    msg["Bcc"] = ", ".join(recipients)  # recipients don't see each other
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")

    ctx = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=ctx, timeout=30) as s:
            s.login(user, password)
            s.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.starttls(context=ctx)
            s.login(user, password)
            s.send_message(msg)


# ---------------------------------------------------------------- main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(HERE / "config.yaml"))
    ap.add_argument("--state", default=str(HERE / "state.json"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)

    cfg = yaml.safe_load(Path(args.config).read_text())
    state_path = Path(args.state)
    state = json.loads(state_path.read_text()) if state_path.exists() else {}

    sched = cfg.get("schedule", {})
    tz = ZoneInfo(sched.get("timezone", "America/New_York"))
    now_utc = datetime.now(timezone.utc)
    now_local = now_utc.astimezone(tz)

    pairs = [p.upper() for p in cfg["pairs"]]
    rates, provider = fetch_rates(pairs, cfg.get("providers") or list(PROVIDERS))
    print(f"[{now_local:%Y-%m-%d %H:%M %Z}] via {provider}: "
          + ", ".join(f"{p}={rates[p]}" for p in pairs))

    window = in_window(now_local, sched.get("send_from", "07:00"), sched.get("send_until", "19:00"))
    if not window and not args.force:
        print("Outside email window; checked rates only, no email sent.")
        # Alert state is not updated outside the window, so a condition that becomes
        # true overnight is still emailed at the first in-window run.
        return 0

    firing, alert_state = evaluate_rules(
        cfg.get("rules"), rates, state, now_utc, cfg.get("alert_repeat_after_hours", 24))

    mode = cfg.get("mode", "both")
    should_send = (mode in ("digest", "both")) or (mode == "alerts" and firing)
    if not should_send:
        print("No alerts triggered; nothing to send.")
        if not args.dry_run:
            state["alerts"] = alert_state
            state_path.write_text(json.dumps(state, indent=2) + "\n")
        return 0

    env_recipients = [r.strip() for r in os.environ.get("RECIPIENTS", "").split(",") if r.strip()]
    recipients = env_recipients or cfg.get("recipients") or []
    if not recipients:
        print("No recipients configured.", file=sys.stderr)
        return 1

    trends = {}
    try:
        history = fetch_history(pairs)
        trends = {p: compute_trends(history.get(p, []), rates[p]) for p in pairs}
    except Exception as exc:  # trends are a nice-to-have; still send the rates
        print(f"Could not load history for trends: {exc}", file=sys.stderr)

    subject, text, html = build_email(
        cfg, rates, provider, firing, state.get("last_sent_rates", {}), now_local, trends)

    if args.dry_run:
        print(f"\n--- DRY RUN: would send to {len(recipients)} recipient(s) ---")
        print("Subject:", subject)
        print(text)
        return 0

    send_email(recipients, subject, text, html)
    print(f"Sent '{subject}' to {len(recipients)} recipient(s).")

    for rule in firing:
        alert_state[rule_id(rule)]["last_sent"] = now_utc.isoformat()
    state["alerts"] = alert_state
    state["last_sent_rates"] = rates
    state["last_sent_at"] = now_utc.isoformat()
    state_path.write_text(json.dumps(state, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
