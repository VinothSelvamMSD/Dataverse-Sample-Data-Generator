/**
 * Core Engine - AI Data Generator
 * Uses a Language Model to generate contextually relevant sample data.
 * The LM function is injected — no VS Code dependency in core.
 */

import type { ColumnMetadata, TableMetadata } from './metadata';
import type { GeneratedRecord } from './generator';
import { isSystemField } from './system-fields';

/**
 * Function signature for calling the Language Model.
 * The extension layer provides this — maps to vscode.lm API.
 */
export type LMCompletionFn = (messages: Array<{ role: 'user' | 'assistant'; content: string }>) => Promise<string>;

export interface AIGeneratorConfig {
  /** Business context from the user (e.g., "Banking loan management system"). May be empty. */
  businessContext?: string;
  /** LM completion function injected from the extension layer */
  lmComplete: LMCompletionFn;
  /** Optional external column filter — overrides the built-in getPopulatableColumns */
  columnFilter?: (metadata: TableMetadata) => ColumnMetadata[];
  /** Optional progress callback for batch-level updates */
  onBatchProgress?: (completed: number, total: number) => void;
  /** Max concurrent LLM calls (default 3) */
  concurrency?: number;
}

export class AIDataGenerator {
  private businessContext: string;
  private lmComplete: LMCompletionFn;
  private columnFilter?: (metadata: TableMetadata) => ColumnMetadata[];
  private onBatchProgress?: (completed: number, total: number) => void;
  private concurrency: number;

  constructor(config: AIGeneratorConfig) {
    this.businessContext = config.businessContext || '';
    this.lmComplete = config.lmComplete;
    this.columnFilter = config.columnFilter;
    this.onBatchProgress = config.onBatchProgress;
    this.concurrency = config.concurrency ?? 3;
  }

  /**
   * Generate N records for a table using the LLM.
   * Uses parallel batches with auto-retry on token overflow.
   */
  async generateRecords(
    metadata: TableMetadata,
    count: number,
    tableContext?: string,
  ): Promise<GeneratedRecord[]> {
    let columns = this.columnFilter ? this.columnFilter(metadata) : this.getPopulatableColumns(metadata);

    // Cap columns at 25 for prompt regardless of filter — keeps output manageable
    // Prioritize: required → primary name → high-value → rest
    if (columns.length > 25) {
      const required = columns.filter((c) => c.isRequired || c.logicalName === metadata.primaryNameAttribute);
      const requiredSet = new Set(required.map((c) => c.logicalName));
      const highValuePatterns = ['name', 'firstname', 'lastname', 'email', 'telephone', 'phone',
        'address', 'city', 'country', 'website', 'company', 'jobtitle', 'department', 'description',
        'revenue', 'industry', 'subject', 'topic'];
      const highValue = columns.filter((c) => !requiredSet.has(c.logicalName) &&
        highValuePatterns.some((p) => c.logicalName.includes(p)));
      const hvSet = new Set(highValue.map((c) => c.logicalName));
      const rest = columns.filter((c) => !requiredSet.has(c.logicalName) && !hvSet.has(c.logicalName));
      columns = [...required, ...highValue, ...rest].slice(0, 25);
    }

    // Fixed batch size of 5 — proven sweet spot for output token limits
    const batchSize = Math.min(count, 5);

    const prompt = this.buildPrompt(metadata, columns, tableContext);
    const allRecords: GeneratedRecord[] = [];

    // Build batch work items
    const batches: Array<{ start: number; size: number }> = [];
    for (let i = 0; i < count; i += batchSize) {
      batches.push({ start: i, size: Math.min(batchSize, count - i) });
    }

    const totalBatches = batches.length;
    let completedBatches = 0;

    // Process batches with concurrency limit
    const results = new Array<GeneratedRecord[]>(batches.length);

    for (let chunk = 0; chunk < batches.length; chunk += this.concurrency) {
      const batchSlice = batches.slice(chunk, chunk + this.concurrency);
      const promises = batchSlice.map(async (batch, idx) => {
        const records = await this.generateBatch(
          prompt, metadata, batch.size, chunk + idx + 1, totalBatches
        );
        completedBatches++;
        this.onBatchProgress?.(completedBatches, totalBatches);
        return records;
      });

      const batchResults = await Promise.all(promises);
      batchResults.forEach((records, idx) => {
        results[chunk + idx] = records;
      });
    }

    for (const batch of results) {
      if (batch) allRecords.push(...batch);
    }

    return allRecords;
  }

  /**
   * Generate a single batch of records with auto-retry on token overflow.
   */
  private async generateBatch(
    basePrompt: string,
    metadata: TableMetadata,
    count: number,
    batchNum: number,
    totalBatches: number,
  ): Promise<GeneratedRecord[]> {
    const batchInstruction = totalBatches > 1
      ? `\nBatch ${batchNum}/${totalBatches}: generate ${count} UNIQUE record(s). Vary all values.`
      : '';

    const fullPrompt = `${basePrompt}${batchInstruction}\n\nGenerate exactly ${count} record(s) as a JSON array. ONLY output the JSON array.`;

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: fullPrompt },
    ];

    let response: string;
    try {
      response = await this.lmComplete(messages);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if ((errMsg.toLowerCase().includes('too long') || errMsg.toLowerCase().includes('too_long') || errMsg.toLowerCase().includes('max_tokens')) && count > 1) {
        // Split batch in half and run sequentially
        const half = Math.ceil(count / 2);
        const first = await this.generateBatch(basePrompt, metadata, half, batchNum, totalBatches);
        const second = await this.generateBatch(basePrompt, metadata, count - half, batchNum, totalBatches);
        return [...first, ...second];
      }
      throw err;
    }

    try {
      return this.parseRecords(response, metadata);
    } catch (firstErr) {
      // Retry once with correction
      messages.push(
        { role: 'assistant', content: response },
        {
          role: 'user',
          content: `JSON parse error: ${firstErr instanceof Error ? firstErr.message : String(firstErr)}\n\nRespond with ONLY a raw JSON array. No markdown, no code fences. Just [ ... ]`,
        },
      );
      response = await this.lmComplete(messages);
      return this.parseRecords(response, metadata);
    }
  }

  /**
   * Build the reusable part of the prompt (schema + context). Count is appended per batch.
   */
  private buildPrompt(
    metadata: TableMetadata,
    columns: ColumnMetadata[],
    tableContext?: string,
  ): string {
    // Compact column descriptions — one line each, minimal tokens
    const colLines = columns.map((col) => {
      const parts = [col.logicalName, col.attributeType];
      if (col.maxLength) parts.push(`max${col.maxLength}`);
      if (col.options && col.options.length > 0) {
        const opts = col.options.slice(0, 6).map((o) => `${o.value}=${o.label}`).join('|');
        parts.push(`[${opts}]`);
      }
      return parts.join(' ');
    });

    const ctx = this.businessContext ? `Context: ${this.businessContext}` : '';
    const tblCtx = tableContext ? `Table context: ${tableContext}` : '';
    const desc = metadata.description ? `Purpose: ${metadata.description}` : '';
    const contextBlock = [ctx, tblCtx, desc].filter(Boolean).join('\n');

    return `Generate sample records for Dataverse table "${metadata.displayName}".
${contextBlock ? contextBlock + '\n' : ''}
Schema (${columns.length} columns — populate ALL):
${colLines.join('\n')}

Rules: populate EVERY column. Picklist values=integers from options. Vary data realistically. Dates=ISO 8601. No nulls.`;
  }

  /**
   * Get the list of columns that should be populated (same blacklist as Faker generator).
   * Prioritizes: required fields, primary name, fields with descriptions, then others.
   * Caps at ~25 columns — prioritizes required, primary name, described fields.
   */
  private getPopulatableColumns(metadata: TableMetadata): ColumnMetadata[] {
    const MAX_COLS = 30;
    const all = metadata.columns.filter((col) => {
      if (col.logicalName === metadata.primaryIdAttribute) return false;
      if (['State', 'Status'].includes(col.attributeType)) return false;
      if (['Lookup', 'Customer', 'Owner'].includes(col.attributeType)) return false;
      if (col.attributeType === 'Uniqueidentifier') return false;
      if (col.isAutoNumber) return false;
      if (col.isComputed) return false;
      if (isSystemField(col.logicalName)) return false;
      return true;
    });

    if (all.length <= MAX_COLS) return all;

    // Well-known high-value CRM field patterns (name, contact info, address, description)
    const highValuePatterns = [
      'name', 'firstname', 'lastname', 'middlename', 'fullname', 'nickname',
      'email', 'telephone', 'phone', 'mobile', 'fax',
      'address', 'city', 'state', 'country', 'postal', 'zip', 'line1', 'line2', 'line3',
      'website', 'url', 'company', 'jobtitle', 'department', 'description',
      'revenue', 'budget', 'numberofemployees', 'annualrevenue',
      'industry', 'leadsource', 'subject', 'topic',
    ];

    const isHighValue = (c: ColumnMetadata) =>
      highValuePatterns.some((p) => c.logicalName.includes(p));

    // Priority tiers
    const required = all.filter((c) => c.isRequired || c.logicalName === metadata.primaryNameAttribute);
    const requiredSet = new Set(required.map((c) => c.logicalName));
    const highValue = all.filter((c) => !requiredSet.has(c.logicalName) && isHighValue(c));
    const highValueSet = new Set(highValue.map((c) => c.logicalName));
    const withDescription = all.filter((c) => c.description && !requiredSet.has(c.logicalName) && !highValueSet.has(c.logicalName));
    const descSet = new Set(withDescription.map((c) => c.logicalName));
    const rest = all.filter((c) => !requiredSet.has(c.logicalName) && !highValueSet.has(c.logicalName) && !descSet.has(c.logicalName));

    const result = [...required, ...highValue, ...withDescription];
    const remaining = MAX_COLS - result.length;
    if (remaining > 0) {
      result.push(...rest.slice(0, remaining));
    }
    return result.slice(0, MAX_COLS);
  }

  /**
   * Parse LLM response into records, with validation.
   */
  private parseRecords(response: string, metadata: TableMetadata): GeneratedRecord[] {
    let cleaned = response.trim();

    // Strip ALL markdown code fences (```json ... ``` or ``` ... ```)
    cleaned = cleaned.replace(/```(?:json|JSON)?\s*\n?/g, '').replace(/```/g, '').trim();

    // Strip any leading/trailing prose — find the outermost [ ... ]
    const startIdx = cleaned.indexOf('[');
    const endIdx = cleaned.lastIndexOf(']');
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
      throw new Error(`LLM response did not contain a JSON array. Raw response (first 300 chars): ${response.substring(0, 300)}`);
    }
    cleaned = cleaned.substring(startIdx, endIdx + 1);

    let parsed: unknown[];
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new Error(`Failed to parse LLM response as JSON: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error('LLM response was not a JSON array.');
    }

    // Validate and sanitize each record
    const validColumns = new Set(metadata.columns.map((c) => c.logicalName));
    const columnMap = new Map(metadata.columns.map((c) => [c.logicalName, c]));

    return parsed.map((raw) => {
      if (typeof raw !== 'object' || raw === null) return {};
      const record: GeneratedRecord = {};

      for (const [key, value] of Object.entries(raw)) {
        // Only include known columns
        if (!validColumns.has(key)) continue;

        const col = columnMap.get(key)!;
        // Skip system fields
        if (col.logicalName === metadata.primaryIdAttribute) continue;
        if (['State', 'Status', 'Lookup', 'Customer', 'Owner'].includes(col.attributeType)) continue;

        // Basic type coercion/validation
        const sanitized = this.sanitizeValue(value, col);
        if (sanitized !== undefined) {
          record[key] = sanitized;
        }
      }

      return record;
    });
  }

  /**
   * Sanitize a value from the LLM to match the expected Dataverse type.
   */
  private sanitizeValue(value: unknown, col: ColumnMetadata): unknown {
    if (value === null || value === undefined) return undefined;

    switch (col.attributeType) {
      case 'String':
      case 'Memo': {
        const str = String(value);
        return col.maxLength ? str.substring(0, col.maxLength) : str;
      }

      case 'Integer':
      case 'BigInt': {
        const num = typeof value === 'number' ? Math.floor(value) : parseInt(String(value), 10);
        if (isNaN(num)) return undefined;
        if (col.minValue !== undefined && num < col.minValue) return col.minValue;
        if (col.maxValue !== undefined && num > col.maxValue) return col.maxValue;
        return num;
      }

      case 'Double':
      case 'Decimal':
      case 'Money': {
        const num = typeof value === 'number' ? value : parseFloat(String(value));
        if (isNaN(num)) return undefined;
        if (col.minValue !== undefined && num < col.minValue) return col.minValue;
        if (col.maxValue !== undefined && num > col.maxValue) return col.maxValue;
        if (col.precision !== undefined) {
          return parseFloat(num.toFixed(col.precision));
        }
        return num;
      }

      case 'Boolean':
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') return value.toLowerCase() === 'true';
        return Boolean(value);

      case 'DateTime': {
        const str = String(value);
        // Validate it's a plausible date string
        if (col.format === 'DateOnly') {
          // Must be YYYY-MM-DD
          if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
          // Try to extract date part from full ISO string
          const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
          return match ? match[1] : undefined;
        }
        // Full ISO datetime
        const d = new Date(str);
        return isNaN(d.getTime()) ? undefined : d.toISOString();
      }

      case 'Picklist': {
        const num = typeof value === 'number' ? value : parseInt(String(value), 10);
        if (isNaN(num)) return undefined;
        // Validate it's a valid option
        if (col.options && col.options.length > 0) {
          if (!col.options.some((o) => o.value === num)) {
            return col.options[0].value; // Fallback to first option
          }
        }
        return num;
      }

      case 'Uniqueidentifier': {
        const str = String(value);
        if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(str)) {
          return str;
        }
        return undefined;
      }

      default:
        return value;
    }
  }

}
