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

## 4. Zai (z.ai) LLM Provider

OpenCode supports Z.AI natively via the [`zai-coding-plan` provider](https://opencode.ai/docs/providers/#zai)
(endpoint `https://api.z.ai/api/coding/paas/v4`). No custom `opencode.json` or
`OPENAI_*` overrides are needed — just the API key and a `provider/model` id.

### Get Zai API Key

1. Go to https://z.ai (or https://open.bigmodel.cn for international)
2. Sign up / log in to a GLM Coding Plan
3. Create an API key and copy it

### Configure

Add to `.dev.vars`:
```
ZAI_API_KEY=your-zai-api-key
ZAI_MODEL=glm-5.2
```

When a session is created, the Worker injects:
- `ZHIPU_API_KEY` = `ZAI_API_KEY` (the env var OpenCode's native `zai-coding-plan` provider reads)
- `OPENCODE_MODEL` = `zai-coding-plan/<model>` (e.g. `zai-coding-plan/glm-5.2`)

Then the sandbox runner spawns `opencode run --model "$OPENCODE_MODEL" ...`,
and OpenCode resolves the provider from [models.dev](https://models.dev).

### Available Zai Coding Plan Models

| Model | Notes |
|-------|-------|
| `glm-5.2` | Latest, 1M context |
| `glm-5.1` | 200K context |
| `glm-4.7` | 200K context |
| `glm-4.5-air` | Fast, lightweight |

## 5. GitHub App Setup (For PR Creation)

### Step-by-step: Create GitHub App

1. Go to **GitHub Settings**:
   - Personal account: https://github.com/settings/apps/new
   - Organization: `https://github.com/organizations/<org>/settings/apps/new`

2. Fill in **GitHub App name**:
   ```
   Hermes Control Plane
   ```

3. Fill in **Homepage URL**:
   ```
   http://localhost:8787
   ```
   (Use your deployed URL when in production)

4. **Webhook** section:
   - Uncheck **Active** (not needed for MVP)
   - Webhook URL: leave empty
   - Webhook secret: leave empty

5. **Repository permissions** (expand and set each one):

   | Permission | Value | Why |
   |------------|-------|-----|
   | **Administration** | Read-only | List repos |
   | **Contents** | Read and write | Clone repo, push branch, read files |
   | **Metadata** | Read-only | Auto-required, always enabled |
   | **Pull requests** | Read and write | Create PR after task completion |
   | **Commit statuses** | Read-only | Check CI status |
   | **Actions** | Read-only | Check workflow runs (optional) |

   Leave all other permissions as default (No access).

6. **Organization permissions**: leave all as default (No access)

7. **Where can this GitHub App be installed?**
   - Select **Only on this account** (for MVP / personal use)
   - Or select **Any account** if you want others to use it later

8. Click **Create GitHub App**

### After Creating the App

9. **Note the App ID**:
   - On the app's General settings page, find **App ID** (a number like `123456`)
   - Copy this number

10. **Generate a Private Key**:
    - Scroll down to **Private keys** section
    - Click **Generate a private key**
    - A `.pem` file downloads (e.g., `hermes-control-plane.private-key.pem`)
    - Keep this file safe, you can only download it once

11. **Install the App**:
    - On the app settings page, click **Install App** in the left sidebar
    - Select the repositories you want Hermes to access
    - Click **Install**

### Configure in `.dev.vars`

```bash
GITHUB_APP_ID=123456

# For the private key, you need the full PEM content including headers:
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
...your full key here...
-----END RSA PRIVATE KEY-----"
```

Or load from file:
```bash
GITHUB_PRIVATE_KEY=$(cat /path/to/hermes-control-plane.private-key.pem)
```

### Verify GitHub App Works

```bash
# Test that the app can access a repo
curl -s -H "Authorization: token <installation-token>" \
  https://api.github.com/repos/<owner>/<repo>/contents
```

## 6. OpenCode (Inside Sandbox)

OpenCode runs inside the E2B sandbox. The `opencode` template is pre-installed.

The runner bridge (`src/runner/bridge.ts`) starts `opencode run` inside the sandbox.

For OpenCode to work, it needs a model API key. With Zai, this is injected automatically by the Worker:
- `ZHIPU_API_KEY` = your Zai API key (env var read by OpenCode's native `zai-coding-plan` provider)
- `OPENCODE_MODEL` = `zai-coding-plan/<model>` (e.g. `zai-coding-plan/glm-5.2`)

You can override per-session via the `profile.env` field:

```bash
curl -X POST http://localhost:8787/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "taskDescription": "Fix tests",
    "repoUrl": "https://github.com/me/repo",
    "profile": {
      "model": "glm-5.2",
      "env": {
        "ZHIPU_API_KEY": "your-custom-key",
        "OPENCODE_MODEL": "zai-coding-plan/glm-5.2"
      }
    }
  }'
```

## 7. `.dev.vars` Complete Example

```bash
# ---- E2B Sandbox ----
E2B_API_KEY=e2b_xxxxxxxxxxxxxxxxxxxx

# ---- Zai LLM (uses OpenCode native `zai-coding-plan` provider) ----
ZAI_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxx
ZAI_MODEL=glm-5.2

# ---- GitHub App ----
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
-----END RSA PRIVATE KEY-----
```

## 8. Cloudflare Deployment

### Create D1 Database

```bash
wrangler d1 create hermes-db
# Copy database_id from output into wrangler.toml
```

### Create R2 Bucket

```bash
wrangler r2 bucket create hermes-artifacts
```

### Run Schema

```bash
wrangler d1 execute hermes-db --file=schema.sql
```

### Set Secrets for Production

```bash
wrangler secret put E2B_API_KEY
wrangler secret put ZAI_API_KEY
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_PRIVATE_KEY
```

### Deploy

```bash
bun run deploy
```

## 9. Testing Checklist

| Test | Command | Needs Keys? |
|------|---------|:-----------:|
| Unit + integration tests | `bun run test` | No |
| Local Worker + fake runner | `bun run dev` | No |
| Real E2B sandbox | API with E2B provider | E2B key |
| Real Zai LLM (agent runs) | session with env | Zai key |
| Real GitHub PR | approve PR | GitHub App |
| Full end-to-end | all above | All keys |
