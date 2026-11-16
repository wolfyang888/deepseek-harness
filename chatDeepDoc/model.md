# ChatHub Model Usage in Desktop App (No Rebuild Required)

## Problem

The desktop app (`dsh-tauri`) **does not include** ChatHub packages by default:
- Only bundles `@deepseek-ai/dsh-base` (no web UI, no sidebar)
- Experimental chathub packages not in desktop runtime
- Desktop profile doesn't apply required patches

## Solution: ChatHub Gateway (No Desktop Rebuild Required)

Run a gateway process that exposes browser-backed models as OpenAI/Anthropic APIs, then configure the desktop app to call it.

---

### 1. Start the Gateway

#### Option A: Using the Helper Script (Recommended)

```bash
cd /home/ywf/work/code/github/deepseek-harness

# First run: shows browser window for QR code login
DSH_CHATHUB_LOGIN=true scripts/run-chathub-gateway.sh

# Subsequent runs: headless (uses saved Chrome profile)
scripts/run-chathub-gateway.sh

# With proxy for blocked sites (Gemini, ChatGPT)
DSH_CHATHUB_PROXY=http://127.0.0.1:7890 scripts/run-chathub-gateway.sh

# Test one streaming turn after boot (verifies wire works)
DSH_CHATHUB_SMOKE=sse scripts/run-chathub-gateway.sh
```

**Script features:**
- Correct mount order: `chathub-host` → `llm-chathub` → `chathub-gateway`
- Waits for `/v1/models` health endpoint (up to 60s)
- Reports gateway URL (`http://127.0.0.1:8787/v1`) and panel URL (with token)
- Shows model status table (`ready` / `needs-auth`)
- Cleans up ports on exit (Ctrl-C)

#### Option B: Manual Export (All Parameters)

```bash
cd /home/ywf/work/code/github/deepseek-harness

# Browser/profile config
export DSH_CHATHUB_PROFILE_DIR=~/.config/dsh/chathub-profile    # Chrome profile dir
export DSH_CHATHUB_HEADLESS=true                                # Headless browser (false to see window)
export DSH_CHATHUB_LOGIN=false                                  # Set true to show browser for first login
export DSH_CHATHUB_CDP_ENDPOINT=                                # Attach to existing Chrome (optional)
export DSH_CHATHUB_EXECUTABLE_PATH=                             # Custom Chrome binary (optional)
export DSH_CHATHUB_PROXY=                                       # Proxy for blocked sites (e.g. http://127.0.0.1:7890)
export DSH_CHATHUB_LOGIN_TIMEOUT_MS=300000                      # Login timeout (5 min)
export DSH_CHATHUB_TURN_TIMEOUT_MS=300000                       # Turn timeout (5 min)
export DSH_CHATHUB_ACTION_TIMEOUT_MS=15000                      # Action timeout (15s)
export DSH_CHATHUB_POLL_MS=500                                  # Poll interval (ms)
export DSH_CHATHUB_STABLE_POLLS=3                               # Stable polls before done
export DSH_CHATHUB_MAX_QUEUED_TURNS=2                           # Max queued turns per site
export DSH_CHATHUB_TYPE_DELAY_MS=0                              # Typing delay (ms)
export DSH_CHATHUB_PACING=responsive                            # conservative|balanced|responsive|off
export DSH_CHATHUB_MIN_TURN_GAP_MS=20000                        # Min gap between turns (ms)
export DSH_CHATHUB_MAX_TURNS_PER_HOUR=40                        # Max turns per hour
export DSH_CHATHUB_PACING_MAX_WAIT_MS=300000                    # Max wait before refuse (ms)

# LLM adapter config
export DSH_CHATHUB_LLM_SITE=deepseek-web                        # Default site
export DSH_CHATHUB_LLM_SITES=glm-web,qianwen-web,gemini-web,chatgpt-web,doubao-web,deepseek-web  # Sites to mount
export DSH_CHATHUB_LLM_MODEL=web-model                          # Model id advertised
export DSH_CHATHUB_LLM_CONTEXT_WINDOW=128000                    # Context window (tokens)
export DSH_CHATHUB_LLM_ROOT=/home/ywf/work/code/github/deepseek-harness  # Workspace root
export DSH_CHATHUB_LLM_TOOLS=read,grep,glob,edit,write,bash     # Tool whitelist (case-insensitive)
export DSH_CHATHUB_LLM_VERIFY=pnpm run typecheck                # Verification commands
export DSH_CHATHUB_LLM_AUXILIARY=refuse                         # refuse|allow auxiliary calls
export DSH_CHATHUB_LLM_SELECTION=auto                           # auto|fixed (aggregate route)
export DSH_CHATHUB_LLM_SELECTION_STRATEGY=sticky                # sticky|round-robin
export DSH_CHATHUB_LLM_AUTO_ROUTE=web-auto-chathub              # Aggregate route id
export DSH_CHATHUB_LLM_TOPIC_TTL_MS=1800000                     # Topic TTL (30 min)
export DSH_CHATHUB_LLM_SITE_COOLDOWN_MS=600000                  # Site cooldown (10 min)
export DSH_CHATHUB_LLM_FAILOVER=1                               # Failover attempts
export DSH_CHATHUB_LLM_REPAIRS=2                                # Repair rounds
export DSH_CHATHUB_LLM_ESCALATE_AFTER=2                         # Escalate after failures
export DSH_CHATHUB_LLM_SITE_DEMOTE_MS=1800000                   # Demote duration (30 min)
export DSH_CHATHUB_LLM_SITE_RANK=qianwen-web:10,deepseek-web:20,glm-web:20,doubao-web:20,chatgpt-web:30,gemini-web:30
export DSH_CHATHUB_LLM_PROSE_REPLAY=true                        # Replay prose on site switch

# Gateway config
export DSH_CHATHUB_GATEWAY_HOST=127.0.0.1                       # Bind address
export DSH_CHATHUB_GATEWAY_PORT=8787                            # Gateway port
export DSH_CHATHUB_GATEWAY_KEY=                                 # Bearer token (empty = no auth)
export DSH_CHATHUB_GATEWAY_SITES=                               # Sites to expose (default: all mounted)
export DSH_CHATHUB_GATEWAY_WIRES=openai,anthropic               # openai|anthropic
export DSH_CHATHUB_GATEWAY_QUEUE=8                              # Max queue per site
export DSH_CHATHUB_GATEWAY_KEEPALIVE_MS=15000                   # SSE keepalive (ms)

# Start gateway with all three patches
pnpm dsh web \
  --patch packages/experimental/chathub-host/cordis.patch.yml \
  --patch packages/experimental/llm-chathub/cordis.patch.yml \
  --patch packages/experimental/chathub-gateway/cordis.patch.yml
```

---

### 2. Sign In to Sites

Open `http://127.0.0.1:3080` → **ChatHub panel** → Click **Login** for each site:
- `doubao-web` (Doubao/豆包)
- `glm-web` (GLM/Zhipu/智谱)
- `deepseek-web` (DeepSeek Chat)
- `chatgpt-web` (ChatGPT)
- `gemini-web` (Gemini)
- `qianwen-web` (Qianwen/通义千问)

---

### 3. Configure Desktop App

In **Settings → Models** → **Add Custom Provider**:

#### Option A: OpenAI Wire (Recommended)
| Field | Value |
|-------|-------|
| Name | `ChatHub Gateway` |
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | *(empty, or set `DSH_CHATHUB_GATEWAY_KEY`)* |

Models auto-discovered: `doubao-web-chathub`, `glm-web-chathub`, `deepseek-web-chathub`, `web-auto-chathub`, etc.

#### Option B: Anthropic Wire
| Field | Value |
|-------|-------|
| Name | `ChatHub Gateway (Anthropic)` |
| Base URL | `http://127.0.0.1:8787/anthropic` |
| API Key | *(empty)* |

---

### 4. Keep Gateway Running (Background)

```bash
# Using tmux
tmux new -s chathub-gateway
# Run the gateway command above
# Ctrl+B, D to detach

# Or using screen
screen -S chathub-gateway
# Run the gateway command
# Ctrl+A, D to detach

# Or using systemd (create service file)
# ~/.config/systemd/user/chathub-gateway.service
```

---

## Architecture

```
┌─────────────────┐     HTTP      ┌─────────────────┐
│  Desktop App    │ ────────────▶ │  ChatHub        │
│  (dsh-tauri)    │  OpenAI/      │  Gateway        │
│                 │  Anthropic    │  (terminal)     │
└─────────────────┘               └────────┬────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    │                      │                      │
              ┌─────▼─────┐          ┌─────▼─────┐          ┌─────▼─────┐
              │  Browser  │          │  Browser  │          │  Browser  │
              │  Doubao   │          │   GLM     │          │  ...      │
              └───────────┘          └───────────┘          └───────────┘
```

---

## Available Models via Gateway

| Route ID | Site | Notes |
|----------|------|-------|
| `doubao-web-chathub` | Doubao | Chinese, strong coding |
| `glm-web-chathub` | GLM/Zhipu | Deep thinking mode |
| `deepseek-web-chathub` | DeepSeek Chat | Official DeepSeek |
| `chatgpt-web-chathub` | ChatGPT | Requires login |
| `gemini-web-chathub` | Gemini | Google account |
| `qianwen-web-chathub` | Qianwen | Alibaba |
| `web-auto-chathub` | Auto | Picks best site per topic |

---

## Environment Variables Summary

| Variable | Default | Purpose |
|----------|---------|---------|
| `DSH_CHATHUB_PROFILE_DIR` | `$DSH_HOME/chathub-profile` | Chrome profile dir |
| `DSH_CHATHUB_HEADLESS` | `true` | Headless browser |
| `DSH_CHATHUB_LOGIN` | `false` | Show browser for login |
| `DSH_CHATHUB_PROXY` | *(none)* | Proxy for blocked sites |
| `DSH_CHATHUB_LLM_SITES` | *all 6 sites* | Sites to mount as routes |
| `DSH_CHATHUB_GATEWAY_HOST` | `127.0.0.1` | Gateway bind address |
| `DSH_CHATHUB_GATEWAY_PORT` | `8787` | Gateway port |
| `DSH_CHATHUB_GATEWAY_KEY` | *(empty)* | Bearer token for auth |
| `DSH_CHATHUB_GATEWAY_WIRES` | `openai,anthropic` | Wire protocols |
| `DSH_CHATHUB_PACING` | `conservative` | Anti-abuse profile |

---

## Troubleshooting

**Gateway won't start:** Check Node ≥ 24.9, `pnpm install` done.

**Models not showing in desktop:** Wait for gateway to fully start (check logs), then refresh desktop app model list.

**Login fails:** Open `http://127.0.0.1:3080` manually, sign in, then retry.

**Connection refused:** Ensure gateway port `8787` not blocked by firewall.

**Site blocked (Gemini/ChatGPT):** Set `DSH_CHATHUB_PROXY=http://127.0.0.1:7890` (or your proxy).

**Desktop app shows 401:** Re-sign in via web UI; session may have expired.

---

## Why This Works

| Component | Where it runs | Purpose |
|-----------|---------------|---------|
| **chathub-host** | Gateway terminal | Launches browser, manages login state |
| **llm-chathub** | Gateway terminal | Registers routes like `doubao-web-chathub` |
| **chathub-gateway** | Gateway terminal | Exposes routes as OpenAI/Anthropic API |
| **Desktop app** | Your dsh-tauri | Just calls the gateway like any OpenAI API |

The gateway keeps the browser running and signed in. Your desktop app just sends requests to `localhost:8787`.