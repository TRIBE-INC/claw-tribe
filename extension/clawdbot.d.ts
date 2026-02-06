declare module "clawdbot/plugin-sdk" {
  export interface ClawdbotPluginApi {
    id: string;
    name: string;
    version: string;
    description: string;
    source: string;
    config: Record<string, unknown>;
    pluginConfig: unknown;
    runtime: {
      tools: Record<string, unknown>;
    };
    logger: {
      info(msg: string): void;
      warn(msg: string): void;
      error(msg: string): void;
      debug(msg: string): void;
    };

    registerTool(
      definition:
        | {
            name: string;
            label?: string;
            description: string;
            parameters: unknown;
            execute(
              toolCallId: string,
              params: Record<string, unknown>,
            ): Promise<{
              content: Array<{ type: "text"; text: string }>;
              details?: unknown;
            }>;
          }
        | ((ctx: {
            config: Record<string, unknown>;
            sessionKey: string;
            sandboxed: boolean;
          }) => unknown | null),
      options?: { name?: string; names?: string[]; optional?: boolean },
    ): void;

    registerCli(
      factory: (ctx: { program: unknown }) => void,
      options?: { commands: string[] },
    ): void;

    registerService(definition: {
      id: string;
      start(ctx?: {
        config: Record<string, unknown>;
        workspaceDir: string;
        stateDir: string;
        logger: {
          info(msg: string): void;
          warn(msg: string): void;
          error(msg: string): void;
          debug(msg: string): void;
        };
      }): void;
      stop?(ctx?: {
        config: Record<string, unknown>;
        workspaceDir: string;
        stateDir: string;
        logger: {
          info(msg: string): void;
          warn(msg: string): void;
          error(msg: string): void;
          debug(msg: string): void;
        };
      }): void;
    }): void;

    // ---------------------------------------------------------------------------
    // Lifecycle hooks
    // ---------------------------------------------------------------------------

    on(
      event: "before_agent_start",
      handler: (event: {
        prompt: string;
      }) => Promise<
        | { prependContext?: string; systemPromptAppend?: string }
        | undefined
        | void
      >,
    ): void;

    on(
      event: "agent_end",
      handler: (event: {
        success: boolean;
        messages: unknown[];
      }) => Promise<void>,
    ): void;

    on(event: string, handler: (...args: unknown[]) => unknown): void;
  }

  export function emptyPluginConfigSchema(): {
    type: "object";
    additionalProperties: false;
    properties: Record<string, never>;
  };
}
