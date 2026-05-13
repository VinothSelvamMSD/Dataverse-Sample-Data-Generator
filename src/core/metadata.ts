/**
 * Core Engine - Metadata Reader
 * Fetches table, column, and relationship metadata from Dataverse.
 */

import type { DataverseClient } from './client';

/** Table (Entity) metadata */
export interface TableMetadata {
  logicalName: string;
  schemaName: string;
  displayName: string;
  /** Table description from Dataverse (explains what this entity is for) */
  description?: string;
  entitySetName: string;
  primaryIdAttribute: string;
  primaryNameAttribute: string;
  /** Whether this entity supports record creation */
  isCreatable: boolean;
  columns: ColumnMetadata[];
  /** Tables this table has lookups TO (parent tables) */
  manyToOneRelationships: RelationshipMetadata[];
  /** Tables that have lookups TO this table (child tables) */
  oneToManyRelationships: RelationshipMetadata[];
  /** N:N relationships */
  manyToManyRelationships: ManyToManyMetadata[];
}

/** Column (Attribute) metadata */
export interface ColumnMetadata {
  logicalName: string;
  schemaName: string;
  displayName: string;
  /** Column description from Dataverse (explains what this field is for) */
  description?: string;
  attributeType: string;
  /** Is required for create */
  isRequired: boolean;
  /** Can be set on create */
  isValidForCreate: boolean;
  /** Autonumber field (system generates value) */
  isAutoNumber?: boolean;
  /** Computed/Formula/Rollup field (system generates value) */
  isComputed?: boolean;
  /** Max length for string columns */
  maxLength?: number;
  /** Min value for numeric columns */
  minValue?: number;
  /** Max value for numeric columns */
  maxValue?: number;
  /** Precision for decimal/money columns */
  precision?: number;
  /** Options for picklist/optionset columns */
  options?: OptionMetadata[];
  /** For lookup columns: target entity logical name */
  lookupTargets?: string[];
  /** Navigation property name for lookups */
  navigationProperty?: string;
  /** Format (e.g., 'Email', 'Phone', 'Url') */
  format?: string;
}

export interface OptionMetadata {
  value: number;
  label: string;
}

export interface RelationshipMetadata {
  schemaName: string;
  /** The lookup column on the "many" side */
  referencingAttribute: string;
  /** The entity that has the lookup column */
  referencingEntity: string;
  /** The entity being looked up to */
  referencedEntity: string;
  /** The primary key on the referenced entity */
  referencedAttribute: string;
  /** Navigation property name to use in @odata.bind */
  referencingEntityNavigationPropertyName: string;
  referencedEntityNavigationPropertyName: string;
}

export interface ManyToManyMetadata {
  schemaName: string;
  entity1LogicalName: string;
  entity1NavigationPropertyName: string;
  entity2LogicalName: string;
  entity2NavigationPropertyName: string;
  intersectEntityName: string;
}

// Dataverse API response shapes (raw)
interface RawEntityDefinition {
  LogicalName: string;
  SchemaName: string;
  DisplayName: { UserLocalizedLabel?: { Label: string } };
  Description: { UserLocalizedLabel?: { Label: string } };
  EntitySetName: string;
  PrimaryIdAttribute: string;
  PrimaryNameAttribute: string;
  IsCustomizable: { Value: boolean };
  CanCreateForms: { Value: boolean };
  IsValidForAdvancedFind: boolean;
}

interface RawAttributeDefinition {
  LogicalName: string;
  SchemaName: string;
  DisplayName: { UserLocalizedLabel?: { Label: string } };
  Description: { UserLocalizedLabel?: { Label: string } };
  AttributeType: string;
  RequiredLevel: { Value: string };
  IsValidForCreate: boolean;
  MaxLength?: number;
  MinValue?: number;
  MaxValue?: number;
  Precision?: number;
  Format?: string;
  Targets?: string[];
}

interface RawOptionSetOption {
  Value: number;
  Label: { UserLocalizedLabel?: { Label: string } };
}

interface RawRelationship {
  SchemaName: string;
  ReferencingAttribute: string;
  ReferencingEntity: string;
  ReferencedEntity: string;
  ReferencedAttribute: string;
  ReferencingEntityNavigationPropertyName: string;
  ReferencedEntityNavigationPropertyName: string;
}

interface RawManyToMany {
  SchemaName: string;
  Entity1LogicalName: string;
  Entity1NavigationPropertyName: string;
  Entity2LogicalName: string;
  Entity2NavigationPropertyName: string;
  IntersectEntityName: string;
}

export class MetadataReader {
  constructor(private client: DataverseClient) {}

  /**
   * Fetch list of all user-selectable tables (filters out system/internal tables).
   */
  async getSelectableTables(): Promise<Array<{ logicalName: string; displayName: string; entitySetName: string }>> {
    const raw = await this.client.getAll<RawEntityDefinition>(
      'EntityDefinitions',
      {
        $select: 'LogicalName,SchemaName,DisplayName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,IsValidForAdvancedFind',
        $filter: 'IsValidForAdvancedFind eq true and IsIntersect eq false',
      }
    );

    return raw
      .map((e) => ({
        logicalName: e.LogicalName,
        displayName: e.DisplayName?.UserLocalizedLabel?.Label || e.LogicalName,
        entitySetName: e.EntitySetName,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /**
   * Fetch full metadata for a specific table (columns + relationships).
   */
  async getTableMetadata(logicalName: string): Promise<TableMetadata> {
    // Fetch entity definition
    const entityResp = await this.client.request<RawEntityDefinition>({
      method: 'GET',
      path: `EntityDefinitions(LogicalName='${logicalName}')`,
      queryParams: {
        $select: 'LogicalName,SchemaName,DisplayName,Description,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,IsValidForAdvancedFind,CanCreateForms',
      },
    });

    const entity = entityResp.data;

    // Fetch columns first (already batched internally), then relationships
    const columns = await this.getColumns(logicalName);

    const [manyToOne, oneToMany, manyToMany] = await Promise.all([
      this.getManyToOneRelationships(logicalName),
      this.getOneToManyRelationships(logicalName),
      this.getManyToManyRelationships(logicalName),
    ]);

    return {
      logicalName: entity.LogicalName,
      schemaName: entity.SchemaName,
      displayName: entity.DisplayName?.UserLocalizedLabel?.Label || entity.LogicalName,
      description: entity.Description?.UserLocalizedLabel?.Label || undefined,
      entitySetName: entity.EntitySetName,
      primaryIdAttribute: entity.PrimaryIdAttribute,
      primaryNameAttribute: entity.PrimaryNameAttribute,
      isCreatable: entity.IsValidForAdvancedFind && (entity.CanCreateForms?.Value !== false),
      columns,
      manyToOneRelationships: manyToOne,
      oneToManyRelationships: oneToMany,
      manyToManyRelationships: manyToMany,
    };
  }

  /**
   * Fetch full metadata for multiple tables at once.
   */
  async getTablesMetadata(logicalNames: string[]): Promise<Map<string, TableMetadata>> {
    const results = new Map<string, TableMetadata>();

    // Fetch in parallel (but limit concurrency to avoid throttling)
    const concurrency = 5;
    for (let i = 0; i < logicalNames.length; i += concurrency) {
      const batch = logicalNames.slice(i, i + concurrency);
      const metadataResults = await Promise.all(
        batch.map((name) => this.getTableMetadata(name))
      );
      for (const meta of metadataResults) {
        results.set(meta.logicalName, meta);
      }
    }

    return results;
  }

  private async getColumns(entityLogicalName: string): Promise<ColumnMetadata[]> {
    // Fetch all attributes using type-specific casts in sequential batches
    // to avoid overwhelming Dataverse with too many parallel requests.
    // Batch 1: String, Memo, Integer, Double
    const [strings, memos, integers, doubles] = await Promise.all([
      this.getTypedAttributes<{ LogicalName: string; SchemaName: string; DisplayName: { UserLocalizedLabel?: { Label: string } }; Description: { UserLocalizedLabel?: { Label: string } }; AttributeType: string; RequiredLevel: { Value: string }; IsValidForCreate: boolean; MaxLength?: number; FormatName?: { Value?: string }; Format?: string; AutoNumberFormat?: string; SourceType?: number }>(
        entityLogicalName, 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
        'LogicalName,SchemaName,DisplayName,Description,AttributeType,RequiredLevel,IsValidForCreate,MaxLength,FormatName,Format,AutoNumberFormat,SourceType'
      ),
      this.getTypedAttributes<{ LogicalName: string; SchemaName: string; DisplayName: { UserLocalizedLabel?: { Label: string } }; Description: { UserLocalizedLabel?: { Label: string } }; AttributeType: string; RequiredLevel: { Value: string }; IsValidForCreate: boolean; MaxLength?: number; Format?: string }>(
        entityLogicalName, 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
        'LogicalName,SchemaName,DisplayName,Description,AttributeType,RequiredLevel,IsValidForCreate,MaxLength,Format'
      ),
      this.getTypedAttributes<{ LogicalName: string; SchemaName: string; DisplayName: { UserLocalizedLabel?: { Label: string } }; Description: { UserLocalizedLabel?: { Label: string } }; AttributeType: string; RequiredLevel: { Value: string }; IsValidForCreate: boolean; MinValue?: number; MaxValue?: number }>(
        entityLogicalName, 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
        'LogicalName,SchemaName,DisplayName,Description,AttributeType,RequiredLevel,IsValidForCreate,MinValue,MaxValue'
      ),
      this.getTypedAttributes<{ LogicalName: string; SchemaName: string; DisplayName: { UserLocalizedLabel?: { Label: string } }; Description: { UserLocalizedLabel?: { Label: string } }; AttributeType: string; RequiredLevel: { Value: string }; IsValidForCreate: boolean; MinValue?: number; MaxValue?: number; Precision?: number }>(
        entityLogicalName, 'Microsoft.Dynamics.CRM.DoubleAttributeMetadata',
        'LogicalName,SchemaName,DisplayName,Description,AttributeType,RequiredLevel,IsValidForCreate,MinValue,MaxValue,Precision'
      ),
    ]);

    // Batch 2: Decimal, Money, Lookup, DateTime
    const [decimals, moneys, lookups, dateTimes] = await Promise.all([
      this.getTypedAttributes<{ LogicalName: string; SchemaName: string; DisplayName: { UserLocalizedLabel?: { Label: string } }; Description: { UserLocalizedLabel?: { Label: string } }; AttributeType: string; RequiredLevel: { Value: string }; IsValidForCreate: boolean; MinValue?: number; MaxValue?: number; Precision?: number }>(
        entityLogicalName, 'Microsoft.Dynamics.CRM.DecimalAttributeMetadata',
        'LogicalName,SchemaName,DisplayName,Description,AttributeType,RequiredLevel,IsValidForCreate,MinValue,MaxValue,Precision'
      ),
      this.getTypedAttributes<{ LogicalName: string; SchemaName: string; DisplayName: { UserLocalizedLabel?: { Label: string } }; Description: { UserLocalizedLabel?: { Label: string } }; AttributeType: string; RequiredLevel: { Value: string }; IsValidForCreate: boolean; MinValue?: number; MaxValue?: number; Precision?: number }>(
        entityLogicalName, 'Microsoft.Dynamics.CRM.MoneyAttributeMetadata',
        'LogicalName,SchemaName,DisplayName,Description,AttributeType,RequiredLevel,IsValidForCreate,MinValue,MaxValue,Precision'
      ),
      this.getTypedAttributes<{ LogicalName: string; SchemaName: string; DisplayName: { UserLocalizedLabel?: { Label: string } }; Description: { UserLocalizedLabel?: { Label: string } }; AttributeType: string; RequiredLevel: { Value: string }; IsValidForCreate: boolean; Targets?: string[] }>(
        entityLogicalName, 'Microsoft.Dynamics.CRM.LookupAttributeMetadata',
        'LogicalName,SchemaName,DisplayName,Description,AttributeType,RequiredLevel,IsValidForCreate,Targets'
      ),
      this.getTypedAttributes<{ LogicalName: string; SchemaName: string; DisplayName: { UserLocalizedLabel?: { Label: string } }; Description: { UserLocalizedLabel?: { Label: string } }; AttributeType: string; RequiredLevel: { Value: string }; IsValidForCreate: boolean; Format?: string }>(
        entityLogicalName, 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata',
        'LogicalName,SchemaName,DisplayName,Description,AttributeType,RequiredLevel,IsValidForCreate,Format'
      ),
    ]);

    // Batch 3: Picklist, Boolean, Base attributes
    const [picklists, booleans, baseAttrs] = await Promise.all([
      this.getTypedAttributes<{ LogicalName: string; SchemaName: string; DisplayName: { UserLocalizedLabel?: { Label: string } }; Description: { UserLocalizedLabel?: { Label: string } }; AttributeType: string; RequiredLevel: { Value: string }; IsValidForCreate: boolean }>(
        entityLogicalName, 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata',
        'LogicalName,SchemaName,DisplayName,Description,AttributeType,RequiredLevel,IsValidForCreate'
      ),
      this.getTypedAttributes<{ LogicalName: string; SchemaName: string; DisplayName: { UserLocalizedLabel?: { Label: string } }; Description: { UserLocalizedLabel?: { Label: string } }; AttributeType: string; RequiredLevel: { Value: string }; IsValidForCreate: boolean }>(
        entityLogicalName, 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata',
        'LogicalName,SchemaName,DisplayName,Description,AttributeType,RequiredLevel,IsValidForCreate'
      ),
      // Base endpoint for remaining types (Uniqueidentifier, BigInt, etc.)
      this.client.getAll<RawAttributeDefinition>(
        `EntityDefinitions(LogicalName='${entityLogicalName}')/Attributes`,
        {
          $select: 'LogicalName,SchemaName,DisplayName,Description,AttributeType,RequiredLevel,IsValidForCreate',
          $filter: 'IsValidForCreate eq true',
        }
      ),
    ]);

    // Build a map of enriched columns keyed by logicalName
    const columnMap = new Map<string, ColumnMetadata>();

    // Helper to add a base column
    const addBase = (attr: { LogicalName: string; SchemaName: string; DisplayName: { UserLocalizedLabel?: { Label: string } }; Description: { UserLocalizedLabel?: { Label: string } }; AttributeType: string; RequiredLevel: { Value: string }; IsValidForCreate: boolean }) => {
      if (['Virtual', 'EntityName', 'CalendarRules', 'PartyList'].includes(attr.AttributeType)) {
        return;
      }
      if (!attr.IsValidForCreate) {
        return;
      }
      if (!columnMap.has(attr.LogicalName)) {
        columnMap.set(attr.LogicalName, {
          logicalName: attr.LogicalName,
          schemaName: attr.SchemaName,
          displayName: attr.DisplayName?.UserLocalizedLabel?.Label || attr.LogicalName,
          description: attr.Description?.UserLocalizedLabel?.Label || undefined,
          attributeType: attr.AttributeType,
          isRequired: attr.RequiredLevel?.Value === 'ApplicationRequired' || attr.RequiredLevel?.Value === 'SystemRequired',
          isValidForCreate: attr.IsValidForCreate,
        });
      }
    };

    // Process typed results — they have the enriched properties
    for (const attr of strings) {
      if (!attr.IsValidForCreate) continue;
      columnMap.set(attr.LogicalName, {
        logicalName: attr.LogicalName,
        schemaName: attr.SchemaName,
        displayName: attr.DisplayName?.UserLocalizedLabel?.Label || attr.LogicalName,
        description: attr.Description?.UserLocalizedLabel?.Label || undefined,
        attributeType: attr.AttributeType || 'String',
        isRequired: attr.RequiredLevel?.Value === 'ApplicationRequired' || attr.RequiredLevel?.Value === 'SystemRequired',
        isValidForCreate: attr.IsValidForCreate,
        isAutoNumber: !!attr.AutoNumberFormat,
        isComputed: attr.SourceType === 1 || attr.SourceType === 2,
        maxLength: attr.MaxLength,
        format: attr.FormatName?.Value || attr.Format,
      });
    }

    for (const attr of memos) {
      if (!attr.IsValidForCreate) continue;
      columnMap.set(attr.LogicalName, {
        logicalName: attr.LogicalName,
        schemaName: attr.SchemaName,
        displayName: attr.DisplayName?.UserLocalizedLabel?.Label || attr.LogicalName,
        description: attr.Description?.UserLocalizedLabel?.Label || undefined,
        attributeType: attr.AttributeType || 'Memo',
        isRequired: attr.RequiredLevel?.Value === 'ApplicationRequired' || attr.RequiredLevel?.Value === 'SystemRequired',
        isValidForCreate: attr.IsValidForCreate,
        maxLength: attr.MaxLength,
        format: attr.Format,
      });
    }

    for (const attr of integers) {
      if (!attr.IsValidForCreate) continue;
      columnMap.set(attr.LogicalName, {
        logicalName: attr.LogicalName,
        schemaName: attr.SchemaName,
        displayName: attr.DisplayName?.UserLocalizedLabel?.Label || attr.LogicalName,
        description: attr.Description?.UserLocalizedLabel?.Label || undefined,
        attributeType: attr.AttributeType || 'Integer',
        isRequired: attr.RequiredLevel?.Value === 'ApplicationRequired' || attr.RequiredLevel?.Value === 'SystemRequired',
        isValidForCreate: attr.IsValidForCreate,
        minValue: attr.MinValue,
        maxValue: attr.MaxValue,
      });
    }

    for (const attr of [...doubles, ...decimals, ...moneys]) {
      if (!attr.IsValidForCreate) continue;
      columnMap.set(attr.LogicalName, {
        logicalName: attr.LogicalName,
        schemaName: attr.SchemaName,
        displayName: attr.DisplayName?.UserLocalizedLabel?.Label || attr.LogicalName,
        description: attr.Description?.UserLocalizedLabel?.Label || undefined,
        attributeType: attr.AttributeType || 'Decimal',
        isRequired: attr.RequiredLevel?.Value === 'ApplicationRequired' || attr.RequiredLevel?.Value === 'SystemRequired',
        isValidForCreate: attr.IsValidForCreate,
        minValue: attr.MinValue,
        maxValue: attr.MaxValue,
        precision: attr.Precision,
      });
    }

    for (const attr of lookups) {
      if (!attr.IsValidForCreate) continue;
      columnMap.set(attr.LogicalName, {
        logicalName: attr.LogicalName,
        schemaName: attr.SchemaName,
        displayName: attr.DisplayName?.UserLocalizedLabel?.Label || attr.LogicalName,
        description: attr.Description?.UserLocalizedLabel?.Label || undefined,
        attributeType: attr.AttributeType || 'Lookup',
        isRequired: attr.RequiredLevel?.Value === 'ApplicationRequired' || attr.RequiredLevel?.Value === 'SystemRequired',
        isValidForCreate: attr.IsValidForCreate,
        lookupTargets: attr.Targets,
      });
    }

    for (const attr of dateTimes) {
      if (!attr.IsValidForCreate) continue;
      columnMap.set(attr.LogicalName, {
        logicalName: attr.LogicalName,
        schemaName: attr.SchemaName,
        displayName: attr.DisplayName?.UserLocalizedLabel?.Label || attr.LogicalName,
        description: attr.Description?.UserLocalizedLabel?.Label || undefined,
        attributeType: attr.AttributeType || 'DateTime',
        isRequired: attr.RequiredLevel?.Value === 'ApplicationRequired' || attr.RequiredLevel?.Value === 'SystemRequired',
        isValidForCreate: attr.IsValidForCreate,
        format: attr.Format,
      });
    }

    for (const attr of picklists) {
      if (!attr.IsValidForCreate) continue;
      columnMap.set(attr.LogicalName, {
        logicalName: attr.LogicalName,
        schemaName: attr.SchemaName,
        displayName: attr.DisplayName?.UserLocalizedLabel?.Label || attr.LogicalName,
        description: attr.Description?.UserLocalizedLabel?.Label || undefined,
        attributeType: attr.AttributeType || 'Picklist',
        isRequired: attr.RequiredLevel?.Value === 'ApplicationRequired' || attr.RequiredLevel?.Value === 'SystemRequired',
        isValidForCreate: attr.IsValidForCreate,
      });
    }

    for (const attr of booleans) {
      if (!attr.IsValidForCreate) continue;
      columnMap.set(attr.LogicalName, {
        logicalName: attr.LogicalName,
        schemaName: attr.SchemaName,
        displayName: attr.DisplayName?.UserLocalizedLabel?.Label || attr.LogicalName,
        description: attr.Description?.UserLocalizedLabel?.Label || undefined,
        attributeType: attr.AttributeType || 'Boolean',
        isRequired: attr.RequiredLevel?.Value === 'ApplicationRequired' || attr.RequiredLevel?.Value === 'SystemRequired',
        isValidForCreate: attr.IsValidForCreate,
      });
    }

    // Fill in any remaining types from base query (UniqueIdentifier, BigInt, etc.)
    for (const attr of baseAttrs) {
      addBase(attr);
    }

    // Fetch optionset values for picklist columns
    const columns = Array.from(columnMap.values());
    const picklistCols = columns.filter((c) => ['Picklist', 'State', 'Status'].includes(c.attributeType));
    const optionResults = await Promise.all(
      picklistCols.map((col) => this.getOptionSetValues(entityLogicalName, col.logicalName, col.attributeType))
    );
    for (let i = 0; i < picklistCols.length; i++) {
      picklistCols[i].options = optionResults[i];
    }

    return columns;
  }

  /**
   * Fetch all attributes of a given derived type in one request.
   */
  private async getTypedAttributes<T>(
    entityLogicalName: string,
    typeCast: string,
    select: string
  ): Promise<T[]> {
    try {
      return await this.client.getAll<T>(
        `EntityDefinitions(LogicalName='${entityLogicalName}')/Attributes/${typeCast}`,
        { $select: select, $filter: 'IsValidForCreate eq true' }
      );
    } catch {
      return [];
    }
  }

  private async getOptionSetValues(
    entityLogicalName: string,
    attributeLogicalName: string,
    attributeType: string
  ): Promise<OptionMetadata[]> {
    try {
      const typePath = attributeType === 'Picklist'
        ? 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata'
        : attributeType === 'Status'
          ? 'Microsoft.Dynamics.CRM.StatusAttributeMetadata'
          : 'Microsoft.Dynamics.CRM.StateAttributeMetadata';

      const resp = await this.client.request<{ OptionSet: { Options: RawOptionSetOption[] } }>({
        method: 'GET',
        path: `EntityDefinitions(LogicalName='${entityLogicalName}')/Attributes(LogicalName='${attributeLogicalName}')/${typePath}`,
        queryParams: {
          $select: 'LogicalName',
          $expand: 'OptionSet',
        },
      });

      return (resp.data.OptionSet?.Options || []).map((opt) => ({
        value: opt.Value,
        label: opt.Label?.UserLocalizedLabel?.Label || `Option ${opt.Value}`,
      }));
    } catch {
      // Fallback: return empty if we can't read options
      return [];
    }
  }

  private async getManyToOneRelationships(entityLogicalName: string): Promise<RelationshipMetadata[]> {
    const raw = await this.client.getAll<RawRelationship>(
      `EntityDefinitions(LogicalName='${entityLogicalName}')/ManyToOneRelationships`,
      {
        $select: 'SchemaName,ReferencingAttribute,ReferencingEntity,ReferencedEntity,ReferencedAttribute,ReferencingEntityNavigationPropertyName,ReferencedEntityNavigationPropertyName',
      }
    );

    return raw.map((r) => ({
      schemaName: r.SchemaName,
      referencingAttribute: r.ReferencingAttribute,
      referencingEntity: r.ReferencingEntity,
      referencedEntity: r.ReferencedEntity,
      referencedAttribute: r.ReferencedAttribute,
      referencingEntityNavigationPropertyName: r.ReferencingEntityNavigationPropertyName,
      referencedEntityNavigationPropertyName: r.ReferencedEntityNavigationPropertyName,
    }));
  }

  private async getOneToManyRelationships(entityLogicalName: string): Promise<RelationshipMetadata[]> {
    const raw = await this.client.getAll<RawRelationship>(
      `EntityDefinitions(LogicalName='${entityLogicalName}')/OneToManyRelationships`,
      {
        $select: 'SchemaName,ReferencingAttribute,ReferencingEntity,ReferencedEntity,ReferencedAttribute,ReferencingEntityNavigationPropertyName,ReferencedEntityNavigationPropertyName',
      }
    );

    return raw.map((r) => ({
      schemaName: r.SchemaName,
      referencingAttribute: r.ReferencingAttribute,
      referencingEntity: r.ReferencingEntity,
      referencedEntity: r.ReferencedEntity,
      referencedAttribute: r.ReferencedAttribute,
      referencingEntityNavigationPropertyName: r.ReferencingEntityNavigationPropertyName,
      referencedEntityNavigationPropertyName: r.ReferencedEntityNavigationPropertyName,
    }));
  }

  private async getManyToManyRelationships(entityLogicalName: string): Promise<ManyToManyMetadata[]> {
    const raw = await this.client.getAll<RawManyToMany>(
      `EntityDefinitions(LogicalName='${entityLogicalName}')/ManyToManyRelationships`,
      {
        $select: 'SchemaName,Entity1LogicalName,Entity1NavigationPropertyName,Entity2LogicalName,Entity2NavigationPropertyName,IntersectEntityName',
      }
    );

    return raw.map((r) => ({
      schemaName: r.SchemaName,
      entity1LogicalName: r.Entity1LogicalName,
      entity1NavigationPropertyName: r.Entity1NavigationPropertyName,
      entity2LogicalName: r.Entity2LogicalName,
      entity2NavigationPropertyName: r.Entity2NavigationPropertyName,
      intersectEntityName: r.IntersectEntityName,
    }));
  }
}
