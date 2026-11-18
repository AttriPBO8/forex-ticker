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
        return _get_json(f"https://api.frankfurter.app/latest?{q}")["rates"]
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


def build_email(cfg, rates, provider, firing, last_sent_rates, now_local):
    dec = cfg.get("decimals", {}) or {}
    pairs = [p.upper() for p in cfg["pairs"]]
    sites = cfg.get("chart_links", ["tradingview", "google"]) or []
    stamp = now_local.strftime("%a %b %d, %I:%M %p %Z")

    rows_txt, rows_html = [], []
    for p in pairs:
        r = rates[p]
        change = ""
        if p in last_sent_rates:
            d = r - last_sent_rates[p]
            pct = d / last_sent_rates[p] * 100 if last_sent_rates[p] else 0
            change = f"{d:+.{dec.get(p, 4)}f} ({pct:+.2f}%)"
        links = chart_links(p, sites)
        rows_txt.append(f"  {p:<8} {fmt(p, r, dec):>12}   {change}")
        for name, url in links:
            rows_txt.append(f"           {name} chart: {url}")
        links_html = " &middot; ".join(
            f"<a href='{escape(url)}' style='color:#1a5fb4'>{escape(name)}</a>" for name, url in links)
        color = "#555" if not change else ("#0a7a28" if r >= last_sent_rates[p] else "#b00020")
        rows_html.append(
            f"<tr><td style='padding:4px 12px'><b>{escape(p)}</b></td>"
            f"<td style='padding:4px 12px;text-align:right;font-family:monospace'>{fmt(p, r, dec)}</td>"
            f"<td style='padding:4px 12px;color:{color};font-family:monospace'>{escape(change) or '&nbsp;'}</td>"
            f"<td style='padding:4px 12px'>{links_html or '&nbsp;'}</td></tr>"
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

    text = f"FX rates at {stamp}\n\n"
    if alert_txt:
        text += "\n".join(alert_txt) + "\n\n"
    text += "\n".join(rows_txt)
    text += f"\n\nChange is since the previous email. Source: {provider}.\n"

    html = f"<div style='font-family:Arial,sans-serif;font-size:14px'>"
    html += f"<p>FX rates at <b>{escape(stamp)}</b></p>"
    if alert_html:
        html += ("<div style='background:#fff4e5;border-left:4px solid #e67700;padding:8px 12px;margin-bottom:12px'>"
                 f"<b>Alerts</b><ul style='margin:4px 0'>{''.join(alert_html)}</ul></div>")
    html += ("<table style='border-collapse:collapse'><tr style='color:#777'><th align='left' style='padding:4px 12px'>Pair</th>"
             "<th align='right' style='padding:4px 12px'>Rate</th><th align='left' style='padding:4px 12px'>Change</th>"
             "<th align='left' style='padding:4px 12px'>Chart</th></tr>"
             + "".join(rows_html) + "</table>")
    html += f"<p style='color:#888;font-size:12px'>Change is since the previous email. Source: {escape(provider)}.</p></div>"
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

    subject, text, html = build_email(
        cfg, rates, provider, firing, state.get("last_sent_rates", {}), now_local)

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
