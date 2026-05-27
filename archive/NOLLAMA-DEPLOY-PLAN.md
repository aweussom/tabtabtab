# NOLLAMA-DEPLOY-PLAN.md — Production deploy of `nollama.no`

> Step-by-step rollout of the enriched-UG songbook product to the Azure VM at `nollama.no`. The plan is dormant — execute only when the "semi-working backend" trigger fires (see below). Written for future-Tommy or future-Claude/copilot-cli implementation. **[ESCALATE]** markers flag decisions to surface rather than guess.

## TL;DR

Same `nortabs-web` repo, two deploy surfaces:

| Surface | Hosting | URL | Purpose |
|---|---|---|---|
| **NorTabs proper** (existing) | GitHub Pages | https://aweussom.github.io/nortabs-web/ | nortabs.net catalog viewer. Static. No backend. **Unchanged by this plan.** |
| **Nollama** (this plan) | Azure VM (Tommy's free tier) + nginx | https://nollama.no/ | UG-import / personal-bookmark songbook. Same SPA, build-flag enables UG features. Co-hosted with the LLM proxy. |

Same-origin on nollama.no → zero CORS, one cert, one nginx config. Proxy stays bound to `127.0.0.1:8787`; nginx reverse-proxies `/enrich-tab` to it. The Pages deploy is not touched.

## Trigger — when to actually execute this plan

**"Semi-working backend"** is the cutover threshold. Concretely:

- ✅ **Proxy works end-to-end on local Ollama** — already done, validated 2026-05-17 (see `PLAN.md` Phase 2.5).
- ❌ **Client UI for UG-import exists**: drop UG JSON file → batch `POST /enrich-tab` 3-4 in parallel → live progress bar → results land in `nortabs:private-enrichment:v1` → search + browse picks them up. Needed before there's anything worth showing the public.
- ❌ **At least one upstream-LLM choice is committed** (workstation-Qwen3.6-via-Tailscale, or Mimo V2 Pro, or Ollama Cloud). Picking happens at deploy time per `PROXY_API_BASE` env var, but you need *a* choice locked before you announce a URL.

If either of the unchecked items isn't true: defer. The deployment plan is reference material, not a checklist to grind through speculatively.

## Prerequisites (verify before starting)

- [ ] **Domain registered**: `nollama.no` ✓ (already done — 2026-05-25).
- [ ] **Azure VM up**: SSH access works, Tailscale up (used for the optional workstation-LLM upstream).
- [ ] **VM public IP known**: needed for DNS A record. `curl ifconfig.me` from the VM.
- [ ] **Repo cloned on VM**: somewhere stable like `/home/<user>/nortabs-web` or `/opt/nollama`. **[ESCALATE]** Tommy's preference on path layout — home dir is easier; `/opt` is more "production".
- [ ] **Node 24 installed on VM**: via `nvm` (recommended — no sudo, no system Node interference) or NodeSource. Verify with `node --version`.

## Phase 1 — DNS (5 minutes)

At your registrar's DNS control panel (Domeneshop, GoDaddy, wherever `.no` is registered):

```
A     nollama.no        → <VM-public-IP>     TTL 300
A     www.nollama.no    → <VM-public-IP>     TTL 300
```

(IPv6 / AAAA optional — Azure VM probably has an IPv6 address too if you enabled it. Set both for completeness.)

**Verify before continuing**:
```sh
dig nollama.no +short      # should print VM IP
dig www.nollama.no +short  # should print VM IP
```

If propagation is slow, wait 5-15 min. Don't proceed to certbot until both resolve from your laptop — Let's Encrypt validates by hitting the domain itself.

Raise TTL to 3600 or higher once the deploy is stable (after Phase 6).

## Phase 2 — VM-side prep (15 minutes)

Run as the regular SSH user (not root). Use `sudo` where needed.

```sh
# Update + base packages
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx certbot python3-certbot-nginx ufw

# Firewall: open 80/443 only. Proxy port 8787 stays localhost-only.
sudo ufw allow ssh
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status

# Verify nginx serves the default page
curl http://localhost/    # should return nginx welcome HTML
```

**[ESCALATE]** if the VM already has ufw configured for something else — don't blindly `enable` and lock yourself out. Check `sudo ufw status` first.

If Node isn't installed yet:
```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# Reopen shell or `source ~/.bashrc`
nvm install 24
nvm use 24
node --version    # → v24.x.x
```

Clone the repo:
```sh
cd ~
git clone git@github.com:aweussom/nortabs-web.git
cd nortabs-web
```

(Or `https://github.com/...` if SSH key isn't set up on the VM. The repo is public-readable; the deploy only needs read access.)

## Phase 3 — Proxy as a systemd service (15 minutes)

Configure the proxy `.env` for production:

```sh
cd ~/nortabs-web/proxy
cp .env.example .env
nano .env
```

Set these values:
```
PORT=8787
CORS_ORIGINS=https://nollama.no,https://www.nollama.no,http://localhost:8000
PROXY_API_BASE=<see "Upstream LLM choice" below>
PROXY_API_KEY=<see below>
PROXY_MODEL=<see below>
PROXY_TEMPERATURE=0.7
PROXY_TIMEOUT_MS=600000
PROXY_RETRY_ATTEMPTS=3
PROXY_RETRY_BACKOFF_BASE_MS=5000
PROXY_RETRY_BACKOFF_MAX_MS=60000
CACHE_PATH=/var/lib/nollama/enrichment-cache.json
```

Create the cache dir (so the proxy can write to it):
```sh
sudo mkdir -p /var/lib/nollama
sudo chown $USER:$USER /var/lib/nollama
```

Upstream LLM choice — four options. Default is locked in: **Ollama Cloud + `deepseek-v4-flash:cloud`** based on enrich-bench v2 (2026-05-26, see `crawler/bench/COMPARE.md`). Bench v2 dropped the `body[:1200]` truncation cap that hurt v1, and that *single change* leapfrogged Flash from worst-in-v1 to best-in-v2 — see PLAN.md Phase 2.5 "Bench v2 update" for the model-vs-context reversal story.

| Option | `PROXY_API_BASE` | `PROXY_MODEL` | `PROXY_API_KEY` | Cost | Notes |
|---|---|---|---|---|---|
| **Ollama Cloud + DeepSeek-Flash** ← recommended | `https://ollama.com/v1` | `deepseek-v4-flash:cloud` | `<ollama-cloud-key>` | $20/mo flat (Tommy's existing sub, effectively unlimited for this workload) | Always up. Bench v2 winner: 100% schema-compliance, 100% key_phrases hit-rate, 34.8 s mean latency (with full untruncated body), 100% accuracy on `display_suppress` gold-standard tests. Reasoning-variant; hidden internal reasoning tokens are billed (~3-4× visible output) but flat-rate sub absorbs it. Subjectively tighter theme accuracy than the other models — caught "prostitution" on Tecumseh Valley where Pro/Nemotron said "loss". |
| Ollama Cloud + Nemotron (fallback) | `https://ollama.com/v1` | `nemotron-3-super:cloud` | `<ollama-cloud-key>` | same sub | 100% / 100% / 47.6 s — co-equal on the v2 quality gates but ~27% slower and 60% more verbose than Flash. Solid fallback when Flash has an outage. |
| Workstation Qwen3.6 via Tailscale | `http://<workstation-tailscale-ip>:11434/v1` | `qwen3.6:latest` | (empty) | $0 | Functionally equivalent to qwen3.5:cloud per Tommy. Works only when workstation is on + Ollama running. Tailscale handles auth + encryption. Keep as last-ditch fallback. |
| Mimo V2 Pro | `https://api.mimo.xiaomi.com/v1` | `mimo-v2-pro` | `<mimo-key>` | $16/mo dedicated | Untested in bench. Best candidate for Norwegian content — but UG is ~99.9% English, so not relevant for this path. |

Not recommended (bench v2 losers): `deepseek-v4-pro:cloud` (92% kp hit-rate — caught 3/5 phrases on Hallelujah where the others got 5/5) and `qwen3.5:cloud` (149 s mean latency = ~4× Flash, no quality edge to compensate).

**Body preprocessing prerequisite** (PLAN.md Phase 2.5 "Body preprocessing before LLM"): before deploying to prod, implement the shared `lyrics_only(body)` helper. The bench measured raw-body input, which already gave Nemotron 100% key_phrases hit-rate; preprocessing should only *improve* this, especially for tabs like Passenger's *Let Her Go* where DeepSeek-Pro returned 0 phrases because the truncated body had no actual lyrics yet.

Now create the systemd unit. `sudo nano /etc/systemd/system/nollama-proxy.service`:

```ini
[Unit]
Description=Nollama enrichment proxy (Phase 2.5)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<your-ssh-user>
WorkingDirectory=/home/<your-ssh-user>/nortabs-web/proxy
ExecStart=/home/<your-ssh-user>/.nvm/versions/node/v24.X.X/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nollama-proxy

[Install]
WantedBy=multi-user.target
```

Replace `<your-ssh-user>` and `v24.X.X`. Find the exact Node path with `which node` after `nvm use 24`.

```sh
sudo systemctl daemon-reload
sudo systemctl enable nollama-proxy
sudo systemctl start nollama-proxy
sudo systemctl status nollama-proxy   # should be "active (running)"

# Verify proxy responds locally
curl http://127.0.0.1:8787/health
# → {"status":"ok","mode":"real","model":"...","cache_entries":0}

# Tail logs if something's wrong
journalctl -u nollama-proxy -f
```

## Phase 4 — nginx config (10 minutes)

`sudo nano /etc/nginx/sites-available/nollama.no`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name nollama.no www.nollama.no;

    # Allow Let's Encrypt HTTP-01 challenge through; certbot rewrites this
    # block to add the HTTPS redirect after cert issuance.
    root /home/<your-ssh-user>/nortabs-web;
    index index.html;

    # SPA: hash-routed, no server-side rewrites needed. /enrich-tab is
    # NOT a path the SPA uses (hash routes only), so we can safely
    # claim it for the proxy.
    location /enrich-tab {
        proxy_pass http://127.0.0.1:8787/enrich-tab;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # UG tab bodies can be 10-50 KB; cap at 1 MB to be defensive.
        client_max_body_size 1m;

        # Long timeout — Qwen3.6 cold-call takes ~24 s, batch concurrency
        # of 3-4 plus retries can push individual responses to ~60 s.
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
    }

    location /health {
        proxy_pass http://127.0.0.1:8787/health;
        access_log off;
    }

    # DELETE /cache/<key> is dev-only — disabled in production by
    # NODE_ENV=production. nginx also rejects it just in case.
    location /cache/ {
        return 403;
    }

    # Everything else: static files from the repo root.
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Gzip for text-heavy responses (JSON catalog/enrichment, JS, HTML).
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types application/json application/javascript text/css text/html image/svg+xml;

    # Cache static assets aggressively — they're already cache-busted by
    # ?v=${APP_VERSION} in the URLs the SPA fetches.
    location ~* \.(js|css|svg|woff2?|ttf)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

Enable + test:
```sh
sudo ln -s /etc/nginx/sites-available/nollama.no /etc/nginx/sites-enabled/
sudo nginx -t      # syntax check
sudo systemctl reload nginx

# Verify HTTP works (HTTPS comes in Phase 5)
curl http://nollama.no/health
# → {"status":"ok",...}
```

**[ESCALATE]** if the SPA serves an `#/import/ug` route specifically as the landing page on nollama.no (vs the catalog browser landing on aweussom.github.io). May need a redirect or a separate `index.html` variant. See "Build-time vs runtime feature flag" below.

## Phase 5 — HTTPS via Let's Encrypt (5 minutes)

```sh
sudo certbot --nginx -d nollama.no -d www.nollama.no
```

Follow the prompts:
- Email: `tommy.leonhardsen@q-free.com` (or personal)
- Agree to ToS: yes
- Share email with EFF: optional (recommend no, keeps inbox quiet)
- Redirect HTTP → HTTPS: **yes** (option 2)

Certbot edits `/etc/nginx/sites-available/nollama.no` to add the HTTPS server block + redirect. Verify:

```sh
sudo nginx -t
sudo systemctl reload nginx

curl -I https://nollama.no/health   # should be 200 OK with valid TLS
curl -I http://nollama.no/health    # should be 301 → https
```

Auto-renewal: certbot installs a systemd timer (`certbot.timer`) that runs twice daily. Verify:
```sh
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run   # simulate renewal, should succeed
```

## Phase 6 — Build-time vs runtime feature flag

The same `nortabs-web` repo serves two surfaces (Pages = catalog only; nollama.no = catalog + UG import). The simplest way to handle this is **runtime detection** based on `location.host`:

```js
// In app.js or a new feature-flags.js module:
export const FLAVOR = (
  location.host.endsWith('nollama.no') ? 'nollama' :
  location.host.endsWith('github.io')  ? 'pages'   :
  'dev'   // localhost during development
);

export const ENABLE_UG_IMPORT = FLAVOR === 'nollama' || FLAVOR === 'dev';
export const PROXY_BASE = (
  FLAVOR === 'nollama' ? '' :              // same-origin, just /enrich-tab
  FLAVOR === 'dev'     ? 'http://localhost:8787' :
  null                                     // pages: no proxy access
);
```

UG-import UI (`#/import/ug` route, drop-zone, etc.) checks `ENABLE_UG_IMPORT` and renders accordingly. Pages-served catalog viewer never sees the UG-import surface at all.

**[ESCALATE]** if Tommy wants build-time stripping instead — e.g. minifier removes dead UG-import code on the Pages build to keep the bundle smaller. For now, runtime is simpler and the dead code is small.

## Phase 7 — Smoke test (10 minutes)

Once HTTPS is live:

1. Open https://nollama.no/ in a browser. Catalog viewer loads (same as Pages). Network panel: no errors.
2. Navigate to `#/import/ug` (the route that should exist once the UG-import UI is built per the trigger condition).
3. Drop a UG JSON export. Watch the progress bar fire.
4. Check `journalctl -u nollama-proxy -f` on the VM — should see `[enrich] <artist> / <song> :: MISS (...)` log lines.
5. After enrichment completes, search by lyric phrase. Verify private tabs come up.
6. Open https://nollama.no/health and check `cache_entries` increased.
7. Reload the page; the previously-enriched tabs should be cached (or in localStorage, depending on what the client UI stores).

**Mobile check**: same steps on iPhone Safari + Android Chrome. iOS PWA install (Add to Home Screen) optional but nice — would need a manifest.json which is `PLAN.md` Phase 4 territory.

## Phase 8 — Deploy iteration after initial launch

For SPA updates (JS/CSS changes):
```sh
ssh <vm-user>@nollama.no
cd ~/nortabs-web
git pull
# Done. nginx serves from disk; no restart needed.
```

For proxy updates (anything under `proxy/`):
```sh
ssh <vm-user>@nollama.no
cd ~/nortabs-web
git pull
sudo systemctl restart nollama-proxy
journalctl -u nollama-proxy -n 50   # verify it came back up
```

**Optional automation**: a GitHub Action that SSHes to the VM and runs the pull+restart on push to a specific branch (e.g. `nollama-prod`). Adds an SSH deploy key as a repo secret. Worth it once the iteration tempo is high enough that manual pulls feel like friction. Not at launch time.

## Phase 9 — Update the proxy's CORS allowlist (1 minute)

After Phase 8, edit `proxy/.env`:
```
# Was:
CORS_ORIGINS=https://aweussom.github.io,http://localhost:8000

# New:
CORS_ORIGINS=https://nollama.no,https://www.nollama.no,http://localhost:8000
```

Drop `aweussom.github.io` — Pages never calls the proxy in the new architecture.

This is also worth committing into `.env.example` for clarity, and removing `https://aweussom.github.io` from the example. **Note**: don't commit `.env` itself (it's gitignored).

## Things deliberately out of scope (v1)

Each of these is mentioned in `PLAN.md` Phase 2.5 "Known deferred items" — pinned here so the launch stays small:

- **Magic-link auth / per-user rate limits**: shared-key cost is zero at PoC stage. Add when abuse or cost becomes real.
- **Per-user quotas at the proxy**: same.
- **Observability beyond `journalctl`**: add Grafana/Loki/whatever when traffic is non-zero.
- **CDN in front (Cloudflare etc.)**: no benefit at PoC scale; adds DNS complexity and another control surface to remember.
- **PWA / service worker on nollama.no**: NorTabs proper has SW; nollama.no doesn't need it at launch. Consider for Phase 4-equivalent if iOS users want offline access.
- **`robots.txt` and search-engine indexing policy**: **[ESCALATE]** Tommy's call — recommend `Disallow: /` initially to stay quiet while iterating, lift when ready for discoverability.
- **Privacy policy + terms**: low priority at PoC, but the moment a non-friend user is invited, draft something simple. The "transient bodies, only metadata persisted" architecture (per `PLAN.md` Phase 2.5 "Architecture principle") is the legal moat — write it down.

## Decisions Tommy or future-Claude must NOT make alone

- **Upstream LLM choice** (Phase 3, see table above). Cost/availability trade-off.
- **VM path layout**: home dir vs `/opt` vs `/var/www`. Affects systemd unit `WorkingDirectory` paths everywhere.
- **`robots.txt` + indexing policy**: when is this "public enough" for SEO to be useful?
- **Cutover trigger**: is the UG-import UI "semi-working enough"? Don't deploy a broken first impression.
- **Tampering with the existing Pages deploy**: this plan deliberately does NOT touch `aweussom.github.io/nortabs-web/`. If anything proposes changes there, escalate.

## Failure modes + recovery

| What broke | Symptom | Recovery |
|---|---|---|
| Proxy crashed | `502 Bad Gateway` from `/enrich-tab` (nginx → dead upstream) | `systemctl restart nollama-proxy`; check `journalctl -u nollama-proxy` for the cause. SPA itself still served fine — only enrichment is broken. |
| nginx crashed | Whole site down | `systemctl restart nginx`. Check `nginx -t` for syntax issues if it won't restart. |
| Cert expired | Browser TLS warning | certbot.timer should auto-renew, but if it failed: `sudo certbot renew && systemctl reload nginx`. Investigate `journalctl -u certbot` for why renewal failed. |
| DNS broke | Domain doesn't resolve | Registrar control panel. Low TTL means recovery is fast. |
| VM down | Total outage | Out of scope; failover requires multi-VM setup. Accept the trade-off at PoC scale. |
| Workstation-LLM down (if using that upstream) | Enrichment fails, `502` from `/enrich-tab` | Switch `PROXY_API_BASE` to a hosted upstream (Mimo / Ollama Cloud) and restart proxy. Pre-record the swap commands in a "break-glass" note for future-Tommy. |

## Cost projection (rough)

- VM: $0 (Azure free tier, already running)
- Domain: ~50-100 NOK/year (already paid)
- TLS: $0 (Let's Encrypt)
- LLM:
  - Workstation Qwen3.6: $0 (electricity ≈ a few øre per enrichment)
  - Mimo V2 Pro: $16/mo flat (≈ 150 NOK/mo)
  - Ollama Cloud: $0 free tier or pay-as-you-go after limits
- Total monthly: $0-16 depending on upstream choice. Acceptably low for a PoC.

## Acceptance criteria

Mark the deploy "done" when:

- [ ] https://nollama.no/ loads the SPA (with UG-import features visible)
- [ ] https://nollama.no/health returns `200 OK` with proxy mode + model
- [ ] One full UG-import flow (drop JSON → enrich 10+ tabs → search them) completes successfully end-to-end
- [ ] HTTPS cert is valid + auto-renewal verified via `certbot renew --dry-run`
- [ ] `journalctl -u nollama-proxy --since "1 hour ago"` shows no errors during the test flow
- [ ] Pages deploy at aweussom.github.io/nortabs-web/ is unchanged and still works (regression check)
- [ ] Tommy has SSH access + a one-page "how to deploy a fix" note saved somewhere findable (could be a `DEPLOY-CHEATSHEET.md` in the repo root)

## File layout (what gets added/changed by this plan)

On the **VM**:
```
/home/<user>/nortabs-web/        # git clone
/var/lib/nollama/                # cache directory
  └─ enrichment-cache.json       # written by the proxy
/etc/nginx/sites-available/nollama.no    # nginx config
/etc/systemd/system/nollama-proxy.service # systemd unit
/etc/letsencrypt/live/nollama.no/        # TLS cert
```

In the **repo** (this plan triggers these edits, executed via PRs):
```
proxy/.env.example               # CORS_ORIGINS updated
app.js (or feature-flags.js)     # runtime FLAVOR detection
views/import-ug.js               # new — UG-import drop-zone UI
```

No file deletions, no migrations. The existing Pages deploy continues unaffected because all the changes are additive + behind the `FLAVOR === 'nollama'` flag.
