# Phase 7: Infrastructure Deployment Guide

## Overview

This document outlines the production deployment strategy for the Arbitrage Agents system using a **VPS-based approach** with Docker Compose. This is more cost-effective and simpler than cloud-managed services (AWS RDS, ECS, etc.) for our current workload.

## Architecture Decision: VPS vs Cloud Services

### Why VPS?

| Factor | VPS | AWS/Cloud |
|--------|-----|-----------|
| **Monthly Cost** | $10-20 | $50-150+ |
| **Setup Complexity** | Low (Docker Compose) | High (IAM, VPC, security groups) |
| **Maintenance** | Simple | Complex |
| **Scalability** | Vertical (upgrade VPS) | Horizontal (auto-scaling) |
| **Best For** | Low-medium traffic, scheduled workloads | High traffic, 99.9% SLA requirements |

### When to Migrate to Cloud

- Need 99.9%+ uptime guarantees
- Multi-region deployment required
- Auto-scaling for unpredictable traffic
- Compliance requirements (SOC2, HIPAA)

## Deployment Architecture

```
┌────────────────────────────────────────────┐
│         VPS ($10-20/mo)                    │
│  (DigitalOcean, Linode, Hetzner, etc.)     │
│                                            │
│  ┌──────────────────────────────────────┐ │
│  │  Docker Compose                      │ │
│  │                                      │ │
│  │  ┌──────────┐   ┌─────────────────┐ │ │
│  │  │ API      │   │ Worker          │ │ │
│  │  │ :3000    │   │ (scheduled)     │ │ │
│  │  └────┬─────┘   └────┬────────────┘ │ │
│  │       └───────┬──────┘              │ │
│  │               │                     │ │
│  │       ┌───────▼───────┐            │ │
│  │       │ PostgreSQL    │            │ │
│  │       │ :5432         │            │ │
│  │       └───────────────┘            │ │
│  └──────────────────────────────────────┘ │
│                                            │
│  ┌──────────────────────────────────────┐ │
│  │  Nginx (reverse proxy + HTTPS)       │ │
│  │  :80, :443                           │ │
│  └──────────────────────────────────────┘ │
│                                            │
│  External Services:                        │
│  - Sentry (observability) ✅              │
│  - GitHub Actions (CI/CD)                 │
│  - Uptime Robot (SLO monitoring)          │
└────────────────────────────────────────────┘
```

## Prerequisites

1. **VPS Requirements**
   - 2 CPU cores minimum
   - 4GB RAM minimum
   - 40GB SSD storage
   - Ubuntu 22.04 or 24.04 LTS

2. **Domain Name** (optional but recommended for HTTPS)

3. **Sentry Production Project**
   - Already integrated in codebase
   - Create production project at sentry.io
   - Add DSN to `.env`

## Deployment Steps

The table below is the canonical, up-to-date sequence for the **`main`** branch.
It reflects the Postgres pool centralization (PR #35: a single shared `DatabaseModule`
owns the connection pool and its lifetime, imported once by `ApiAppModule` and
`WorkerAppModule`), the worker scan loop + graceful shutdown (PR #27 / #31), and the
`PaperTradeSimulator` wired into production scanner DI (PR #32). The
`docker-compose.yml` stack runs three services: `postgres`, `api`, `worker`.

> **One-line automated path:** `sudo bash scripts/deploy.sh` performs Steps 2–8
> interactively. The table below documents what it does so you can also run
> the steps by hand.

| # | Step | Command / Action | Notes for `main` |
|---|------|-------------------|------------------|
| 1 | **Provision VPS** | Choose DigitalOcean / Linode / Hetzner / Vultr ($10–20/mo). 2 vCPU, 4GB RAM, 40GB SSD, Ubuntu 22.04/24.04 LTS. | 8 GB VPS recommended — compose memory budget is postgres 1536M + api 1536M + worker 3G. |
| 2 | **Install Docker** | `ssh ubuntu@<vps>` → `sudo curl -fsSL https://get.docker.com \| sudo sh` → `sudo apt-get install -y docker-compose-plugin` → `sudo usermod -aG docker ubuntu` → **log out/in** → verify `docker --version` and `docker compose version` (no `sudo` needed). | Installs with `sudo` under the unprivileged `ubuntu` account; adding `ubuntu` to the `docker` group lets daily `docker compose` ops run without `sudo`. `scripts/deploy.sh` (run via `sudo bash`) also performs this `usermod` step. |
| 3 | **Clone repository (`main`)** | `mkdir -p /opt/arbitrage-agents && cd /opt/arbitrage-agents` → `git clone https://github.com/<user>/arbitrage-agents.git .` → `git checkout main`. | **Deploy from `main`**, not the old `phase-7-deploy` branch. |
| 4 | **Configure environment** | `cp .env.example .env` → `nano .env` → `chmod 600 .env && chown ubuntu:ubuntu .env`. | **Required:** `DB_PASSWORD` (strong), `SENTRY_DSN`. See env var table below. Owner must be the operator (`ubuntu`) who runs `docker compose` non-root (Step 2) — `docker compose` reads `.env` via the CLI process as that user, so `root:root` + 600 would make it unreadable and break `up`/migrate/backup. |
| 5 | **Deploy with Docker Compose** | `docker compose up -d --build` → `docker compose ps` → `docker compose logs -f`. | Services: `postgres` (health-gated), `api` (:3000, localhost-only), `worker`. API/worker both depend on `postgres` healthy. |
| 6 | **Run database migrations** | `docker compose exec api npm run db:migrate` (or `docker compose exec -T api npm run db:migrate` for non-interactive runs). | Runs `drizzle-kit migrate` against `DATABASE_URL`. Pool is created by the shared `DatabaseModule`. |
| 7 | **Set up Nginx reverse proxy (HTTPS)** | `apt-get install -y nginx certbot python3-certbot-nginx` → create `/etc/nginx/sites-available/arbitrage-api` (proxy to `localhost:3000`) → `ln -s …/sites-enabled/` → `nginx -t && systemctl reload nginx` → `certbot --nginx -d api.yourdomain.com`. | API binds `127.0.0.1:3000`; Nginx is the public edge. `nginx/arbitrage-api.conf` is in the repo. |
| 8 | **Set up automated backups** | Create `/opt/arbitrage-agents/backup.sh` (sources `.env` so `$DB_USER`/`$DB_NAME` are set under cron), running `docker compose exec -T postgres pg_dump -U $DB_USER $DB_NAME > /opt/backups/.../db_$(date +%Y%m%d_%H%M%S).sql`, retain 7 days; add `0 2 * * *` crontab entry. | Backs up the `postgres` container via `pg_dump`. The script must `source .env` — cron runs with a minimal env, so without it `$DB_USER`/`$DB_NAME` are empty and `pg_dump` fails. |

### Environment variables for Step 4 (`main` branch)

From `.env.example` + `docker-compose.yml`. Variables marked **required** must be
set before `docker compose up`.

| Variable | Used by | Default | Required for prod | Notes |
|----------|---------|---------|-------------------|-------|
| `DB_USER` | compose (postgres init) | `arbitrage_user` | — | Postgres role. |
| `DB_NAME` | compose (postgres init) | `arbitrage` | — | Postgres database. |
| `DB_PASSWORD` | compose (postgres + `DATABASE_URL`) | _(empty)_ | **Yes** | Strong password. |
| `API_PORT` | compose (api port) | `3000` | — | Bound to `127.0.0.1`. |
| `DATABASE_URL` | app (both api + worker) | `postgres://postgres:postgres@localhost:5432/arbitrage_agents` | **Yes** | In compose, constructed from `DB_USER`/`DB_PASSWORD`/`DB_NAME`. |
| `SENTRY_DSN` | api + worker | _(empty)_ | **Yes** | Observability. |
| `SENTRY_MONITOR_SLUG` | worker | `arbitrage-agents-scan` | — | Sentry monitor slug. |
| `SENTRY_TRACES_SAMPLE_RATE` | api + worker | `0` | — | 0 = no traces (free tier). |
| `LLM_ENABLED` | scanner | `false` | — | Enable LLM-assisted market matching. |
| `LLM_BASE_URL` | scanner | `http://host.docker.internal:11434/api/chat` | — | Ollama-compatible endpoint. |
| `LLM_MODEL` | scanner | `glm-5.2:cloud` | — | Model id. |
| `LLM_PROVIDER` | scanner | `ollama` | — | Provider label. |
| `WORKER_SCAN_INTERVAL_MINUTES` | worker | `15` | — | Clamped to `[1, 1440]` (PR #31). |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | worker | `30000` | — | Bounded graceful-shutdown wait (PR #27). |
| `OLLAMA_BASE_URL` / `DASHSCOPE_API_KEY` / `OPENROUTER_API_KEY` | compose legacy passthrough | — | — | Not read by app; kept for backward compat. |

> The old `VENUE_A_API_KEY` / `VENUE_B_API_KEY` vars in prior versions of this
> doc are **not** part of the current `.env.example` — drop them unless you wire
> venue-specific auth yourself.

### Inline reference commands (Step 2 / Step 5 / Step 6 / Step 8)

```bash
# Step 2 — Install Docker (as ubuntu, with sudo)
ssh ubuntu@<vps>
sudo curl -fsSL https://get.docker.com | sudo sh
sudo apt-get install -y docker-compose-plugin
sudo usermod -aG docker ubuntu
# log out and back in so the new group takes effect, then:
docker --version && docker compose version   # works without sudo
```

```bash
# Step 5 — Deploy
docker compose up -d --build
docker compose ps
docker compose logs -f api
docker compose logs -f worker
```

```bash
# Step 6 — Migrate
docker compose exec api npm run db:migrate
```

```bash
# Step 7 — Nginx config
cat > /etc/nginx/sites-available/arbitrage-api <<'EOF'
server {
    listen 80;
    server_name api.yourdomain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF
ln -s /etc/nginx/sites-available/arbitrage-api /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d api.yourdomain.com
```

```bash
# Step 8 — Backup script + cron
cat > /opt/arbitrage-agents/backup.sh <<'EOF'
#!/bin/bash
set -e

BACKUP_DIR="/opt/backups/arbitrage-agents"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# Source environment so $DB_USER / $DB_NAME are set. cron runs this script with
# a minimal environment (no .env), so without sourcing, those vars are empty
# and pg_dump fails ("role \"\" does not exist"). docker compose loads .env for
# the *container*, but $DB_USER/$DB_NAME here are expanded by the cron shell.
source /opt/arbitrage-agents/.env

# Run from the app dir so `docker compose` finds docker-compose.yml.
cd /opt/arbitrage-agents
docker compose exec -T postgres pg_dump -U $DB_USER $DB_NAME > $BACKUP_DIR/db_$TIMESTAMP.sql

# Keep only last 7 days of backups
find $BACKUP_DIR -name "db_*.sql" -mtime +7 -delete

echo "Backup completed: $TIMESTAMP"
EOF
chmod +x /opt/arbitrage-agents/backup.sh
crontab -l | { cat; echo "0 2 * * * /opt/arbitrage-agents/backup.sh >> /var/log/arbitrage-backup.log 2>&1"; } | crontab -
```

## Service Management

### View Logs

```bash
# All services
docker compose logs -f

# API only
docker compose logs -f api

# Worker only
docker compose logs -f worker

# Last 100 lines
docker compose logs --tail=100 api
```

### Restart Services

```bash
# Restart API
docker compose restart api

# Restart Worker
docker compose restart worker

# Restart PostgreSQL
docker compose restart postgres
```

### Update Deployment

```bash
# Pull latest changes
git pull origin main

# Rebuild and restart
docker compose up -d --build

# Run new migrations (if any)
docker compose exec api npm run db:migrate
```

## Monitoring & SLOs

### Sentry Monitoring

- **Error Tracking**: Automatically captured by Sentry SDK
- **Performance Monitoring**: Transaction tracing enabled
- **Release Tracking**: Tag releases with git SHA

```bash
# Create Sentry release
export SENTRY_AUTH_TOKEN=<your-token>
export SENTRY_PROJECT=arbitrage-agents
export SENTRY_ORG=your-org

sentry-cli releases new $(git rev-parse HEAD)
sentry-cli releases set-commits $(git rev-parse HEAD) --auto
sentry-cli releases finalize $(git rev-parse HEAD)
```

### SLO Monitoring

| SLO | Target | Monitoring Method |
|-----|--------|-------------------|
| **API Availability** | 99.5% uptime | Uptime Robot / Pingdom |
| **Scan Success Rate** | >95% | Sentry custom metrics |
| **Scan Latency (p95)** | <5 minutes | Sentry transaction traces |
| **Database Uptime** | 99.9% | Docker health checks |
| **Error Rate** | <1% requests | Sentry error tracking |

### Health Checks

```bash
# API health endpoint
curl http://localhost:3000/health

# Database connectivity
docker compose exec postgres pg_isready -U $DB_USER

# Check all containers running
docker compose ps
```

## Secret Management

### Current Approach: Environment Variables

For VPS deployment, we use `.env` file with strict file permissions:

```bash
# Restrict access to .env file. Owner is the operator (e.g. ubuntu) who runs
# `docker compose` non-root — `docker compose` reads .env via the CLI process
# as that user, so root:root + 600 would make it unreadable and break
# `up`/migrate/backup. Mode 600 keeps it unreadable by other system users.
chmod 600 /opt/arbitrage-agents/.env
chown ubuntu:ubuntu /opt/arbitrage-agents/.env
```

### Future: Upgrade to Vault (if needed)

If you need more sophisticated secret management:
- **HashiCorp Vault**: Self-hosted on VPS
- **AWS Secrets Manager**: Migrate to AWS
- **Doppler**: Cloud secret management ($0-20/mo)

## Troubleshooting

### Common Issues

**1. Database connection refused**
```bash
# Check PostgreSQL is running
docker compose ps postgres

# Check logs
docker compose logs postgres

# Verify credentials
docker compose exec postgres psql -U $DB_USER -d $DB_NAME -c "SELECT 1"
```

**2. API not starting**
```bash
# Check logs
docker compose logs api

# Common issues:
# - Missing environment variables
# - Database not ready (add depends_on)
# - Port already in use
```

**3. Worker not executing scans**
```bash
# Check worker logs
docker compose logs worker

# Verify environment
docker compose exec worker env | grep SCAN

# Manually trigger scan (if endpoint exists)
curl -X POST http://localhost:3000/api/scans/trigger
```

**4. Out of memory**
```bash
# Check memory usage
free -h
docker stats

# Increase VPS RAM or optimize services
```

### Emergency Procedures

**Full System Restart**
```bash
docker compose down
docker compose up -d
docker compose exec api npm run db:migrate
```

**Database Recovery from Backup**
```bash
# Stop API and Worker
docker compose stop api worker

# Restore database
docker compose exec -T postgres psql -U $DB_USER -d $DB_NAME < backup.sql

# Restart services
docker compose start api worker
```

## Cost Estimation

### Monthly Costs (VPS Approach)

| Component | Cost |
|-----------|------|
| **VPS (2 core, 4GB RAM)** | $10-20 |
| **Domain Name** | $1-2 |
| **Sentry (Team Plan)** | $26 (or free tier) |
| **Uptime Robot** | Free |
| **Total** | **$11-48/mo** |

### Monthly Costs (AWS Equivalent)

| Component | Cost |
|-----------|------|
| **ECS (Fargate)** | $15-30 |
| **RDS (PostgreSQL)** | $15-50 |
| **Load Balancer** | $15-20 |
| **Sentry** | $26 |
| **CloudWatch** | $5-10 |
| **Total** | **$76-136/mo** |

**Savings with VPS: ~$65-90/month (70-85% cheaper)**

## Next Steps

1. ✅ Deploy to VPS with Docker Compose
2. ✅ Set up HTTPS with Let's Encrypt
3. ✅ Configure automated backups
4. ✅ Set up monitoring (Sentry + Uptime Robot)
5. 📋 Define SLOs and alerting thresholds
6. 📋 Load test API under production traffic
7. 📋 Document runbook for common operations

## Rollback Plan

If issues arise after deployment:

```bash
# Revert to previous version
git checkout <previous-commit>

# Rebuild and restart
docker compose up -d --build

# Verify health
curl http://localhost:3000/health
docker compose logs -f
```
