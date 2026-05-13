/**
 * Core Engine - Data Generator
 * Generates realistic sample data based on column metadata.
 * Uses seeded RNG (faker) for reproducibility.
 */

import { faker } from '@faker-js/faker';
import type { ColumnMetadata, TableMetadata } from './metadata';
import { isSystemField } from './system-fields';

export interface GeneratorConfig {
  /** Random seed for reproducibility */
  seed?: number;
  /** Scenario prompt for domain-specific data (e.g., "finance company in New York") */
  scenario?: string;
}

/** A single record to be inserted (column name → value) */
export type GeneratedRecord = Record<string, unknown>;

export class DataGenerator {
  private seed: number;

  constructor(config: GeneratorConfig = {}) {
    this.seed = config.seed ?? Math.floor(Math.random() * 1_000_000);
    faker.seed(this.seed);
  }

  /** Get the seed being used (for manifest) */
  getSeed(): number {
    return this.seed;
  }

  /**
   * Generate N records for a given table.
   *
   * @param metadata Table metadata with column info
   * @param count Number of records to generate
   * @param parentRecordIds Map of parent table logical name → array of created GUIDs (for lookups)
   */
  generateRecords(
    metadata: TableMetadata,
    count: number,
    parentRecordIds: Map<string, string[]> = new Map(),
    allowedColumns?: string[]
  ): GeneratedRecord[] {
    const records: GeneratedRecord[] = [];

    // Identify which columns to populate:
    // Strategy: BLACKLIST system fields, include everything else.
    // This works for OOB tables AND custom tables with any schema.
    // Required fields and primary name are always included.
    const columnsToPopulate = metadata.columns.filter((col) => {
      // Skip primary key (auto-generated)
      if (col.logicalName === metadata.primaryIdAttribute) {
        return false;
      }
      // Skip state/status (auto-managed by Dataverse)
      if (['State', 'Status'].includes(col.attributeType)) {
        return false;
      }
      // Skip lookups — handled by Writer via @odata.bind
      if (['Lookup', 'Customer', 'Owner'].includes(col.attributeType)) {
        return false;
      }
      // Skip autonumber fields (system auto-generates)
      if (col.isAutoNumber) {
        return false;
      }
      // Skip formula/calculated/rollup fields
      if (col.isComputed) {
        return false;
      }
      // Always include required fields
      if (col.isRequired) {
        return true;
      }
      // Always include primary name attribute
      if (col.logicalName === metadata.primaryNameAttribute) {
        return true;
      }
      // If allowedColumns is provided, only include those (plus required/primary already included above)
      if (allowedColumns) {
        return allowedColumns.includes(col.logicalName);
      }
      // Skip known system/internal fields — universal across ALL Dataverse tables
      if (this.isSystemField(col.logicalName)) {
        return false;
      }
      // Everything else is likely a user-facing or custom field — include it
      return true;
    });

    for (let i = 0; i < count; i++) {
      const record: GeneratedRecord = {};

      for (const col of columnsToPopulate) {
        // Skip some optional fields randomly (40% skip rate to add variety)
        if (!col.isRequired && col.logicalName !== metadata.primaryNameAttribute && faker.datatype.boolean(0.4)) {
          continue;
        }

        const value = this.generateValue(col, metadata, parentRecordIds);
        if (value !== undefined) {
          record[col.logicalName] = value;
        }
      }

      records.push(record);
    }

    return records;
  }

  /**
   * Check if a column is a system/internal field that should be skipped.
   * Delegates to shared system-fields utility.
   */
  private isSystemField(name: string): boolean {
    return isSystemField(name);
  }

  /**
   * Generate a value for a single column based on its type and constraints.
   */
  private generateValue(
    col: ColumnMetadata,
    _metadata: TableMetadata,
    _parentRecordIds: Map<string, string[]>
  ): unknown {
    switch (col.attributeType) {
      case 'String':
      case 'Memo':
        return this.generateString(col);

      case 'Integer':
        return this.generateInteger(col);

      case 'BigInt':
        return this.generateBigInt(col);

      case 'Double':
      case 'Decimal':
        return this.generateDecimal(col);

      case 'Money':
        return this.generateMoney(col);

      case 'Boolean':
        return faker.datatype.boolean();

      case 'DateTime':
        return this.generateDateTime(col);

      case 'Picklist':
        return this.generatePicklist(col);

      case 'Uniqueidentifier':
        return faker.string.uuid();

      case 'Lookup':
      case 'Customer':
      case 'Owner':
        // Handled externally by Writer
        return undefined;

      default:
        return undefined;
    }
  }

  private generateString(col: ColumnMetadata): string {
    const maxLen = col.maxLength || 100;
    const name = col.logicalName.toLowerCase();

    // Try to infer semantic meaning from column name
    if (name.includes('email') || col.format === 'Email') {
      return faker.internet.email().substring(0, maxLen);
    }
    if (name.includes('phone') || name.includes('telephone') || col.format === 'Phone') {
      return faker.phone.number().substring(0, maxLen);
    }
    if (name.includes('url') || name.includes('website') || col.format === 'Url') {
      return faker.internet.url().substring(0, maxLen);
    }
    if (name.includes('firstname') || name === 'first_name') {
      return faker.person.firstName().substring(0, maxLen);
    }
    if (name.includes('lastname') || name === 'last_name') {
      return faker.person.lastName().substring(0, maxLen);
    }
    if (name.includes('fullname') || name === 'name') {
      return faker.person.fullName().substring(0, maxLen);
    }
    if (name.includes('company') || name.includes('accountname') || name.includes('organizationname')) {
      return faker.company.name().substring(0, maxLen);
    }
    if (name.includes('address') || name.includes('street') || name.includes('line1')) {
      return faker.location.streetAddress().substring(0, maxLen);
    }
    if (name.includes('city')) {
      return faker.location.city().substring(0, maxLen);
    }
    if (name.includes('state') || name.includes('province')) {
      return faker.location.state().substring(0, maxLen);
    }
    if (name.includes('country')) {
      return faker.location.country().substring(0, maxLen);
    }
    if (name.includes('zip') || name.includes('postal')) {
      return faker.location.zipCode().substring(0, maxLen);
    }
    if (name.includes('description') || name.includes('notes') || col.attributeType === 'Memo') {
      return faker.lorem.paragraph().substring(0, maxLen);
    }
    if (name.includes('subject') || (name === 'title' && col.displayName?.toLowerCase().includes('case'))) {
      // Case/incident subject — generate IT support-style text
      const subjects = [
        'Unable to access email', 'Password reset request', 'VPN connection issue',
        'Software installation request', 'Laptop not booting', 'Printer not responding',
        'Network connectivity issue', 'Application crashing on startup',
        'Permission denied accessing shared drive', 'Two-factor authentication not working',
        'Monitor display issue', 'Cannot connect to database',
        'System running slow', 'USB device not recognized', 'Browser certificate error',
      ];
      return faker.helpers.arrayElement(subjects).substring(0, maxLen);
    }
    if (name.includes('jobtitle')) {
      return faker.person.jobTitle().substring(0, maxLen);
    }
    if (name === 'title') {
      // Generic title — use a short descriptive phrase
      return faker.lorem.sentence({ min: 3, max: 8 }).substring(0, maxLen);
    }
    if (name.includes('department')) {
      return faker.commerce.department().substring(0, maxLen);
    }
    if (name.includes('industry')) {
      return faker.company.buzzNoun().substring(0, maxLen);
    }
    if (name.includes('ticker') || name.includes('symbol')) {
      return faker.finance.currencyCode().substring(0, maxLen);
    }

    // Default: generate a sentence that fits
    if (maxLen <= 10) {
      return faker.string.alphanumeric(maxLen);
    }
    return faker.lorem.words(3).substring(0, maxLen);
  }

  private generateInteger(col: ColumnMetadata): number {
    const name = col.logicalName.toLowerCase();

    // Special handling for timezone offset columns
    // Dataverse UTCOffset fields expect values in range -1500 to 1500 (minutes offset)
    // but some orgs use timezone codes. Safest: generate common UTC offsets in minutes.
    if (name.includes('utcoffset')) {
      // Common UTC offsets in minutes: -720 to +840 (UTC-12 to UTC+14)
      const commonOffsets = [-480, -420, -360, -300, -240, 0, 60, 120, 330, 480, 540, 600];
      return faker.helpers.arrayElement(commonOffsets);
    }

    const min = col.minValue ?? 0;
    const max = col.maxValue ?? 1_000_000;
    return faker.number.int({ min, max });
  }

  private generateBigInt(col: ColumnMetadata): number {
    const min = col.minValue ?? 0;
    const max = col.maxValue ?? 1_000_000_000;
    return faker.number.int({ min, max });
  }

  private generateDecimal(col: ColumnMetadata): number {
    const min = col.minValue ?? 0;
    const max = col.maxValue ?? 100_000;
    const precision = col.precision ?? 2;
    return parseFloat(faker.number.float({ min, max, fractionDigits: precision }).toFixed(precision));
  }

  private generateMoney(col: ColumnMetadata): number {
    const min = col.minValue ?? 0;
    const max = col.maxValue ?? 1_000_000;
    return parseFloat(faker.finance.amount({ min, max, dec: col.precision ?? 2 }));
  }

  private generateDateTime(col: ColumnMetadata): string {
    // Generate dates within the last 2 years
    const date = faker.date.between({
      from: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000),
      to: new Date(),
    });

    // If column format is 'DateOnly', return just YYYY-MM-DD (Edm.Date)
    if (col.format === 'DateOnly') {
      return date.toISOString().split('T')[0];
    }

    // Otherwise return full ISO 8601 datetime (Edm.DateTimeOffset)
    return date.toISOString();
  }

  private generatePicklist(col: ColumnMetadata): number | undefined {
    if (!col.options || col.options.length === 0) {
      return undefined;
    }
    const option = faker.helpers.arrayElement(col.options);
    return option.value;
  }
}
