# Deployment & CI/CD

TomoriBot is designed for **production deployment** with comprehensive CI/CD pipelines, environment management, and scalable hosting architecture. The project follows DevOps best practices with automated testing, linting, and deployment processes.

## Development Environment

### Prerequisites

- **Bun** (latest version) - Runtime and package manager
- **PostgreSQL** (14+) - Database server with pgcrypto extension
- **Node.js** (18+) - For compatibility with some Discord.js dependencies
- **Git** - Version control

### Local Setup

1. **Clone and install dependencies**:
```bash
git clone https://github.com/your-org/TomoriBot.git
cd TomoriBot
bun install
```

2. **Database setup**:
```bash
# Create PostgreSQL database
createdb tomoribot_dev

# Initialize schema and seed data
bun run seed-db
```

3. **Environment configuration**:
```bash
# Copy example environment file
cp .env.example .env

# Configure required variables:
# - DISCORD_TOKEN
# - DATABASE_URL
# - GOOGLE_AI_API_KEY
# - CRYPTO_SECRET
```

4. **Development server**:
```bash
# Start with hot reload
bun run dev
```

### Development Commands

```bash
# Core Development
bun run dev              # Hot reload development mode
bun run build           # Production build
bun run start           # Run built application
bun run watch           # Build with watch mode

# Code Quality  
bun run check           # TypeScript compilation check
bun run lint            # Biome linting and formatting

# Database Management
bun run seed-db         # Initialize database with seed data
bun run nuke-db         # ⚠️ Completely wipe database
bun run purge-commands  # Remove all Discord slash commands

# Utilities
bun run clean-dist      # Clean build artifacts
```

## CI/CD Pipeline

### GitHub Actions Workflow

**Location**: `.github/workflows/ci.yml`

```yaml
name: CI/CD Pipeline
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test-and-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest
      
      - name: Install dependencies
        run: bun install
      
      - name: TypeScript check
        run: bun run check
      
      - name: Lint code
        run: bun run lint
      
      - name: Build application
        run: bun run build

  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run security audit
        run: bun audit
```

### Automated Quality Checks

**Code Quality Enforcement**:
- TypeScript compilation with strict mode
- Biome linting with zero-tolerance policy
- Security dependency scanning
- Build verification on all platforms

**Pre-commit Hooks** (planned):
```bash
# Install husky for git hooks
bun add --dev husky lint-staged

# Pre-commit checks
- TypeScript compilation
- Biome formatting and linting
- Security audit
```

## Environment Configuration

### Required Environment Variables

```bash
# Discord Integration
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_application_id

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/tomoribot

# AI Provider APIs
GOOGLE_AI_API_KEY=your_google_gemini_api_key
# OPENAI_API_KEY=your_openai_api_key (future)
# ANTHROPIC_API_KEY=your_anthropic_api_key (future)

# Security
CRYPTO_SECRET=your_encryption_secret_minimum_32_chars

# MCP Server APIs (optional)
BRAVE_API_KEY=your_brave_search_api_key

# Optional: Logging and Monitoring
LOG_LEVEL=info
SENTRY_DSN=your_sentry_dsn
```

### Environment-Specific Configurations

**Development** (`.env.development`)
```bash
NODE_ENV=development
LOG_LEVEL=debug
DATABASE_URL=postgresql://localhost:5432/tomoribot_dev
```

**Staging** (`.env.staging`)
```bash
NODE_ENV=staging
LOG_LEVEL=info
DATABASE_URL=postgresql://staging-db:5432/tomoribot_staging
```

**Production** (`.env.production`)
```bash
NODE_ENV=production
LOG_LEVEL=warn
DATABASE_URL=postgresql://prod-db:5432/tomoribot
```

## Docker Deployment

### Multi-Stage Dockerfile

```dockerfile
# Build stage
FROM oven/bun:1 as builder
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Production stage
FROM oven/bun:1-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD curl -f http://localhost:3000/health || exit 1

EXPOSE 3000
CMD ["bun", "start"]
```

### Docker Compose (Development)

```yaml
version: '3.8'
services:
  tomoribot:
    build: .
    environment:
      - NODE_ENV=development
      - DATABASE_URL=postgresql://postgres:password@db:5432/tomoribot
    depends_on:
      - db
    ports:
      - "3000:3000"
    volumes:
      - ./src:/app/src  # Hot reload
  
  db:
    image: postgres:15
    environment:
      - POSTGRES_DB=tomoribot
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=password
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./src/db/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql
      - ./src/db/seed.sql:/docker-entrypoint-initdb.d/02-seed.sql
    ports:
      - "5432:5432"

volumes:
  postgres_data:
```

## Cloud Deployment Architecture

### AWS Deployment (Planned)

**Infrastructure Components**:
- **ECS Fargate** - Containerized application hosting
- **RDS PostgreSQL** - Managed database with encryption
- **Application Load Balancer** - Traffic distribution and SSL termination
- **CloudWatch** - Logging and monitoring
- **Secrets Manager** - Secure API key storage
- **CloudFront** - CDN for static assets (future web interface)

**Terraform Configuration** (planned):
```hcl
resource "aws_ecs_cluster" "tomoribot" {
  name = "tomoribot-cluster"
}

resource "aws_ecs_service" "tomoribot" {
  name            = "tomoribot"
  cluster         = aws_ecs_cluster.tomoribot.id
  task_definition = aws_ecs_task_definition.tomoribot.arn
  desired_count   = 2
  
  deployment_configuration {
    maximum_percent         = 200
    minimum_healthy_percent = 100
  }
}

resource "aws_db_instance" "tomoribot" {
  identifier     = "tomoribot-db"
  engine         = "postgres"
  engine_version = "15.4"
  instance_class = "db.t3.micro"
  
  db_name  = "tomoribot"
  username = var.db_username
  password = var.db_password
  
  encrypted = true
  storage_encrypted = true
}
```

### Alternative Deployment Options

**Railway** (Recommended for quick deployment)
```bash
# Install Railway CLI
npm install -g @railway/cli

# Deploy
railway login
railway init
railway up
```

**Heroku** (Quick prototyping)
```bash
# Install Heroku CLI and deploy
heroku create tomoribot-app
heroku addons:create heroku-postgresql:hobby-dev
git push heroku main
```

**DigitalOcean App Platform**
```yaml
# .do/app.yaml
name: tomoribot
services:
- name: web
  source_dir: /
  build_command: bun run build
  run_command: bun start
  environment_slug: node-js
  instance_count: 1
  instance_size_slug: basic-xxs
  
databases:
- name: db
  engine: PG
  version: "15"
```

## Monitoring and Observability

### Application Metrics

**Health Check Endpoint**:
```typescript
// src/utils/monitoring/health.ts
export function createHealthCheck() {
  return {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    database: await checkDatabaseConnection(),
    discord: await checkDiscordConnection(),
  };
}
```

**Performance Monitoring**:
- Discord API rate limit tracking
- Database query performance metrics
- LLM provider response times
- Tool execution statistics

### Logging Strategy

**Structured Logging** (`src/utils/misc/logger.ts`):
```typescript
export const log = {
  info: (message: string, meta?: object) => 
    console.log(JSON.stringify({ level: 'info', message, meta, timestamp: new Date() })),
  
  error: (message: string, error: Error, meta?: object) => 
    console.error(JSON.stringify({ level: 'error', message, error: error.message, stack: error.stack, meta, timestamp: new Date() })),
  
  // ... other levels
};
```

**Log Aggregation**:
- CloudWatch Logs (AWS)
- ELK Stack (self-hosted)
- Datadog (third-party)

### Error Tracking

**Sentry Integration** (planned):
```typescript
import * as Sentry from '@sentry/bun';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
});

// Error capture in tool execution
try {
  await toolExecution();
} catch (error) {
  Sentry.captureException(error);
  throw error;
}
```

## Security Considerations

### Production Security Checklist

- [ ] **API Key Rotation**: Regular rotation of Discord and LLM provider keys
- [ ] **Database Encryption**: Encrypted connections and data at rest
- [ ] **Environment Isolation**: Separate staging and production environments
- [ ] **Access Control**: Limited production database access
- [ ] **Vulnerability Scanning**: Regular dependency audits
- [ ] **Rate Limiting**: Discord API rate limit compliance
- [ ] **Input Validation**: All user inputs validated and sanitized
- [ ] **Error Handling**: No sensitive data in error messages

### Infrastructure Security

- **Network Segmentation**: Private subnets for database access
- **SSL/TLS**: End-to-end encryption for all communications
- **Secrets Management**: AWS Secrets Manager or equivalent
- **Access Logging**: Comprehensive audit trails
- **Backup Security**: Encrypted backups with retention policies

## Scaling Considerations

### Horizontal Scaling

- **Stateless Design**: No in-memory session storage
- **Database Connection Pooling**: Efficient connection management
- **Load Balancing**: Multiple application instances
- **Caching Strategy**: Redis for session and frequently accessed data

### Performance Optimization

- **Database Indexing**: Optimized queries with proper indexes
- **CDN Integration**: Static asset delivery optimization
- **Connection Pooling**: Efficient resource utilization
- **Monitoring**: Proactive performance monitoring and alerting

---

**Next**: Learn about [Contributing Guidelines](09-contributing.md) and development workflow.