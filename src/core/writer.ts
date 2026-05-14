/**
 * Core Engine - Writer (Bulk Insert)
 * Handles record creation via Dataverse Web API with $batch,
 * lookup binding (@odata.bind), N:N association, and two-phase commit.
 */

import type { DataverseClient, BatchOperation } from './client';
import type { TableMetadata } from './metadata';
import type { ExecutionPlan, CyclicDependency } from './planner';
import type { GeneratedRecord } from './generator';

/** Async function that generates records for a table */
export type RecordProvider = (metadata: TableMetadata, count: number) => Promise<GeneratedRecord[]>;

/** Progress callback for reporting status */
export type ProgressCallback = (message: string, percentage: number) => void;

/** Result of a single table's insertion */
export interface TableInsertResult {
  tableName: string;
  requested: number;
  created: number;
  failed: number;
  errors: string[];
  createdIds: string[];
}

/** Result of a full generation run */
export interface RunResult {
  success: boolean;
  startedAt: string;
  completedAt: string;
  seed?: number;
  environmentUrl: string;
  tables: TableInsertResult[];
  deferredLookupsPatched: number;
  manyToManyAssociated: number;
  totalCreated: number;
  totalFailed: number;
  errors: string[];
}

export class Writer {
  private batchSize: number;

  constructor(
    private client: DataverseClient,
    batchSize: number = 100
  ) {
    this.batchSize = Math.min(batchSize, 1000); // Dataverse limit
  }

  /**
   * Execute the full generation plan.
   */
  async execute(
    plan: ExecutionPlan,
    tablesMetadata: Map<string, TableMetadata>,
    recordProvider: RecordProvider,
    environmentUrl: string,
    onProgress?: ProgressCallback
  ): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const tableResults: TableInsertResult[] = [];
    const allErrors: string[] = [];

    // Map of table logical name → array of created GUIDs
    const createdRecordIds = new Map<string, string[]>();

    // Calculate total operations for progress
    let totalOps = 0;
    for (const [, count] of plan.recordCounts) {
      totalOps += count;
    }
    totalOps += plan.deferredLookups.length > 0 ? 1 : 0; // Phase 2
    totalOps += plan.manyToManyAssociations.length; // Phase 3
    let completedOps = 0;

    // === PHASE 1: Create records layer by layer ===
    for (const layer of plan.insertionOrder) {
      // Pre-generate records for ALL tables in this layer in parallel (AI calls are the bottleneck)
      const layerTables = layer.tables.filter(tableName => {
        const metadata = tablesMetadata.get(tableName);
        const count = plan.recordCounts.get(tableName) || 0;
        return metadata && count > 0;
      });

      if (layerTables.length === 0) continue;

      onProgress?.(
        `Generating data for ${layerTables.length} table(s): ${layerTables.join(', ')}...`,
        (completedOps / totalOps) * 100
      );

      // Parallel AI generation for all tables in the layer
      const generatedRecords = new Map<string, Record<string, any>[]>();
      const genPromises = layerTables.map(async (tableName) => {
        const metadata = tablesMetadata.get(tableName)!;
        const count = plan.recordCounts.get(tableName) || 0;
        const records = await recordProvider(metadata, count);
        return { tableName, records };
      });

      const genResults = await Promise.all(genPromises);
      for (const { tableName, records } of genResults) {
        generatedRecords.set(tableName, records);
      }

      // Sequential writes (need createdRecordIds for lookup binding within same layer)
      for (const tableName of layerTables) {
        const metadata = tablesMetadata.get(tableName)!;
        const count = plan.recordCounts.get(tableName) || 0;
        const records = generatedRecords.get(tableName) || [];

        onProgress?.(
          `Writing ${count} records to ${metadata.displayName}...`,
          (completedOps / totalOps) * 100
        );

        // Build a whitelist of safe column names for this table
        const columnMap = new Map(metadata.columns.map(c => [c.logicalName, c]));
        const unsafeTypes = new Set(['Uniqueidentifier', 'State', 'Status', 'Lookup', 'Customer', 'Owner', 'PartyList', 'Virtual', 'EntityName', 'CalendarRules']);
        const safeColumns = new Set<string>();
        for (const [name, col] of columnMap) {
          if (name === metadata.primaryIdAttribute) continue;
          if (!col.isValidForCreate) continue;
          if (unsafeTypes.has(col.attributeType)) continue;
          if (col.isComputed || col.isAutoNumber) continue;
          safeColumns.add(name);
        }
        console.log(`[Writer] ${tableName}: ${safeColumns.size} safe columns out of ${metadata.columns.length} total`);

        // Bind lookups (non-deferred only)
        const deferredCols = new Set(
          plan.deferredLookups
            .filter((d) => d.referencingEntity === tableName)
            .map((d) => d.referencingAttribute)
        );

        // Resolve required lookups that aren't in the plan
        const requiredLookupDefaults = await this.resolveRequiredLookupDefaults(
          metadata, createdRecordIds, tablesMetadata, deferredCols
        );

        const boundRecords = records.map((record) => {
          const bound = this.bindLookups(record, metadata, createdRecordIds, tablesMetadata, deferredCols);
          // Apply required lookup defaults for unbound required lookups
          for (const [key, value] of Object.entries(requiredLookupDefaults)) {
            if (!(key in bound)) {
              bound[key] = value;
            }
          }
          // Final sanitization: WHITELIST approach — only keep safe columns and @odata.bind
          const stripped: string[] = [];
          for (const key of Object.keys(bound)) {
            if (key.includes('@odata.bind')) continue;
            if (!safeColumns.has(key)) {
              stripped.push(key);
              delete bound[key];
            }
          }
          if (stripped.length > 0) {
            console.log(`[Writer] ${tableName}: stripped fields: ${stripped.join(', ')}`);
          }
          return bound;
        });

        // Log first record payload for debugging
        if (boundRecords.length > 0) {
          console.log(`[Writer] ${tableName}: entitySetName=${metadata.entitySetName}, primaryId=${metadata.primaryIdAttribute}`);
          console.log(`[Writer] ${tableName}: sample payload: ${JSON.stringify(boundRecords[0])}`);
        }

        // Insert via $batch
        const result = await this.insertRecords(
          metadata.entitySetName,
          tableName,
          boundRecords,
          count
        );

        tableResults.push(result);
        createdRecordIds.set(tableName, result.createdIds);
        allErrors.push(...result.errors);
        completedOps += count;
      }
    }

    // === PHASE 2: Patch deferred cyclic lookups ===
    let deferredLookupsPatched = 0;
    if (plan.deferredLookups.length > 0) {
      onProgress?.('Patching deferred lookups (cyclic dependencies)...', (completedOps / totalOps) * 100);

      for (const deferred of plan.deferredLookups) {
        const patched = await this.patchDeferredLookups(
          deferred,
          createdRecordIds,
          tablesMetadata
        );
        deferredLookupsPatched += patched;
      }
      completedOps += 1;
    }

    // === PHASE 3: Associate N:N relationships ===
    let manyToManyAssociated = 0;
    for (const assoc of plan.manyToManyAssociations) {
      onProgress?.(
        `Associating ${assoc.entity1} ↔ ${assoc.entity2}...`,
        (completedOps / totalOps) * 100
      );

      const associated = await this.associateManyToMany(
        assoc,
        createdRecordIds,
        tablesMetadata
      );
      manyToManyAssociated += associated;
      completedOps += 1;
    }

    const totalCreated = tableResults.reduce((sum, r) => sum + r.created, 0);
    const totalFailed = tableResults.reduce((sum, r) => sum + r.failed, 0);

    onProgress?.('Complete!', 100);

    return {
      success: totalFailed === 0 && allErrors.length === 0,
      startedAt,
      completedAt: new Date().toISOString(),
      environmentUrl,
      tables: tableResults,
      deferredLookupsPatched,
      manyToManyAssociated,
      totalCreated,
      totalFailed,
      errors: allErrors,
    };
  }

  /**
   * Bind lookup columns using @odata.bind syntax.
   */
  private bindLookups(
    record: GeneratedRecord,
    metadata: TableMetadata,
    createdRecordIds: Map<string, string[]>,
    tablesMetadata: Map<string, TableMetadata>,
    deferredColumns: Set<string>
  ): GeneratedRecord {
    const boundRecord = { ...record };
    const boundColumns = new Set<string>();

    for (const rel of metadata.manyToOneRelationships) {
      // Never bind the primary key as a lookup (e.g., activityid → activitypointer)
      if (rel.referencingAttribute === metadata.primaryIdAttribute) {
        continue;
      }

      // Skip deferred cyclic lookups
      if (deferredColumns.has(rel.referencingAttribute)) {
        continue;
      }

      // Skip if this lookup column was already bound (e.g., polymorphic with multiple targets)
      if (boundColumns.has(rel.referencingAttribute)) {
        continue;
      }

      const parentIds = createdRecordIds.get(rel.referencedEntity);
      if (!parentIds || parentIds.length === 0) {
        continue;
      }

      const parentMeta = tablesMetadata.get(rel.referencedEntity);
      if (!parentMeta) {
        continue;
      }

      // Pick a random parent record
      const randomParentId = parentIds[Math.floor(Math.random() * parentIds.length)];

      // Use @odata.bind with relative path (per MS docs)
      const navProp = rel.referencingEntityNavigationPropertyName;
      boundRecord[`${navProp}@odata.bind`] = `/${parentMeta.entitySetName}(${randomParentId})`;

      // Remove the raw lookup column if present (avoid conflict)
      delete boundRecord[rel.referencingAttribute];
      boundColumns.add(rel.referencingAttribute);
    }

    // Handle lookup columns with lookupTargets that weren't covered by manyToOneRelationships
    // (e.g., Customer/polymorphic lookups)
    for (const col of metadata.columns) {
      if (!col.lookupTargets || col.lookupTargets.length === 0) continue;
      if (col.attributeType === 'Owner') continue;
      if (boundColumns.has(col.logicalName)) continue;
      if (deferredColumns.has(col.logicalName)) continue;

      // Try each target entity until we find one with created records
      for (const target of col.lookupTargets) {
        const parentIds = createdRecordIds.get(target);
        if (!parentIds || parentIds.length === 0) continue;

        const parentMeta = tablesMetadata.get(target);
        if (!parentMeta) continue;

        const randomParentId = parentIds[Math.floor(Math.random() * parentIds.length)];
        // Polymorphic lookups use: <colname>_<targetentity>@odata.bind
        boundRecord[`${col.logicalName}_${target}@odata.bind`] = `/${parentMeta.entitySetName}(${randomParentId})`;
        delete boundRecord[col.logicalName];
        boundColumns.add(col.logicalName);
        break; // Bound to one target, done
      }
    }

    return boundRecord;
  }

  /**
   * For required lookup columns that aren't in the execution plan,
   * query Dataverse for an existing record to bind to.
   */
  private async resolveRequiredLookupDefaults(
    metadata: TableMetadata,
    createdRecordIds: Map<string, string[]>,
    tablesMetadata: Map<string, TableMetadata>,
    deferredColumns: Set<string>
  ): Promise<Record<string, string>> {
    const defaults: Record<string, string> = {};
    const resolvedEntities = new Map<string, { entitySetName: string; recordId: string } | null>();

    for (const rel of metadata.manyToOneRelationships) {
      // Never bind the primary key as a lookup (e.g., activityid → activitypointer)
      if (rel.referencingAttribute === metadata.primaryIdAttribute) continue;

      if (deferredColumns.has(rel.referencingAttribute)) continue;

      // Skip if we already have created records for this target
      const parentIds = createdRecordIds.get(rel.referencedEntity);
      if (parentIds && parentIds.length > 0 && tablesMetadata.has(rel.referencedEntity)) continue;

      // Only resolve if column exists in metadata AND is required.
      // Columns NOT in metadata have IsValidForCreate=false (e.g., createdby, modifiedby)
      // — binding those would cause OData payload errors.
      const col = metadata.columns.find((c) => c.logicalName === rel.referencingAttribute);
      if (!col || !col.isRequired) continue;

      console.log(`[RequiredLookup] ${metadata.logicalName}: resolving required lookup ${rel.referencingAttribute} → ${rel.referencedEntity}`);

      // Cache entity resolution to avoid duplicate API calls
      if (!resolvedEntities.has(rel.referencedEntity)) {
        try {
          const entityDefResponse = await this.client.request<{ EntitySetName: string; PrimaryIdAttribute: string }>({
            method: 'GET',
            path: `EntityDefinitions(LogicalName='${rel.referencedEntity}')`,
            queryParams: { '$select': 'EntitySetName,PrimaryIdAttribute' },
          });
          const entitySetName = entityDefResponse.data?.EntitySetName;
          const primaryId = entityDefResponse.data?.PrimaryIdAttribute;
          if (!entitySetName || !primaryId) {
            console.log(`[RequiredLookup] ${rel.referencedEntity}: no EntitySetName or PrimaryIdAttribute`);
            resolvedEntities.set(rel.referencedEntity, null);
            continue;
          }

          const recordResponse = await this.client.request<{ value: Record<string, string>[] }>({
            method: 'GET',
            path: entitySetName,
            queryParams: { '$top': '1', '$select': primaryId },
          });
          const records = recordResponse.data?.value;
          if (records && records.length > 0 && records[0][primaryId]) {
            console.log(`[RequiredLookup] ${rel.referencedEntity}: resolved to ${records[0][primaryId]} via ${entitySetName}`);
            resolvedEntities.set(rel.referencedEntity, {
              entitySetName,
              recordId: records[0][primaryId],
            });
          } else {
            console.log(`[RequiredLookup] ${rel.referencedEntity}: no records found in ${entitySetName}`);
            resolvedEntities.set(rel.referencedEntity, null);
          }
        } catch (err) {
          console.log(`[RequiredLookup] ${rel.referencedEntity}: error - ${err instanceof Error ? err.message : String(err)}`);
          resolvedEntities.set(rel.referencedEntity, null);
        }
      }

      const resolved = resolvedEntities.get(rel.referencedEntity);
      if (resolved) {
        const navProp = rel.referencingEntityNavigationPropertyName;
        defaults[`${navProp}@odata.bind`] = `/${resolved.entitySetName}(${resolved.recordId})`;
        console.log(`[RequiredLookup] ${metadata.logicalName}: bound ${navProp} → /${resolved.entitySetName}(${resolved.recordId})`);
      }
    }

    return defaults;
  }

  /**
   * Insert records for a single table using $batch.
   */
  private async insertRecords(
    entitySetName: string,
    tableName: string,
    records: GeneratedRecord[],
    requested: number
  ): Promise<TableInsertResult> {
    const createdIds: string[] = [];
    const errors: string[] = [];

    // Chunk into batches
    for (let i = 0; i < records.length; i += this.batchSize) {
      const chunk = records.slice(i, i + this.batchSize);

      const operations: BatchOperation[] = chunk.map((record) => ({
        method: 'POST',
        path: entitySetName,
        body: record,
      }));

      try {
        const responses = await this.client.batch(operations);

        for (let j = 0; j < responses.length; j++) {
          const resp = responses[j];
          if (resp.status >= 200 && resp.status < 300) {
            if (resp.entityId) {
              createdIds.push(resp.entityId);
            }
          } else {
            const errorMsg = resp.body
              ? JSON.stringify(resp.body)
              : `HTTP ${resp.status}`;
            errors.push(`${tableName} record ${i + j}: ${errorMsg}`);
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const batchErrorMsg = `${tableName} batch starting at ${i}: ${msg}`;

        // Retry with individual creates for this chunk
        let retrySuccessCount = 0;
        for (const record of chunk) {
          try {
            const resp = await this.client.request<unknown>({
              method: 'POST',
              path: entitySetName,
              body: record,
              headers: {
                Prefer: 'return=minimal',
              },
            });

            // Extract ID from OData-EntityId header
            const entityIdHeader = resp.headers['odata-entityid'];
            if (entityIdHeader) {
              const guidMatch = entityIdHeader.match(/\(([a-fA-F0-9-]+)\)/);
              if (guidMatch) {
                createdIds.push(guidMatch[1].toLowerCase());
                retrySuccessCount++;
              }
            }
          } catch (retryError) {
            const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
            errors.push(`${tableName} individual retry: ${retryMsg}`);
          }
        }

        // Only report the batch error if retries didn't fully recover
        if (retrySuccessCount < chunk.length) {
          errors.push(batchErrorMsg);
        } else {
          console.log(`[Writer] ${tableName}: batch failed but all ${retrySuccessCount} individual retries succeeded`);
        }
      }
    }

    return {
      tableName,
      requested,
      created: createdIds.length,
      failed: requested - createdIds.length,
      errors,
      createdIds,
    };
  }

  /**
   * Phase 2: Patch deferred cyclic lookups.
   */
  private async patchDeferredLookups(
    deferred: CyclicDependency,
    createdRecordIds: Map<string, string[]>,
    tablesMetadata: Map<string, TableMetadata>
  ): Promise<number> {
    const childIds = createdRecordIds.get(deferred.referencingEntity) || [];
    const parentIds = createdRecordIds.get(deferred.referencedEntity) || [];
    const childMeta = tablesMetadata.get(deferred.referencingEntity);
    const parentMeta = tablesMetadata.get(deferred.referencedEntity);

    if (childIds.length === 0 || parentIds.length === 0 || !childMeta || !parentMeta) {
      return 0;
    }

    let patched = 0;

    // Batch the patches
    for (let i = 0; i < childIds.length; i += this.batchSize) {
      const chunk = childIds.slice(i, i + this.batchSize);

      const operations: BatchOperation[] = chunk.map((childId) => {
        const randomParentId = parentIds[Math.floor(Math.random() * parentIds.length)];
        return {
          method: 'PATCH' as const,
          path: `${childMeta.entitySetName}(${childId})`,
          body: {
            [`${deferred.navigationProperty}@odata.bind`]: `/${parentMeta.entitySetName}(${randomParentId})`,
          },
        };
      });

      try {
        await this.client.batch(operations);
        patched += chunk.length;
      } catch {
        // Try individually
        for (const op of operations) {
          try {
            await this.client.request({
              method: 'PATCH',
              path: op.path,
              body: op.body,
            });
            patched++;
          } catch {
            // Log but continue
          }
        }
      }
    }

    return patched;
  }

  /**
   * Phase 3: Associate N:N relationships.
   */
  private async associateManyToMany(
    assoc: { schemaName: string; entity1: string; entity2: string },
    createdRecordIds: Map<string, string[]>,
    tablesMetadata: Map<string, TableMetadata>
  ): Promise<number> {
    const entity1Ids = createdRecordIds.get(assoc.entity1) || [];
    const entity2Ids = createdRecordIds.get(assoc.entity2) || [];
    const entity1Meta = tablesMetadata.get(assoc.entity1);
    const entity2Meta = tablesMetadata.get(assoc.entity2);

    if (entity1Ids.length === 0 || entity2Ids.length === 0 || !entity1Meta || !entity2Meta) {
      return 0;
    }

    // Find the N:N relationship navigation property
    const m2mRel = entity1Meta.manyToManyRelationships.find(
      (r) => r.schemaName === assoc.schemaName
    );
    if (!m2mRel) {
      return 0;
    }

    let associated = 0;

    // Create some associations (not all×all, just a reasonable subset)
    const associationCount = Math.min(
      Math.max(entity1Ids.length, entity2Ids.length),
      entity1Ids.length * 3
    );

    for (let i = 0; i < associationCount; i++) {
      const e1Id = entity1Ids[i % entity1Ids.length];
      const e2Id = entity2Ids[Math.floor(Math.random() * entity2Ids.length)];

      const navProp = m2mRel.entity1LogicalName === assoc.entity1
        ? m2mRel.entity1NavigationPropertyName
        : m2mRel.entity2NavigationPropertyName;

      try {
        await this.client.request({
          method: 'POST',
          path: `${entity1Meta.entitySetName}(${e1Id})/${navProp}/$ref`,
          body: {
            '@odata.id': `${this.client.baseUrl}/${entity2Meta.entitySetName}(${e2Id})`,
          },
        });
        associated++;
      } catch {
        // Duplicate association or other error — continue
      }
    }

    return associated;
  }
}
