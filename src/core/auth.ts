/**
 * Core Engine - Auth Module
 * Handles MSAL authentication for Dataverse Web API.
 */

import * as msal from '@azure/msal-node';

/** Configuration for Dataverse connection */
export interface DataverseAuthConfig {
  /** Dataverse environment URL (e.g., https://org.crm.dynamics.com) */
  environmentUrl: string;
  /** Azure AD Tenant ID */
  tenantId: string;
  /** Azure AD App Registration Client ID */
  clientId: string;
  /** Client Secret (only for client credentials flow) */
  clientSecret?: string;
}

/** Active connection with token management */
export interface DataverseConnection {
  /** The environment URL */
  environmentUrl: string;
  /** Get a valid access token (handles refresh automatically) */
  getToken(): Promise<string>;
  /** Whether the connection is active */
  isConnected: boolean;
  /** Disconnect and clear token cache */
  disconnect(): void;
}

// Default client ID for interactive login (well-known Power Platform first-party app)
const DEFAULT_CLIENT_ID = '51f81489-12ee-4a9e-aaae-a2591f45987d';

export class AuthManager {
  private ccaApp: msal.ConfidentialClientApplication | null = null;
  private pcaApp: msal.PublicClientApplication | null = null;
  private cachedToken: msal.AuthenticationResult | null = null;
  private config: DataverseAuthConfig | null = null;

  /**
   * Connect via browser sign-in (Authorization Code + PKCE).
   * Best UX: opens system browser, handles MFA/federation/conditional access.
   * Only requires the environment URL — no tenant ID or app registration.
   * @param openBrowser - callback to open a URL in the system browser
   */
  async connectWithBrowser(
    environmentUrl: string,
    openBrowser: (url: string) => Promise<void>
  ): Promise<DataverseConnection> {
    this.config = {
      environmentUrl,
      tenantId: 'organizations',
      clientId: DEFAULT_CLIENT_ID,
    };

    this.pcaApp = new msal.PublicClientApplication({
      auth: {
        clientId: DEFAULT_CLIENT_ID,
        authority: 'https://login.microsoftonline.com/organizations',
      },
    });

    const tokenRequest: msal.InteractiveRequest = {
      scopes: [`${environmentUrl}/user_impersonation`],
      openBrowser,
      prompt: 'select_account',
      successTemplate:
        '<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1e1e1e;color:#fff"><div style="text-align:center"><h1 style="color:#4ec9b0">&#10003; Signed in successfully</h1><p>You can close this browser tab and return to VS Code.</p></div></body>',
      errorTemplate:
        '<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1e1e1e;color:#fff"><div style="text-align:center"><h1 style="color:#f14c4c">&#10007; Sign-in failed</h1><p>Error: {{error}}</p></div></body>',
    };

    this.cachedToken = await this.pcaApp.acquireTokenInteractive(tokenRequest);
    if (!this.cachedToken) {
      throw new Error('Failed to acquire token via browser sign-in.');
    }

    return this.createConnection(environmentUrl);
  }

  /**
   * Connect using client credentials (app registration + secret).
   */
  async connectWithClientCredentials(config: DataverseAuthConfig): Promise<DataverseConnection> {
    if (!config.clientSecret) {
      throw new Error('Client secret is required for client credentials flow.');
    }

    this.config = config;
    const authority = `https://login.microsoftonline.com/${config.tenantId}`;

    this.ccaApp = new msal.ConfidentialClientApplication({
      auth: {
        clientId: config.clientId,
        authority,
        clientSecret: config.clientSecret,
      },
    });

    // Test the connection by acquiring a token
    await this.acquireTokenClientCredentials();

    return this.createConnection(config.environmentUrl);
  }

  /**
   * Connect using device code flow (fallback for restricted environments).
   */
  async connectWithDeviceCode(
    environmentUrl: string,
    onDeviceCode: (message: string) => void
  ): Promise<DataverseConnection> {
    this.config = {
      environmentUrl,
      tenantId: 'organizations',
      clientId: DEFAULT_CLIENT_ID,
    };

    this.pcaApp = new msal.PublicClientApplication({
      auth: {
        clientId: DEFAULT_CLIENT_ID,
        authority: 'https://login.microsoftonline.com/organizations',
      },
    });

    const tokenRequest: msal.DeviceCodeRequest = {
      scopes: [`${environmentUrl}/user_impersonation`],
      deviceCodeCallback: (response) => {
        onDeviceCode(response.message);
      },
    };

    this.cachedToken = await this.pcaApp.acquireTokenByDeviceCode(tokenRequest);
    if (!this.cachedToken) {
      throw new Error('Failed to acquire token via device code flow.');
    }

    return this.createConnection(environmentUrl);
  }

  private async acquireTokenClientCredentials(): Promise<string> {
    if (!this.ccaApp || !this.config) {
      throw new Error('Not configured for client credentials.');
    }

    const tokenRequest: msal.ClientCredentialRequest = {
      scopes: [`${this.config.environmentUrl}/.default`],
    };

    this.cachedToken = await this.ccaApp.acquireTokenByClientCredential(tokenRequest);
    if (!this.cachedToken) {
      throw new Error('Failed to acquire token via client credentials.');
    }

    return this.cachedToken.accessToken;
  }

  private createConnection(environmentUrl: string): DataverseConnection {
    let connected = true;

    return {
      environmentUrl,
      isConnected: connected,
      getToken: async () => {
        if (!connected) {
          throw new Error('Not connected to Dataverse.');
        }

        // Check if token is expired or about to expire (5 min buffer)
        if (this.cachedToken && this.cachedToken.expiresOn) {
          const expiresAt = this.cachedToken.expiresOn.getTime();
          const now = Date.now();
          const bufferMs = 5 * 60 * 1000;

          if (now >= expiresAt - bufferMs) {
            // Token expired or expiring soon, refresh
            if (this.ccaApp) {
              await this.acquireTokenClientCredentials();
            }
            // For PCA (interactive), MSAL handles silent refresh via cache
          }
        }

        if (!this.cachedToken) {
          throw new Error('No valid token available. Please reconnect.');
        }

        return this.cachedToken.accessToken;
      },
      disconnect: () => {
        connected = false;
        this.cachedToken = null;
        this.ccaApp = null;
        this.pcaApp = null;
        this.config = null;
      },
    };
  }
}
