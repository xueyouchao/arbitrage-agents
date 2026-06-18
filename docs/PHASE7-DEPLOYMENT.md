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

### Step 1: Provision VPS

Choose a provider:
- **DigitalOcean**: Droplet ($10-20/mo)
- **Linode**: Nanode/Linode ($10-20/mo)
- **Hetzner**: Cloud VM (€4-8/mo, excellent value)
- **Vultr**: Compute ($10-20/mo)

### Step 2: Install Docker

```bash
# SSH into VPS
ssh root@your-vps-ip

# Install Docker
curl -fsSL https://get.docker.com | sh

# Install Docker Compose
apt-get install -y docker-compose-plugin

# Verify installation
docker --version
docker compose version
```

### Step 3: Clone Repository

```bash
# Create deployment directory
mkdir -p /opt/arbitrage-agents
cd /opt/arbitrage-agents

# Clone repository
git clone https://github.com/your-username/arbitrage-agents.git .
git checkout phase-7-deploy
```

### Step 4: Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit with production values
nano .env
```

**Required Environment Variables:**

```env
# Database
DB_USER=arbitrage_user
DB_PASSWORD=<strong-password>
DB_NAME=arbitrage

# Sentry
SENTRY_DSN=https://<key>@sentry.io/<project-id>

# API Configuration
API_PORT=3000
NODE_ENV=production

# Worker Configuration
WORKER_SCAN_INTERVAL_MINUTES=15

# Venue API Keys (if needed)
VENUE_A_API_KEY=<key>
VENUE_B_API_KEY=<key>
```

### Step 5: Deploy with Docker Compose

```bash
# Build and start all services
docker compose up -d --build

# Check status
docker compose ps

# View logs
docker compose logs -f

# View specific service logs
docker compose logs -f api
docker compose logs -f worker
```

### Step 6: Run Database Migrations

```bash
# Run migrations inside the API container
docker compose exec api npm run db:migrate
```

### Step 7: Set Up Nginx Reverse Proxy (HTTPS)

```bash
# Install Nginx
apt-get install -y nginx certbot python3-certbot-nginx

# Create Nginx configuration
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

# Enable site
ln -s /etc/nginx/sites-available/arbitrage-api /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx

# Get SSL certificate
certbot --nginx -d api.yourdomain.com
```

### Step 8: Set Up Automated Backups

```bash
# Create backup script
cat > /opt/arbitrage-agents/backup.sh <<'EOF'
#!/bin/bash
BACKUP_DIR="/opt/backups/arbitrage-agents"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# Backup PostgreSQL
docker compose exec -T postgres pg_dump -U $DB_USER $DB_NAME > $BACKUP_DIR/db_$TIMESTAMP.sql

# Keep only last 7 days of backups
find $BACKUP_DIR -name "db_*.sql" -mtime +7 -delete

echo "Backup completed: $TIMESTAMP"
EOF

chmod +x /opt/arbitrage-agents/backup.sh

# Add to crontab (daily at 2 AM)
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
# Restrict access to .env file
chmod 600 /opt/arbitrage-agents/.env
chown root:root /opt/arbitrage-agents/.env
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
