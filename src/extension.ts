/**
 * VS Code Extension Entry Point
 * Registers commands, chat participant, and language model tool.
 */

import * as vscode from 'vscode';
import { AuthManager, DataverseClient, MetadataReader, DependencyPlanner, DataGenerator, AIDataGenerator, Writer } from './core';
import type { DataverseConnection, RunResult, RecordProvider, TableMetadata } from './core';
import { DataverseWebviewPanel } from './webview/panel';

// ─── Global State ───────────────────────────────────────────────────────────
let authManager: AuthManager;
let connection: DataverseConnection | null = null;
let appContext: string | undefined;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let uiStatusBarItem: vscode.StatusBarItem;

// ─── Activate ───────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  authManager = new AuthManager();
  outputChannel = vscode.window.createOutputChannel('Dataverse Sample Data');
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'dvdata.connect';
  updateStatusBar();

  // UI launcher button in status bar (always visible)
  uiStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  uiStatusBarItem.text = '$(window) DV Generator';
  uiStatusBarItem.tooltip = 'Open Dataverse Sample Data Generator UI';
  uiStatusBarItem.command = 'dvdata.openUI';
  uiStatusBarItem.show();

  // ── Commands ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('dvdata.connect', connectCommand),
    vscode.commands.registerCommand('dvdata.disconnect', disconnectCommand),
    vscode.commands.registerCommand('dvdata.generate', generateCommand),
    vscode.commands.registerCommand('dvdata.showPlan', showPlanCommand),
    vscode.commands.registerCommand('dvdata.openUI', () => {
      DataverseWebviewPanel.createOrShow(context.extensionUri, outputChannel, connection);
    }),
  );

  // ── Chat Participant ──────────────────────────────────────────────────
  const participant = vscode.chat.createChatParticipant('dvdata.chatParticipant', chatHandler);
  participant.iconPath = new vscode.ThemeIcon('database');

  participant.followupProvider = {
    provideFollowups(result: ChatResult, _context: vscode.ChatContext, _token: vscode.CancellationToken) {
      const followups: vscode.ChatFollowup[] = [];

      if (result.action === 'connected') {
        followups.push({ prompt: 'Show me the available tables', label: 'List tables' });
        followups.push({ prompt: 'Generate sample data', label: 'Generate data' });
      } else if (result.action === 'tables') {
        followups.push({ prompt: 'Generate 50 records each for Account and Contact', label: 'Generate for common tables' });
      } else if (result.action === 'plan') {
        followups.push({ prompt: 'Run the generation now', label: 'Execute the plan' });
      } else if (result.action === 'generated') {
        followups.push({ prompt: 'Show me the run summary', label: 'View results' });
      }

      return followups;
    },
  };

  context.subscriptions.push(participant);

  // ── Language Model Tool ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.lm.registerTool('dvdata_generate_sample_data', new GenerateSampleDataTool())
  );

  // ── Subscriptions ─────────────────────────────────────────────────────
  context.subscriptions.push(outputChannel, statusBarItem, uiStatusBarItem);

  log('Dataverse Sample Data Generator activated.');
}

export function deactivate() {
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}

// ─── Status Bar ─────────────────────────────────────────────────────────────
function updateStatusBar() {
  if (connection?.isConnected) {
    statusBarItem.text = `$(database) ${connection.environmentUrl.replace('https://', '').split('.')[0]}`;
    statusBarItem.tooltip = `Connected: ${connection.environmentUrl}`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = '$(database) Dataverse: Not connected';
    statusBarItem.tooltip = 'Click to connect to Dataverse';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusBarItem.show();
}

// ─── Logging ────────────────────────────────────────────────────────────────
function log(message: string) {
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] ${message}`);
}

// ─── Auto-Resolve Dependencies ─────────────────────────────────────────────

/**
 * Given user-selected tables and their metadata, discover required lookup
 * dependencies pointing to tables NOT in the user's list, fetch their metadata,
 * and add them to the plan with a default record count.
 */
async function resolveRequiredDependencies(
  userTables: string[],
  tablesMetadata: Map<string, TableMetadata>,
  recordCounts: Map<string, number>,
  reader: MetadataReader,
  onLog?: (msg: string) => void,
  excludeTables?: Set<string>
): Promise<void> {
  const resolved = new Set<string>([...tablesMetadata.keys()]);
  // Pre-mark excluded tables as resolved so they're never auto-included
  if (excludeTables) {
    for (const t of excludeTables) {
      resolved.add(t);
    }
  }
  const toResolve: string[] = [...userTables];

  while (toResolve.length > 0) {
    const tableName = toResolve.pop()!;
    const meta = tablesMetadata.get(tableName);
    if (!meta) continue;

    // --- 1. Check standard ManyToOne relationships ---
    for (const rel of meta.manyToOneRelationships) {
      const parentTable = rel.referencedEntity;
      if (parentTable === tableName || resolved.has(parentTable)) continue;

      const lookupCol = meta.columns.find((c) => c.logicalName === rel.referencingAttribute);
      // Skip Owner type lookups — ownership is system-managed
      if (lookupCol?.attributeType === 'Owner') continue;
      // Skip Customer type — handled separately below (polymorphic, any target satisfies)
      if (lookupCol?.attributeType === 'Customer') continue;
      if (!(lookupCol?.isRequired ?? false)) continue;

      await tryAutoInclude(parentTable, tableName, rel.referencingAttribute, reader, tablesMetadata, recordCounts, resolved, toResolve, onLog);
    }

    // --- 2. Check Customer type polymorphic lookups ---
    for (const col of meta.columns) {
      if (col.attributeType !== 'Customer' || !col.isRequired) continue;
      // Customer lookups target e.g. ['account', 'contact']
      // If ANY target is already resolved (in plan, excluded, or already exists), the lookup is satisfied
      const anyTargetResolved = (col.lookupTargets || []).some((t) => resolved.has(t));
      if (anyTargetResolved) continue;

      // None resolved — auto-include the first creatable target
      for (const target of col.lookupTargets || []) {
        if (target === tableName) continue;
        await tryAutoInclude(target, tableName, col.logicalName, reader, tablesMetadata, recordCounts, resolved, toResolve, onLog);
        break;
      }
    }
  }
}

async function tryAutoInclude(
  parentTable: string,
  childTable: string,
  columnName: string,
  reader: MetadataReader,
  tablesMetadata: Map<string, TableMetadata>,
  recordCounts: Map<string, number>,
  resolved: Set<string>,
  toResolve: string[],
  onLog?: (msg: string) => void
): Promise<void> {
  try {
    const parentMeta = await reader.getTableMetadata(parentTable);

    // Skip non-creatable entities (virtual, intersect, system entities)
    if (!parentMeta.isCreatable) {
      onLog?.(`Skipping "${parentTable}" — entity is not creatable`);
      resolved.add(parentTable); // Mark as resolved so we don't retry
      return;
    }

    onLog?.(`Auto-including "${parentTable}" — required by "${childTable}.${columnName}"`);
    tablesMetadata.set(parentTable, parentMeta);

    const childCount = recordCounts.get(childTable) || 1;
    const parentCount = Math.min(Math.max(1, Math.ceil(childCount / 2)), 10);
    recordCounts.set(parentTable, parentCount);

    resolved.add(parentTable);
    toResolve.push(parentTable);
  } catch (err) {
    onLog?.(`Warning: Could not fetch metadata for "${parentTable}": ${err}`);
    resolved.add(parentTable);
  }
}

// ─── Commands ───────────────────────────────────────────────────────────────
async function connectCommand() {
  const config = vscode.workspace.getConfiguration('dvdata');
  const authMethod = config.get<string>('authMethod') || 'browser';

  // Normalize the environment URL (strip trailing slash)
  let envUrl = config.get<string>('environmentUrl');
  if (!envUrl) {
    envUrl = await vscode.window.showInputBox({
      prompt: 'Enter your Dataverse environment URL',
      placeHolder: 'https://yourorg.crm.dynamics.com',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value.startsWith('https://') || !value.includes('.dynamics.com')) {
          return 'Please enter a valid Dataverse URL (e.g., https://yourorg.crm.dynamics.com)';
        }
        return undefined;
      },
    });

    if (!envUrl) {
      return;
    }
  }
  envUrl = envUrl.replace(/\/+$/, '');

  try {
    if (authMethod === 'clientCredentials') {
      // App registration flow — needs tenant ID, client ID (in settings), and client secret
      const tenantId = await promptForTenantId(config);
      if (!tenantId) {
        return;
      }

      const clientId = config.get<string>('clientId');
      const clientSecret = await vscode.window.showInputBox({
        prompt: 'Enter the Client Secret',
        password: true,
        ignoreFocusOut: true,
      });
      if (!clientSecret || !clientId) {
        vscode.window.showErrorMessage('Client ID (in settings) and Client Secret are required.');
        return;
      }

      connection = await authManager.connectWithClientCredentials({
        environmentUrl: envUrl,
        tenantId,
        clientId,
        clientSecret,
      });
    } else if (authMethod === 'deviceCode') {
      // Device code flow — fallback for restricted environments
      connection = await authManager.connectWithDeviceCode(envUrl, (message) => {
        vscode.window.showInformationMessage(message);
        log(message);
      });
    } else {
      // Default: Browser sign-in (Auth Code + PKCE) — handles MFA, federation, everything
      log('Opening browser for sign-in...');
      connection = await authManager.connectWithBrowser(envUrl, async (url) => {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      });
    }

    updateStatusBar();
    vscode.window.showInformationMessage(`Connected to ${envUrl}`);
    log(`Connected to ${envUrl}`);

    // Ask for app-level context (optional — user can skip)
    const ctx = await vscode.window.showInputBox({
      prompt: '(Optional) Describe what this application is used for — helps generate realistic data later',
      placeHolder: 'e.g., Banking loan management, Hospital patient tracking, Automobile dealership CRM...',
      ignoreFocusOut: true,
    });
    if (ctx) {
      appContext = ctx;
      log(`App context set: ${appContext}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Connection failed: ${msg}`);
    log(`Connection failed: ${msg}`);
  }
}

async function promptForTenantId(config: vscode.WorkspaceConfiguration): Promise<string | undefined> {
  let tenantId = config.get<string>('tenantId');
  if (!tenantId) {
    tenantId = await vscode.window.showInputBox({
      prompt: 'Enter your Azure AD Tenant ID',
      placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      ignoreFocusOut: true,
    });
  }
  return tenantId;
}

async function disconnectCommand() {
  if (connection) {
    connection.disconnect();
    connection = null;
    appContext = undefined;
    updateStatusBar();
    vscode.window.showInformationMessage('Disconnected from Dataverse.');
    log('Disconnected.');
  }
}

async function generateCommand() {
  if (!connection) {
    vscode.window.showWarningMessage('Not connected. Please connect first.');
    await connectCommand();
    if (!connection) {
      return;
    }
  }

  const result = await runGeneration(connection);
  if (result) {
    showRunResult(result);
  }
}

async function showPlanCommand() {
  if (!connection) {
    vscode.window.showWarningMessage('Not connected. Please connect first.');
    return;
  }

  const client = new DataverseClient(connection);
  const reader = new MetadataReader(client);

  // Let user pick tables
  const tables = await pickTables(reader);
  if (!tables || tables.length === 0) {
    return;
  }

  const count = await askRecordCount();
  if (!count) {
    return;
  }

  const tablesMetadata = await reader.getTablesMetadata(tables);
  const recordCounts = new Map(tables.map((t) => [t, count]));

  const planner = new DependencyPlanner();
  const plan = planner.buildPlan(tablesMetadata, recordCounts);

  // Show plan in output channel
  outputChannel.clear();
  outputChannel.appendLine(plan.summary);
  outputChannel.show();
}

// ─── Helpers ────────────────────────────────────────────────────────────────
async function pickTables(reader: MetadataReader): Promise<string[] | undefined> {
  const allTables = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Loading tables...' },
    () => reader.getSelectableTables()
  );

  const picks = await vscode.window.showQuickPick(
    allTables.map((t) => ({
      label: t.displayName,
      description: t.logicalName,
      picked: false,
    })),
    {
      canPickMany: true,
      placeHolder: 'Select tables to generate data for',
      title: 'Dataverse Tables',
    }
  );

  return picks?.map((p) => p.description!);
}

async function askRecordCount(): Promise<number | undefined> {
  const input = await vscode.window.showInputBox({
    prompt: 'How many records per table?',
    value: '50',
    validateInput: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1 || n > 5000) {
        return 'Enter a number between 1 and 5000';
      }
      return undefined;
    },
  });

  return input ? parseInt(input, 10) : undefined;
}

async function runGeneration(conn: DataverseConnection): Promise<RunResult | undefined> {
  const client = new DataverseClient(conn);
  const reader = new MetadataReader(client);

  const tables = await pickTables(reader);
  if (!tables || tables.length === 0) {
    return undefined;
  }

  const count = await askRecordCount();
  if (!count) {
    return undefined;
  }

  // Ask for business context
  const tableContext = await vscode.window.showInputBox({
    prompt: '(Optional) Any specific context for this generation?',
    placeHolder: 'e.g., Generate data for a loan origination workflow with pending approvals...',
    ignoreFocusOut: true,
  });

  // Combine app context + table-specific context
  const businessContext = [appContext, tableContext].filter(Boolean).join('. ') || undefined;

  const config = vscode.workspace.getConfiguration('dvdata');
  const batchSize = config.get<number>('batchSize') || 100;

  const tablesMetadata = await reader.getTablesMetadata(tables);
  const recordCounts = new Map(tables.map((t) => [t, count]));

  // Auto-resolve required lookup dependencies
  await resolveRequiredDependencies(tables, tablesMetadata, recordCounts, reader, (msg) => log(msg));

  const planner = new DependencyPlanner();
  const plan = planner.buildPlan(tablesMetadata, recordCounts);

  // Show plan and confirm
  outputChannel.clear();
  outputChannel.appendLine(plan.summary);
  outputChannel.show();

  const confirm = await vscode.window.showWarningMessage(
    `This will create ${Array.from(recordCounts.values()).reduce((a, b) => a + b, 0)} records across ${tables.length} tables. Continue?`,
    { modal: true },
    'Yes, generate'
  );

  if (confirm !== 'Yes, generate') {
    return undefined;
  }

  const { provider: recordProvider, dataSource } = await createRecordProvider(businessContext);
  log(`Data source: ${dataSource === 'ai' ? 'GitHub Copilot LM' : 'Faker.js (random)'}`);
  const writer = new Writer(client, batchSize);

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Generating sample data...',
      cancellable: false,
    },
    async (progress) => {
      return writer.execute(
        plan,
        tablesMetadata,
        recordProvider,
        conn.environmentUrl,
        (message, percentage) => {
          progress.report({ message, increment: percentage });
          log(message);
        }
      );
    }
  );

  return result;
}

interface RecordProviderResult {
  provider: RecordProvider;
  dataSource: 'ai' | 'faker';
  modelName?: string;
  failureReason?: string;
  tableDataSources?: Map<string, { source: 'ai' | 'faker'; error?: string }>;
}

/**
 * Create a RecordProvider backed by the VS Code Language Model (Copilot).
 * Falls back to Faker if the LLM is unavailable.
 * @param businessContext Optional context about the business scenario.
 * @param chatModel Optional model from the chat request — preferred as it's already authorized.
 */
async function createRecordProvider(businessContext?: string, chatModel?: vscode.LanguageModelChat): Promise<RecordProviderResult> {
  try {
    let model = chatModel;

    if (!model) {
      // Fallback: select a model ourselves
      let models = await vscode.lm.selectChatModels();
      log(`Available LM models: ${models.map((m) => `${m.name} (${m.family}, ${m.vendor}, max:${m.maxInputTokens})`).join(', ') || 'none'}`);
      // Filter out "Internal only" models and prefer copilot vendor + GPT family
      const usable = models.filter((m) => !m.name.includes('Internal only'));
      usable.sort((a, b) => {
        const aVendor = a.vendor === 'copilot' ? 1 : 0;
        const bVendor = b.vendor === 'copilot' ? 1 : 0;
        if (aVendor !== bVendor) return bVendor - aVendor;
        const aIsGpt = a.family.toLowerCase().includes('gpt') ? 1 : 0;
        const bIsGpt = b.family.toLowerCase().includes('gpt') ? 1 : 0;
        if (aIsGpt !== bIsGpt) return bIsGpt - aIsGpt;
        return b.maxInputTokens - a.maxInputTokens;
      });
      model = usable[0];
    }

    if (model) {
      log(`[AI] Using model: ${model.name} (family: ${model.family}, vendor: ${model.vendor}, maxTokens: ${model.maxInputTokens})`);

      const aiGenerator = new AIDataGenerator({
        businessContext,
        lmComplete: async (msgs) => {
          const totalChars = msgs.reduce((s, m) => s + m.content.length, 0);
          log(`[AI] Sending ${msgs.length} message(s), total ${totalChars} chars (~${Math.ceil(totalChars / 4)} tokens)`);
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
          log(`[AI] Response: ${text.length} chars`);
          if (text.length > 0) {
            log(`[AI] Preview: ${text.substring(0, 300)}`);
          } else {
            throw new Error(`Model "${model.name}" returned an empty response. The prompt may be too large or the model may not support this request.`);
          }
          return text;
        },
      });

      const tableDataSources = new Map<string, { source: 'ai' | 'faker'; error?: string }>();

      return {
        provider: async (metadata, count) => {
          try {
            log(`[AI] Generating ${count} records for ${metadata.logicalName}...`);
            const records = await aiGenerator.generateRecords(metadata, count);
            log(`[AI] ✓ Generated ${records.length} records via Copilot LM for ${metadata.logicalName}`);
            tableDataSources.set(metadata.logicalName, { source: 'ai' });
            return records;
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`[AI] ✗ FAILED for ${metadata.logicalName}: ${errMsg}`);
            log('[FALLBACK] Falling back to Faker for this table.');
            tableDataSources.set(metadata.logicalName, { source: 'faker', error: errMsg });
            const fakerGen = new DataGenerator();
            return fakerGen.generateRecords(metadata, count);
          }
        },
        dataSource: 'ai',
        modelName: model.name,
        tableDataSources,
      };
    } else {
      log('[FALLBACK] No Language Model available.');
      const fakerGen = new DataGenerator();
      return {
        provider: async (metadata, count) => fakerGen.generateRecords(metadata, count),
        dataSource: 'faker',
        failureReason: 'No language models available — is GitHub Copilot installed and signed in?',
      };
    }
  } catch (err) {
    log(`[FALLBACK] Could not access Language Model: ${err}`);
    const fakerGen = new DataGenerator();
    return {
      provider: async (metadata, count) => fakerGen.generateRecords(metadata, count),
      dataSource: 'faker',
      failureReason: `LM API error: ${err}`,
    };
  }
}

function showRunResult(result: RunResult) {
  outputChannel.appendLine('');
  outputChannel.appendLine('=== Run Complete ===');
  outputChannel.appendLine(`Total created: ${result.totalCreated}`);
  outputChannel.appendLine(`Total failed: ${result.totalFailed}`);
  outputChannel.appendLine(`Duration: ${new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime()}ms`);

  for (const table of result.tables) {
    outputChannel.appendLine(`  ${table.tableName}: ${table.created}/${table.requested} created`);
    for (const err of table.errors) {
      outputChannel.appendLine(`    ERROR: ${err}`);
    }
  }

  if (result.success) {
    vscode.window.showInformationMessage(
      `Sample data generated: ${result.totalCreated} records across ${result.tables.length} tables.`
    );
  } else {
    vscode.window.showWarningMessage(
      `Generation completed with ${result.totalFailed} failures. Check Output for details.`
    );
  }

  outputChannel.show();
}

// ─── Chat Participant ───────────────────────────────────────────────────────
interface ChatResult extends vscode.ChatResult {
  action?: string;
}

const chatHandler: vscode.ChatRequestHandler = async (
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken
): Promise<ChatResult> => {
  switch (request.command) {
    case 'connect':
      return handleChatConnect(stream);

    case 'tables':
      return handleChatTables(stream);

    case 'plan':
      return handleChatPlan(request, stream);

    case 'generate':
      return handleChatGenerate(request, stream);

    case 'cleanup':
      stream.markdown('Cleanup functionality is coming soon. For now, you can manually delete records from Dataverse.');
      return { action: 'info' };

    default:
      return handleChatDefault(request, stream);
  }
};

async function handleChatConnect(stream: vscode.ChatResponseStream): Promise<ChatResult> {
  if (connection?.isConnected) {
    stream.markdown(`Already connected to **${connection.environmentUrl}**.\n\nUse \`/tables\` to see available tables or \`/generate\` to create sample data.`);
    return { action: 'connected' };
  }

  stream.progress('Opening connection dialog...');
  await vscode.commands.executeCommand('dvdata.connect');

  if (connection?.isConnected) {
    stream.markdown(`Connected to **${connection.environmentUrl}** ✓`);
    if (appContext) {
      stream.markdown(`\n\nApp context: *${appContext}*`);
    }
    return { action: 'connected' };
  } else {
    stream.markdown('Connection was not completed. Please try again with `/connect`.');
    return { action: 'error' };
  }
}

async function handleChatTables(stream: vscode.ChatResponseStream): Promise<ChatResult> {
  if (!connection?.isConnected) {
    stream.markdown('Not connected to Dataverse. Use `/connect` first.');
    return { action: 'error' };
  }

  stream.progress('Loading tables...');
  const client = new DataverseClient(connection);
  const reader = new MetadataReader(client);

  const tables = await reader.getSelectableTables();

  stream.markdown(`Found **${tables.length}** tables.\n\nHere are some common ones:\n\n`);

  const commonTables = ['account', 'contact', 'lead', 'opportunity', 'incident', 'systemuser'];
  const common = tables.filter((t) => commonTables.includes(t.logicalName));
  const custom = tables.filter((t) => t.logicalName.includes('_'));

  if (common.length > 0) {
    stream.markdown('**Standard tables:**\n');
    for (const t of common) {
      stream.markdown(`- \`${t.logicalName}\` — ${t.displayName}\n`);
    }
  }

  if (custom.length > 0) {
    stream.markdown(`\n**Custom tables** (${custom.length} found):\n`);
    for (const t of custom.slice(0, 20)) {
      stream.markdown(`- \`${t.logicalName}\` — ${t.displayName}\n`);
    }
    if (custom.length > 20) {
      stream.markdown(`\n...and ${custom.length - 20} more.\n`);
    }
  }

  return { action: 'tables' };
}

async function handleChatPlan(request: vscode.ChatRequest, stream: vscode.ChatResponseStream): Promise<ChatResult> {
  if (!connection?.isConnected) {
    stream.markdown('Not connected to Dataverse. Use `/connect` first.');
    return { action: 'error' };
  }

  // Parse with LLM for natural language understanding
  stream.progress('Understanding your request...');
  const parsed = await parsePromptWithLLM(request.prompt, request.model);
  const { tables, count, excludeTables: planExclude } = parsed;
  if (tables.length === 0) {
    stream.markdown('I couldn\'t identify which tables you want. Example: `/plan account, contact 100`');
    return { action: 'error' };
  }

  stream.progress('Reading metadata...');
  const client = new DataverseClient(connection);
  const reader = new MetadataReader(client);
  const tablesMetadata = await reader.getTablesMetadata(tables);
  const recordCounts = new Map(tables.map((t) => [t, count]));

  // Auto-resolve required lookup dependencies (skip user-excluded tables)
  stream.progress('Resolving dependencies...');
  await resolveRequiredDependencies(tables, tablesMetadata, recordCounts, reader, (msg) => {
    stream.progress(msg);
    log(msg);
  }, new Set(planExclude));

  const planner = new DependencyPlanner();
  const plan = planner.buildPlan(tablesMetadata, recordCounts);

  stream.markdown('```\n' + plan.summary + '\n```');
  return { action: 'plan' };
}

async function handleChatGenerate(request: vscode.ChatRequest, stream: vscode.ChatResponseStream): Promise<ChatResult> {
  if (!connection?.isConnected) {
    stream.markdown('Not connected to Dataverse. Use `/connect` first.');
    return { action: 'error' };
  }

  // Parse with LLM for natural language understanding
  stream.progress('Understanding your request...');
  const parsed = await parsePromptWithLLM(request.prompt, request.model);
  const { tables, count, scenario: parsedScenario, instructions, excludeTables } = parsed;
  if (tables.length === 0) {
    stream.markdown('I couldn\'t identify which tables you want. Example:\n\n`/generate account, contact 50`\n\nor\n\n`/generate create 5 incident records for an IT helpdesk`');
    return { action: 'error' };
  }

  // Show what the LLM understood
  stream.markdown(`**Understood:** Generate **${count}** records for: ${tables.map(t => `\`${t}\``).join(', ')}\n`);
  if (instructions) {
    stream.markdown(`> Instructions: *${instructions}*\n`);
  }
  if (excludeTables.length > 0) {
    stream.markdown(`> Will use existing records for: ${excludeTables.map(t => `\`${t}\``).join(', ')}\n`);
  }

  // Get table-specific context: from parsed scenario, instructions, or ask the user
  let tableContext = parsedScenario;
  if (instructions) {
    tableContext = [tableContext, instructions].filter(Boolean).join('. ');
  }
  if (!tableContext) {
    tableContext = await vscode.window.showInputBox({
      prompt: '(Optional) Any specific context for these tables?',
      placeHolder: 'e.g., Support cases for a software product with escalations...',
      ignoreFocusOut: true,
    }) || undefined;
  }

  // Combine app context + table-specific context
  const businessContext = [appContext, tableContext].filter(Boolean).join('. ') || undefined;

  const config = vscode.workspace.getConfiguration('dvdata');
  const batchSize = config.get<number>('batchSize') || 100;

  stream.progress('Reading metadata...');
  const client = new DataverseClient(connection);
  const reader = new MetadataReader(client);
  const tablesMetadata = await reader.getTablesMetadata(tables);
  const recordCounts = new Map(tables.map((t) => [t, count]));

  // Auto-resolve required lookup dependencies (skip user-excluded tables)
  stream.progress('Resolving dependencies...');
  const excludeSet = new Set(excludeTables);
  await resolveRequiredDependencies(tables, tablesMetadata, recordCounts, reader, (msg) => {
    stream.progress(msg);
    log(msg);
  }, excludeSet);

  const planner = new DependencyPlanner();
  const plan = planner.buildPlan(tablesMetadata, recordCounts);

  // Show plan and ask for confirmation before creating any records
  const totalRecords = Array.from(recordCounts.values()).reduce((a, b) => a + b, 0);
  const tableList = Array.from(recordCounts.entries())
    .map(([t, c]) => `  • **${t}** — ${c} records`)
    .join('\n');

  stream.markdown(
    `**Execution Plan:**\n\`\`\`\n${plan.summary}\n\`\`\`\n\n` +
    `This will create **${totalRecords}** records across **${recordCounts.size}** tables:\n${tableList}\n\n`
  );

  const confirm = await vscode.window.showWarningMessage(
    `This will create ${totalRecords} records across ${recordCounts.size} tables in your Dataverse environment. Continue?`,
    { modal: true },
    'Yes, generate'
  );

  if (confirm !== 'Yes, generate') {
    stream.markdown('Generation cancelled.');
    return { action: 'cancelled' };
  }

  stream.progress('Preparing data generator...');

  const { provider: recordProvider, dataSource, modelName, failureReason, tableDataSources } = await createRecordProvider(businessContext, request.model);

  if (dataSource === 'ai') {
    stream.markdown(`\n> **Data Source:** GitHub Copilot LM (\`${modelName}\`) — AI-generated contextual data\n\n`);
  } else {
    stream.markdown(`\n> **Data Source:** Faker.js (random data) — ${failureReason}\n\n`);
  }

  stream.progress('Generating data...');

  const writer = new Writer(client, batchSize);

  const result = await writer.execute(
    plan,
    tablesMetadata,
    recordProvider,
    connection.environmentUrl,
    (message, _percentage) => {
      stream.progress(message);
    }
  );

  // Show per-table data source info
  if (tableDataSources && tableDataSources.size > 0) {
    stream.markdown(`\n**Data Source per Table:**\n`);
    for (const [table, info] of tableDataSources) {
      if (info.source === 'ai') {
        stream.markdown(`- ${table}: ✓ AI (\`${modelName}\`)\n`);
      } else {
        stream.markdown(`- ${table}: ⚠ Faker fallback — ${info.error}\n`);
      }
    }
    stream.markdown('\n');
  }

  // Format result
  stream.markdown(`\n**Results:**\n`);
  stream.markdown(`- Total created: **${result.totalCreated}**\n`);
  stream.markdown(`- Total failed: **${result.totalFailed}**\n`);
  stream.markdown(`- Duration: ${new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime()}ms\n\n`);

  for (const table of result.tables) {
    const icon = table.failed === 0 ? '✓' : '⚠';
    stream.markdown(`${icon} **${table.tableName}**: ${table.created}/${table.requested}\n`);
  }

  if (result.errors.length > 0) {
    stream.markdown(`\n**Errors:**\n`);
    for (const err of result.errors.slice(0, 10)) {
      stream.markdown(`- ${err}\n`);
    }
  }

  return { action: 'generated' };
}

async function handleChatDefault(request: vscode.ChatRequest, stream: vscode.ChatResponseStream): Promise<ChatResult> {
  // Use LLM to understand the intent and provide guidance
  stream.markdown(
    `I can help you generate sample data for Dataverse. Here's what I can do:\n\n` +
    `- \`/connect\` — Connect to a Dataverse environment\n` +
    `- \`/tables\` — List available tables\n` +
    `- \`/plan account, contact 100\` — Show execution plan\n` +
    `- \`/generate account, contact 50\` — Generate and insert data\n` +
    `- \`/cleanup\` — Remove generated data\n\n` +
    `You asked: *"${request.prompt}"*\n\n` +
    `Try one of the commands above to get started!`
  );
  return { action: 'help' };
}

// ─── Language Model Tool ────────────────────────────────────────────────────
interface GenerateToolInput {
  tables?: string[];
  recordCount?: number;
  seed?: number;
  scenario?: string;
}

class GenerateSampleDataTool implements vscode.LanguageModelTool<GenerateToolInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GenerateToolInput>,
    _token: vscode.CancellationToken
  ) {
    const input = options.input;
    const tableList = input.tables?.join(', ') || 'selected tables';
    const count = input.recordCount || 50;

    return {
      invocationMessage: `Generating ${count} sample records for ${tableList}`,
      confirmationMessages: {
        title: 'Generate Dataverse Sample Data',
        message: new vscode.MarkdownString(
          `Generate **${count}** records per table for: **${tableList}**?\n\n` +
          (input.scenario ? `Scenario: *${input.scenario}*\n\n` : '') +
          `This will create records in your connected Dataverse environment.`
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GenerateToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;

    if (!connection?.isConnected) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'Not connected to Dataverse. Please run the "Dataverse Sample Data: Connect to Dataverse Environment" command first.'
        ),
      ]);
    }

    if (!input.tables || input.tables.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No tables specified. Please provide table logical names (e.g., account, contact).'
        ),
      ]);
    }

    const count = input.recordCount || 50;
    const config = vscode.workspace.getConfiguration('dvdata');
    const batchSize = config.get<number>('batchSize') || 100;

    try {
      const client = new DataverseClient(connection);
      const reader = new MetadataReader(client);
      const tablesMetadata = await reader.getTablesMetadata(input.tables);
      const recordCounts = new Map(input.tables.map((t) => [t, count]));

      // Auto-resolve required lookup dependencies
      await resolveRequiredDependencies(input.tables, tablesMetadata, recordCounts, reader, (msg) => log(msg));

      const planner = new DependencyPlanner();
      const plan = planner.buildPlan(tablesMetadata, recordCounts);

      // Build business context from scenario, app context, or synthesize from table descriptions
      let businessContext = input.scenario || appContext;
      if (!businessContext) {
        const tableDescriptions = Array.from(tablesMetadata.values())
          .filter((t) => t.description)
          .map((t) => `${t.displayName}: ${t.description}`)
          .join('; ');
        businessContext = tableDescriptions || undefined;
      }
      const { provider: recordProvider, dataSource: lmDataSource } = await createRecordProvider(businessContext);
      log(`[LM Tool] Data source: ${lmDataSource === 'ai' ? 'GitHub Copilot LM' : 'Faker.js (random)'}`);
      const writer = new Writer(client, batchSize);

      const result = await writer.execute(
        plan,
        tablesMetadata,
        recordProvider,
        connection.environmentUrl,
        (message) => log(message)
      );

      // Format result for LLM
      const summary = [
        `Sample data generation complete.`,
        `Total created: ${result.totalCreated}`,
        `Total failed: ${result.totalFailed}`,
        '',
        ...result.tables.map(
          (t) => `${t.tableName}: ${t.created}/${t.requested} records`
        ),
      ];

      if (result.errors.length > 0) {
        summary.push('', 'Errors:', ...result.errors.slice(0, 5));
      }

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(summary.join('\n')),
      ]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error generating sample data: ${msg}`),
      ]);
    }
  }
}

// ─── Input Parsing ──────────────────────────────────────────────────────────

/** Map of word numbers to digits */
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  hundred: 100, thousand: 1000,
};

/** Common display-name-to-logical-name aliases for Dataverse tables */
const TABLE_ALIASES: Record<string, string> = {
  case: 'incident', cases: 'incident',
  activity: 'activitypointer', activities: 'activitypointer',
  note: 'annotation', notes: 'annotation',
  user: 'systemuser', users: 'systemuser',
  team: 'team', teams: 'team',
  currency: 'transactioncurrency',
  email: 'email', emails: 'email',
  task: 'task', tasks: 'task',
  appointment: 'appointment', appointments: 'appointment',
  phonecall: 'phonecall',
  letter: 'letter',
  fax: 'fax',
  product: 'product', products: 'product',
  quote: 'quote', quotes: 'quote',
  order: 'salesorder', orders: 'salesorder',
  invoice: 'invoice', invoices: 'invoice',
  campaign: 'campaign', campaigns: 'campaign',
  article: 'knowledgearticle', articles: 'knowledgearticle',
};

function parseChatInput(prompt: string): {
  tables: string[];
  count: number;
  seed?: number;
  scenario?: string;
} {
  const tables: string[] = [];
  let count = 50;
  let seed: number | undefined;
  let scenario: string | undefined;

  // Extract --seed and --scenario flags
  const seedMatch = prompt.match(/--seed\s+(\d+)/i);
  if (seedMatch) {
    seed = parseInt(seedMatch[1], 10);
  }

  const scenarioMatch = prompt.match(/--scenario\s+"([^"]+)"/i) || prompt.match(/--scenario\s+(.+?)(?:\s+--|$)/i);
  if (scenarioMatch) {
    scenario = scenarioMatch[1].trim();
  }

  // Clean prompt (remove flags)
  let clean = prompt
    .replace(/--seed\s+\d+/gi, '')
    .replace(/--scenario\s+"[^"]+"/gi, '')
    .replace(/--scenario\s+.+?(?=\s+--|$)/gi, '')
    .trim();

  // Extract word-numbers BEFORE removing stop words (e.g., "two" → 2)
  for (const [word, num] of Object.entries(WORD_NUMBERS)) {
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (regex.test(clean) && num >= 1 && num <= 10000) {
      count = num;
      clean = clean.replace(regex, '').trim();
      break; // Take the first word-number found
    }
  }

  // Extract digit numbers (record count)
  const numberMatch = clean.match(/\b(\d+)\b/);
  if (numberMatch) {
    const n = parseInt(numberMatch[1], 10);
    if (n >= 1 && n <= 10000) {
      count = n;
    }
    clean = clean.replace(numberMatch[0], '').trim();
  }

  // Remove filler words
  clean = clean
    .replace(/\brecords?\b/gi, '')
    .replace(/\bfor\b/gi, '')
    .replace(/\beach\b/gi, '')
    .replace(/\band\b/gi, ',')
    .replace(/\bwith\b/gi, '')
    .replace(/\bin\b/gi, '')
    .replace(/\bthe\b/gi, '')
    .replace(/\bmy\b/gi, '')
    .trim();

  // Common English stop words that should never be treated as table names
  const stopWords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'cannot', 'must',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'u', 'he', 'she', 'it',
    'they', 'them', 'their', 'its', 'his', 'her',
    'to', 'of', 'at', 'by', 'up', 'on', 'off', 'out', 'into', 'from',
    'if', 'or', 'as', 'so', 'but', 'not', 'no', 'nor', 'yet',
    'all', 'any', 'some', 'few', 'many', 'much', 'more', 'most', 'other',
    'each', 'every', 'both', 'either', 'neither', 'such',
    'this', 'that', 'these', 'those', 'here', 'there', 'where', 'when',
    'then', 'than', 'also', 'too', 'very', 'just', 'only', 'even',
    'about', 'after', 'again', 'along', 'already', 'always',
    'before', 'between', 'because', 'different', 'during',
    'for', 'with', 'without', 'while',
    'get', 'got', 'give', 'go', 'going', 'make', 'making',
    'new', 'now', 'like', 'want', 'need', 'please', 'pls',
    'create', 'created', 'insert', 'inserted', 'add', 'added',
    'generate', 'generated', 'generating', 'put', 'sample', 'data', 'test',
    'dataverse', 'dynamics', 'crm', 'table', 'tables', 'entity', 'entities',
    'per', 'ok', 'okay', 'sure', 'yes', 'no', 'hello', 'hi', 'hey',
  ]);

  // Split remaining by comma, space, or other separators
  const parts = clean.split(/[\s,;]+/).filter((p) => p.length > 0);

  for (const part of parts) {
    let candidate = part.toLowerCase().trim();
    if (!candidate || !(/^[a-z][a-z0-9_]*$/.test(candidate)) || stopWords.has(candidate)) {
      continue;
    }

    // Check aliases first (case → incident, etc.)
    if (TABLE_ALIASES[candidate]) {
      candidate = TABLE_ALIASES[candidate];
    } else {
      // Strip common plurals
      if (candidate.endsWith('ies') && candidate.length > 4) {
        candidate = candidate.slice(0, -3) + 'y';
      } else if (!(candidate.endsWith('ses') || candidate.endsWith('xes') || candidate.endsWith('zes'))
        && candidate.endsWith('s') && !candidate.endsWith('ss') && !candidate.endsWith('us') && !candidate.endsWith('is')) {
        candidate = candidate.slice(0, -1);
      }
      // Check aliases again after depluralization
      if (TABLE_ALIASES[candidate]) {
        candidate = TABLE_ALIASES[candidate];
      }
    }

    if (!tables.includes(candidate)) {
      tables.push(candidate);
    }
  }

  return { tables, count, seed, scenario };
}

/**
 * Use the LLM to parse natural language prompts into structured generation config.
 * Falls back to regex-based parseChatInput if LLM is unavailable or fails.
 */
async function parsePromptWithLLM(
  prompt: string,
  model: vscode.LanguageModelChat
): Promise<{ tables: string[]; count: number; scenario?: string; instructions?: string; excludeTables: string[] }> {
  const systemPrompt = `You are a parser for a Dataverse sample data generation tool. Extract structured intent from the user's natural language request.

Return ONLY a JSON object with these fields:
- "tables": array of Dataverse table logical names the user wants to generate data FOR (e.g., ["incident", "account"]). Use logical names, not display names. Common mappings: case/cases→incident, user→systemuser, note→annotation, article→knowledgearticle, order→salesorder.
- "count": number of records per table (default 50 if not specified)
- "scenario": business context/scenario if mentioned (e.g., "IT support helpdesk")
- "instructions": any special instructions about HOW to generate (e.g., "use existing contacts, don't create new ones")
- "excludeTables": array of Dataverse table logical names the user explicitly does NOT want to create. If user says "use existing contacts" or "don't create contacts", put "contact" here. These tables will be skipped even if they are dependencies.

IMPORTANT: Only include in "tables" the tables the user wants to CREATE records in. Tables the user wants to USE EXISTING records from go in "excludeTables".

Examples:
- "create 2 records into incident" → {"tables":["incident"],"count":2,"excludeTables":[]}
- "generate 50 accounts and contacts for a banking system" → {"tables":["account","contact"],"count":50,"scenario":"banking system","excludeTables":[]}
- "create 5 cases but do not create new contacts, use existing ones" → {"tables":["incident"],"count":5,"instructions":"use existing contacts","excludeTables":["contact"]}
- "insert 2 incident records, use existing contact and account" → {"tables":["incident"],"count":2,"instructions":"use existing contact and account","excludeTables":["contact","account"]}
- "10 leads and opportunities" → {"tables":["lead","opportunity"],"count":10,"excludeTables":[]}

Respond with ONLY the JSON object. No other text.`;

  try {
    const messages = [
      vscode.LanguageModelChatMessage.User(systemPrompt + '\n\nUser prompt: ' + prompt),
    ];
    const response = await model.sendRequest(messages, {
      justification: 'Parse user intent for Dataverse sample data generation.',
    });
    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      log(`[LLM Parser] Extracted: ${JSON.stringify(parsed)}`);
      return {
        tables: Array.isArray(parsed.tables) ? parsed.tables : [],
        count: typeof parsed.count === 'number' ? parsed.count : 50,
        scenario: parsed.scenario || undefined,
        instructions: parsed.instructions || undefined,
        excludeTables: Array.isArray(parsed.excludeTables) ? parsed.excludeTables : [],
      };
    }
  } catch (err) {
    log(`[LLM Parser] Failed, falling back to regex: ${err}`);
  }

  // Fallback to regex parser
  const fallback = parseChatInput(prompt);
  return { tables: fallback.tables, count: fallback.count, scenario: fallback.scenario, excludeTables: [] };
}
