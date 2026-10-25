# Deploying June-hosts on a VPS

End-to-end: Ubuntu 24.04 VPS → Postgres → Node 24 → this monorepo → nginx + TLS.
The API server also serves the built frontend, so one process runs everything.

Verified flow (schema push, boot, `/api/healthz`, static frontend) against a
fresh Postgres — follow in order.

---

## 0. Requirements

| Thing | Version |
|---|---|
| VPS | Ubuntu 22.04/24.04, 1 vCPU / 1 GB RAM is enough to start |
| Node.js | **24.x** (the repo enforces `>=24 <25`) |
| pnpm | 11.x (`corepack` picks the exact version from `packageManager`) |
| PostgreSQL | 14+ (16 recommended) — local or managed (Neon, Supabase, RDS…) |
| Domain | A record pointing at the VPS IP (for TLS + OAuth + Paystack) |

---

## 1. Server prep

```bash
sudo apt update && sudo apt -y upgrade
sudo ufw allow OpenSSH
sudo ufw allow "Nginx Full"
sudo ufw enable
```

## 2. Node 24 + pnpm

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable
corepack prepare pnpm@11.15.0 --activate
node -v   # v24.x
pnpm -v   # 11.15.0
```

## 3. PostgreSQL (skip if you use a managed DB)

```bash
sudo apt install -y postgresql
sudo -u postgres psql <<'SQL'
CREATE USER junex WITH PASSWORD 'CHANGE_ME_STRONG';
CREATE DATABASE junex OWNER junex;
SQL
```

Your `DATABASE_URL` becomes
`postgres://junex:CHANGE_ME_STRONG@127.0.0.1:5432/junex`.

## 4. App install

```bash
git clone https://github.com/eminentboy11/June-hosts.git /opt/junex
cd /opt/junex

cp .env.example .env
nano .env          # fill in DATABASE_URL, SESSION_SECRET, PAYSTACK_SECRET_KEY, …

pnpm install --frozen-lockfile
pnpm run build                     # typecheck + frontend + api-server
pnpm --filter @workspace/db push   # create/update the DB schema
```

`SESSION_SECRET`: `openssl rand -hex 32`.

Smoke-test before wiring systemd:

```bash
set -a; source .env; set +a
pnpm --filter @workspace/api-server start
# in another terminal:
curl http://127.0.0.1:8080/api/healthz   # {"status":"ok"}
```

## 5. systemd service

`sudo nano /etc/systemd/system/junex.service`:

```ini
[Unit]
Description=June-hosts platform
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/junex
EnvironmentFile=/opt/junex/.env
ExecStart=/usr/bin/pnpm --filter @workspace/api-server start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo chown -R www-data:www-data /opt/junex
sudo systemctl daemon-reload
sudo systemctl enable --now junex
sudo systemctl status junex     # should be active (running)
```

> If pnpm is not at `/usr/bin/pnpm`, find it with `which pnpm` (corepack shims
> it into the Node install directory) and use that full path in `ExecStart`.

## 6. nginx + TLS

`sudo nano /etc/nginx/sites-available/junex`:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    client_max_body_size 5m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/junex /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

## 7. External services

**Paystack** (Dashboard → Settings → API Keys & Webhooks):
- Secret key → `PAYSTACK_SECRET_KEY` in `.env`
- Webhook URL → `https://yourdomain.com/api/payments/webhook`
  (Paystack allows **one** webhook URL per account. The wallet auto-credit
  webhook at `/api/wallet/webhook` cannot also be registered — wallet top-ups
  still settle through the verify endpoint when the user returns from checkout,
  so nothing breaks.)

**Google OAuth** (console.cloud.google.com → Credentials):
- Authorized redirect URI: `https://yourdomain.com/api/auth/google/callback`
- Client ID/secret → `.env`

**GitHub OAuth** (github.com/settings/developers):
- Authorization callback URL: `https://yourdomain.com/api/auth/github/callback`
- Client ID/secret → `.env`

OAuth is optional — email/password auth works without it.

## 8. Updates

```bash
cd /opt/junex
sudo -u www-data git pull
sudo -u www-data pnpm install --frozen-lockfile
sudo -u www-data pnpm run build
sudo -u www-data pnpm --filter @workspace/db push   # when schema changed
sudo systemctl restart junex
```

## 9. Backups

Nightly Postgres dump, keep 7 days:

```bash
sudo crontab -e
# add:
0 2 * * * pg_dump -U junex junex | gzip > /var/backups/junex-$(date +\%F).sql.gz && find /var/backups -name 'junex-*.gz' -mtime +7 -delete
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `PORT environment variable is required` | `.env` not loaded — start via systemd (`EnvironmentFile`) or `set -a; source .env` |
| `SESSION_SECRET must be set in production` | fill `SESSION_SECRET` in `.env` |
| `DATABASE_URL, ensure the database is provisioned` | DB step 3 not done, or wrong URL |
| Boot loops at `loadSettingsFromDb` | Postgres not reachable from the VPS (check `pg_hba.conf` / firewall / managed-DB allowlist) |
| OAuth redirect mismatch | callback URL must be exactly `https://yourdomain.com/api/auth/{google,github}/callback` |
| Paystack webhook 401 in logs | signature check working as designed — make sure the dashboard webhook secret/URL is right and the body is not being proxied/re-encoded |
