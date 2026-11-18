# To-do: get the email alerts running

Tick these off in order. Nothing in this repo should contain an email address or
password: the repo is public, so those only go into **repo secrets**.

Repo secrets page: **Settings → Secrets and variables → Actions → New repository secret**
(https://github.com/AttriPBO8/forex-ticker/settings/secrets/actions)

## 1. Merge the open pull request
- [ ] Merge the open pull request (chart links, rates webpage and this list) into `main`.

## 2. Pick how the emails get sent (do ONE of A or B)

### A. Gmail (sender: your Gmail account)
- [ ] Turn on 2-Step Verification: https://myaccount.google.com/signinoptions/twosv
      (Google hides "App passwords" until this is on. If it still says "setting not
      available", the account may be a work/school account or use only passkeys or a
      security key; use option B instead.)
- [ ] Create an app password: https://myaccount.google.com/apppasswords
      (name it "forex-ticker"; copy the 16 characters, no spaces needed)
- [ ] Add these repo secrets:

  | Secret | Value |
  |---|---|
  | `SMTP_HOST` | `smtp.gmail.com` |
  | `SMTP_PORT` | `587` |
  | `SMTP_USER` | your Gmail address |
  | `SMTP_PASSWORD` | the 16-character app password |

### B. Brevo (free, 300 emails/day, no Google settings needed)
- [ ] Sign up at https://www.brevo.com (free plan).
- [ ] Add and verify your sender address: **Senders, Domains & Dedicated IPs → Senders → Add a sender**
      (use your Gmail address; Brevo emails you a confirmation link).
- [ ] Get SMTP details: **SMTP & API → SMTP tab → Generate a new SMTP key**.
      Note the **Login** shown there (looks like `xxxxxx@smtp-brevo.com`) and the key.
- [ ] Add these repo secrets:

  | Secret | Value |
  |---|---|
  | `SMTP_HOST` | `smtp-relay.brevo.com` |
  | `SMTP_PORT` | `587` |
  | `SMTP_USER` | the Brevo SMTP **Login** |
  | `SMTP_PASSWORD` | the Brevo SMTP key |
  | `MAIL_FROM` | your verified sender address (required for Brevo) |

## 3. Who gets the emails
- [ ] Add repo secret `RECIPIENTS` = recipient address(es), comma separated.

## 4. Optional: rates that move during the day
- [ ] Sign up free at https://twelvedata.com → dashboard → copy the API key.
- [ ] Add repo secret `TWELVEDATA_API_KEY`. (Uses 72 of the 800 free calls/day.)
      Without it, emails use once-a-day European Central Bank rates.

## 5. Test it
- [ ] Go to **Actions → FX rate alerts → Run workflow**, tick **force**, click **Run workflow**.
- [ ] Open the run. A green tick and "Sent ... to 1 recipient(s)" in the log means it worked.
- [ ] Check the recipient inbox (and the spam folder the first time).
- [ ] If it fails, copy the red error lines from the log and send them to Claude.

## 6. Leave it running
- [ ] Nothing else to do. It runs every hour and only emails 7 AM to 7 PM Eastern.
- [ ] To change alert levels, edit `rules:` in `config.yaml` (the webpage uses the same levels).
- [ ] To pause it: **Actions → FX rate alerts → ⋯ → Disable workflow**.

## Rates webpage
- Live page: https://attripbo8.github.io/forex-ticker/ (served by GitHub Pages from `main`).
- [ ] If it shows 404: **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save**,
      wait a minute, then reload.
