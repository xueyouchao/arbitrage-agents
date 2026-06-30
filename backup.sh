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
