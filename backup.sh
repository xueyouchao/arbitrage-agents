#!/bin/bash
set -euo pipefail

BACKUP_DIR="/opt/backups/arbitrage-agents"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="db_$TIMESTAMP.sql"
mkdir -p "$BACKUP_DIR"

# Source environment
source /opt/arbitrage-agents/.env

# Verify required env vars are present
: "${DB_USER:?DB_USER not set in .env}"
: "${DB_NAME:?DB_NAME not set in .env}"

echo "Starting database backup: $TIMESTAMP"

# Backup PostgreSQL
cd /opt/arbitrage-agents
docker compose exec -T postgres pg_dump -U "$DB_USER" "$DB_NAME" > "$BACKUP_DIR/$BACKUP_FILE"

# Validate the dump is non-empty and well-formed
if [ ! -s "$BACKUP_DIR/$BACKUP_FILE" ]; then
  echo "ERROR: backup file is empty — pg_dump may have failed silently" >&2
  exit 1
fi
if ! grep -q "PostgreSQL database dump complete" "$BACKUP_DIR/$BACKUP_FILE"; then
  echo "ERROR: backup file is missing the completion marker — dump may be truncated" >&2
  exit 1
fi

# Keep only last 7 days of backups
find "$BACKUP_DIR" -name "db_*.sql" -mtime +7 -delete

echo "Backup completed successfully: $TIMESTAMP"