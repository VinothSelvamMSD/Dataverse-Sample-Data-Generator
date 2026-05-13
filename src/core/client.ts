/**
 * Core Engine - Dataverse HTTP Client
 * Low-level HTTP wrapper for Dataverse Web API calls.
 */

import type { DataverseConnection } from './auth';

export interface DataverseRequestOptions {
  /** HTTP method */
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** API path (relative to /api/data/v9.2/) */
  path: string;
  /** Request body (for POST/PATCH) */
  body?: unknown;
  /** Additional headers */
  headers?: Record<string, string>;
  /** Query parameters to append */
  queryParams?: Record<string, string>;
}

export interface DataverseResponse<T = unknown> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

export interface ODataCollection<T> {
  '@odata.context'?: string;
  '@odata.count'?: number;
  '@odata.nextLink'?: string;
  value: T[];
}

const API_VERSION = 'v9.2';

export class DataverseClient {
  private connection: DataverseConnection;
  private _baseUrl: string;

  constructor(connection: DataverseConnection) {
    this.connection = connection;
    // Ensure no trailing slash on env URL
    const envUrl = connection.environmentUrl.replace(/\/+$/, '');
    this._baseUrl = `${envUrl}/api/data/${API_VERSION}`;
  }

  /** The base URL for the Dataverse Web API (e.g., https://org.crm.dynamics.com/api/data/v9.2) */
  get baseUrl(): string {
    return this._baseUrl;
  }

  /**
   * Execute a single request against the Dataverse Web API.
   */
  async request<T = unknown>(options: DataverseRequestOptions): Promise<DataverseResponse<T>> {
    const token = await this.connection.getToken();

    let url = `${this._baseUrl}/${options.path}`;
    if (options.queryParams) {
      const params = new URLSearchParams(options.queryParams);
      url += `?${params.toString()}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      ...options.headers,
    };

    if (options.body) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (err: unknown) {
      const cause = (err as { cause?: Error })?.cause;
      const detail = cause ? `${(err as Error).message}: ${cause.message}` : (err as Error).message;
      throw new DataverseApiError(
        `Network error calling ${options.method} ${options.path}: ${detail}`,
        0
      );
    }

    // Parse response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Handle different response scenarios
    if (response.status === 204) {
      // No content (success for DELETE, some PATCH)
      return { status: response.status, data: {} as T, headers: responseHeaders };
    }

    if (!response.ok) {
      const errorBody = await response.text();
      let errorMessage = `Dataverse API error: ${response.status} ${response.statusText}`;
      try {
        const errorJson = JSON.parse(errorBody);
        if (errorJson.error?.message) {
          errorMessage = errorJson.error.message;
        }
      } catch {
        // Plain text error
        if (errorBody) {
          errorMessage += ` - ${errorBody}`;
        }
      }
      throw new DataverseApiError(errorMessage, response.status);
    }

    const data = (await response.json()) as T;
    return { status: response.status, data, headers: responseHeaders };
  }

  /**
   * GET with automatic pagination (follows @odata.nextLink).
   */
  async getAll<T>(path: string, queryParams?: Record<string, string>): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | undefined;

    // First request
    const firstResponse = await this.request<ODataCollection<T>>({
      method: 'GET',
      path,
      queryParams,
    });
    results.push(...firstResponse.data.value);
    nextUrl = firstResponse.data['@odata.nextLink'];

    // Follow pagination
    while (nextUrl) {
      const token = await this.connection.getToken();
      let response: Response;
      try {
        response = await fetch(nextUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'OData-MaxVersion': '4.0',
            'OData-Version': '4.0',
          },
        });
      } catch (err: unknown) {
        const cause = (err as { cause?: Error })?.cause;
        const detail = cause ? `${(err as Error).message}: ${cause.message}` : (err as Error).message;
        throw new DataverseApiError(`Pagination network error: ${detail}`, 0);
      }

      if (!response.ok) {
        throw new DataverseApiError(
          `Pagination error: ${response.status} ${response.statusText}`,
          response.status
        );
      }

      const data = (await response.json()) as ODataCollection<T>;
      results.push(...data.value);
      nextUrl = data['@odata.nextLink'];
    }

    return results;
  }

  /**
   * Execute a $batch request with multiple operations.
   * Returns the individual response statuses and bodies.
   */
  async batch(operations: BatchOperation[]): Promise<BatchResponse[]> {
    const batchId = `batch_${crypto.randomUUID()}`;

    // Build multipart body — each operation in its own changeset
    // to avoid SQL timeouts on complex entities with plugins/workflows.
    let body = '';

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      const changesetId = `changeset_${crypto.randomUUID()}`;

      body += `--${batchId}\r\n`;
      body += `Content-Type: multipart/mixed; boundary=${changesetId}\r\n\r\n`;

      body += `--${changesetId}\r\n`;
      body += `Content-Type: application/http\r\n`;
      body += `Content-Transfer-Encoding: binary\r\n`;
      body += `Content-ID: ${i + 1}\r\n\r\n`;

      const opUrl = `${this._baseUrl}/${op.path}`;
      body += `${op.method} ${opUrl} HTTP/1.1\r\n`;
      body += `Content-Type: application/json\r\n`;
      body += `Accept: application/json\r\n\r\n`;

      if (op.body) {
        body += JSON.stringify(op.body);
      }
      body += `\r\n`;
      body += `--${changesetId}--\r\n`;
    }

    body += `--${batchId}--\r\n`;

    const token = await this.connection.getToken();
    let response: Response;
    try {
      response = await fetch(`${this._baseUrl}/$batch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/mixed; boundary=${batchId}`,
          Accept: 'application/json',
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
        },
        body,
      });
    } catch (err: unknown) {
      const cause = (err as { cause?: Error })?.cause;
      const detail = cause ? `${(err as Error).message}: ${cause.message}` : (err as Error).message;
      throw new DataverseApiError(`Batch network error: ${detail}`, 0);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new DataverseApiError(`Batch request failed: ${response.status} - ${errorText}`, response.status);
    }

    // Parse batch response
    const responseText = await response.text();
    return this.parseBatchResponse(responseText);
  }

  private parseBatchResponse(responseText: string): BatchResponse[] {
    const results: BatchResponse[] = [];

    // Split by any boundary (batch or changeset response boundaries)
    const parts = responseText.split(/--(?:batchresponse|changesetresponse)_[a-f0-9-]+/);

    for (const part of parts) {
      // Look for HTTP status lines within individual response parts
      const statusMatch = part.match(/HTTP\/1\.1 (\d+)/);
      if (!statusMatch) {
        continue;
      }

      // Skip parts that are just changeset headers (Content-Type: multipart/mixed)
      if (part.includes('Content-Type: multipart/mixed')) {
        continue;
      }

      const status = parseInt(statusMatch[1], 10);
      let body: unknown = null;
      let entityId: string | undefined;

      // Extract OData-EntityId header (for created records)
      const entityIdMatch = part.match(/OData-EntityId:\s*(.+)/i);
      if (entityIdMatch) {
        const idUrl = entityIdMatch[1].trim();
        const guidMatch = idUrl.match(/\(([a-fA-F0-9-]+)\)/);
        if (guidMatch) {
          entityId = guidMatch[1].toLowerCase();
        }
      }

      // Extract JSON body — find the first complete JSON object after headers
      const headerBodySplit = part.split(/\r?\n\r?\n/);
      const bodySection = headerBodySplit.slice(2).join('\n\n'); // Skip HTTP line + headers
      if (bodySection.trim()) {
        const jsonMatch = bodySection.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            body = JSON.parse(jsonMatch[0]);
          } catch {
            // Not valid JSON, skip
          }
        }
      }

      results.push({ status, body, entityId });
    }

    return results;
  }
}

export interface BatchOperation {
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

export interface BatchResponse {
  status: number;
  body: unknown;
  entityId?: string;
}

export class DataverseApiError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = 'DataverseApiError';
  }
}
