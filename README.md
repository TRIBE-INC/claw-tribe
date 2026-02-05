# Muse for Moltbot

A Moltbot plugin that integrates [TribeCode](https://tribecode.ai) into your AI coding workflow. It gives your agent access to your coding history, knowledge base, and multi-agent orchestration tools -- automatically enriching every conversation with context from past sessions and capturing insights for future use.

## What It Does

**Context Injection** -- Before each agent turn, the plugin queries your TRIBE session history and knowledge base, then injects relevant context into the prompt. Your agent knows what you've been working on, which projects are active, and what patterns you've established.

**Knowledge Capture** -- After each successful conversation, the plugin analyzes the exchange, categorizes it (debugging, architecture, pattern, solution, decision), extracts technology tags, and saves a condensed summary to your TRIBE knowledge base. Future sessions automatically benefit from past insights.

**33 Tools** -- Direct access to TRIBE's full CLI from within Moltbot: search sessions, query events, manage your knowledge base, orchestrate agents with MUSE, and run autonomous issue resolution with CIRCUIT.

## Prerequisites

- [Moltbot](https://molt.bot) >= 2026.1.0
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

Add this plugin to your Moltbot configuration. The plugin is published as `@tribecode/muse`:

```json
{
  "plugins": {
    "@tribecode/muse": {}
  }
}
```

Or install via MoltHub:

```bash
npx molthub@latest install muse
```

Or clone this repo and point Moltbot at the local `extension/` directory.

### 4. Verify

Once loaded, the plugin runs a health check on startup and logs its status:

```
muse: TRIBE connected and authenticated.
muse: autoContext=true, autoCapture=true, depth=standard
```

You can also run the `muse_setup` tool from within Moltbot for guided installation and diagnostics.

## Configuration

The plugin accepts four configuration options in your Moltbot plugin config:

```json
{
  "plugins": {
    "@tribecode/muse": {
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
| `muse_setup` | Install the CLI, check authentication, report status. Safe to run multiple times. |

### Telemetry

| Tool | Description |
|------|-------------|
| `muse_enable` | Enable telemetry collection for Claude, Cursor, and Codex |
| `muse_disable` | Disable telemetry collection (preserves existing data) |
| `muse_status` | Show collection status, sync state, and connected tools |
| `muse_version` | Show CLI version and build info |

### Authentication

| Tool | Description |
|------|-------------|
| `muse_auth_status` | Check authentication state without triggering login |
| `muse_logout` | Remove stored credentials |

### Search & Query

| Tool | Parameters | Description |
|------|-----------|-------------|
| `muse_search` | `query`, `limit?`, `timeRange?`, `tool?`, `project?`, `format?` | Search across all AI coding sessions |
| `muse_recall` | `sessionId`, `format?` | Generate a detailed summary of a specific session |
| `muse_extract` | `sessionId`, `type?`, `limit?`, `format?` | Extract code, commands, files, or edits from a session |
| `muse_query_sessions` | `limit?`, `timeRange?`, `tool?`, `project?`, `format?` | List sessions with filters |
| `muse_query_insights` | `limit?`, `format?` | Query coding insights and summaries |
| `muse_query_events` | `sessionId`, `limit?`, `format?` | Query events for a specific session |

### Sessions

| Tool | Parameters | Description |
|------|-----------|-------------|
| `muse_sessions_list` | `cwd?`, `project?`, `search?`, `limit?`, `format?` | List sessions with project and search filters |
| `muse_sessions_read` | `sessionId`, `format?` | Read full session details |
| `muse_sessions_search` | `query`, `format?` | Search within session content |

### Knowledge Base

| Tool | Parameters | Description |
|------|-----------|-------------|
| `muse_kb_search` | `query` | Search the knowledge base |
| `muse_kb_list` | -- | List all KB documents |
| `muse_kb_save` | `content` | Save content to KB |
| `muse_kb_get` | `docId` | Retrieve a document by ID |
| `muse_kb_delete` | `docId` | Delete a document by ID |
| `muse_kb_stats` | -- | Show KB statistics and sync status |

### Orchestration (Interactive Agent Management)

Muse spawns and coordinates multiple subagents, each in an isolated git worktree.

| Tool | Parameters | Description |
|------|-----------|-------------|
| `muse_leader_start` | `agent?` | Start the Muse leader agent |
| `muse_spawn` | `task`, `name?`, `agent?` | Spawn a subagent with a specific task |
| `muse_orchestration_status` | `format?` | Show leader and subagent status |
| `muse_agents` | `format?` | List all registered agents |
| `muse_prompt` | `session`, `message` | Send a message to a running subagent |
| `muse_kill` | `session`, `reason?` | Kill an unresponsive subagent |

### CIRCUIT (Autonomous Issue Resolution)

CIRCUIT assigns agents to issues from a priority queue, with heartbeat monitoring and auto-recovery.

| Tool | Parameters | Description |
|------|-----------|-------------|
| `muse_circuit_list` | -- | List autonomous agent sessions |
| `muse_circuit_spawn` | `issue`, `force?` | Spawn an agent for a GitHub issue number |
| `muse_circuit_status` | -- | Quick status summary |
| `muse_circuit_metrics` | -- | Performance metrics |
| `muse_circuit_auto` | `interval?` | Auto-spawn agents by priority until queue is empty |

## How Context Injection Works

On every `before_agent_start` event (when `autoContext` is enabled):

1. **Session query** -- Fetches recent coding sessions from TRIBE. The CLI progressively widens the time range (24h -> 7d -> 30d -> all) if no sessions are found in the initial window.
2. **KB search** -- Extracts the most distinctive keyword from the user's prompt and searches the knowledge base (skipped at `minimal` depth or for prompts under 5 characters).
3. **Context block** -- Formats results into a `<muse-context>` XML block containing:
   - **Recent Activity** -- sessions with tool names, projects, timestamps, durations, and branches
   - **Relevant Knowledge** -- matching KB entries with categories
   - **Active Project** -- the most recent project and branch
4. **Injection** -- Returns the block as `prependContext`, which Moltbot adds to the agent's prompt.

The entire pipeline targets < 500ms with a 2-second hard timeout per CLI call. Session data is cached for 60 seconds.

## How Knowledge Capture Works

On every `agent_end` event (when `autoCapture` is enabled and the conversation succeeded):

1. **Text extraction** -- Pulls text from user and assistant messages, handling both string and content-block formats. Ignores system and tool messages.
2. **Substantiveness filter** -- Skips trivial exchanges (greetings, acknowledgments, messages under 15 characters).
3. **Category detection** -- Classifies the conversation: debugging, architecture, pattern, solution, decision, or general.
4. **Tag extraction** -- Identifies technology tags (typescript, docker, database, auth, etc.) from conversation content.
5. **Summary building** -- Takes the last 3 substantive messages, truncates each to 500 characters, and joins them.
6. **KB save** -- Saves to TRIBE KB with a `[Muse <category>]` prefix and tags line. Fire-and-forget with a 10-second timeout.

## Architecture

```
extension/
  index.ts              # Plugin entry: tools, hooks, service registration
  muse.plugin.json      # Plugin config schema
  moltbot.d.ts          # Moltbot plugin SDK type declarations
  lib/
    tribe-runner.ts     # CLI binary executor (spawn, timeout, JSON parsing)
    context-builder.ts  # Session + KB queries, context formatting
    knowledge-capture.ts # Conversation analysis, category/tag detection, KB save
skill/
  SKILL.md              # Skill definition for the tribe CLI
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
                     <muse-context> block
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

## Development

```bash
# Clone the repo
git clone https://github.com/TRIBE-INC/muse-extension.git
cd muse-extension

# Install dev dependencies
npm install

# Install extension dependencies
cd extension && npm install && cd ..

# Run type check
npx tsc --noEmit
```

## Support

- **Discord**: [arena.xware.online](https://arena.xware.online/)
- **Email**: support@tribecode.ai
- **GitHub**: [github.com/TRIBE-INC](https://github.com/orgs/TRIBE-INC/)
- **Documentation**: [tribecode.ai/docs](https://tribecode.ai/docs)

## License

MIT License - See [LICENSE](LICENSE) for details.
