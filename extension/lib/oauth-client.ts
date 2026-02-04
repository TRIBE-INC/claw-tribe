/**
 * OAuth Client - Browser-based OAuth flow for tribecode.ai
 *
 * Flow:
 * 1. Start local HTTP server to receive callback
 * 2. Open browser to authorization URL
 * 3. User authenticates in browser
 * 4. Receive authorization code via callback
 * 5. Exchange code for tokens
 * 6. Save tokens to ~/.tribe/tutor/auth.json
 */

import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Logger } from "./logger.js";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthConfig {
  clientId: string;
  authUrl: string;
  tokenUrl: string;
  callbackPort: number;
  scopes: string[];
  dashboardUrl: string;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  exp: number;
  expires_in: number;
  iat: number;
  token_type: string;
  user_info: {
    id: string;
    email: string;
    name: string;
  };
}

export interface AuthStatus {
  authenticated: boolean;
  userId?: string;
  email?: string;
  name?: string;
  expiresAt?: number;
  serverUrl: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_FILE = path.join(homedir(), ".tribe", "config.json");
const AUTH_FILE = path.join(homedir(), ".tribe", "tutor", "auth.json");

const DEFAULT_CONFIG: OAuthConfig = {
  clientId: "tribe-cli",
  authUrl: "https://tribecode.ai/oauth/authorize",
  tokenUrl: "https://tribecode.ai/oauth/token",
  callbackPort: 8765,
  scopes: ["openid", "profile", "email"],
  dashboardUrl: "https://tribecode.ai",
};

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// OAuthClient Class
// ---------------------------------------------------------------------------

export class OAuthClient {
  private config: OAuthConfig = DEFAULT_CONFIG;
  private tokens: OAuthTokens | null = null;
  private logger: Logger;
  private server: http.Server | null = null;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger("oauth-client");
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    try {
      // Load config to get custom URLs if set
      const data = await fs.readFile(CONFIG_FILE, "utf-8");
      const config = JSON.parse(data);

      if (config.dashboard_url) {
        this.config.dashboardUrl = config.dashboard_url;
        this.config.authUrl = `${config.dashboard_url}/oauth/authorize`;
        this.config.tokenUrl = `${config.dashboard_url}/oauth/token`;
      }

      if (config.oauth_client_id) {
        this.config.clientId = config.oauth_client_id;
      }

      if (config.oauth_callback_port) {
        this.config.callbackPort = config.oauth_callback_port;
      }
    } catch {
      // Use defaults
    }

    // Load existing tokens
    await this.loadTokens();
  }

  // ---------------------------------------------------------------------------
  // Token Management
  // ---------------------------------------------------------------------------

  async loadTokens(): Promise<OAuthTokens | null> {
    try {
      const data = await fs.readFile(AUTH_FILE, "utf-8");
      this.tokens = JSON.parse(data);
      return this.tokens;
    } catch {
      this.tokens = null;
      return null;
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.tokens = tokens;

    try {
      const dir = path.dirname(AUTH_FILE);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(AUTH_FILE, JSON.stringify(tokens, null, 2));
      this.logger.debug("Tokens saved successfully");
    } catch (error) {
      this.logger.error(`Failed to save tokens: ${error}`);
      throw error;
    }
  }

  async clearTokens(): Promise<void> {
    this.tokens = null;
    try {
      await fs.unlink(AUTH_FILE);
      this.logger.debug("Tokens cleared");
    } catch {
      // File might not exist
    }
  }

  // ---------------------------------------------------------------------------
  // Auth Status
  // ---------------------------------------------------------------------------

  async getStatus(): Promise<AuthStatus> {
    await this.loadTokens();

    const baseStatus: AuthStatus = {
      authenticated: false,
      serverUrl: this.config.dashboardUrl,
    };

    if (!this.tokens) {
      return baseStatus;
    }

    const now = Date.now();
    const expMs = this.tokens.exp * 1000;

    if (now >= expMs) {
      // Token expired, try to refresh
      const refreshed = await this.refreshToken();
      if (!refreshed) {
        return baseStatus;
      }
    }

    return {
      authenticated: true,
      userId: this.tokens.user_info.id,
      email: this.tokens.user_info.email,
      name: this.tokens.user_info.name,
      expiresAt: this.tokens.exp * 1000,
      serverUrl: this.config.dashboardUrl,
    };
  }

  isAuthenticated(): boolean {
    if (!this.tokens) return false;
    const now = Date.now();
    const expMs = this.tokens.exp * 1000;
    return now < expMs;
  }

  needsRefresh(): boolean {
    if (!this.tokens) return false;
    const now = Date.now();
    const expMs = this.tokens.exp * 1000;
    return now >= expMs - TOKEN_REFRESH_BUFFER_MS;
  }

  // ---------------------------------------------------------------------------
  // OAuth Flow
  // ---------------------------------------------------------------------------

  async login(): Promise<OAuthTokens> {
    await this.init();

    return new Promise((resolve, reject) => {
      // Generate state for CSRF protection
      const state = this.generateState();

      // Create callback URL
      const redirectUri = `http://localhost:${this.config.callbackPort}/callback`;

      // Build authorization URL
      const authParams = new URLSearchParams({
        client_id: this.config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: this.config.scopes.join(" "),
        state,
      });

      const authUrl = `${this.config.authUrl}?${authParams.toString()}`;

      // Start local server
      this.startCallbackServer(state, redirectUri)
        .then(async (code) => {
          // Exchange code for tokens
          const tokens = await this.exchangeCode(code, redirectUri);
          await this.saveTokens(tokens);
          resolve(tokens);
        })
        .catch(reject);

      // Open browser
      this.openBrowser(authUrl).catch((error) => {
        this.logger.error(`Failed to open browser: ${error}`);
        console.log(`\nPlease open this URL in your browser:\n${authUrl}\n`);
      });
    });
  }

  private startCallbackServer(expectedState: string, redirectUri: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stopServer();
        reject(new Error("Login timeout - no callback received within 5 minutes"));
      }, 5 * 60 * 1000);

      this.server = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://localhost:${this.config.callbackPort}`);

        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");

          if (error) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(this.getErrorHtml(error));
            clearTimeout(timeout);
            this.stopServer();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (state !== expectedState) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(this.getErrorHtml("Invalid state parameter"));
            clearTimeout(timeout);
            this.stopServer();
            reject(new Error("Invalid state parameter - possible CSRF attack"));
            return;
          }

          if (!code) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(this.getErrorHtml("No authorization code received"));
            clearTimeout(timeout);
            this.stopServer();
            reject(new Error("No authorization code received"));
            return;
          }

          // Success!
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(this.getSuccessHtml());
          clearTimeout(timeout);
          this.stopServer();
          resolve(code);
        } else {
          res.writeHead(404);
          res.end("Not Found");
        }
      });

      this.server.listen(this.config.callbackPort, () => {
        this.logger.debug(`Callback server listening on port ${this.config.callbackPort}`);
      });

      this.server.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private stopServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.config.clientId,
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
    }

    const tokens: OAuthTokens = await response.json();
    return tokens;
  }

  async refreshToken(): Promise<boolean> {
    if (!this.tokens?.refresh_token) {
      this.logger.debug("No refresh token available");
      return false;
    }

    try {
      const response = await fetch(this.config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.config.clientId,
          refresh_token: this.tokens.refresh_token,
        }).toString(),
      });

      if (!response.ok) {
        this.logger.error(`Token refresh failed: ${response.status}`);
        return false;
      }

      const newTokens: OAuthTokens = await response.json();
      await this.saveTokens(newTokens);
      this.logger.debug("Token refreshed successfully");
      return true;
    } catch (error) {
      this.logger.error(`Token refresh error: ${error}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Browser
  // ---------------------------------------------------------------------------

  private async openBrowser(url: string): Promise<void> {
    const platform = process.platform;

    let command: string;
    if (platform === "darwin") {
      command = `open "${url}"`;
    } else if (platform === "win32") {
      command = `start "" "${url}"`;
    } else {
      // Linux - try xdg-open, then fallback to other browsers
      command = `xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null || x-www-browser "${url}" 2>/dev/null || gnome-open "${url}" 2>/dev/null`;
    }

    await execAsync(command);
  }

  // ---------------------------------------------------------------------------
  // HTML Templates
  // ---------------------------------------------------------------------------

  private getSuccessHtml(): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <title>TribeCode - Login Successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
    }
    .icon {
      font-size: 64px;
      margin-bottom: 20px;
    }
    h1 {
      margin: 0 0 10px 0;
      font-size: 24px;
    }
    p {
      margin: 0;
      opacity: 0.9;
    }
    .close-hint {
      margin-top: 20px;
      font-size: 14px;
      opacity: 0.7;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✓</div>
    <h1>Login Successful!</h1>
    <p>You are now authenticated with TribeCode.</p>
    <p class="close-hint">You can close this window and return to your terminal.</p>
  </div>
  <script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`;
  }

  private getErrorHtml(error: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <title>TribeCode - Login Failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #f5576c 0%, #f093fb 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
    }
    .icon {
      font-size: 64px;
      margin-bottom: 20px;
    }
    h1 {
      margin: 0 0 10px 0;
      font-size: 24px;
    }
    p {
      margin: 0;
      opacity: 0.9;
    }
    .error-detail {
      margin-top: 15px;
      padding: 10px;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 8px;
      font-family: monospace;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✗</div>
    <h1>Login Failed</h1>
    <p>There was a problem authenticating with TribeCode.</p>
    <div class="error-detail">${error}</div>
  </div>
</body>
</html>`;
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  private generateState(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  getTokens(): OAuthTokens | null {
    return this.tokens;
  }

  getConfig(): OAuthConfig {
    return { ...this.config };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let oauthClientInstance: OAuthClient | null = null;

export function getOAuthClient(logger?: Logger): OAuthClient {
  if (!oauthClientInstance) {
    oauthClientInstance = new OAuthClient(logger);
  }
  return oauthClientInstance;
}

// Export for testing
export const _testing = {
  CONFIG_FILE,
  AUTH_FILE,
  DEFAULT_CONFIG,
  TOKEN_REFRESH_BUFFER_MS,
};
