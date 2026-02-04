/**
 * Agent Detector - Auto-detect and tag agent types and API providers
 *
 * Detection sources:
 * - Environment variables (MUSE_LEADER, CIRCUIT_AGENT, etc.)
 * - CLI flags (--muse, --circuit)
 * - Content patterns in messages
 * - API key presence
 */

import type { ActorType } from "./interaction-logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSignature {
  type: ActorType;
  priority: number; // Higher = checked first
  patterns: {
    envVars?: string[];
    cliFlags?: string[];
    contentPatterns?: RegExp[];
    processNamePatterns?: RegExp[];
  };
}

export type ApiProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "azure"
  | "cohere"
  | "mistral"
  | "groq"
  | "together"
  | "ollama"
  | "local"
  | "unknown";

export interface DetectionResult {
  agentType: ActorType;
  apiProvider: ApiProvider;
  tags: string[];
  confidence: "high" | "medium" | "low";
  detectedFrom: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_SIGNATURES: AgentSignature[] = [
  {
    type: "muse-leader",
    priority: 100,
    patterns: {
      envVars: ["MUSE_LEADER", "MUSE_ENABLED", "TRIBE_MUSE_LEADER"],
      cliFlags: ["--muse-leader", "--muse", "-m"],
      contentPatterns: [
        /MUSE\s+orchestrat/i,
        /multi-agent\s+leader/i,
        /coordinating\s+subagents/i,
      ],
    },
  },
  {
    type: "muse-subagent",
    priority: 90,
    patterns: {
      envVars: ["MUSE_SUBAGENT", "MUSE_AGENT_ID", "TRIBE_MUSE_SUBAGENT"],
      cliFlags: ["--muse-subagent", "--subagent"],
      contentPatterns: [
        /MUSE\s+subagent/i,
        /spawned\s+by\s+MUSE/i,
        /reporting\s+to\s+leader/i,
      ],
    },
  },
  {
    type: "circuit-agent",
    priority: 85,
    patterns: {
      envVars: ["CIRCUIT_AGENT", "CIRCUIT_MODE", "TRIBE_CIRCUIT", "CIRCUIT_ISSUE"],
      cliFlags: ["--circuit", "-c", "--autonomous"],
      contentPatterns: [
        /circuit\s+.*issue/i,
        /autonomous\s+.*resolve/i,
        /github\s+issue\s+#\d+/i,
        /working\s+on\s+issue/i,
      ],
    },
  },
  {
    type: "subagent",
    priority: 50,
    patterns: {
      envVars: ["SUBAGENT", "AGENT_TYPE", "TRIBE_SUBAGENT"],
      cliFlags: ["--subagent", "--agent"],
      contentPatterns: [
        /subagent\s+task/i,
        /delegated\s+task/i,
      ],
    },
  },
  {
    type: "openclaw",
    priority: 40,
    patterns: {
      envVars: ["OPENCLAW", "OPENCLAW_MODE", "TRIBE_OPENCLAW"],
      cliFlags: ["--openclaw"],
      contentPatterns: [
        /openclaw\s+context/i,
        /knowledge\s+provider/i,
      ],
    },
  },
  {
    type: "clawdbot",
    priority: 30,
    patterns: {
      envVars: ["CLAWDBOT", "CLAWDBOT_MODE", "TRIBE_CLAWDBOT"],
      cliFlags: ["--clawdbot"],
      contentPatterns: [
        /clawdbot\s+assistant/i,
      ],
    },
  },
];

const API_KEY_ENV_VARS: Record<ApiProvider, string[]> = {
  openai: ["OPENAI_API_KEY", "OPENAI_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_AI_API_KEY"],
  azure: ["AZURE_OPENAI_KEY", "AZURE_OPENAI_API_KEY", "AZURE_API_KEY"],
  cohere: ["COHERE_API_KEY", "CO_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  together: ["TOGETHER_API_KEY", "TOGETHERAI_API_KEY"],
  ollama: ["OLLAMA_HOST", "OLLAMA_API_BASE"],
  local: ["LOCAL_LLM_API_KEY", "LLM_API_BASE"],
  unknown: [],
};

const PROVIDER_MODEL_PATTERNS: Record<ApiProvider, RegExp[]> = {
  openai: [/gpt-4/i, /gpt-3\.5/i, /davinci/i, /text-embedding/i],
  anthropic: [/claude/i, /opus/i, /sonnet/i, /haiku/i],
  google: [/gemini/i, /palm/i, /bard/i],
  azure: [/azure/i],
  cohere: [/command/i, /cohere/i],
  mistral: [/mistral/i, /mixtral/i],
  groq: [/groq/i, /llama.*groq/i],
  together: [/together/i],
  ollama: [/ollama/i, /llama.*local/i],
  local: [/local/i, /localhost/i],
  unknown: [],
};

// ---------------------------------------------------------------------------
// AgentDetector Class
// ---------------------------------------------------------------------------

export class AgentDetector {
  private cachedResult: DetectionResult | null = null;
  private cliArgs: string[] = [];
  private contextContent: string = "";

  constructor(options?: { cliArgs?: string[]; contextContent?: string }) {
    this.cliArgs = options?.cliArgs || process.argv.slice(2);
    this.contextContent = options?.contextContent || "";
  }

  // ---------------------------------------------------------------------------
  // Main Detection
  // ---------------------------------------------------------------------------

  detect(): DetectionResult {
    if (this.cachedResult) {
      return this.cachedResult;
    }

    const detectedFrom: string[] = [];
    let agentType: ActorType = "clawdbot"; // Default
    let confidence: "high" | "medium" | "low" = "low";

    // Sort signatures by priority (highest first)
    const sortedSignatures = [...AGENT_SIGNATURES].sort((a, b) => b.priority - a.priority);

    // Check each signature
    for (const signature of sortedSignatures) {
      const envMatch = this.checkEnvVars(signature.patterns.envVars);
      if (envMatch) {
        agentType = signature.type;
        confidence = "high";
        detectedFrom.push(`env:${envMatch}`);
        break;
      }

      const cliMatch = this.checkCliFlags(signature.patterns.cliFlags);
      if (cliMatch) {
        agentType = signature.type;
        confidence = "high";
        detectedFrom.push(`cli:${cliMatch}`);
        break;
      }

      const contentMatch = this.checkContentPatterns(signature.patterns.contentPatterns);
      if (contentMatch) {
        agentType = signature.type;
        confidence = "medium";
        detectedFrom.push(`content:${contentMatch}`);
        break;
      }
    }

    // Detect API provider
    const apiProvider = this.detectApiProvider();
    if (apiProvider !== "unknown") {
      detectedFrom.push(`api:${apiProvider}`);
    }

    // Generate tags
    const tags = this.generateTags(agentType, apiProvider);

    this.cachedResult = {
      agentType,
      apiProvider,
      tags,
      confidence,
      detectedFrom,
    };

    return this.cachedResult;
  }

  // ---------------------------------------------------------------------------
  // Detection Methods
  // ---------------------------------------------------------------------------

  private checkEnvVars(envVars?: string[]): string | null {
    if (!envVars) return null;

    for (const envVar of envVars) {
      const value = process.env[envVar];
      if (value && value !== "false" && value !== "0") {
        return envVar;
      }
    }

    return null;
  }

  private checkCliFlags(flags?: string[]): string | null {
    if (!flags) return null;

    for (const flag of flags) {
      if (this.cliArgs.includes(flag)) {
        return flag;
      }
    }

    return null;
  }

  private checkContentPatterns(patterns?: RegExp[]): string | null {
    if (!patterns || !this.contextContent) return null;

    for (const pattern of patterns) {
      if (pattern.test(this.contextContent)) {
        return pattern.source.substring(0, 20);
      }
    }

    return null;
  }

  detectApiProvider(): ApiProvider {
    // Check environment variables first (most reliable)
    for (const [provider, envVars] of Object.entries(API_KEY_ENV_VARS) as [ApiProvider, string[]][]) {
      if (provider === "unknown") continue;

      for (const envVar of envVars) {
        if (process.env[envVar]) {
          return provider;
        }
      }
    }

    // Check content for model mentions
    if (this.contextContent) {
      for (const [provider, patterns] of Object.entries(PROVIDER_MODEL_PATTERNS) as [ApiProvider, RegExp[]][]) {
        if (provider === "unknown") continue;

        for (const pattern of patterns) {
          if (pattern.test(this.contextContent)) {
            return provider;
          }
        }
      }
    }

    return "unknown";
  }

  // ---------------------------------------------------------------------------
  // Convenience Methods
  // ---------------------------------------------------------------------------

  detectFromEnvironment(): ActorType {
    return this.detect().agentType;
  }

  detectFromCliArgs(args: string[]): ActorType {
    this.cliArgs = args;
    this.cachedResult = null;
    return this.detect().agentType;
  }

  detectFromContent(content: string): ActorType {
    this.contextContent = content;
    this.cachedResult = null;
    return this.detect().agentType;
  }

  getAgentTags(): string[] {
    return this.detect().tags;
  }

  // ---------------------------------------------------------------------------
  // Tag Generation
  // ---------------------------------------------------------------------------

  private generateTags(agentType: ActorType, apiProvider: ApiProvider): string[] {
    const tags: string[] = [];

    // Agent type tag
    tags.push(`agent:${agentType}`);

    // API provider tag
    if (apiProvider !== "unknown") {
      tags.push(`provider:${apiProvider}`);
    }

    // Platform tag
    tags.push(`platform:${process.platform}`);

    // Node version tag (major only)
    const nodeVersion = process.version.split(".")[0];
    tags.push(`node:${nodeVersion}`);

    // Detect if running in CI
    if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.GITLAB_CI) {
      tags.push("env:ci");
    } else {
      tags.push("env:local");
    }

    // Detect if running in container
    if (process.env.DOCKER || process.env.KUBERNETES_SERVICE_HOST) {
      tags.push("container:true");
    }

    // Detect terminal type
    if (process.env.TERM_PROGRAM) {
      tags.push(`terminal:${process.env.TERM_PROGRAM.toLowerCase()}`);
    }

    return tags;
  }

  // ---------------------------------------------------------------------------
  // Static Utilities
  // ---------------------------------------------------------------------------

  static getAvailableApiProviders(): ApiProvider[] {
    const providers: ApiProvider[] = [];

    for (const [provider, envVars] of Object.entries(API_KEY_ENV_VARS) as [ApiProvider, string[]][]) {
      if (provider === "unknown") continue;

      for (const envVar of envVars) {
        if (process.env[envVar]) {
          providers.push(provider);
          break;
        }
      }
    }

    return providers;
  }

  static isAgentType(type: string): type is ActorType {
    const validTypes: ActorType[] = [
      "user",
      "clawdbot",
      "openclaw",
      "subagent",
      "muse-leader",
      "muse-subagent",
      "circuit-agent",
      "system",
    ];
    return validTypes.includes(type as ActorType);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let agentDetectorInstance: AgentDetector | null = null;

export function getAgentDetector(options?: { cliArgs?: string[]; contextContent?: string }): AgentDetector {
  if (!agentDetectorInstance) {
    agentDetectorInstance = new AgentDetector(options);
  }
  return agentDetectorInstance;
}

// Export for testing
export const _testing = {
  AGENT_SIGNATURES,
  API_KEY_ENV_VARS,
  PROVIDER_MODEL_PATTERNS,
};
