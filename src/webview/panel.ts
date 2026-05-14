/**
 * Webview Panel — Dataverse Sample Data Generator UI.
 * Manages the lifecycle of the webview and message passing.
 */

import * as vscode from 'vscode';
import type { DataverseConnection, TableMetadata, RunResult, ColumnMetadata, CleanupResult, DeletionPlan } from '../core';
import { AuthManager, DataverseClient, MetadataReader, DependencyPlanner, DataGenerator, AIDataGenerator, Writer, RecordCleaner } from '../core';
import { isSystemField } from '../core/system-fields';

/** Column mode options */
export type ColumnMode = 'best' | 'mandatory' | 'selected';

/** Per-table configuration from the UI */
export interface TableConfig {
  logicalName: string;
  displayName: string;
  recordCount: number;
  columnMode: ColumnMode;
  selectedColumns?: string[];
  tableContext?: string;
}

/** Messages FROM webview → extension */
type WebviewMessage =
  | { type: 'connect'; envUrl: string; authMethod: string }
  | { type: 'disconnect' }
  | { type: 'loadTables' }
  | { type: 'loadColumns'; tableName: string }
  | { type: 'generate'; tables: TableConfig[]; context?: string }
  | { type: 'analyzeDocument' }
  | { type: 'cleanupPlan'; tables: Array<{ logicalName: string; recordCount: number; sortOrder: string; fetchXml?: string }> }
  | { type: 'cleanupExecute' }
  | { type: 'cleanupRecordCount'; tableName: string }
  | { type: 'ready' };

/** Messages FROM extension → webview */
type ExtensionMessage =
  | { type: 'connectionStatus'; connected: boolean; envUrl?: string }
  | { type: 'tables'; tables: Array<{ logicalName: string; displayName: string; description?: string }> }
  | { type: 'columns'; tableName: string; columns: Array<{ logicalName: string; displayName: string; description?: string; attributeType: string; isRequired: boolean; maxLength?: number }> }
  | { type: 'progress'; message: string; percentage?: number }
  | { type: 'result'; result: RunResult; tableDataSources?: Record<string, { source: string; error?: string }> }
  | { type: 'documentContext'; context: string; suggestedTables?: string[] }
  | { type: 'cleanupPlan'; plan: { steps: Array<{ order: number; logicalName: string; displayName: string; recordCount: number; sortOrder: string; fetchXml?: string; reason: string }>; summary: string } }
  | { type: 'cleanupResult'; result: CleanupResult }
  | { type: 'cleanupRecordCount'; tableName: string; count: number }
  | { type: 'error'; message: string }
  | { type: 'log'; message: string };

export class DataverseWebviewPanel {
  public static currentPanel: DataverseWebviewPanel | undefined;
  private static readonly viewType = 'dvdata.webview';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  // Shared state
  private _authManager: AuthManager;
  private _connection: DataverseConnection | null = null;
  private _outputChannel: vscode.OutputChannel;
  private _tablesMetadataCache = new Map<string, TableMetadata>();
  private _pendingCleanupPlan: DeletionPlan | null = null;
  private _pendingCleanupMetadata: Map<string, TableMetadata> | null = null;

  public static createOrShow(
    extensionUri: vscode.Uri,
    outputChannel: vscode.OutputChannel,
    existingConnection?: DataverseConnection | null
  ) {
    const column = vscode.ViewColumn.One;

    if (DataverseWebviewPanel.currentPanel) {
      DataverseWebviewPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      DataverseWebviewPanel.viewType,
      'Dataverse Sample Data Generator',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    DataverseWebviewPanel.currentPanel = new DataverseWebviewPanel(
      panel, extensionUri, outputChannel, existingConnection ?? null
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    outputChannel: vscode.OutputChannel,
    existingConnection: DataverseConnection | null
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._outputChannel = outputChannel;
    this._authManager = new AuthManager();
    this._connection = existingConnection;

    this._panel.webview.html = this._getHtmlForWebview();

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this._handleMessage(message),
      null,
      this._disposables
    );

    // Cleanup on dispose
    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
  }

  /** Expose connection for the main extension to pick up */
  public get connection(): DataverseConnection | null {
    return this._connection;
  }

  private _postMessage(message: ExtensionMessage) {
    this._panel.webview.postMessage(message);
  }

  private _log(msg: string) {
    const ts = new Date().toISOString();
    this._outputChannel.appendLine(`[${ts}] [UI] ${msg}`);
  }

  private async _handleMessage(message: WebviewMessage) {
    switch (message.type) {
      case 'ready':
        // Send current connection status when webview loads
        this._postMessage({
          type: 'connectionStatus',
          connected: !!this._connection?.isConnected,
          envUrl: this._connection?.environmentUrl,
        });
        break;

      case 'connect':
        await this._handleConnect(message.envUrl, message.authMethod);
        break;

      case 'disconnect':
        this._handleDisconnect();
        break;

      case 'loadTables':
        await this._handleLoadTables();
        break;

      case 'loadColumns':
        await this._handleLoadColumns(message.tableName);
        break;

      case 'generate':
        await this._handleGenerate(message.tables, message.context);
        break;

      case 'analyzeDocument':
        await this._handleAnalyzeDocument();
        break;

      case 'cleanupPlan':
        await this._handleCleanupPlan(message.tables);
        break;

      case 'cleanupExecute':
        await this._handleCleanupExecute();
        break;

      case 'cleanupRecordCount':
        await this._handleCleanupRecordCount(message.tableName);
        break;
    }
  }

  private async _handleConnect(envUrl: string, authMethod: string) {
    try {
      this._postMessage({ type: 'progress', message: 'Connecting...' });

      const normalizedUrl = envUrl.replace(/\/+$/, '');

      if (authMethod === 'browser') {
        this._connection = await this._authManager.connectWithBrowser(normalizedUrl, async (url) => {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        });
      } else if (authMethod === 'deviceCode') {
        this._connection = await this._authManager.connectWithDeviceCode(normalizedUrl, (msg) => {
          vscode.window.showInformationMessage(msg);
        });
      }

      this._log(`Connected to ${normalizedUrl}`);
      this._postMessage({ type: 'connectionStatus', connected: true, envUrl: normalizedUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log(`Connection failed: ${msg}`);
      this._postMessage({ type: 'error', message: `Connection failed: ${msg}` });
      this._postMessage({ type: 'connectionStatus', connected: false });
    }
  }

  private _handleDisconnect() {
    if (this._connection) {
      this._connection.disconnect();
      this._connection = null;
      this._tablesMetadataCache.clear();
    }
    this._postMessage({ type: 'connectionStatus', connected: false });
  }

  private async _handleLoadTables() {
    if (!this._connection) {
      this._postMessage({ type: 'error', message: 'Not connected.' });
      return;
    }

    try {
      this._postMessage({ type: 'progress', message: 'Loading tables...' });
      const client = new DataverseClient(this._connection);
      const reader = new MetadataReader(client);
      const tables = await reader.getSelectableTables();

      this._postMessage({
        type: 'tables',
        tables: tables.map((t) => ({
          logicalName: t.logicalName,
          displayName: t.displayName,
          description: (t as any).description,
        })),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._postMessage({ type: 'error', message: `Failed to load tables: ${msg}` });
    }
  }

  private async _handleLoadColumns(tableName: string) {
    if (!this._connection) {
      this._postMessage({ type: 'error', message: 'Not connected.' });
      return;
    }

    try {
      const client = new DataverseClient(this._connection);
      const reader = new MetadataReader(client);

      let metadata = this._tablesMetadataCache.get(tableName);
      if (!metadata) {
        metadata = await reader.getTableMetadata(tableName);
        this._tablesMetadataCache.set(tableName, metadata);
      }

      // Filter to user-populatable columns
      const columns = metadata.columns.filter((col) => {
        if (col.logicalName === metadata!.primaryIdAttribute) return false;
        if (['State', 'Status'].includes(col.attributeType)) return false;
        if (['Lookup', 'Customer', 'Owner'].includes(col.attributeType)) return false;
        if (col.attributeType === 'Uniqueidentifier') return false;
        if (col.isAutoNumber) return false;
        if (col.isComputed) return false;
        if (isSystemField(col.logicalName)) return false;
        return true;
      });

      this._postMessage({
        type: 'columns',
        tableName,
        columns: columns.map((c) => ({
          logicalName: c.logicalName,
          displayName: c.displayName,
          description: c.description,
          attributeType: c.attributeType,
          isRequired: c.isRequired,
          maxLength: c.maxLength,
        })),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._postMessage({ type: 'error', message: `Failed to load columns for ${tableName}: ${msg}` });
    }
  }

  private async _handleGenerate(tableConfigs: TableConfig[], businessContext?: string) {
    if (!this._connection) {
      this._postMessage({ type: 'error', message: 'Not connected.' });
      return;
    }

    // Show output channel so user can see AI logs
    this._outputChannel.show(true);
    this._log(`=== Generation started ===`);
    this._log(`Business context: ${businessContext || '(none)'}`);
    this._log(`Tables: ${tableConfigs.map((t) => t.logicalName + ' (' + t.recordCount + ' records)').join(', ')}`);

    try {
      const client = new DataverseClient(this._connection);
      const reader = new MetadataReader(client);
      const config = vscode.workspace.getConfiguration('dvdata');
      const batchSize = config.get<number>('batchSize') || 100;

      // Step 1: Load metadata for all tables (with retry)
      this._postMessage({ type: 'progress', message: 'Loading metadata...' });
      const tableNames = tableConfigs.map((t) => t.logicalName);
      const tablesMetadata = new Map<string, TableMetadata>();

      for (const name of tableNames) {
        let meta = this._tablesMetadataCache.get(name);
        if (!meta) {
          this._postMessage({ type: 'progress', message: `Loading metadata for ${name}...` });
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              meta = await reader.getTableMetadata(name);
              break;
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              this._log(`[Meta] Attempt ${attempt} failed for ${name}: ${errMsg}`);
              if (attempt === 2) throw new Error(`Failed to load metadata for "${name}" after 2 attempts: ${errMsg}`);
            }
          }
          this._tablesMetadataCache.set(name, meta!);
        }
        tablesMetadata.set(name, meta!);
      }

      const recordCounts = new Map(tableConfigs.map((t) => [t.logicalName, t.recordCount]));

      // Step 2: Auto-resolve required lookup dependencies
      this._postMessage({ type: 'progress', message: 'Resolving dependencies...' });
      await this._resolveRequiredDependencies(tableNames, tablesMetadata, recordCounts, reader);

      // Step 3: Build plan
      const planner = new DependencyPlanner();
      const plan = planner.buildPlan(tablesMetadata, recordCounts);

      // Step 4: Build column filter map from user config
      const columnFilterMap = new Map<string, { mode: ColumnMode; selected?: string[] }>();
      for (const tc of tableConfigs) {
        columnFilterMap.set(tc.logicalName, {
          mode: tc.columnMode,
          selected: tc.selectedColumns,
        });
      }

      // Step 4b: Build per-table context map
      const tableContextMap = new Map<string, string>();
      for (const tc of tableConfigs) {
        if (tc.tableContext) {
          tableContextMap.set(tc.logicalName, tc.tableContext);
        }
      }

      // Step 5: Create record provider with column filtering
      const { provider, dataSource, modelName, tableDataSources } =
        await this._createRecordProvider(businessContext, tablesMetadata, columnFilterMap, tableContextMap);

      this._log(`Data source: ${dataSource === 'ai' ? `AI (${modelName})` : 'Faker.js'}`);
      this._postMessage({ type: 'progress', message: `Generating data via ${dataSource === 'ai' ? 'AI' : 'Faker'}...` });

      // Step 6: Execute
      const writer = new Writer(client, batchSize);
      const result = await writer.execute(
        plan,
        tablesMetadata,
        provider,
        this._connection.environmentUrl,
        (message, percentage) => {
          this._postMessage({ type: 'progress', message, percentage });
        }
      );

      // Step 7: Send result
      const sourcesObj: Record<string, { source: string; error?: string }> = {};
      if (tableDataSources) {
        for (const [k, v] of tableDataSources) {
          sourcesObj[k] = v;
        }
      }

      this._postMessage({
        type: 'result',
        result,
        tableDataSources: sourcesObj,
      });

      this._log(`Generation complete: ${result.totalCreated} created, ${result.totalFailed} failed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log(`Generation failed: ${msg}`);
      this._postMessage({ type: 'error', message: `Generation failed: ${msg}` });
    }
  }

  private async _resolveRequiredDependencies(
    userTables: string[],
    tablesMetadata: Map<string, TableMetadata>,
    recordCounts: Map<string, number>,
    reader: MetadataReader
  ) {
    const resolved = new Set<string>([...tablesMetadata.keys()]);
    const toResolve = [...userTables];

    while (toResolve.length > 0) {
      const tableName = toResolve.pop()!;
      const meta = tablesMetadata.get(tableName);
      if (!meta) continue;

      for (const rel of meta.manyToOneRelationships) {
        const parent = rel.referencedEntity;
        if (parent === tableName || resolved.has(parent)) continue;

        const col = meta.columns.find((c) => c.logicalName === rel.referencingAttribute);
        if (col?.attributeType === 'Owner') continue;
        if (!(col?.isRequired ?? false)) continue;

        try {
          const parentMeta = await reader.getTableMetadata(parent);
          if (!parentMeta.isCreatable) {
            resolved.add(parent);
            continue;
          }
          this._log(`Auto-including "${parent}" — required by "${tableName}.${rel.referencingAttribute}"`);
          tablesMetadata.set(parent, parentMeta);
          this._tablesMetadataCache.set(parent, parentMeta);
          const childCount = recordCounts.get(tableName) || 1;
          recordCounts.set(parent, Math.min(Math.max(1, Math.ceil(childCount / 2)), 10));
          resolved.add(parent);
          toResolve.push(parent);
        } catch {
          resolved.add(parent);
        }
      }
    }
  }

  // ─── Cleanup Handlers ───────────────────────────────────────

  private async _handleCleanupRecordCount(tableName: string) {
    if (!this._connection) return;

    try {
      const client = new DataverseClient(this._connection);
      let meta = this._tablesMetadataCache.get(tableName);
      if (!meta) {
        const reader = new MetadataReader(client);
        meta = await reader.getTableMetadata(tableName);
        this._tablesMetadataCache.set(tableName, meta);
      }

      const cleaner = new RecordCleaner(client);
      const count = await cleaner.getRecordCount(meta.entitySetName);
      this._postMessage({ type: 'cleanupRecordCount', tableName, count });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log(`[Cleanup] Record count failed for ${tableName}: ${msg}`);
      this._postMessage({ type: 'cleanupRecordCount', tableName, count: -1 });
    }
  }

  private async _handleAnalyzeDocument() {
    // Let user pick a document file
    const fileUris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: {
        'Documents': ['txt', 'md', 'pdf', 'docx', 'doc'],
        'All Files': ['*'],
      },
      title: 'Select a document to extract business context',
    });

    if (!fileUris || fileUris.length === 0) return;

    const fileUri = fileUris[0];
    const fileName = fileUri.fsPath.split(/[\\/]/).pop() || 'document';
    this._log(`[Document] User selected: ${fileUri.fsPath}`);
    this._postMessage({ type: 'progress', message: `📄 Reading document: ${fileName}...` });

    try {
      // Read file content
      let documentText = '';
      const ext = fileName.split('.').pop()?.toLowerCase() || '';

      if (ext === 'txt' || ext === 'md') {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        documentText = Buffer.from(bytes).toString('utf-8');
      } else if (ext === 'docx' || ext === 'doc') {
        // For docx, read as text by extracting XML content
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        // Simple docx text extraction — read the raw XML and strip tags
        const raw = Buffer.from(bytes).toString('utf-8');
        // If it's a real docx (zip), we extract readable text using a basic approach
        documentText = await this._extractDocxText(fileUri);
      } else if (ext === 'pdf') {
        // PDF: read raw bytes and attempt basic text extraction
        documentText = await this._extractPdfText(fileUri);
      } else {
        // Try reading as plain text
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        documentText = Buffer.from(bytes).toString('utf-8');
      }

      if (!documentText || documentText.trim().length < 20) {
        this._postMessage({ type: 'error', message: 'Could not extract meaningful text from the document. Try a .txt or .md file.' });
        return;
      }

      // Truncate if too large (keep first ~15000 chars to fit in LLM context)
      const maxChars = 15000;
      if (documentText.length > maxChars) {
        documentText = documentText.substring(0, maxChars) + '\n\n[... document truncated for analysis ...]';
        this._log(`[Document] Truncated to ${maxChars} chars`);
      }

      this._log(`[Document] Extracted ${documentText.length} chars from ${fileName}`);
      this._postMessage({ type: 'progress', message: '🤖 Analyzing document with AI...' });

      // Get available table names for matching
      const availableTables = Array.from(this._tablesMetadataCache.keys());
      let tableListForPrompt = '';
      if (availableTables.length > 0) {
        tableListForPrompt = availableTables.join(', ');
      } else if (this._connection) {
        // Load table names if not cached
        const client = new DataverseClient(this._connection);
        const reader = new MetadataReader(client);
        const tables = await reader.getSelectableTables();
        tableListForPrompt = tables.map(t => t.logicalName).join(', ');
      }

      // Call LLM to extract context and identify tables
      const models = await vscode.lm.selectChatModels();
      const usableModels = models.filter((m) => !m.name.includes('Internal only'));
      const model = usableModels[0];

      if (!model) {
        this._postMessage({ type: 'error', message: 'No AI models available. Make sure GitHub Copilot is active.' });
        return;
      }

      const prompt = `You are analyzing a business document to extract context for generating sample data in a Microsoft Dataverse environment.

Document content:
---
${documentText}
---

${tableListForPrompt ? `Available Dataverse tables in this environment: ${tableListForPrompt}` : ''}

Please analyze this document and respond in EXACTLY this JSON format (no markdown, no explanation):
{
  "businessContext": "A concise 1-2 sentence description of the business domain and application described in this document",
  "suggestedTables": ["table1", "table2"]
}

Rules:
- "businessContext" should describe the business scenario clearly enough to generate realistic sample data (e.g., "Healthcare clinic management system in Singapore with patient records and appointment scheduling")
- "suggestedTables" should contain Dataverse logical table names (from the available tables list) that are relevant to this document. Only include tables that are clearly referenced or implied. Return an empty array if none match.
- Return ONLY the JSON object, nothing else.`;

      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      const response = await model.sendRequest(messages, {
        justification: 'Analyze uploaded document to extract business context for Dataverse sample data generation.',
      });

      let responseText = '';
      for await (const chunk of response.text) {
        responseText += chunk;
      }

      this._log(`[Document] LLM response: ${responseText}`);

      // Parse the JSON response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this._postMessage({ type: 'error', message: 'AI could not analyze the document. Try a different file.' });
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const context = parsed.businessContext || '';
      const suggestedTables: string[] = parsed.suggestedTables || [];

      this._log(`[Document] Extracted context: ${context}`);
      this._log(`[Document] Suggested tables: ${suggestedTables.join(', ') || '(none)'}`);

      this._postMessage({ type: 'documentContext', context, suggestedTables });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log(`[Document] Analysis failed: ${msg}`);
      this._postMessage({ type: 'error', message: `Document analysis failed: ${msg}` });
    }
  }

  /** Extract text from a .docx file (ZIP with XML inside) */
  private async _extractDocxText(fileUri: vscode.Uri): Promise<string> {
    try {
      // Use a child process to run a quick Node script for unzipping
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const { Readable } = await import('stream');
      const { createInflateRaw } = await import('zlib');

      // Docx is a ZIP file. We need to find word/document.xml and extract text.
      // Using a minimal approach with the built-in 'zlib' module
      const buffer = Buffer.from(bytes);

      // Check ZIP magic number
      if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
        return ''; // Not a valid ZIP/docx
      }

      // Find the End of Central Directory record
      let eocdOffset = -1;
      for (let i = buffer.length - 22; i >= 0; i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) {
          eocdOffset = i;
          break;
        }
      }
      if (eocdOffset === -1) return '';

      const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
      const cdSize = buffer.readUInt32LE(eocdOffset + 12);

      // Parse central directory to find word/document.xml
      let offset = cdOffset;
      const textParts: string[] = [];

      while (offset < cdOffset + cdSize) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
        const compMethod = buffer.readUInt16LE(offset + 10);
        const compSize = buffer.readUInt32LE(offset + 20);
        const uncompSize = buffer.readUInt32LE(offset + 24);
        const nameLen = buffer.readUInt16LE(offset + 28);
        const extraLen = buffer.readUInt16LE(offset + 30);
        const commentLen = buffer.readUInt16LE(offset + 32);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf-8', offset + 46, offset + 46 + nameLen);

        if (name === 'word/document.xml' || name.startsWith('word/document') && name.endsWith('.xml')) {
          // Read from local file header
          const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
          const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
          const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
          const compressedData = buffer.subarray(dataStart, dataStart + compSize);

          let xmlContent: string;
          if (compMethod === 0) {
            xmlContent = compressedData.toString('utf-8');
          } else {
            // Deflate
            const { inflateRawSync } = await import('zlib');
            const decompressed = inflateRawSync(compressedData);
            xmlContent = decompressed.toString('utf-8');
          }

          // Strip XML tags, keep text content
          const text = xmlContent
            .replace(/<w:p[^>]*>/g, '\n')
            .replace(/<w:tab\/>/g, '\t')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          textParts.push(text);
        }

        offset += 46 + nameLen + extraLen + commentLen;
      }

      return textParts.join('\n');
    } catch (err) {
      this._log(`[Document] DOCX extraction failed: ${err}`);
      return '';
    }
  }

  /** Extract text from a PDF file (basic extraction for text-based PDFs) */
  private async _extractPdfText(fileUri: vscode.Uri): Promise<string> {
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const content = Buffer.from(bytes).toString('latin1');

      // Basic PDF text extraction — finds text between BT and ET operators
      const textParts: string[] = [];
      const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
      let match;

      // Also try to extract text directly from parenthesized strings in page content
      const textOps = content.match(/\(([^)]*)\)\s*Tj|\(([^)]*)\)\s*'/g);
      if (textOps) {
        for (const op of textOps) {
          const textMatch = op.match(/\(([^)]*)\)/);
          if (textMatch) {
            textParts.push(textMatch[1]);
          }
        }
      }

      // Also try TJ arrays
      const tjRegex = /\[(.*?)\]\s*TJ/g;
      while ((match = tjRegex.exec(content)) !== null) {
        const items = match[1].match(/\(([^)]*)\)/g);
        if (items) {
          textParts.push(items.map(i => i.slice(1, -1)).join(''));
        }
      }

      const result = textParts.join(' ').replace(/\\n/g, '\n').replace(/\\r/g, '').trim();

      if (!result || result.length < 20) {
        this._log('[Document] PDF text extraction yielded insufficient text. PDF may be image-based.');
        return '';
      }

      return result;
    } catch (err) {
      this._log(`[Document] PDF extraction failed: ${err}`);
      return '';
    }
  }

  private async _handleCleanupPlan(tables: Array<{ logicalName: string; recordCount: number; sortOrder: string; fetchXml?: string }>) {
    if (!this._connection) {
      this._postMessage({ type: 'error', message: 'Not connected.' });
      return;
    }

    try {
      this._postMessage({ type: 'progress', message: 'Building cleanup plan...' });
      this._log('=== Cleanup plan requested ===');
      this._log(`Tables: ${tables.map((t) => `${t.logicalName} (${t.recordCount}, ${t.sortOrder}${t.fetchXml ? ', FetchXML' : ''})`).join(', ')}`);

      const client = new DataverseClient(this._connection);
      const reader = new MetadataReader(client);

      // Load metadata for all selected tables
      const tablesMetadata = new Map<string, TableMetadata>();
      for (const t of tables) {
        this._postMessage({ type: 'progress', message: `Loading metadata for ${t.logicalName}...` });
        let meta = this._tablesMetadataCache.get(t.logicalName);
        if (!meta) {
          meta = await reader.getTableMetadata(t.logicalName);
          this._tablesMetadataCache.set(t.logicalName, meta);
        }
        tablesMetadata.set(t.logicalName, meta);
      }

      // Build cleanup configs
      const configs = tables.map((t) => {
        const meta = tablesMetadata.get(t.logicalName)!;
        return {
          logicalName: t.logicalName,
          entitySetName: meta.entitySetName,
          primaryIdAttribute: meta.primaryIdAttribute,
          recordCount: t.recordCount,
          sortOrder: (t.sortOrder || 'newest') as 'newest' | 'oldest',
          fetchXml: t.fetchXml || undefined,
        };
      });

      // Build and store the plan
      const cleaner = new RecordCleaner(client);
      const plan = cleaner.buildDeletionPlan(configs, tablesMetadata);

      this._pendingCleanupPlan = plan;
      this._pendingCleanupMetadata = tablesMetadata;

      this._log(`Cleanup plan: ${plan.summary}`);

      this._postMessage({
        type: 'cleanupPlan',
        plan: {
          steps: plan.steps,
          summary: plan.summary,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log(`Cleanup plan failed: ${msg}`);
      this._postMessage({ type: 'error', message: `Failed to build cleanup plan: ${msg}` });
    }
  }

  private async _handleCleanupExecute() {
    if (!this._connection || !this._pendingCleanupPlan) {
      this._postMessage({ type: 'error', message: 'No cleanup plan pending.' });
      return;
    }

    try {
      this._log('=== Cleanup execution started ===');

      const client = new DataverseClient(this._connection);
      const cleaner = new RecordCleaner(client);

      const result = await cleaner.execute(
        this._pendingCleanupPlan,
        (message, percentage) => {
          this._postMessage({ type: 'progress', message, percentage });
        }
      );

      this._log(`Cleanup complete: ${result.totalDeleted} deleted, ${result.totalFailed} failed`);
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          this._log(`[Cleanup Error] ${err}`);
        }
      }

      this._pendingCleanupPlan = null;
      this._pendingCleanupMetadata = null;

      this._postMessage({ type: 'cleanupResult', result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log(`Cleanup execution failed: ${msg}`);
      this._postMessage({ type: 'error', message: `Cleanup failed: ${msg}` });
    }
  }

  private async _createRecordProvider(
    businessContext: string | undefined,
    tablesMetadata: Map<string, TableMetadata>,
    columnFilterMap: Map<string, { mode: ColumnMode; selected?: string[] }>,
    tableContextMap?: Map<string, string>
  ): Promise<{
    provider: (metadata: TableMetadata, count: number) => Promise<Record<string, any>[]>;
    dataSource: 'ai' | 'faker';
    modelName?: string;
    tableDataSources: Map<string, { source: string; error?: string }>;
  }> {
    const tableDataSources = new Map<string, { source: string; error?: string }>();

    // Build a column filter function
    const filterColumns = (metadata: TableMetadata): ColumnMetadata[] => {
      const filter = columnFilterMap.get(metadata.logicalName);
      const mode = filter?.mode ?? 'best';

      const allCols = metadata.columns.filter((col) => {
        if (col.logicalName === metadata.primaryIdAttribute) return false;
        if (!col.isValidForCreate) return false;
        if (['State', 'Status'].includes(col.attributeType)) return false;
        if (['Lookup', 'Customer', 'Owner'].includes(col.attributeType)) return false;
        if (col.attributeType === 'Uniqueidentifier') return false;
        if (col.isAutoNumber) return false;
        if (col.isComputed) return false;
        return true;
      });

      switch (mode) {
        case 'mandatory':
          return allCols.filter((c) => c.isRequired || c.logicalName === metadata.primaryNameAttribute);

        case 'selected': {
          const selected = new Set(filter?.selected ?? []);
          // Always include required + primary name even if not selected
          return allCols.filter((c) =>
            c.isRequired || c.logicalName === metadata.primaryNameAttribute || selected.has(c.logicalName)
          );
        }

        case 'best':
        default: {
          // Best = filter system fields, include the rest
          return allCols.filter((c) => {
            if (c.isRequired || c.logicalName === metadata.primaryNameAttribute) return true;
            if (isSystemField(c.logicalName)) return false;
            return true;
          });
        }
      }
    };

    // Try AI first
    try {
      this._log(`[AI] Selecting available chat models...`);
      this._postMessage({ type: 'progress', message: 'Checking for AI models...' });
      let models = await vscode.lm.selectChatModels();
      this._log(`[AI] Found ${models.length} model(s): ${models.map((m) => m.name + ' (' + m.family + ', ' + m.vendor + ')').join(', ') || 'none'}`);

      if (models.length === 0) {
        // Show this clearly to the user
        this._log(`[AI] No models returned by selectChatModels(). Copilot extension may not be active.`);
        this._postMessage({ type: 'progress', message: '⚠️ No AI models found. Ensure GitHub Copilot is active. Falling back to Faker...' });
        vscode.window.showWarningMessage(
          'Dataverse Generator: No AI models available. Make sure GitHub Copilot Chat is active. Using Faker as fallback.',
          'Open Output Log'
        ).then((choice) => {
          if (choice === 'Open Output Log') {
            this._outputChannel.show();
          }
        });
      }

      // Filter and rank models:
      // 1. Exclude "Internal only" models (they return empty responses)
      // 2. Prefer 'copilot' vendor (authorized for extension API)
      // 3. Prefer known-good families for JSON generation (avoid 'mini' — low token limits)
      // 4. Use maxInputTokens as tiebreaker
      const usableModels = models.filter((m) => !m.name.includes('Internal only'));
      this._log(`[AI] Usable models (after filtering internal-only): ${usableModels.length}`);

      const familyPriority = (family: string): number => {
        const f = family.toLowerCase();
        if (f.includes('mini') || f.includes('fast')) return 30;  // Low output token limits
        if (f.includes('codex')) return 25;   // Code-focused, not ideal for data gen
        if (f.includes('gpt-5.4')) return 100; // Fast, high token limits
        if (f.includes('gpt-5.5')) return 98;
        if (f.includes('gpt-5.2')) return 95;
        if (f.includes('gpt-4.1')) return 90;
        if (f.includes('gpt-4o')) return 88;
        if (f.includes('claude-sonnet')) return 85;
        if (f.includes('gemini')) return 70;
        if (f.includes('claude-haiku')) return 65;
        if (f.includes('claude-opus')) return 60;
        return 50;
      };

      usableModels.sort((a, b) => {
        // Prefer 'copilot' vendor
        const aVendor = a.vendor === 'copilot' ? 1 : 0;
        const bVendor = b.vendor === 'copilot' ? 1 : 0;
        if (aVendor !== bVendor) return bVendor - aVendor;
        // Then by family priority
        const pDiff = familyPriority(b.family) - familyPriority(a.family);
        if (pDiff !== 0) return pDiff;
        // Then by maxInputTokens (higher = better)
        return b.maxInputTokens - a.maxInputTokens;
      });

      const model = usableModels[0];

      if (model) {
        this._log(`[AI] Using model: ${model.name} (family: ${model.family}, vendor: ${model.vendor}, maxInput: ${model.maxInputTokens})`);
        this._log(`[AI] Top 5 ranked: ${usableModels.slice(0, 5).map((m) => m.name + ' (' + m.family + ', ' + m.maxInputTokens + ')').join(', ')}`);
        this._postMessage({ type: 'progress', message: `🤖 Using AI model: ${model.name}` });

        const aiGenerator = new AIDataGenerator({
          businessContext,
          lmComplete: async (msgs) => {
            const messages = msgs.map((m) =>
              m.role === 'assistant'
                ? vscode.LanguageModelChatMessage.Assistant(m.content)
                : vscode.LanguageModelChatMessage.User(m.content)
            );
            const response = await model.sendRequest(messages, {
              justification: 'Generate realistic sample data for Dataverse tables based on schema and business context.',
            });
            let text = '';
            for await (const chunk of response.text) {
              text += chunk;
            }
            if (!text.length) {
              throw new Error('Model returned empty response');
            }
            this._log(`[AI] Got response: ${text.length} chars`);
            return text;
          },
          columnFilter: filterColumns,
          concurrency: 5,
        });

        return {
          provider: async (metadata, count) => {
            try {
              const tblCtx = tableContextMap?.get(metadata.logicalName);
              this._log(`[AI] Generating ${count} records for ${metadata.logicalName}...${tblCtx ? ' (context: ' + tblCtx + ')' : ''}`);
              this._postMessage({ type: 'progress', message: `🤖 AI generating ${metadata.displayName} (${count} records)...` });
              const records = await aiGenerator.generateRecords(metadata, count, tblCtx);
              this._log(`[AI] Success for ${metadata.logicalName}: ${records.length} records`);
              tableDataSources.set(metadata.logicalName, { source: 'ai' });
              return records;
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              this._log(`[AI] Failed for ${metadata.logicalName}: ${errMsg}`);
              this._postMessage({ type: 'progress', message: `⚠️ AI failed for ${metadata.displayName}, using Faker fallback...` });
              tableDataSources.set(metadata.logicalName, { source: 'faker', error: errMsg });
              const fakerGen = new DataGenerator();
              return fakerGen.generateRecords(metadata, count, undefined, filterColumns(metadata).map((c) => c.logicalName));
            }
          },
          dataSource: 'ai',
          modelName: model.name,
          tableDataSources,
        };
      } else {
        this._log(`[AI] No chat models available — will use Faker fallback`);
        this._postMessage({ type: 'progress', message: '⚠️ No AI models available. Using Faker generator...' });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this._log(`[AI] Error selecting models: ${errMsg}`);
      this._postMessage({ type: 'progress', message: `⚠️ AI unavailable: ${errMsg}. Using Faker...` });
    }

    // Fallback to Faker
    this._log(`[Faker] Using Faker.js as data generator`);
    const fakerGen = new DataGenerator();
    return {
      provider: async (metadata, count) => {
        const cols = filterColumns(metadata).map((c) => c.logicalName);
        tableDataSources.set(metadata.logicalName, { source: 'faker' });
        return fakerGen.generateRecords(metadata, count, undefined, cols);
      },
      dataSource: 'faker',
      tableDataSources,
    };
  }

  private _dispose() {
    DataverseWebviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      d?.dispose();
    }
  }

  private _getHtmlForWebview(): string {
    const nonce = getNonce();
    return getWebviewHtml(nonce);
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// ─── HTML Template ──────────────────────────────────────────────────────────
function getWebviewHtml(nonce: string): string {
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dataverse Sample Data Generator</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --input-bg: var(--vscode-input-background);
      --input-border: var(--vscode-input-border);
      --input-fg: var(--vscode-input-foreground);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --btn-secondary-bg: var(--vscode-button-secondaryBackground);
      --btn-secondary-fg: var(--vscode-button-secondaryForeground);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-focusBorder);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --error-fg: var(--vscode-errorForeground);
      --success-fg: var(--vscode-testing-iconPassed);
      --warn-fg: var(--vscode-editorWarning-foreground);
      --list-hover: var(--vscode-list-hoverBackground);
      --description-fg: var(--vscode-descriptionForeground);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background: var(--bg);
      padding: 16px 20px;
      line-height: 1.5;
    }

    h1 { font-size: 1.4em; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
    h2 { font-size: 1.05em; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); color: var(--fg); letter-spacing: 0.02em; }
    h3 { font-size: 1em; margin: 12px 0 6px; }

    .subtitle { color: var(--description-fg); font-size: 0.9em; margin-bottom: 16px; }

    /* Sections */
    .section {
      margin-bottom: 16px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: color-mix(in srgb, var(--vscode-sideBar-background, var(--bg)) 60%, var(--bg));
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }

    /* Connection */
    .connection-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      padding: 8px 12px;
      background: color-mix(in srgb, var(--success-fg, #4caf50) 8%, transparent);
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, var(--success-fg, #4caf50) 25%, transparent);
    }
    .status-dot {
      width: 10px; height: 10px; border-radius: 50%; display: inline-block;
      box-shadow: 0 0 6px color-mix(in srgb, var(--success-fg, #4caf50) 50%, transparent);
    }
    .status-dot.connected { background: var(--success-fg, #4caf50); }
    .status-dot.disconnected { background: var(--error-fg, #f44336); }

    /* Inputs */
    input[type="text"], input[type="number"], select, textarea {
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 6px 10px;
      font-family: inherit;
      font-size: inherit;
      outline: none;
      width: 100%;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--accent); }
    textarea { resize: vertical; min-height: 48px; }

    .input-row {
      display: flex; gap: 8px; align-items: center; margin-bottom: 8px;
    }
    .input-row label { min-width: 100px; font-weight: 500; }
    .input-row input, .input-row select { flex: 1; }

    /* Buttons */
    button {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 5px;
      padding: 7px 16px;
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
      white-space: nowrap;
      transition: background 0.15s, box-shadow 0.15s;
    }
    button:hover { background: var(--btn-hover); box-shadow: 0 1px 4px rgba(0,0,0,0.15); }
    button:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }
    button.secondary {
      background: var(--btn-secondary-bg);
      color: var(--btn-secondary-fg);
    }
    #btn-upload-doc {
      width: 100%;
      padding: 10px 16px;
      font-size: 0.9em;
      margin-top: 10px;
      border: 1px solid var(--border) !important;
      border-radius: 6px;
      cursor: pointer;
      background: transparent;
      color: var(--fg);
    }
    #btn-upload-doc:hover {
      border-color: var(--accent) !important;
      background: var(--btn-secondary-bg);
    }

    /* Table list */
    .table-list {
      max-height: 350px;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
    }
    .table-search {
      margin-bottom: 8px;
    }
    .table-item {
      display: flex;
      align-items: center;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border);
      gap: 8px;
    }
    .table-item:hover { background: var(--list-hover); }
    .table-item:last-child { border-bottom: none; }
    .table-item input[type="checkbox"] { flex-shrink: 0; cursor: pointer; }
    .table-item .table-name { font-weight: 500; }
    .table-item .table-logical { color: var(--description-fg); font-size: 0.85em; margin-left: 4px; }
    .table-item .table-desc { color: var(--description-fg); font-size: 0.8em; display: block; margin-left: 24px; }

    /* Selected table configs */
    .selected-tables { margin-top: 12px; }
    .table-config {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 10px;
      background: var(--input-bg);
      transition: border-color 0.15s;
    }
    .table-config:hover { border-color: var(--accent); }
    .table-config-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .table-config-header .table-name { font-weight: 600; font-size: 0.95em; }
    .table-config-header .table-logical { font-weight: 400; }
    .remove-table { background: transparent; color: var(--error-fg, red); padding: 2px 6px; font-size: 1.2em; }
    .remove-table:hover { background: rgba(255,0,0,0.1); border-radius: 4px; }
    .config-row {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-bottom: 6px;
      flex-wrap: wrap;
    }
    .config-row label { font-size: 0.85em; color: var(--description-fg); font-weight: 500; text-transform: uppercase; letter-spacing: 0.03em; }
    .config-row input[type="number"] { width: 70px; flex: none; }
    .config-row select { width: 160px; flex: none; }
    .config-row input[type="text"] { flex: 1; min-width: 150px; font-size: 0.9em; }
    .config-desc-row { margin-top: 2px; }
    .config-desc-row input[type="text"] {
      width: 100%; font-size: 0.88em; padding: 5px 10px;
      background: var(--bg); border: 1px dashed var(--border); border-radius: 4px;
    }
    .config-desc-row input[type="text"]:focus { border-style: solid; border-color: var(--accent); }
    .generate-actions { display: flex; gap: 10px; align-items: center; }
    .btn-secondary { background: var(--button-secondary-bg, #3a3a3a); color: var(--button-secondary-fg, #ccc); border: 1px solid var(--border); }
    .btn-secondary:hover { background: var(--button-secondary-hover-bg, #4a4a4a); }

    /* Chips */
    .chip-container { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; padding: 4px 0; }
    .chip {
      display: inline-flex; align-items: center; gap: 4px;
      background: var(--badge-bg, #2a6bb0); color: var(--badge-fg, #fff);
      padding: 3px 10px; border-radius: 12px; font-size: 0.8em; font-weight: 500;
      white-space: nowrap;
      transition: opacity 0.15s;
    }
    .chip:hover { opacity: 0.85; }
    .chip-remove {
      background: none; border: none; color: inherit; cursor: pointer;
      font-size: 1.1em; padding: 0 2px; opacity: 0.7; line-height: 1;
    }
    .chip-remove:hover { opacity: 1; }
    .chip-secondary {
      background: var(--input-bg, #2a2a2a); color: var(--fg); border: 1px solid var(--border);
    }
    .selected-cols-chips { margin-top: 4px; }

    /* Column picker */
    .column-picker {
      max-height: 250px;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
      margin-top: 6px;
      padding: 4px 0;
    }
    .column-item {
      display: flex;
      align-items: center;
      padding: 3px 10px;
      gap: 8px;
      font-size: 0.9em;
    }
    .column-item:hover { background: var(--list-hover); }
    .column-item .col-name { font-weight: 500; }
    .column-item .col-type { color: var(--description-fg); font-size: 0.85em; }
    .column-item .col-required { color: var(--warn-fg, orange); font-size: 0.8em; font-weight: 600; }
    .column-item .col-desc { color: var(--description-fg); font-size: 0.8em; }

    .column-actions { display: flex; gap: 8px; margin-top: 6px; }
    .column-actions button { font-size: 0.85em; padding: 3px 10px; }

    /* Progress */
    .progress-bar {
      height: 5px;
      background: var(--border);
      border-radius: 3px;
      overflow: hidden;
      margin: 8px 0;
    }
    .progress-bar .fill {
      height: 100%;
      background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 70%, var(--success-fg, #4caf50)));
      transition: width 0.3s ease;
      border-radius: 3px;
    }
    .progress-message { font-size: 0.9em; color: var(--description-fg); }

    /* Results */
    .results { margin-top: 12px; }
    .result-summary {
      display: flex;
      gap: 20px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .result-stat {
      text-align: center;
      padding: 8px 16px;
      background: var(--input-bg);
      border-radius: 8px;
      min-width: 80px;
    }
    .result-stat .number { font-size: 1.8em; font-weight: 700; }
    .result-stat .label { font-size: 0.8em; color: var(--description-fg); text-transform: uppercase; letter-spacing: 0.03em; }

    .result-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9em;
    }
    .result-table th, .result-table td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    .result-table th {
      font-weight: 600; font-size: 0.85em; text-transform: uppercase;
      color: var(--description-fg); letter-spacing: 0.03em;
    }
    .result-table tr:hover td { background: var(--list-hover); }

    .error-list { margin-top: 8px; }
    .error-item {
      padding: 4px 8px;
      font-size: 0.85em;
      color: var(--error-fg, #f44336);
      background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1));
      border-radius: 3px;
      margin-bottom: 4px;
      word-break: break-all;
    }

    .badge {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 10px;
      font-size: 0.8em;
      font-weight: 600;
      background: var(--badge-bg);
      color: var(--badge-fg);
    }

    /* Utilities */
    .hidden { display: none !important; }
    .flex-grow { flex: 1; }
    .mt-8 { margin-top: 8px; }
    .mt-12 { margin-top: 12px; }
    .mb-8 { margin-bottom: 8px; }
    .text-center { text-align: center; }
    .gap-8 { gap: 8px; }
    .flex { display: flex; }
    .items-center { align-items: center; }

    /* Mode toggle */
    .mode-toggle {
      display: flex; gap: 0; margin: 12px 0 16px 0;
      border: 1px solid var(--border); border-radius: 8px; overflow: hidden; width: fit-content;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .mode-toggle button {
      border-radius: 0; border: none; padding: 8px 24px; font-size: 0.95em;
      background: var(--input-bg); color: var(--description-fg); min-width: 130px;
      transition: background 0.15s, color 0.15s;
    }
    .mode-toggle button.active {
      background: var(--accent); color: #fff; font-weight: 600;
    }
    .mode-toggle button:hover:not(.active) { background: var(--list-hover); }

    /* Cleanup plan */
    .plan-table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 0.9em; }
    .plan-table th, .plan-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); text-align: left; }
    .plan-table th { font-weight: 600; color: var(--description-fg); font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.03em; }
    .plan-table tr:hover td { background: var(--list-hover); }
    .plan-arrow { color: var(--accent); font-size: 1.2em; margin: 0 6px; }
    .plan-summary { padding: 10px 14px; background: var(--input-bg); border-radius: 6px; margin: 8px 0; font-size: 0.9em; border-left: 3px solid var(--accent); }
    .plan-warning { color: var(--warn-fg, orange); font-size: 0.9em; margin: 8px 0; }
    .confirm-actions { display: flex; gap: 10px; margin-top: 12px; }
    .btn-danger { background: #c44; color: #fff; }
    .btn-danger:hover { background: #d55; }
    .fetchxml-area { margin-top: 6px; }
    .fetchxml-area textarea {
      width: 100%; min-height: 80px; font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em; background: var(--input-bg); color: var(--fg); border: 1px solid var(--border);
      border-radius: 4px; padding: 6px 8px; resize: vertical;
    }
    .cleanup-filter-row {
      display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    }
    .cleanup-filter-row select { width: 130px; }
    .filter-mode-label { font-size: 0.8em; color: var(--description-fg); cursor: pointer; text-decoration: underline; }
  </style>
</head>
<body>
  <!-- Header -->
  <h1>⚡ Dataverse Sample Data Generator</h1>
  <p class="subtitle">Generate realistic sample data for your Dataverse environment</p>
  <div style="height:1px;background:linear-gradient(90deg,var(--accent),transparent);margin-bottom:8px;"></div>

  <!-- Mode Toggle -->
  <div class="mode-toggle hidden" id="mode-toggle">
    <button class="active" id="btn-mode-generate" data-mode="generate">🚀 Generate</button>
    <button id="btn-mode-cleanup" data-mode="cleanup">🧹 Cleanup</button>
  </div>

  <!-- Step 1: Connection -->
  <div class="section" id="section-connection">
    <h2>1. Connect to Dataverse</h2>
    <div class="connection-bar" id="connection-connected" style="display:none;">
      <span class="status-dot connected"></span>
      <span>Connected to <strong id="connected-env"></strong></span>
      <button class="secondary" id="btn-disconnect">Disconnect</button>
    </div>
    <div id="connection-form">
      <div class="input-row">
        <label for="envUrl">Environment URL</label>
        <input type="text" id="envUrl" placeholder="https://yourorg.crm.dynamics.com">
      </div>
      <div class="input-row">
        <label for="authMethod">Auth Method</label>
        <select id="authMethod">
          <option value="browser" selected>Browser Sign-in (recommended)</option>
          <option value="deviceCode">Device Code</option>
        </select>
      </div>
      <button id="btn-connect">Connect</button>
    </div>
    <div id="context-area" class="hidden" style="margin-top:16px;padding:14px 16px;border:1px dashed var(--border);border-radius:8px;">
      <label for="app-context" style="display:block;margin-bottom:8px;font-size:0.95em;">📝 Business Context <span style="color:var(--description-fg);font-weight:normal;">(describes what kind of data to generate)</span></label>
      <textarea id="app-context" placeholder="e.g., Healthcare clinic management system in Singapore with patient records, appointment scheduling, and billing..." style="font-size:0.95em;padding:12px 14px;min-height:90px;resize:vertical;font-family:inherit;line-height:1.6;width:100%;box-sizing:border-box;border-radius:6px;"></textarea>
      <button id="btn-upload-doc" class="secondary" title="Upload a document to auto-extract business context and detect tables">📄 Upload Document to Extract Context</button>
      <div id="doc-status" style="font-size:0.85em;color:var(--description-fg);margin-top:8px;"></div>
    </div>
  </div>

  <!-- Step 2: Table Selection -->
  <div class="section hidden" id="section-tables">
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <h2 style="margin:0;border:none;">2. Select Tables</h2>
      <button class="secondary" id="btn-collapse-tables" style="font-size:0.85em;padding:3px 10px;">▲ Collapse</button>
    </div>
    <div id="table-picker-area">
      <div class="input-row table-search" style="margin-top:8px;">
        <input type="text" id="table-search" placeholder="Search tables...">
        <span class="badge" id="table-count">0</span>
      </div>
      <div class="table-list" id="table-list"></div>
    </div>
    <div id="selected-tables-chips" class="chip-container hidden"></div>
  </div>

  <!-- Step 3: Configure -->
  <div class="section hidden" id="section-config">
    <h2>3. Configure Generation</h2>
    <div class="selected-tables" id="selected-tables"></div>
  </div>

  <!-- Step 4: Generate -->
  <div class="section hidden" id="section-generate">
    <h2>4. Generate</h2>
    <div id="generate-summary"></div>
    <div class="generate-actions mt-8">
      <button id="btn-generate">🚀 Generate Sample Data</button>
      <button id="btn-reset" class="btn-secondary" title="Reset selections and start over">🔄 Reset</button>
    </div>

    <div id="progress-area" class="hidden mt-12">
      <div class="progress-bar"><div class="fill" id="progress-fill" style="width: 0%"></div></div>
      <p class="progress-message" id="progress-message">Preparing...</p>
    </div>
  </div>

  <!-- Step 5: Results -->
  <div class="section hidden" id="section-results">
    <h2>5. Results</h2>
    <div class="results" id="results-content"></div>
  </div>

  <!-- ═══ Cleanup Mode Sections ═══ -->

  <!-- Cleanup: Select Tables -->
  <div class="section hidden" id="section-cleanup-tables">
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <h2 style="margin:0;border:none;">1. Select Tables to Clean</h2>
      <button class="secondary" id="btn-collapse-cleanup-tables" style="font-size:0.85em;padding:3px 10px;">▲ Collapse</button>
    </div>
    <div id="cleanup-table-picker-area">
      <div class="input-row table-search" style="margin-top:8px;">
        <input type="text" id="cleanup-table-search" placeholder="Search tables...">
      </div>
      <div class="table-list" id="cleanup-table-list"></div>
    </div>
    <div id="cleanup-selected-chips" class="chip-container" style="margin-top:8px;"></div>
  </div>

  <!-- Cleanup: Configure -->
  <div class="section hidden" id="section-cleanup-config">
    <h2>2. Configure Cleanup</h2>
    <div id="cleanup-configs"></div>
    <button id="btn-build-plan" class="mt-8">📋 Build Deletion Plan</button>
  </div>

  <!-- Cleanup: Plan & Confirm -->
  <div class="section hidden" id="section-cleanup-plan">
    <h2>3. Deletion Plan</h2>
    <div id="cleanup-plan-content"></div>
    <div id="cleanup-progress" class="hidden mt-12">
      <div class="progress-bar"><div class="fill" id="cleanup-progress-fill" style="width: 0%"></div></div>
      <p class="progress-message" id="cleanup-progress-message">Preparing...</p>
    </div>
  </div>

  <!-- Cleanup: Results -->
  <div class="section hidden" id="section-cleanup-results">
    <h2>4. Cleanup Results</h2>
    <div id="cleanup-results-content"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // ─── State ──────────────────────────────────────────────────
    let allTables = [];
    let selectedTableNames = new Set();
    let tableConfigs = {};
    let tableColumns = {};
    let isConnected = false;
    let currentMode = 'generate'; // 'generate' | 'cleanup'

    // Cleanup state
    let cleanupSelectedTables = new Set();
    let cleanupConfigs = {}; // logicalName → { displayName, recordCount, available, sortOrder, filterMode, fetchXml }
    let cleanupRecordCounts = {}; // logicalName → server count

    // ─── Init ───────────────────────────────────────────────────
    vscode.postMessage({ type: 'ready' });

    // ─── Static Event Listeners ─────────────────────────────────
    document.getElementById('btn-connect').addEventListener('click', function() {
      const envUrl = document.getElementById('envUrl').value.trim();
      if (!envUrl) { showError('Please enter an environment URL.'); return; }
      const authMethod = document.getElementById('authMethod').value;
      this.disabled = true;
      this.textContent = 'Connecting...';
      vscode.postMessage({ type: 'connect', envUrl: envUrl, authMethod: authMethod });
    });

    document.getElementById('btn-disconnect').addEventListener('click', function() {
      vscode.postMessage({ type: 'disconnect' });
    });

    document.getElementById('btn-upload-doc').addEventListener('click', function() {
      var docStatus = document.getElementById('doc-status');
      docStatus.textContent = '📄 Analyzing document...';
      docStatus.className = '';
      this.disabled = true;
      vscode.postMessage({ type: 'analyzeDocument' });
      var self = this;
      // Re-enable after 30s timeout
      setTimeout(function() { self.disabled = false; }, 30000);
    });

    // ─── Mode Toggle ──────────────────────────────────────────
    document.getElementById('btn-mode-generate').addEventListener('click', function() { switchMode('generate'); });
    document.getElementById('btn-mode-cleanup').addEventListener('click', function() { switchMode('cleanup'); });

    document.getElementById('table-search').addEventListener('input', function() {
      renderTableList();
    });

    document.getElementById('btn-collapse-tables').addEventListener('click', function() {
      var area = document.getElementById('table-picker-area');
      var isHidden = area.classList.contains('hidden');
      if (isHidden) {
        area.classList.remove('hidden');
        this.textContent = '\u25b2 Collapse';
        document.getElementById('selected-tables-chips').classList.add('hidden');
      } else {
        area.classList.add('hidden');
        this.textContent = '\u25bc ' + selectedTableNames.size + ' table(s) selected \u2014 Expand';
        updateSelectedTableChips();
      }
    });

    document.getElementById('btn-generate').addEventListener('click', function() {
      var tables = Array.from(selectedTableNames).map(function(name) {
        var cfg = tableConfigs[name];
        return {
          logicalName: name,
          displayName: cfg.displayName,
          recordCount: cfg.recordCount,
          columnMode: cfg.columnMode,
          selectedColumns: cfg.selectedColumns || [],
          tableContext: cfg.tableContext || '',
        };
      });
      if (tables.length === 0) { showError('No tables selected.'); return; }
      var context = document.getElementById('app-context').value.trim() || undefined;
      show('progress-area');
      this.disabled = true;
      hide('section-results');
      vscode.postMessage({ type: 'generate', tables: tables, context: context });
    });

    document.getElementById('btn-reset').addEventListener('click', function() {
      // Reset all selections and UI state
      selectedTableNames.clear();
      tableConfigs = {};
      tableColumns = {};
      // Uncheck all table checkboxes
      var checkboxes = document.querySelectorAll('#table-list input[type="checkbox"]');
      checkboxes.forEach(function(cb) { cb.checked = false; });
      // Hide config, generate, results sections
      hide('section-config');
      hide('section-generate');
      hide('section-results');
      hide('progress-area');
      document.getElementById('btn-generate').disabled = false;
      document.getElementById('progress-fill').style.width = '0%';
      document.getElementById('progress-message').textContent = 'Preparing...';
      document.getElementById('results-content').innerHTML = '';
      document.getElementById('selected-tables-chips').innerHTML = '';
      document.getElementById('selected-tables-chips').classList.add('hidden');
      // Show table picker
      var area = document.getElementById('table-picker-area');
      area.classList.remove('hidden');
      document.getElementById('btn-collapse-tables').textContent = '\u25b2 Collapse';
      // Clear search
      var search = document.getElementById('table-search');
      if (search) { search.value = ''; search.dispatchEvent(new Event('input')); }
      updateConfigSection();
    });

    // ─── Cleanup Event Listeners ────────────────────────────────
    document.getElementById('cleanup-table-search').addEventListener('input', function() {
      renderCleanupTableList();
    });

    document.getElementById('btn-collapse-cleanup-tables').addEventListener('click', function() {
      var area = document.getElementById('cleanup-table-picker-area');
      var isHidden = area.classList.contains('hidden');
      if (isHidden) {
        area.classList.remove('hidden');
        this.textContent = '\u25b2 Collapse';
      } else {
        area.classList.add('hidden');
        this.textContent = '\u25bc ' + cleanupSelectedTables.size + ' table(s) selected \u2014 Expand';
      }
    });

    document.getElementById('cleanup-table-list').addEventListener('change', function(e) {
      var cb = e.target;
      if (cb.type !== 'checkbox') return;
      var item = cb.closest('.table-item');
      if (!item) return;
      toggleCleanupTable(item.dataset.logical, item.dataset.display, cb.checked);
    });

    document.getElementById('cleanup-selected-chips').addEventListener('click', function(e) {
      var btn = e.target.closest('.chip-remove');
      if (!btn) return;
      var table = btn.dataset.table;
      if (table) removeCleanupTable(table);
    });

    document.getElementById('cleanup-configs').addEventListener('change', function(e) {
      var el = e.target;
      if (!el.dataset || !el.dataset.table) return;
      var table = el.dataset.table;
      var cfg = cleanupConfigs[table];
      if (!cfg) return;

      if (el.dataset.action === 'cleanupCount') {
        cfg.recordCount = Math.max(1, Math.min(5000, parseInt(el.value) || 10));
      } else if (el.dataset.action === 'cleanupSort') {
        cfg.sortOrder = el.value;
      } else if (el.dataset.action === 'cleanupFilterMode') {
        cfg.filterMode = el.value;
        // Show/hide FetchXML area
        var fxArea = document.getElementById('fetchxml-' + table);
        if (fxArea) {
          if (el.value === 'fetchxml') { fxArea.classList.remove('hidden'); }
          else { fxArea.classList.add('hidden'); }
        }
      }
    });

    document.getElementById('cleanup-configs').addEventListener('input', function(e) {
      var el = e.target;
      if (el.dataset && el.dataset.action === 'fetchXml' && el.dataset.table) {
        if (cleanupConfigs[el.dataset.table]) cleanupConfigs[el.dataset.table].fetchXml = el.value;
      }
    });

    document.getElementById('btn-build-plan').addEventListener('click', function() {
      var tables = Array.from(cleanupSelectedTables).map(function(name) {
        var cfg = cleanupConfigs[name];
        var entry = { logicalName: name, recordCount: cfg ? cfg.recordCount : 10, sortOrder: cfg ? (cfg.sortOrder || 'newest') : 'newest' };
        if (cfg && cfg.filterMode === 'fetchxml' && cfg.fetchXml && cfg.fetchXml.trim()) {
          entry.fetchXml = cfg.fetchXml.trim();
        }
        return entry;
      });
      if (tables.length === 0) { showError('No tables selected for cleanup.'); return; }
      this.disabled = true;
      this.textContent = 'Building plan...';
      vscode.postMessage({ type: 'cleanupPlan', tables: tables });
    });

    // ─── Delegated Event Listeners (for dynamic content) ────────
    document.getElementById('table-list').addEventListener('change', function(e) {
      var cb = e.target;
      if (cb.type !== 'checkbox') return;
      var item = cb.closest('.table-item');
      if (!item) return;
      var logicalName = item.dataset.logical;
      var displayName = item.dataset.display;
      toggleTable(logicalName, displayName, cb.checked);
    });

    document.getElementById('selected-tables-chips').addEventListener('click', function(e) {
      var btn = e.target.closest('.chip-remove');
      if (!btn) return;
      var table = btn.dataset.table;
      if (table) removeTable(table);
    });

    document.getElementById('selected-tables').addEventListener('click', function(e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var action = btn.dataset.action;
      var table = btn.dataset.table;
      if (action === 'remove') removeTable(table);
      else if (action === 'selectAll') selectAllColumns(table);
      else if (action === 'selectNone') selectNoneColumns(table);
    });

    document.getElementById('selected-tables').addEventListener('change', function(e) {
      var el = e.target;
      if (el.tagName !== 'INPUT' && el.tagName !== 'SELECT') return;
      var table = el.dataset.table;
      if (!table) return;

      if (el.dataset.action === 'recordCount') {
        updateRecordCount(table, el.value);
      } else if (el.dataset.action === 'columnMode') {
        updateColumnMode(table, el.value);
      } else if (el.dataset.action === 'toggleColumn') {
        toggleColumn(table, el.dataset.column, el.checked);
      } else if (el.dataset.action === 'tableContext') {
        if (tableConfigs[table]) tableConfigs[table].tableContext = el.value;
      }
    });

    document.getElementById('selected-tables').addEventListener('input', function(e) {
      var el = e.target;
      if (el.dataset && el.dataset.action === 'tableContext' && el.dataset.table) {
        if (tableConfigs[el.dataset.table]) tableConfigs[el.dataset.table].tableContext = el.value;
      }
    });

    // ─── Message Handler ────────────────────────────────────────
    window.addEventListener('message', function(event) {
      var msg = event.data;
      switch (msg.type) {
        case 'connectionStatus': handleConnectionStatus(msg); break;
        case 'tables': handleTables(msg.tables); break;
        case 'columns': handleColumns(msg.tableName, msg.columns); break;
        case 'progress': handleProgress(msg); handleCleanupProgress(msg); break;
        case 'result': handleResult(msg.result, msg.tableDataSources); break;
        case 'documentContext': handleDocumentContext(msg); break;
        case 'cleanupPlan': handleCleanupPlan(msg.plan); break;
        case 'cleanupResult': handleCleanupResult(msg.result); break;
        case 'cleanupRecordCount': handleCleanupRecordCount(msg.tableName, msg.count); break;
        case 'error': showError(msg.message); break;
      }
    });

    // ─── Connection ─────────────────────────────────────────────
    function handleConnectionStatus(msg) {
      isConnected = msg.connected;
      if (msg.connected) {
        document.getElementById('connection-form').style.display = 'none';
        document.getElementById('connection-connected').style.display = 'flex';
        document.getElementById('connected-env').textContent = msg.envUrl;
        show('context-area');
        show('mode-toggle');
        switchMode(currentMode);
        vscode.postMessage({ type: 'loadTables' });
      } else {
        document.getElementById('connection-form').style.display = '';
        document.getElementById('connection-connected').style.display = 'none';
        document.getElementById('btn-connect').disabled = false;
        document.getElementById('btn-connect').textContent = 'Connect';
        hide('context-area');
        hide('mode-toggle');
        hide('section-tables');
        hide('section-config');
        hide('section-generate');
        hide('section-results');
        hideCleanupSections();
      }
    }

    // ─── Document Context ───────────────────────────────────────
    function handleDocumentContext(msg) {
      var docStatus = document.getElementById('doc-status');
      document.getElementById('btn-upload-doc').disabled = false;

      // Set the business context field
      if (msg.context) {
        document.getElementById('app-context').value = msg.context;
        docStatus.textContent = '✅ Context extracted from document.';
      }

      // Auto-select suggested tables (if tables are loaded)
      if (msg.suggestedTables && msg.suggestedTables.length > 0 && allTables.length > 0) {
        var matched = [];
        msg.suggestedTables.forEach(function(tableName) {
          var found = allTables.find(function(t) {
            return t.logicalName === tableName;
          });
          if (found && !selectedTableNames.has(found.logicalName)) {
            toggleTable(found.logicalName, found.displayName, true);
            matched.push(found.displayName);
          }
        });
        if (matched.length > 0) {
          docStatus.textContent += ' Tables auto-selected: ' + matched.join(', ');
        }
        renderTableList();
        updateConfigSection();
      }

      // Hide progress
      hide('progress-area');
    }

    // ─── Tables ─────────────────────────────────────────────────
    function handleTables(tables) {
      allTables = tables.sort(function(a, b) { return a.displayName.localeCompare(b.displayName); });
      renderTableList();
    }

    function renderTableList() {
      var search = document.getElementById('table-search').value.toLowerCase();
      var filtered = allTables.filter(function(t) {
        return t.displayName.toLowerCase().includes(search) || t.logicalName.toLowerCase().includes(search);
      });

      var container = document.getElementById('table-list');
      container.innerHTML = filtered.map(function(t) {
        var checked = selectedTableNames.has(t.logicalName) ? 'checked' : '';
        return '<div class="table-item" data-logical="' + t.logicalName + '" data-display="' + escapeAttr(t.displayName) + '">' +
          '<input type="checkbox" ' + checked + '>' +
          '<div>' +
            '<span class="table-name">' + escapeHtml(t.displayName) + '</span>' +
            '<span class="table-logical">' + t.logicalName + '</span>' +
            (t.description ? '<span class="table-desc">' + escapeHtml(t.description) + '</span>' : '') +
          '</div>' +
        '</div>';
      }).join('');

      document.getElementById('table-count').textContent = selectedTableNames.size + ' selected';
    }

    function toggleTable(logicalName, displayName, checked) {
      if (checked) {
        if (selectedTableNames.size >= 10) {
          showError('Maximum 10 tables per run. Generate these first, then add more.');
          renderTableList();
          return;
        }
        selectedTableNames.add(logicalName);
        if (!tableConfigs[logicalName]) {
          tableConfigs[logicalName] = {
            displayName: displayName,
            recordCount: 10,
            columnMode: 'best',
            selectedColumns: [],
            tableContext: '',
          };
        }
      } else {
        selectedTableNames.delete(logicalName);
        delete tableConfigs[logicalName];
      }
      document.getElementById('table-count').textContent = selectedTableNames.size + ' selected';
      updateConfigSection();
    }

    // ─── Config Section ─────────────────────────────────────────
    function updateConfigSection() {
      var hasSelection = selectedTableNames.size > 0;
      if (hasSelection) { show('section-config'); show('section-generate'); }
      else { hide('section-config'); hide('section-generate'); }

      // Update table chips if picker is collapsed
      var area = document.getElementById('table-picker-area');
      if (area.classList.contains('hidden')) {
        updateSelectedTableChips();
        document.getElementById('btn-collapse-tables').textContent =
          '\u25bc ' + selectedTableNames.size + ' table(s) selected \u2014 Expand';
      }

      var container = document.getElementById('selected-tables');
      container.innerHTML = '';

      selectedTableNames.forEach(function(name) {
        var cfg = tableConfigs[name];
        var div = document.createElement('div');
        div.className = 'table-config';
        div.id = 'config-' + name;

        div.innerHTML =
          '<div class="table-config-header">' +
            '<span class="table-name">' + escapeHtml(cfg.displayName) + ' <span class="table-logical">(' + name + ')</span></span>' +
            '<button class="remove-table" data-action="remove" data-table="' + name + '" title="Remove">×</button>' +
          '</div>' +
          '<div class="config-row">' +
            '<label>Records</label>' +
            '<input type="number" min="1" max="5000" value="' + cfg.recordCount + '" data-action="recordCount" data-table="' + name + '">' +
            '<label>Columns</label>' +
            '<select data-action="columnMode" data-table="' + name + '">' +
              '<option value="best"' + (cfg.columnMode === 'best' ? ' selected' : '') + '>Best Applicable</option>' +
              '<option value="mandatory"' + (cfg.columnMode === 'mandatory' ? ' selected' : '') + '>Only Mandatory</option>' +
              '<option value="selected"' + (cfg.columnMode === 'selected' ? ' selected' : '') + '>Selected Columns</option>' +
            '</select>' +
          '</div>' +
          '<div class="config-desc-row">' +
            '<input type="text" placeholder="Describe ' + escapeAttr(cfg.displayName) + ' records (optional)..." ' +
              'value="' + escapeAttr(cfg.tableContext || '') + '" data-action="tableContext" data-table="' + name + '">' +
          '</div>' +
          '<div id="columns-' + name + '" class="' + (cfg.columnMode === 'selected' ? '' : 'hidden') + '">' +
            '<div class="text-center" style="padding:8px;color:var(--description-fg);">Loading columns...</div>' +
          '</div>';

        container.appendChild(div);

        if (cfg.columnMode === 'selected' && !tableColumns[name]) {
          vscode.postMessage({ type: 'loadColumns', tableName: name });
        } else if (cfg.columnMode === 'selected' && tableColumns[name]) {
          renderColumnPicker(name);
        }
      });

      updateGenerateSummary();
    }

    function removeTable(logicalName) {
      selectedTableNames.delete(logicalName);
      delete tableConfigs[logicalName];
      renderTableList();
      updateConfigSection();
    }

    function updateRecordCount(logicalName, value) {
      var n = Math.max(1, Math.min(5000, parseInt(value) || 10));
      tableConfigs[logicalName].recordCount = n;
      updateGenerateSummary();
    }

    function updateColumnMode(logicalName, mode) {
      tableConfigs[logicalName].columnMode = mode;
      var colDiv = document.getElementById('columns-' + logicalName);
      if (mode === 'selected') {
        colDiv.classList.remove('hidden');
        if (!tableColumns[logicalName]) {
          vscode.postMessage({ type: 'loadColumns', tableName: logicalName });
        } else {
          renderColumnPicker(logicalName);
        }
      } else {
        colDiv.classList.add('hidden');
      }
      updateGenerateSummary();
    }

    // ─── Column Picker ──────────────────────────────────────────
    function handleColumns(tableName, columns) {
      tableColumns[tableName] = columns;
      renderColumnPicker(tableName);
    }

    function renderColumnPicker(tableName) {
      var columns = tableColumns[tableName];
      if (!columns) return;
      var container = document.getElementById('columns-' + tableName);
      if (!container) return;
      var cfg = tableConfigs[tableName];
      var selected = new Set(cfg.selectedColumns || []);

      // Build selected columns chip summary
      var chipHtml = '';
      var allSelected = columns.filter(function(c) { return c.isRequired || selected.has(c.logicalName); });
      if (allSelected.length > 0) {
        chipHtml = '<div class="selected-cols-chips chip-container">';
        allSelected.forEach(function(c) {
          chipHtml += '<span class="chip chip-secondary">' + escapeHtml(c.displayName) +
            (c.isRequired ? ' <span style="opacity:0.5;">*</span>' : '') + '</span>';
        });
        chipHtml += '</div>';
      }

      container.innerHTML =
        chipHtml +
        '<div class="column-actions">' +
          '<button class="secondary" data-action="selectAll" data-table="' + tableName + '">Select All</button>' +
          '<button class="secondary" data-action="selectNone" data-table="' + tableName + '">Deselect All</button>' +
          '<span class="badge" id="col-count-' + tableName + '">' + selected.size + ' / ' + columns.length + '</span>' +
        '</div>' +
        '<div class="column-picker">' +
          columns.map(function(c) {
            var isReq = c.isRequired;
            var checked = (isReq || selected.has(c.logicalName)) ? 'checked' : '';
            var disabled = isReq ? 'disabled' : '';
            return '<div class="column-item">' +
              '<input type="checkbox" ' + checked + ' ' + disabled + ' data-action="toggleColumn" data-table="' + tableName + '" data-column="' + c.logicalName + '">' +
              '<span class="col-name">' + escapeHtml(c.displayName) + '</span>' +
              '<span class="col-type">' + c.attributeType + (c.maxLength ? '(' + c.maxLength + ')' : '') + '</span>' +
              (isReq ? '<span class="col-required">REQUIRED</span>' : '') +
              (c.description ? '<span class="col-desc">' + escapeHtml(c.description) + '</span>' : '') +
            '</div>';
          }).join('') +
        '</div>';
    }

    function toggleColumn(tableName, colName, checked) {
      var cfg = tableConfigs[tableName];
      if (!cfg.selectedColumns) cfg.selectedColumns = [];
      if (checked) {
        if (!cfg.selectedColumns.includes(colName)) cfg.selectedColumns.push(colName);
      } else {
        cfg.selectedColumns = cfg.selectedColumns.filter(function(c) { return c !== colName; });
      }
      var cols = tableColumns[tableName] || [];
      var countEl = document.getElementById('col-count-' + tableName);
      if (countEl) {
        var reqCount = cols.filter(function(c) { return c.isRequired; }).length;
        countEl.textContent = (cfg.selectedColumns.length + reqCount) + ' / ' + cols.length;
      }
      // Update the selected column chips
      renderColumnChips(tableName);
      updateGenerateSummary();
    }

    function renderColumnChips(tableName) {
      var columns = tableColumns[tableName];
      if (!columns) return;
      var container = document.getElementById('columns-' + tableName);
      if (!container) return;
      var cfg = tableConfigs[tableName];
      var selected = new Set(cfg.selectedColumns || []);
      var existing = container.querySelector('.selected-cols-chips');

      var allSelected = columns.filter(function(c) { return c.isRequired || selected.has(c.logicalName); });
      if (allSelected.length === 0) {
        if (existing) existing.remove();
        return;
      }
      var chipHtml = '';
      allSelected.forEach(function(c) {
        chipHtml += '<span class="chip chip-secondary">' + escapeHtml(c.displayName) +
          (c.isRequired ? ' <span style="opacity:0.5;">*</span>' : '') + '</span>';
      });

      if (existing) {
        existing.innerHTML = chipHtml;
      } else {
        var div = document.createElement('div');
        div.className = 'selected-cols-chips chip-container';
        div.innerHTML = chipHtml;
        container.insertBefore(div, container.firstChild);
      }
    }

    function selectAllColumns(tableName) {
      var cols = tableColumns[tableName] || [];
      tableConfigs[tableName].selectedColumns = cols.filter(function(c) { return !c.isRequired; }).map(function(c) { return c.logicalName; });
      renderColumnPicker(tableName);
      updateGenerateSummary();
    }

    function selectNoneColumns(tableName) {
      tableConfigs[tableName].selectedColumns = [];
      renderColumnPicker(tableName);
      updateGenerateSummary();
    }

    // ─── Generate ───────────────────────────────────────────────
    function updateSelectedTableChips() {
      var container = document.getElementById('selected-tables-chips');
      if (selectedTableNames.size === 0) {
        container.classList.add('hidden');
        container.innerHTML = '';
        return;
      }
      container.classList.remove('hidden');
      var html = '';
      selectedTableNames.forEach(function(name) {
        var cfg = tableConfigs[name];
        var label = cfg ? cfg.displayName : name;
        html += '<span class="chip">' + escapeHtml(label) +
          ' <span style="opacity:0.7;">(' + (cfg ? cfg.recordCount : 0) + ')</span>' +
          '<button class="chip-remove" data-table="' + name + '" title="Remove">&times;</button></span>';
      });
      container.innerHTML = html;
    }

    function updateGenerateSummary() {
      var total = 0;
      selectedTableNames.forEach(function(t) { total += (tableConfigs[t] ? tableConfigs[t].recordCount : 0); });
      var el = document.getElementById('generate-summary');
      el.innerHTML = '<strong>' + selectedTableNames.size + '</strong> table(s), <strong>' + total + '</strong> total records';
    }

    function handleProgress(msg) {
      document.getElementById('progress-message').textContent = msg.message;
      if (msg.percentage !== undefined) {
        document.getElementById('progress-fill').style.width = msg.percentage + '%';
      }
    }

    function handleResult(result, tableDataSources) {
      hide('progress-area');
      document.getElementById('btn-generate').disabled = false;
      show('section-results');

      var duration = new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime();

      var html =
        '<div class="result-summary">' +
          '<div class="result-stat"><div class="number" style="color:var(--success-fg)">' + result.totalCreated + '</div><div class="label">Created</div></div>' +
          '<div class="result-stat"><div class="number" style="color:var(--error-fg)">' + result.totalFailed + '</div><div class="label">Failed</div></div>' +
          '<div class="result-stat"><div class="number">' + (duration / 1000).toFixed(1) + 's</div><div class="label">Duration</div></div>' +
        '</div>';

      html += '<table class="result-table"><thead><tr><th>Table</th><th>Created</th><th>Requested</th><th>Source</th><th>Status</th></tr></thead><tbody>';
      for (var i = 0; i < result.tables.length; i++) {
        var t = result.tables[i];
        var src = tableDataSources && tableDataSources[t.tableName];
        var srcLabel = src ? (src.source === 'ai' ? '🤖 AI' : '🎲 Faker') : '—';
        var icon = t.failed === 0 ? '✅' : '⚠️';
        html += '<tr><td>' + t.tableName + '</td><td>' + t.created + '</td><td>' + t.requested + '</td><td>' + srcLabel + '</td><td>' + icon + '</td></tr>';
      }
      html += '</tbody></table>';

      if (result.errors && result.errors.length > 0) {
        html += '<h3 class="mt-12">Errors</h3><div class="error-list">';
        for (var j = 0; j < result.errors.length && j < 10; j++) {
          html += '<div class="error-item">' + escapeHtml(result.errors[j]) + '</div>';
        }
        if (result.errors.length > 10) {
          html += '<div style="color:var(--description-fg);padding:4px;">... and ' + (result.errors.length - 10) + ' more</div>';
        }
        html += '</div>';
      }

      document.getElementById('results-content').innerHTML = html;
      document.getElementById('section-results').scrollIntoView({ behavior: 'smooth' });
    }

    // ─── Utilities ──────────────────────────────────────────────
    function show(id) { document.getElementById(id).classList.remove('hidden'); }
    function hide(id) { document.getElementById(id).classList.add('hidden'); }
    function escapeHtml(s) {
      if (!s) return '';
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function escapeAttr(s) {
      if (!s) return '';
      return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function showError(message) {
      var div = document.createElement('div');
      div.className = 'error-item';
      div.style.cssText = 'position:fixed;top:12px;right:12px;z-index:9999;max-width:400px;padding:10px 16px;border-radius:6px;';
      div.textContent = message;
      document.body.appendChild(div);
      setTimeout(function() { div.remove(); }, 5000);
    }

    // ─── Mode Switching ─────────────────────────────────────────
    function switchMode(mode) {
      currentMode = mode;
      document.getElementById('btn-mode-generate').classList.toggle('active', mode === 'generate');
      document.getElementById('btn-mode-cleanup').classList.toggle('active', mode === 'cleanup');

      if (mode === 'generate') {
        // Show generate sections, hide cleanup
        show('context-area');
        show('section-tables');
        if (selectedTableNames.size > 0) { show('section-config'); show('section-generate'); }
        hideCleanupSections();
      } else {
        // Show cleanup sections, hide generate
        hide('context-area');
        hide('section-tables');
        hide('section-config');
        hide('section-generate');
        hide('section-results');
        show('section-cleanup-tables');
        // Ensure table picker area is expanded
        var cpArea = document.getElementById('cleanup-table-picker-area');
        cpArea.classList.remove('hidden');
        document.getElementById('btn-collapse-cleanup-tables').textContent = '\u25b2 Collapse';
        renderCleanupTableList();
        if (cleanupSelectedTables.size > 0) { show('section-cleanup-config'); }
      }
    }

    function hideCleanupSections() {
      hide('section-cleanup-tables');
      hide('section-cleanup-config');
      hide('section-cleanup-plan');
      hide('section-cleanup-results');
    }

    // ─── Cleanup: Table Selection ───────────────────────────────
    function renderCleanupTableList() {
      var search = document.getElementById('cleanup-table-search').value.toLowerCase();
      var filtered = allTables.filter(function(t) {
        return t.displayName.toLowerCase().includes(search) || t.logicalName.toLowerCase().includes(search);
      });

      var container = document.getElementById('cleanup-table-list');
      container.innerHTML = filtered.map(function(t) {
        var checked = cleanupSelectedTables.has(t.logicalName) ? 'checked' : '';
        return '<div class="table-item" data-logical="' + t.logicalName + '" data-display="' + escapeAttr(t.displayName) + '">' +
          '<input type="checkbox" ' + checked + '>' +
          '<div>' +
            '<span class="table-name">' + escapeHtml(t.displayName) + '</span>' +
            '<span class="table-logical">' + t.logicalName + '</span>' +
          '</div>' +
        '</div>';
      }).join('');

      updateCleanupChips();
    }

    function toggleCleanupTable(logicalName, displayName, checked) {
      if (checked) {
        if (cleanupSelectedTables.size >= 10) {
          showError('Maximum 10 tables allowed.');
          renderCleanupTableList();
          return;
        }
        cleanupSelectedTables.add(logicalName);
        if (!cleanupConfigs[logicalName]) {
          cleanupConfigs[logicalName] = { displayName: displayName, recordCount: 50, available: -1, sortOrder: 'newest', filterMode: 'count', fetchXml: '' };
        }
        // Request record count from server
        vscode.postMessage({ type: 'cleanupRecordCount', tableName: logicalName });
      } else {
        cleanupSelectedTables.delete(logicalName);
        delete cleanupConfigs[logicalName];
      }
      updateCleanupUI();
    }

    function removeCleanupTable(logicalName) {
      cleanupSelectedTables.delete(logicalName);
      delete cleanupConfigs[logicalName];
      renderCleanupTableList();
      updateCleanupUI();
    }

    function updateCleanupChips() {
      var container = document.getElementById('cleanup-selected-chips');
      if (cleanupSelectedTables.size === 0) {
        container.innerHTML = '';
        return;
      }
      var html = '';
      cleanupSelectedTables.forEach(function(name) {
        var cfg = cleanupConfigs[name];
        var label = cfg ? cfg.displayName : name;
        var countLabel = cfg && cfg.available >= 0 ? ' (' + cfg.available + ' records)' : '';
        html += '<span class="chip">' + escapeHtml(label) + countLabel +
          '<button class="chip-remove" data-table="' + name + '">&times;</button></span>';
      });
      container.innerHTML = html;
    }

    function updateCleanupUI() {
      updateCleanupChips();

      if (cleanupSelectedTables.size > 0) {
        show('section-cleanup-config');
        renderCleanupConfigs();
      } else {
        hide('section-cleanup-config');
        hide('section-cleanup-plan');
        hide('section-cleanup-results');
      }
    }

    function renderCleanupConfigs() {
      var container = document.getElementById('cleanup-configs');
      var html = '';
      cleanupSelectedTables.forEach(function(name) {
        var cfg = cleanupConfigs[name];
        var availStr = cfg.available >= 0 ? ' <span style="color:var(--description-fg);">(' + cfg.available + ' available)</span>' : ' <span style="color:var(--description-fg);">(checking...)</span>';
        var sortVal = cfg.sortOrder || 'newest';
        var filterMode = cfg.filterMode || 'count';
        html +=
          '<div class="table-config" style="padding:8px 12px;">' +
            '<div style="font-weight:600;margin-bottom:4px;">' + escapeHtml(cfg.displayName) + availStr + '</div>' +
            '<div class="cleanup-filter-row">' +
              '<label>Delete</label>' +
              '<input type="number" min="1" max="5000" value="' + cfg.recordCount + '" data-action="cleanupCount" data-table="' + name + '" style="width:80px;">' +
              '<select data-action="cleanupSort" data-table="' + name + '">' +
                '<option value="newest"' + (sortVal === 'newest' ? ' selected' : '') + '>Newest first</option>' +
                '<option value="oldest"' + (sortVal === 'oldest' ? ' selected' : '') + '>Oldest first</option>' +
              '</select>' +
              '<select data-action="cleanupFilterMode" data-table="' + name + '">' +
                '<option value="count"' + (filterMode === 'count' ? ' selected' : '') + '>By count</option>' +
                '<option value="fetchxml"' + (filterMode === 'fetchxml' ? ' selected' : '') + '>FetchXML filter</option>' +
              '</select>' +
            '</div>' +
            '<div id="fetchxml-' + name + '" class="fetchxml-area' + (filterMode === 'fetchxml' ? '' : ' hidden') + '">' +
              '<textarea placeholder="Paste FetchXML query here..." data-action="fetchXml" data-table="' + name + '">' + escapeHtml(cfg.fetchXml || '') + '</textarea>' +
            '</div>' +
          '</div>';
      });
      container.innerHTML = html;

      // Reset build plan button
      var btn = document.getElementById('btn-build-plan');
      btn.disabled = false;
      btn.textContent = '\ud83d\udccb Build Deletion Plan';
    }

    function handleCleanupRecordCount(tableName, count) {
      cleanupRecordCounts[tableName] = count;
      if (cleanupConfigs[tableName]) {
        cleanupConfigs[tableName].available = count;
        // Auto-set delete count to available count if smaller
        if (count >= 0 && cleanupConfigs[tableName].recordCount > count) {
          cleanupConfigs[tableName].recordCount = Math.max(1, count);
        }
      }
      updateCleanupUI();
    }

    // ─── Cleanup: Plan Display ──────────────────────────────────
    function handleCleanupPlan(plan) {
      var btn = document.getElementById('btn-build-plan');
      btn.disabled = false;
      btn.textContent = '\ud83d\udccb Build Deletion Plan';

      show('section-cleanup-plan');
      hide('cleanup-progress');

      var html =
        '<div class="plan-summary">' +
          '<strong>Plan:</strong> ' + escapeHtml(plan.summary) +
        '</div>' +
        '<p class="plan-warning">\u26a0\ufe0f This action is irreversible. Records will be permanently deleted.</p>' +
        '<table class="plan-table">' +
          '<thead><tr><th>Order</th><th>Table</th><th>Records</th><th>Sort</th><th>Filter</th></tr></thead>' +
          '<tbody>';

      for (var i = 0; i < plan.steps.length; i++) {
        var step = plan.steps[i];
        var filterLabel = step.fetchXml ? 'FetchXML' : 'By count';
        var sortLabel = step.sortOrder === 'oldest' ? 'Oldest first' : 'Newest first';
        html += '<tr>' +
          '<td>' + step.order + '</td>' +
          '<td><strong>' + escapeHtml(step.displayName) + '</strong> <span style="color:var(--description-fg);">(' + step.logicalName + ')</span></td>' +
          '<td>' + (step.fetchXml ? 'All matching' : step.recordCount) + '</td>' +
          '<td>' + sortLabel + '</td>' +
          '<td>' + filterLabel + '</td>' +
        '</tr>';
      }

      html += '</tbody></table>';

      html += '<div class="confirm-actions">' +
        '<button class="btn-danger" id="btn-confirm-cleanup">\ud83d\uddd1\ufe0f Confirm & Delete</button>' +
        '<button class="btn-secondary" id="btn-cancel-cleanup">Cancel</button>' +
      '</div>';

      document.getElementById('cleanup-plan-content').innerHTML = html;

      document.getElementById('btn-confirm-cleanup').addEventListener('click', function() {
        this.disabled = true;
        this.textContent = 'Deleting...';
        document.getElementById('btn-cancel-cleanup').disabled = true;
        show('cleanup-progress');
        vscode.postMessage({ type: 'cleanupExecute' });
      });

      document.getElementById('btn-cancel-cleanup').addEventListener('click', function() {
        hide('section-cleanup-plan');
      });

      document.getElementById('section-cleanup-plan').scrollIntoView({ behavior: 'smooth' });
    }

    function handleCleanupProgress(msg) {
      if (currentMode !== 'cleanup') return;
      var msgEl = document.getElementById('cleanup-progress-message');
      if (msgEl) msgEl.textContent = msg.message;
      if (msg.percentage !== undefined) {
        var fill = document.getElementById('cleanup-progress-fill');
        if (fill) fill.style.width = msg.percentage + '%';
      }
    }

    // ─── Cleanup: Results ───────────────────────────────────────
    function handleCleanupResult(result) {
      hide('cleanup-progress');
      show('section-cleanup-results');

      var duration = new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime();

      var html =
        '<div class="result-summary">' +
          '<div class="result-stat"><div class="number" style="color:var(--success-fg)">' + result.totalDeleted + '</div><div class="label">Deleted</div></div>' +
          '<div class="result-stat"><div class="number" style="color:var(--error-fg)">' + result.totalFailed + '</div><div class="label">Failed</div></div>' +
          '<div class="result-stat"><div class="number">' + (duration / 1000).toFixed(1) + 's</div><div class="label">Duration</div></div>' +
        '</div>';

      html += '<table class="result-table"><thead><tr><th>Table</th><th>Deleted</th><th>Failed</th><th>Available</th><th>Status</th></tr></thead><tbody>';
      for (var i = 0; i < result.tables.length; i++) {
        var t = result.tables[i];
        var icon = t.failed === 0 ? '\u2705' : '\u26a0\ufe0f';
        html += '<tr><td>' + t.tableName + '</td><td>' + t.deleted + '</td><td>' + t.failed + '</td><td>' + t.available + '</td><td>' + icon + '</td></tr>';
      }
      html += '</tbody></table>';

      if (result.errors && result.errors.length > 0) {
        html += '<h3 class="mt-12">Errors</h3><div class="error-list">';
        for (var j = 0; j < result.errors.length && j < 10; j++) {
          html += '<div class="error-item">' + escapeHtml(result.errors[j]) + '</div>';
        }
        html += '</div>';
      }

      html += '<div style="margin-top:12px;"><button class="btn-secondary" id="btn-cleanup-again">\ud83d\udd04 Clean More</button></div>';

      document.getElementById('cleanup-results-content').innerHTML = html;

      document.getElementById('btn-cleanup-again').addEventListener('click', function() {
        // Reset cleanup state
        cleanupSelectedTables.clear();
        cleanupConfigs = {};
        hide('section-cleanup-plan');
        hide('section-cleanup-results');
        renderCleanupTableList();
        updateCleanupUI();
      });

      document.getElementById('section-cleanup-results').scrollIntoView({ behavior: 'smooth' });
    }
  </script>
</body>
</html>`;
}
