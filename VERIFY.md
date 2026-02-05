# Claw-Tribe Verification Guide

How to ensure OpenClaw messages are tracked by tribe and claw-tribe is working.

## Quick Verification

```bash
npx tsx scripts/verify-claw-tribe.ts
```

## Manual Checklist

### 1. TRIBE CLI

```bash
# Install (if needed)
npx @_xtribe/cli@latest

# Verify
tribe --version
```

### 2. Authentication

```bash
tribe login    # Opens browser for OAuth
tribe status   # Should show "Active" and not "Not authenticated"
```

### 3. Telemetry

```bash
tribe enable   # Enable collection
tribe status   # Confirm "Active"
```

Tribe natively tracks: Claude, Cursor, Codex. OpenClaw/ClawdBot is tracked via the **claw-tribe plugin** (KB capture + context injection).

### 4. Plugin Installation

**Option A: Extension (recommended)**

```bash
cd extension && npm install && npm link
mkdir -p ~/.openclaw/extensions
cd ~/.openclaw/extensions && npm link @tribecode/tribecode
```

**Option B: Config**

Add to `~/.openclaw/config.json`:

```json
{
  "plugins": {
    "@tribecode/tribecode": {
      "autoContext": true,
      "autoCapture": true,
      "autoSync": false,
      "contextDepth": "standard"
    }
  }
}
```

### 5. Verify OpenClaw Messages Are Tracked

| What | How It Works | How to Verify |
|------|--------------|---------------|
| **KB Capture** | On each successful agent_end, plugin saves a condensed summary to tribe KB | `tribe kb search "your topic"` — should find [ClawdBot ...] entries |
| **Context Injection** | Before each turn, plugin injects recent sessions + KB matches | Check OpenClaw logs for "tribecode: injecting context" |
| **Session Search** | Tribe CLI sessions come from Claude/Cursor/Codex telemetry | `tribe query sessions` — OpenClaw sessions appear when plugin sends them (future) |

**Current behavior:** OpenClaw conversations are captured to the **knowledge base** (searchable via `tribe kb search`). They are not yet in the session list (`tribe query sessions`) because the tribe CLI's native telemetry targets Claude/Cursor/Codex. The plugin's `autoCapture` ensures your OpenClaw chats are stored and searchable.

### 6. Test KB Capture

1. Have a substantive conversation with OpenClaw (e.g., "How do I add auth to my Express app?")
2. Wait for the agent to finish (agent_end fires)
3. Run: `tribe kb search "auth"` or `tribe kb list`
4. You should see entries prefixed with `[ClawdBot <category>]`

### 7. Test Context Injection

1. Enable `autoContext: true` (default)
2. Start a new OpenClaw conversation
3. Check OpenClaw logs for: `tribecode: injecting context (sessions, knowledge, ...)`
4. If you see that, context from past sessions and KB is being injected into the prompt

### 8. Tribe Setup Tool

From within OpenClaw, ask the agent to run `tribe_setup`. It will:

- Check CLI installation
- Check authentication
- Report telemetry status
- Give next steps if anything is missing

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Not authenticated" | Run `tribe login` in terminal |
| "TRIBE CLI not found" | Run `npx @_xtribe/cli@latest` |
| No KB entries from OpenClaw | Ensure plugin is loaded, `autoCapture: true`, and conversation was substantive |
| No context injection | Ensure `autoContext: true` and tribe has sessions/KB data |
| Plugin not loading | Check `~/.openclaw/config.json` and extension install |

## Architecture Summary

```
OpenClaw User Message
        │
        ▼
before_agent_start ──► buildContext() ──► tribe query sessions + kb search
        │                    │
        │                    └──► <tribe-context> injected into prompt
        │
        ▼
    Agent Turn
        │
        ▼
agent_end ──► captureConversation() ──► tribe kb save [ClawdBot <category>]
        │
        └──► KB entry searchable via tribe kb search
```
