# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Build application
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install curl for healthchecks
RUN apk add --no-cache curl

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy built application
COPY --from=builder /app/dist ./dist

# The base image (node:20-alpine) ships a `node` user at UID/GID 1000, which
# matches the host `ubuntu` user. Reuse it instead of creating a new user:
# this keeps the container UID aligned with the host user so any host-visible
# files written by the container (dist/, node_modules/ via bind-mounts or copy)
# are owned by the host user — no EACCES on host-side npm gates.

# Change ownership of the app directory (dist + node_modules are copied in
# above as root) so the non-root node user can execute its own binaries.
RUN chown -R node:node /app
USER node

# Expose API port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Default command (overridden in docker-compose.yml)
CMD ["npm", "run", "start:prod:api"]
