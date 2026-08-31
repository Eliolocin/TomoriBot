# Use the official Bun image as base
# Think of this as choosing the "apartment building type" - Bun comes pre-installed
FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS base

# Set the working directory inside the container
# This is like choosing which floor/apartment number TomoriBot lives in
WORKDIR /app

# Install system dependencies that might be needed
# Alpine Linux is minimal, so we add some common tools
# Include Node.js for the bundled DuckDuckGo MCP server executable
# Include curl for health checks
# --- SECURITY FIX: Added 'apk update && apk upgrade' to patch OpenSSL CVEs ---
RUN apk update && apk upgrade && \
    apk add --no-cache \
    ca-certificates \
    tzdata \
    curl \
    ffmpeg \
    postgresql-client \
    nodejs

# Create a non-root user for security
# It's like giving TomoriBot her own user account instead of admin access
RUN addgroup -g 1001 -S tomori && \
    adduser -S tomori -u 1001 -G tomori

# Prepare writable runtime directories and change ownership of the app directory
RUN mkdir -p /app/backups /app/logs /app/data && \
    chown -R tomori:tomori /app

# Switch to non-root user
USER tomori

ENV PATH="/app/node_modules/.bin:$PATH"

# Copy package files first for better Docker layer caching
# This is like getting the "lease agreement" (dependencies) ready first
COPY --chown=tomori:tomori package.json ./
COPY --chown=tomori:tomori tsconfig.json ./
# Copy lockfile if it exists (Bun sometimes uses different names)
COPY --chown=tomori:tomori bun.lock* ./
# Copy patches directory for patchedDependencies (e.g. matrix-sdk-crypto-nodejs)
COPY --chown=tomori:tomori patches/ ./patches/
# Copy workspace member manifests so the frozen lockfile resolves the full
# workspace topology. Their deps are dev-only and pruned by --production below,
# so this satisfies the lockfile check without bloating the runtime image.
COPY --chown=tomori:tomori apps/docs/package.json ./apps/docs/package.json

# Install dependencies
# Think of this as "furnishing the apartment" with all the tools TomoriBot needs
RUN bun install --frozen-lockfile --production

# This executable is loaded from config rather than a TypeScript import. Fail
# the image build if dependency pruning ever removes it again.
RUN test -x /app/node_modules/.bin/ddg-search-mcp

# Copy the rest of the application code
# This is like moving TomoriBot's belongings into her new apartment
COPY --chown=tomori:tomori src/ ./src/

# Copy maintenance scripts so Docker Compose users can run backup/restore/update
# helpers inside the app image without host Bun.
COPY --chown=tomori:tomori scripts/ ./scripts/

# Copy static images used by slash commands (banners)
COPY --chown=tomori:tomori assets/img/ ./assets/img/

# Copy bundled fonts (Noto Sans JP) used by the /stats generate infographic.
# satori + @resvg/resvg-js load these as buffers directly, so rendering does not
# depend on host fonts — Alpine installs none (see assets/fonts/README.md).
COPY --chown=tomori:tomori assets/fonts/ ./assets/fonts/

# Copy local tokenizer assets used by model-aware logit-bias resolution
COPY --chown=tomori:tomori tokenizers/ ./tokenizers/

# Copy provider-specific SSL certificates. Azure PostgreSQL uses the maintained
# operating-system trust store; AWS RDS retains its dedicated bundle.
COPY --chown=tomori:tomori docker/certs/ ./certs/

# No build step needed - Bun runs TypeScript natively!
# This matches your proven development setup

# Environment variables that should be consistent
ENV NODE_ENV=production
ENV RUN_ENV=production
ENV TOKENIZER_ASSET_DIR=./tokenizers

# Cloud Run injects PORT=8080; the health server binds to 0.0.0.0:$PORT
EXPOSE 8080

# Health check for local docker run — Cloud Run uses its own TCP startup probe on PORT
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://0.0.0.0:${PORT:-8080}/health || exit 1

# Run TypeScript directly - just like your development setup
CMD ["bun", "run", "src/index.ts"]
