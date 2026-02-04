# TribeCode for ClawdBot

A ClawdBot plugin that integrates [TribeCode](https://tribecode.ai) into your AI coding workflow. It gives your agent access to your coding history, knowledge base, and multi-agent orchestration tools -- automatically enriching every conversation with context from past sessions and capturing insights for future use.

## What It Does

**Context Injection** -- Before each agent turn, the plugin queries your TRIBE session history and knowledge base, then injects relevant context into the prompt. Your agent knows what you've been working on, which projects are active, and what patterns you've established.

**Knowledge Capture** -- After each successful conversation, the plugin analyzes the exchange, categorizes it (debugging, architecture, pattern, solution, decision), extracts technology tags, and saves a condensed summary to your TRIBE knowledge base. Future sessions automatically benefit from past insights.

**33 Tools** -- Direct access to TRIBE's full CLI from within ClawdBot: search sessions, query events, manage your knowledge base, orchestrate agents with MUSE, and run autonomous issue resolution with CIRCUIT.

## Prerequisites

- [ClawdBot](https://openclaw.ai) >= 2026.1.0
- [TRIBE CLI](https://tribecode.ai) (`@_xtribe/cli`)
- Node.js >= 18

## Installation

### 1. Install the TRIBE CLI

```bash
npx @_xtribe/cli@latest
```

This downloads the `tribe` binary to `~/.tribe/bin/tribe`.

### 2. Authenticate

```bash
tribe login
```

Opens your browser for secure authentication via tribecode.ai. Without login, the plugin operates in local-only mode with limited session data.

### 3. Install the Plugin

Add this plugin to your ClawdBot configuration. The plugin is published as `@tribecode/tribecode`:

```json
{
  "plugins": {
    "@tribecode/tribecode": {}
  }
}
```

Or clone this repo and point ClawdBot at the local `extension/` directory.

### 4. Verify

Once loaded, the plugin runs a health check on startup and logs its status:

```
tribecode: TRIBE connected and authenticated.
tribecode: autoContext=true, autoCapture=true, depth=standard
```

You can also run the `tribe_setup` tool from within ClawdBot for guided installation and diagnostics.

## Configuration

The plugin accepts four configuration options in your ClawdBot plugin config:

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

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoContext` | boolean | `true` | Inject TRIBE context before every agent turn |
| `autoCapture` | boolean | `true` | Capture conversation insights to TRIBE KB after each session |
| `autoSync` | boolean | `false` | Run `tribe sync` in the background every 5 minutes |
| `contextDepth` | string | `"standard"` | How much context to inject: `minimal` (recent sessions only), `standard` (sessions + KB search), `deep` (sessions + KB + full session details) |

## Tools

The plugin registers 33 tools grouped by function. All tools include auth-aware error handling -- if TRIBE isn't installed or authenticated, they return helpful setup instructions instead of cryptic errors.

### Setup

| Tool | Description |
|------|-------------|
| `tribe_setup` | Install the CLI, check authentication, report status. Safe to run multiple times. |

### Telemetry

| Tool | Description |
|------|-------------|
| `tribe_enable` | Enable telemetry collection for Claude, Cursor, and Codex |
| `tribe_disable` | Disable telemetry collection (preserves existing data) |
| `tribe_status` | Show collection status, sync state, and connected tools |
| `tribe_version` | Show CLI version and build info |

### Authentication

| Tool | Description |
|------|-------------|
| `tribe_auth_status` | Check authentication state without triggering login |
| `tribe_logout` | Remove stored credentials |

### Search & Query

| Tool | Parameters | Description |
|------|-----------|-------------|
| `tribe_search` | `query`, `limit?`, `timeRange?`, `tool?`, `project?`, `format?` | Search across all AI coding sessions |
| `tribe_recall` | `sessionId`, `format?` | Generate a detailed summary of a specific session |
| `tribe_extract` | `sessionId`, `type?`, `limit?`, `format?` | Extract code, commands, files, or edits from a session |
| `tribe_query_sessions` | `limit?`, `timeRange?`, `tool?`, `project?`, `format?` | List sessions with filters |
| `tribe_query_insights` | `limit?`, `format?` | Query coding insights and summaries |
| `tribe_query_events` | `sessionId`, `limit?`, `format?` | Query events for a specific session |

### Sessions

| Tool | Parameters | Description |
|------|-----------|-------------|
| `tribe_sessions_list` | `cwd?`, `project?`, `search?`, `limit?`, `format?` | List sessions with project and search filters |
| `tribe_sessions_read` | `sessionId`, `format?` | Read full session details |
| `tribe_sessions_search` | `query`, `format?` | Search within session content |

### Knowledge Base

| Tool | Parameters | Description |
|------|-----------|-------------|
| `tribe_kb_search` | `query` | Search the knowledge base |
| `tribe_kb_list` | -- | List all KB documents |
| `tribe_kb_save` | `content` | Save content to KB |
| `tribe_kb_get` | `docId` | Retrieve a document by ID |
| `tribe_kb_delete` | `docId` | Delete a document by ID |
| `tribe_kb_stats` | -- | Show KB statistics and sync status |

### MUSE (Interactive Agent Orchestration)

MUSE spawns and coordinates multiple subagents, each in an isolated git worktree.

| Tool | Parameters | Description |
|------|-----------|-------------|
| `tribe_muse_start` | `agent?` | Start the MUSE leader agent |
| `tribe_muse_spawn` | `task`, `name?`, `agent?` | Spawn a subagent with a specific task |
| `tribe_muse_status` | `format?` | Show leader and subagent status |
| `tribe_muse_agents` | `format?` | List all registered agents |
| `tribe_muse_prompt` | `session`, `message` | Send a message to a running subagent |
| `tribe_muse_kill` | `session`, `reason?` | Kill an unresponsive subagent |

### CIRCUIT (Autonomous Issue Resolution)

CIRCUIT assigns agents to issues from a priority queue, with heartbeat monitoring and auto-recovery.

| Tool | Parameters | Description |
|------|-----------|-------------|
| `tribe_circuit_list` | -- | List autonomous agent sessions |
| `tribe_circuit_spawn` | `issue`, `force?` | Spawn an agent for a GitHub issue number |
| `tribe_circuit_status` | -- | Quick status summary |
| `tribe_circuit_metrics` | -- | Performance metrics |
| `tribe_circuit_auto` | `interval?` | Auto-spawn agents by priority until queue is empty |

## How Context Injection Works

On every `before_agent_start` event (when `autoContext` is enabled):

1. **Session query** -- Fetches recent coding sessions from TRIBE. The CLI progressively widens the time range (24h -> 7d -> 30d -> all) if no sessions are found in the initial window.
2. **KB search** -- Extracts the most distinctive keyword from the user's prompt and searches the knowledge base (skipped at `minimal` depth or for prompts under 5 characters).
3. **Context block** -- Formats results into a `<tribe-context>` XML block containing:
   - **Recent Activity** -- sessions with tool names, projects, timestamps, durations, and branches
   - **Relevant Knowledge** -- matching KB entries with categories
   - **Active Project** -- the most recent project and branch
4. **Injection** -- Returns the block as `prependContext`, which ClawdBot adds to the agent's prompt.

The entire pipeline targets < 500ms with a 2-second hard timeout per CLI call. Session data is cached for 60 seconds.

## How Knowledge Capture Works

On every `agent_end` event (when `autoCapture` is enabled and the conversation succeeded):

1. **Text extraction** -- Pulls text from user and assistant messages, handling both string and content-block formats. Ignores system and tool messages.
2. **Substantiveness filter** -- Skips trivial exchanges (greetings, acknowledgments, messages under 15 characters).
3. **Category detection** -- Classifies the conversation: debugging, architecture, pattern, solution, decision, or general.
4. **Tag extraction** -- Identifies technology tags (typescript, docker, database, auth, etc.) from conversation content.
5. **Summary building** -- Takes the last 3 substantive messages, truncates each to 500 characters, and joins them.
6. **KB save** -- Saves to TRIBE KB with a `[ClawdBot <category>]` prefix and tags line. Fire-and-forget with a 10-second timeout.

## CLI Wrapper

The plugin includes a CLI wrapper that extends the `tribe` command with additional functionality for authentication, session sync, and interaction logging.

### Authentication

```bash
tribe auth login      # Open browser for OAuth login via tribecode.ai
tribe auth status     # Check authentication status
tribe auth logout     # Clear stored credentials
tribe auth whoami     # Display current user info
tribe auth refresh    # Manually refresh access token
```

### Session Sync

```bash
tribe sync            # Sync pending sessions to tutor.tribecode.ai
tribe sync --status   # Show sync status (pending, synced, last sync time)
tribe sync --force    # Force re-upload all sessions
tribe sync --auto     # Toggle automatic background sync
```

### Interaction Logs

```bash
tribe logs            # View recent interaction logs
tribe logs --watch    # Watch logs in real-time
tribe logs --actor clawdbot  # Filter by actor (user, clawdbot, muse-leader, etc.)
tribe logs --type tool_call  # Filter by type (message, tool_call, spawn, etc.)
tribe logs --since 1h        # Show logs since 1h, 24h, or 7d
tribe logs --json            # Output as JSON
tribe logs --sessions        # List log sessions
```

### Telemetry

The CLI wrapper includes a telemetry client that sends session data to `tutor.tribecode.ai`:

- **Event Queue**: Events are batched and flushed periodically (default: every 30s or when 50 events queued)
- **Auth Token Management**: Tokens auto-refresh 5 minutes before expiry
- **Offline Support**: Events queue locally and sync when connection restores
- **Privacy**: All data goes through PII redaction before upload

### Agent Detection

The wrapper automatically detects and tags sessions based on:

| Detection Source | Examples |
|------------------|----------|
| Environment Variables | `MUSE_LEADER`, `CIRCUIT_AGENT`, `OPENAI_API_KEY` |
| CLI Flags | `--muse`, `--circuit`, `--subagent` |
| Content Patterns | "MUSE orchestration", "circuit issue #123" |

Detected agent types: `user`, `clawdbot`, `openclaw`, `subagent`, `muse-leader`, `muse-subagent`, `circuit-agent`, `system`

Detected API providers: `openai`, `anthropic`, `google`, `azure`, `cohere`, `mistral`, `groq`, `together`, `ollama`

## Architecture

```
extension/
  index.ts              # Plugin entry: tools, hooks, service registration
  clawdbot.plugin.json  # Plugin config schema
  clawdbot.d.ts         # ClawdBot plugin SDK type declarations
  lib/
    tribe-runner.ts     # CLI binary executor (spawn, timeout, JSON parsing)
    context-builder.ts  # Session + KB queries, context formatting
    knowledge-capture.ts # Conversation analysis, category/tag detection, KB save
    telemetry-client.ts # Telemetry event queue and server communication
    oauth-client.ts     # Browser-based OAuth flow for tribecode.ai
    session-sync.ts     # Session upload/download and sync state
    agent-detector.ts   # Agent type and API provider detection
    interaction-logger.ts # Multi-actor session logging
    intelligent-cache.ts  # L1/L2 caching with TTL and invalidation
    metrics-tracker.ts    # Performance metrics and anomaly detection
    pii-redactor.ts       # PII detection and redaction
  bin/
    tribe-wrapper       # CLI wrapper routing custom commands
    tribe-auth          # Authentication CLI
    tribe-sync          # Session sync CLI
    tribe-logs          # Interaction log viewer
skill/
  SKILL.md              # Skill definition for the tribe CLI
test-components.ts      # Component tests (~96 assertions)
test-e2e.ts             # End-to-end tests (~30 assertions)
test-telemetry.ts       # Telemetry client tests (35 assertions)
test-cli-wrapper.ts     # CLI wrapper integration tests (59 assertions)
```

### Data Flow

```
                    before_agent_start
User Prompt ──────────────────────────────> context-builder.ts
                                              │
                    ┌─────────────────────────┤
                    │                         │
              fetchRecentSessions()     searchKB()
                    │                         │
                    └────────┬────────────────┘
                             │
                     <tribe-context> block
                             │
                      prependContext ──────> Agent sees enriched prompt


                    agent_end
Conversation ─────────────────────────────> knowledge-capture.ts
                                              │
                                    extractTexts()
                                    isSubstantive()
                                    detectCategory()
                                    extractTags()
                                    buildSummary()
                                              │
                                    tribe kb save ──────> TRIBE KB
```

### Telemetry & Sync Flow

```
                          Session Events
interaction-logger.ts ─────────────────────> telemetry-client.ts
                                                    │
                                              Event Queue
                                              (batched)
                                                    │
                               ┌────────────────────┴────────────────────┐
                               │                                         │
                         oauth-client.ts                          session-sync.ts
                         (auth tokens)                            (session data)
                               │                                         │
                               └─────────────┬───────────────────────────┘
                                             │
                                    tutor.tribecode.ai
                                             │
                               ┌─────────────┴─────────────┐
                               │                           │
                         /api/v1/telemetry          /api/v1/sessions
```

### Agent Detection Flow

```
Environment ──────┐
                  │
CLI Args ─────────┼──────> agent-detector.ts ──────> Detection Result
                  │               │                        │
Content ──────────┘               │                        ├── agentType
                                  │                        ├── apiProvider
                            API Key Check                  ├── tags[]
                                  │                        └── confidence
                                  v
                         OPENAI_API_KEY? ──> openai
                         ANTHROPIC_API_KEY? ──> anthropic
                         GOOGLE_API_KEY? ──> google
                         ...
```

### CLI Communication

The plugin communicates with TRIBE through the binary at `~/.tribe/bin/tribe`. Each call is executed via `child_process.execFile` with:

- Configurable timeouts: fast (15s), default (30s), slow (60s), long (120s)
- 10 MB stdout buffer
- `NO_COLOR=1` environment variable for clean output parsing
- AbortSignal support for cancellation

## Privacy & Data

### What the plugin collects

- **Session metadata**: project paths, tool names, timestamps, durations, branch names
- **Knowledge base entries**: condensed summaries of substantive conversations (last 3 messages, max 500 chars each), with category and technology tags
- **No raw prompts or full conversations** are stored -- only condensed summaries that pass the substantiveness filter

### Where data lives

- **Local by default**: TRIBE stores data in an encrypted SQLite database at `~/.tribe/`
- **Cloud sync (opt-in)**: When authenticated, data syncs to tribecode.ai with end-to-end encryption and automatic PII scrubbing
- **No third-party sharing**: TRIBE does not sell data to third parties

**Local file locations:**

| File | Purpose |
|------|---------|
| `~/.tribe/config.json` | Configuration (server URLs, sync mode) |
| `~/.tribe/tutor/auth.json` | OAuth tokens and user info |
| `~/.tribe/logs/` | Interaction logs (current + archived sessions) |
| `~/.tribe/sync-state.json` | Sync state (pending, synced sessions) |
| `~/.tribe/telemetry-queue.json` | Queued telemetry events (offline support) |
| `~/.tribe/cache/` | Intelligent cache (L2 disk storage) |

### Automatic PII scrubbing

Before any data leaves your machine, TRIBE's scrubbing engine redacts:
- API keys and tokens
- Email addresses and phone numbers
- Database credentials
- Environment variables and secret file paths

### User controls

```bash
tribe disable          # Stop all telemetry collection
tribe export           # Export your data (JSON/CSV)
tribe delete --confirm # Permanently delete all data
tribe logout           # Remove authentication credentials
```

You can also disable specific plugin features via configuration:
- Set `autoContext: false` to stop context injection
- Set `autoCapture: false` to stop knowledge capture
- Set `autoSync: false` to prevent background syncing

For the full privacy policy, see [tribecode.ai/privacy](https://tribecode.ai/privacy).

## Testing

The repo includes multiple test suites that exercise the plugin against a real TRIBE CLI installation.

### Component Tests

```bash
npx tsx test-components.ts
```

Tests individual functions in isolation: JSON extraction, keyword extraction, timestamp formatting, context building, knowledge capture analysis, and plugin wiring. ~96 assertions.

### End-to-End Tests

```bash
npx tsx test-e2e.ts
```

Exercises the full pipeline with real CLI calls: session queries, context injection round-trips, knowledge capture round-trips, and graceful degradation. ~30 assertions.

### Telemetry Tests

```bash
npx tsx extension/test-telemetry.ts
```

Tests the telemetry client: event queue, batch flush, auth token management, enable/disable, and queue persistence. 35 assertions.

### CLI Wrapper Integration Tests

```bash
npx tsx extension/test-cli-wrapper.ts
```

Full integration tests for all CLI wrapper components: telemetry client, OAuth client, session sync, agent detector, and end-to-end flow. 59 assertions.

### Integration Tests

```bash
npx tsx extension/test-integrations.ts
```

Tests for PII redaction, intelligent cache, performance metrics, and knowledge hierarchy. ~65 assertions.

### Type Check

```bash
npx tsc --noEmit
```

## Development

```bash
# Clone the repo
git clone https://github.com/TRIBE-INC/openclaw.git
cd openclaw

# Install dev dependencies
npm install

# Install extension dependencies
cd extension && npm install && cd ..

# Run type check
npx tsc --noEmit

# Run tests
npx tsx test-components.ts
npx tsx test-e2e.ts
```

## Support

- **Discord**: [arena.xware.online](https://arena.xware.online/)
- **Email**: support@tribecode.ai
- **GitHub**: [github.com/TRIBE-INC](https://github.com/orgs/TRIBE-INC/)
- **Documentation**: [tribecode.ai/docs](https://tribecode.ai/docs)

## License

See [LICENSE](LICENSE) for details.
