# Use the official Bun image as base
# Think of this as choosing the "apartment building type" - Bun comes pre-installed
FROM oven/bun:1.2.12-alpine AS base

# Set the working directory inside the container
# This is like choosing which floor/apartment number TomoriBot lives in
WORKDIR /app

# Install system dependencies that might be needed
# Alpine Linux is minimal, so we add some common tools
# Include Python/pip and Node.js/npm for MCP server support
RUN apk add --no-cache \
    ca-certificates \
    tzdata \
    python3 \
    py3-pip \
    nodejs \
    npm

# Create a non-root user for security
# It's like giving TomoriBot her own user account instead of admin access
RUN addgroup -g 1001 -S tomori && \
    adduser -S tomori -u 1001 -G tomori

# Change ownership of the app directory to our user
RUN chown -R tomori:tomori /app

# Switch to non-root user
USER tomori

# Install MCP servers that are required by TomoriBot
# Fetch MCP server needs to be pre-installed with pip
# Install as tomori user to avoid permission issues
RUN pip3 install --user mcp-server-fetch

# Copy package files first for better Docker layer caching
# This is like getting the "lease agreement" (dependencies) ready first
COPY --chown=tomori:tomori package.json ./
COPY --chown=tomori:tomori tsconfig.json ./
# Copy lockfile if it exists (Bun sometimes uses different names)
COPY --chown=tomori:tomori bun.lock* ./

# Install dependencies
# Think of this as "furnishing the apartment" with all the tools TomoriBot needs
RUN bun install --frozen-lockfile --production

# Copy the rest of the application code
# This is like moving TomoriBot's belongings into her new apartment
COPY --chown=tomori:tomori src/ ./src/

# No build step needed - Bun runs TypeScript natively!
# This matches your proven development setup

# Environment variables that should be consistent
ENV NODE_ENV=production
ENV RUN_ENV=production

# Health check to ensure TomoriBot is running properly
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ps aux | grep -v grep | grep "bun.*src/index.ts" || exit 1

# Run TypeScript directly - just like your development setup
CMD ["bun", "run", "src/index.ts"]