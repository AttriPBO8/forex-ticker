# FX Rate Alerts

Checks CAD→INR, USD→INR, CAD→USD and USD→CAD every hour and emails a list of recipients
between 7 AM and 7 PM US Eastern (daylight saving handled automatically). Emails
carry the latest rates, the change since the previous email, and any alerts
from your rules (for example "CAD/INR below 65.6").

Runs free on GitHub Actions. No server needed.

**Setup checklist:** see [TODO.md](TODO.md).
**Live rates page:** https://attripbo8.github.io/forex-ticker/ (`index.html`, GitHub Pages).

## Files

| File | What it is |
|---|---|
| `config.yaml` | Recipients, pairs, email window, mode, alert rules. The only file you normally edit. |
| `fx_alert.py` | The checker. |
| `.github/workflows/fx-alert.yml` | Hourly schedule on GitHub Actions. |
| `index.html` | Live rates webpage (auto-refresh, alert highlights, chart links). |
| `TODO.md` | Remaining setup steps. |
| `state.json` | Created automatically. Remembers last-sent rates and which alerts already fired. |

## Setup (about 10 minutes)

1. **Create a private GitHub repo** (e.g. `fx-rate-alerts`) and upload these files,
   keeping the `.github/workflows/` folder structure.
2. **Get an email app password** for the account that will send the emails.
   - Gmail: turn on 2-Step Verification, then Google Account → Security → App passwords.
     Host `smtp.gmail.com`, port `587`.
   - Outlook/Hotmail: host `smtp-mail.outlook.com`, port `587` (Microsoft may require an app password).
   - Yahoo: Account Security → Generate app password. Host `smtp.mail.yahoo.com`, port `465`.
3. **Add repo secrets**: repo → Settings → Secrets and variables → Actions → New repository secret.

   | Secret | Example |
   |---|---|
   | `SMTP_HOST` | `smtp.gmail.com` |
   | `SMTP_PORT` | `587` |
   | `SMTP_USER` | `alerts.sender@gmail.com` |
   | `SMTP_PASSWORD` | the app password (not your normal password) |
   | `MAIL_FROM` | optional, defaults to `SMTP_USER` |
   | `RECIPIENTS` | optional, comma-separated. Overrides `config.yaml` so addresses stay private |
   | `TWELVEDATA_API_KEY` | optional, see "Rate sources" |

4. **Edit `config.yaml`**: recipients (or use the `RECIPIENTS` secret), rules, mode.
5. **Send a test**: repo → Actions → *FX rate alerts* → Run workflow → tick *force* → Run.

## Modes

- `digest`: an email every hour in the window with the latest rates.
- `alerts`: email only when a rule triggers.
- `both` (default): hourly digest, with triggered alerts highlighted and in the subject.

## Alert repeats

An alert fires once when its condition becomes true. It fires again when the
condition clears and becomes true again, or after `alert_repeat_after_hours`
(default 24). If a condition becomes true overnight, it is sent at the first run after 7 AM.

## Rate sources

Tried in the order listed in `config.yaml`:

- **Twelve Data** (`twelvedata`): intraday rates that move during the day. Free key at
  twelvedata.com (free tier is 800 calls/day; this uses 3 per hour = 72/day).
  Skipped automatically if no key is set.
- **Frankfurter** (`frankfurter`): free, no key, European Central Bank reference rates.
  Updates **once per working day** (~16:00 CET), so hourly emails will show the same
  number most of the day.
- **open.er-api.com** (`open_er_api`): free, no key, updates once a day. Backup.

For hourly checks to be meaningful, add the Twelve Data key.

## Notes

- GitHub cron runs in UTC and can start a few minutes late at busy times. The script
  checks the Eastern time itself, so the window is always right.
- Recipients are put in Bcc so they don't see each other's addresses.
- Local test without sending: `pip install pyyaml && python fx_alert.py --dry-run --force`
