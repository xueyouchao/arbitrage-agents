#!/bin/bash
set -e

echo "========================================="
echo "Arbitrage Agents - VPS Deployment Script"
echo "========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root (or via sudo). Privileged operations below
# (Docker install, writing /opt, /etc/nginx, crontab, chown) require this.
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root or with sudo:  sudo bash scripts/deploy.sh${NC}"
    exit 1
fi

# Configuration
APP_DIR="/opt/arbitrage-agents"
BACKUP_DIR="/opt/backups/arbitrage-agents"
DOMAIN=""
EMAIL=""

echo -e "${YELLOW}Step 1: Installing Docker and Docker Compose${NC}"
echo ""

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo -e "${GREEN}✓ Docker installed${NC}"
else
    echo -e "${GREEN}✓ Docker already installed${NC}"
fi

# Install Docker Compose plugin if not present
if ! docker compose version &> /dev/null; then
    echo "Installing Docker Compose plugin..."
    apt-get update
    apt-get install -y docker-compose-plugin
    echo -e "${GREEN}✓ Docker Compose installed${NC}"
else
    echo -e "${GREEN}✓ Docker Compose already installed${NC}"
fi

# Grant the invoking (non-root) user access to docker so daily `docker compose`
# operations (build, logs, restart, migrate) work without sudo. This assumes the
# deploy was started via `sudo bash scripts/deploy.sh`; $SUDO_USER is the real
# user. A re-login is required for the new group to take effect.
if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
    if ! id -nG "$SUDO_USER" 2>/dev/null | grep -qw docker; then
        usermod -aG docker "$SUDO_USER"
        echo -e "${GREEN}✓ Added '$SUDO_USER' to the docker group (log out/in for it to take effect)${NC}"
    else
        echo -e "${GREEN}✓ '$SUDO_USER' already in the docker group${NC}"
    fi
else
    echo -e "${YELLOW}Note: run via 'sudo bash scripts/deploy.sh' as the ubuntu user to auto-grant docker group access.${NC}"
fi

echo ""
echo -e "${YELLOW}Step 2: Setting up application directory${NC}"
echo ""

# Create application directory
mkdir -p $APP_DIR
mkdir -p $BACKUP_DIR

echo -e "${GREEN}✓ Created directories${NC}"

echo ""
echo -e "${YELLOW}Step 3: Clone repository (if not already present)${NC}"
echo ""

if [ ! -f "$APP_DIR/docker-compose.yml" ]; then
    echo "Enter repository URL (or press Enter to skip):"
    read REPO_URL

    if [ -n "$REPO_URL" ]; then
        cd $APP_DIR
        git clone $REPO_URL .
        echo -e "${GREEN}✓ Repository cloned${NC}"
    else
        echo "Skipping clone (assuming files are already present)"
    fi
else
    echo -e "${GREEN}✓ Application files already present${NC}"
fi

echo ""
echo -e "${YELLOW}Step 4: Configure environment variables${NC}"
echo ""

if [ ! -f "$APP_DIR/.env" ]; then
    echo "Creating .env file from template..."
    cp $APP_DIR/.env.example $APP_DIR/.env

    echo ""
    echo "Please edit the .env file with your production values:"
    echo "  nano $APP_DIR/.env"
    echo ""
    echo "Required variables:"
    echo "  - DB_PASSWORD (strong password)"
    echo "  - SENTRY_DSN (from sentry.io)"
    echo "  - API Keys (if using venue APIs)"
    echo ""
    read -p "Press Enter when you've configured .env..."

    # Set secure permissions. The operator (SUDO_USER, e.g. ubuntu) must be able
    # to read .env, because `docker compose` loads it via the CLI process that
    # runs as that user — not as root via the daemon. root:root + 600 would make
    # it unreadable to the operator, breaking `docker compose up`, migrations,
    # and backups. Own it to the operator and keep it mode 600 (owner-only read,
    # unreadable by other system users).
    chmod 600 $APP_DIR/.env
    chown "${SUDO_USER:-ubuntu}":"${SUDO_USER:-ubuntu}" $APP_DIR/.env
    echo -e "${GREEN}✓ Environment file configured with secure permissions (owner: ${SUDO_USER:-ubuntu}, mode 600)${NC}"
else
    echo -e "${GREEN}✓ Environment file already exists${NC}"
fi

echo ""
echo -e "${YELLOW}Step 5: Deploy with Docker Compose${NC}"
echo ""

cd $APP_DIR

# One-time recovery: remove stale build artifacts that may be owned by root
# or a different UID (e.g. 1001) from prior containerized runs. Running as root
# here lets us delete root-owned dist/coverage/node_modules so the subsequent
# build (now executed by containers running as UID 1000) and any host-side
# npm gates do not hit EACCES on these paths.
echo "Cleaning stale build artifacts (if any)..."
rm -rf dist coverage node_modules
echo -e "${GREEN}✓ Stale artifacts cleared${NC}"

echo "Building images and starting Postgres first..."
docker compose up -d --build postgres

echo ""
echo "Waiting for Postgres to be healthy..."
docker compose exec -T postgres pg_isready -U "${DB_USER:-arbitrage_user}" -d "${DB_NAME:-arbitrage}" || true
until docker compose ps postgres | grep -q "(healthy)"; do
    sleep 2
    echo -n "."
done
echo ""
echo -e "${GREEN}✓ Postgres is healthy${NC}"

echo ""
echo -e "${YELLOW}Step 6: Running database migrations${NC}"
echo ""

# Start a temporary API container just to run migrations. We run it here before
# the worker so the schema exists before the worker attempts to read/write it.
echo "Running migrations..."
docker compose run --rm api npm run db:migrate

echo -e "${GREEN}✓ Database migrations completed${NC}"

echo ""
echo "Starting API and Worker..."
docker compose up -d --build api worker

echo ""
echo "Waiting for services to start..."
sleep 10

echo ""
echo "Service status:"
docker compose ps

echo ""
echo -e "${YELLOW}Step 7: Setting up automated backups${NC}"
echo ""

# Create backup script
cat > $APP_DIR/backup.sh <<'BACKUP_EOF'
#!/bin/bash
set -e

BACKUP_DIR="/opt/backups/arbitrage-agents"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# Source environment
source /opt/arbitrage-agents/.env

echo "Starting database backup: $TIMESTAMP"

# Backup PostgreSQL
cd /opt/arbitrage-agents
docker compose exec -T postgres pg_dump -U $DB_USER $DB_NAME > $BACKUP_DIR/db_$TIMESTAMP.sql

# Keep only last 7 days of backups
find $BACKUP_DIR -name "db_*.sql" -mtime +7 -delete

echo "Backup completed successfully: $TIMESTAMP"
BACKUP_EOF

chmod +x $APP_DIR/backup.sh

# Add to crontab
if ! crontab -l 2>/dev/null | grep -q "backup.sh"; then
    (crontab -l 2>/dev/null; echo "0 2 * * * $APP_DIR/backup.sh >> /var/log/arbitrage-backup.log 2>&1") | crontab -
    echo -e "${GREEN}✓ Backup cron job added (daily at 2 AM)${NC}"
else
    echo -e "${GREEN}✓ Backup cron job already exists${NC}"
fi

echo ""
echo -e "${YELLOW}Step 8: Configure Nginx reverse proxy (optional)${NC}"
echo ""

echo "Do you want to set up Nginx with HTTPS? (y/n)"
read SETUP_NGINX

if [ "$SETUP_NGINX" = "y" ] || [ "$SETUP_NGINX" = "Y" ]; then
    echo ""
    echo "Enter your domain name (e.g., api.example.com):"
    read DOMAIN

    echo "Enter your email for Let's Encrypt:"
    read EMAIL

    # Install Nginx and Certbot
    apt-get install -y nginx certbot python3-certbot-nginx

    # Copy Nginx configuration
    cp $APP_DIR/nginx/arbitrage-api.conf /etc/nginx/sites-available/arbitrage-api
    sed -i "s/api.yourdomain.com/$DOMAIN/g" /etc/nginx/sites-available/arbitrage-api

    # Enable site
    ln -sf /etc/nginx/sites-available/arbitrage-api /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default

    # Test Nginx configuration
    nginx -t

    # Reload Nginx
    systemctl reload nginx

    # Get SSL certificate
    certbot --nginx -d $DOMAIN --email $EMAIL --non-interactive --agree-tos

    echo -e "${GREEN}✓ Nginx configured with HTTPS for $DOMAIN${NC}"
else
    echo "Skipping Nginx setup"
    echo -e "${YELLOW}Note: API is accessible at http://localhost:3000${NC}"
fi

echo ""
echo "========================================="
echo -e "${GREEN}Deployment Complete!${NC}"
echo "========================================="
echo ""
echo "Service URLs:"
if [ -n "$DOMAIN" ]; then
    echo "  API: https://$DOMAIN"
    echo "  Health: https://$DOMAIN/health"
else
    echo "  API: http://localhost:3000"
    echo "  Health: http://localhost:3000/health"
fi
echo ""
echo "Useful Commands:"
echo "  View logs:        cd $APP_DIR && docker compose logs -f"
echo "  View API logs:    cd $APP_DIR && docker compose logs -f api"
echo "  View worker logs: cd $APP_DIR && docker compose logs -f worker"
echo "  Restart services: cd $APP_DIR && docker compose restart"
echo "  Update app:       cd $APP_DIR && git pull && docker compose up -d --build"
echo ""
echo "Backup Location: $BACKUP_DIR"
echo ""
echo "Next Steps:"
echo "  1. Test the API health endpoint"
echo "  2. Configure Sentry production project"
echo "  3. Set up Uptime Robot monitoring"
echo "  4. Define SLO thresholds"
echo ""
