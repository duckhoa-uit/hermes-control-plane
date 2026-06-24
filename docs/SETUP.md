# Hermes Control Plane - Setup Guide

## 1. Prerequisites

- Node.js 22+
- Bun 1.3+
- Wrangler (Cloudflare CLI): `npm i -g wrangler`
- Cloudflare account (free)

## 2. Local Development (No External Keys Needed)

```bash
bun install
bun run test
bun run dev
```

### Test the API locally

```bash
# Terminal 1: Start worker
bun run dev

# Terminal 2: Health check
bun run src/testing/api-client.ts http://localhost:8787 health

# Terminal 3: Create session
bun run src/testing/api-client.ts http://localhost:8787 create "Fix failing tests" "https://github.com/test/repo" "my-project"

# Terminal 4: Connect fake runner
bun run src/testing/fake-runner.ts ws://localhost:8787 <session-id> <runner-token>

# Terminal 5: Watch events
bun run src/testing/api-client.ts http://localhost:8787 events <session-id>

# Terminal 6: Approve PR
bun run src/testing/api-client.ts http://localhost:8787 create-pr <session-id>
```

## 3. E2B Setup (Free)

1. Go to https://e2b.dev/dashboard
2. Sign up (Hobby: $0/mo, $100 credits, no credit card)
3. Copy API key
4. Add to `.dev.vars`: `E2B_API_KEY=your-key`

## 4. GitHub App Setup

1. Go to https://github.com/settings/apps/new
2. Name: Hermes Control Plane
3. Permissions: Contents (read/write), Pull requests (read/write)
4. Create app, generate private key (.pem)
5. Note App ID
6. Install app to repositories
7. Add to `.dev.vars`:
   ```
   GITHUB_APP_ID=123456
   GITHUB_PRIVATE_KEY=<contents of .pem>
   ```

## 5. OpenCode Model Key

OpenCode runs inside sandbox. Pass model API key via session env:

```bash
curl -X POST http://localhost:8787/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "taskDescription": "Fix tests",
    "repoUrl": "https://github.com/me/repo",
    "profile": { "env": { "ANTHROPIC_API_KEY": "sk-ant-..." } }
  }'
```

## 6. Cloudflare Deployment

```bash
wrangler d1 create hermes-db
wrangler r2 bucket create hermes-artifacts
wrangler d1 execute hermes-db --file=schema.sql

wrangler secret put E2B_API_KEY
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_PRIVATE_KEY

bun run deploy
```

## 7. Testing Checklist

| Test | Command | Needs Keys? |
|------|---------|:-----------:|
| Unit + integration tests | `bun run test` | No |
| Local Worker + fake runner | `bun run dev` | No |
| Real E2B sandbox | API with E2B provider | E2B key |
| Real GitHub PR | approve PR | GitHub App |
| Full end-to-end | all above | All keys |
