/**
 * Core Engine - Record Cleaner
 * Deletes records from Dataverse tables in dependency-safe order.
 * Children are deleted before parents to avoid referential integrity errors.
 */

import type { DataverseClient } from './client';
import type { TableMetadata } from './metadata';

/** Configuration for a table to clean */
export interface CleanupTableConfig {
  logicalName: string;
  entitySetName: string;
  primaryIdAttribute: string;
  recordCount: number; // how many to delete (0 = all)
  sortOrder?: 'newest' | 'oldest'; // default: newest
  fetchXml?: string; // optional FetchXML filter — overrides recordCount/sortOrder
}

/** A step in the deletion plan */
export interface DeletionStep {
  order: number;
  logicalName: string;
  displayName: string;
  entitySetName: string;
  primaryIdAttribute: string;
  recordCount: number;
  sortOrder: 'newest' | 'oldest';
  fetchXml?: string;
  reason: string; // "User selected" or "Required dependency of X"
}

/** The deletion plan shown to the user for confirmation */
export interface DeletionPlan {
  steps: DeletionStep[];
  summary: string;
}

/** Result of a cleanup run */
export interface CleanupResult {
  totalDeleted: number;
  totalFailed: number;
  tables: Array<{
    tableName: string;
    deleted: number;
    failed: number;
    available: number;
  }>;
  errors: string[];
  startedAt: string;
  completedAt: string;
}

export class RecordCleaner {
  constructor(private client: DataverseClient) {}

  /**
   * Build a deletion plan by analyzing relationships and computing safe deletion order.
   * Child tables (those that have lookups TO a selected parent) are deleted first.
   */
  buildDeletionPlan(
    selectedTables: CleanupTableConfig[],
    tablesMetadata: Map<string, TableMetadata>
  ): DeletionPlan {
    const selectedSet = new Set(selectedTables.map((t) => t.logicalName));
    const configMap = new Map(selectedTables.map((t) => [t.logicalName, t]));

    // Build dependency graph: parent → children (child depends on parent)
    // For deletion, we reverse: delete children first, then parents
    const dependsOn = new Map<string, Set<string>>(); // table → set of tables it depends on
    for (const table of selectedSet) {
      dependsOn.set(table, new Set());
    }

    for (const tableName of selectedSet) {
      const meta = tablesMetadata.get(tableName);
      if (!meta) continue;

      for (const rel of meta.manyToOneRelationships) {
        const parent = rel.referencedEntity;
        // If this table has a lookup to another selected table, it depends on that parent
        if (parent !== tableName && selectedSet.has(parent)) {
          dependsOn.get(tableName)!.add(parent);
        }
      }
    }

    // Topological sort — tables with no dependencies first (children before parents)
    // A table with dependencies on parents should be deleted BEFORE those parents
    // So we sort: leaf children first, then intermediate, then root parents
    const sorted: string[] = [];
    const visited = new Set<string>();

    // Kahn's algorithm — reverse direction for deletion
    // "no dependencies" means this table doesn't look up to any other selected table = it's a parent = delete last
    // "has dependencies" means this table has lookups to parents = delete first
    // Actually for deletion: delete tables that are depended ON last
    // So: compute "depended on by" count, delete those with 0 first... no.
    // Simpler: use the insertion order from topo sort and REVERSE it.

    // Build forward graph: parent → children
    const children = new Map<string, Set<string>>();
    for (const table of selectedSet) {
      children.set(table, new Set());
    }
    for (const [child, parents] of dependsOn) {
      for (const parent of parents) {
        children.get(parent)?.add(child);
      }
    }

    // Kahn's algorithm for insertion order (parents first)
    const inDegree = new Map<string, number>();
    for (const table of selectedSet) {
      inDegree.set(table, dependsOn.get(table)!.size);
    }

    const queue: string[] = [];
    for (const [table, degree] of inDegree) {
      if (degree === 0) queue.push(table);
    }

    const insertionOrder: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      insertionOrder.push(node);
      for (const child of children.get(node) || []) {
        const newDeg = inDegree.get(child)! - 1;
        inDegree.set(child, newDeg);
        if (newDeg === 0) queue.push(child);
      }
    }

    // Add any remaining (cycles) — just append them
    for (const table of selectedSet) {
      if (!insertionOrder.includes(table)) {
        insertionOrder.push(table);
      }
    }

    // REVERSE for deletion order: children first, parents last
    const deletionOrder = [...insertionOrder].reverse();

    const steps: DeletionStep[] = deletionOrder.map((tableName, idx) => {
      const meta = tablesMetadata.get(tableName)!;
      const cfg = configMap.get(tableName)!;
      return {
        order: idx + 1,
        logicalName: tableName,
        displayName: meta.displayName,
        entitySetName: meta.entitySetName,
        primaryIdAttribute: meta.primaryIdAttribute,
        recordCount: cfg.recordCount,
        sortOrder: cfg.sortOrder || 'newest',
        fetchXml: cfg.fetchXml,
        reason: 'User selected',
      };
    });

    const totalRecords = steps.reduce((sum, s) => sum + s.recordCount, 0);
    const fetchXmlCount = steps.filter((s) => s.fetchXml).length;
    const summaryParts = steps.map((s) => s.displayName + (s.fetchXml ? ' (FetchXML)' : ''));
    const summary = `Delete from ${steps.length} table(s): ${summaryParts.join(' → ')} (${fetchXmlCount > 0 ? 'some filtered by FetchXML, ' : ''}${totalRecords} records total)`;

    return { steps, summary };
  }

  /**
   * Execute the deletion plan.
   * For each table in order: query record IDs, then batch DELETE.
   */
  async execute(
    plan: DeletionPlan,
    onProgress?: (message: string, percentage?: number) => void
  ): Promise<CleanupResult> {
    const startedAt = new Date().toISOString();
    const result: CleanupResult = {
      totalDeleted: 0,
      totalFailed: 0,
      tables: [],
      errors: [],
      startedAt,
      completedAt: '',
    };

    const totalSteps = plan.steps.length;

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const pctBase = (i / totalSteps) * 100;
      const pctStep = 100 / totalSteps;

      onProgress?.(
        `Querying records from ${step.displayName} (${step.order}/${totalSteps})...`,
        Math.round(pctBase)
      );

      try {
        const tableResult = await this.deleteFromTable(
          step,
          (deleted, total) => {
            const pct = pctBase + (deleted / Math.max(total, 1)) * pctStep;
            onProgress?.(
              `Deleting from ${step.displayName}: ${deleted}/${total}`,
              Math.round(pct)
            );
          }
        );
        result.tables.push(tableResult);
        result.totalDeleted += tableResult.deleted;
        result.totalFailed += tableResult.failed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${step.displayName}: ${msg}`);
        result.tables.push({
          tableName: step.logicalName,
          deleted: 0,
          failed: step.recordCount,
          available: 0,
        });
        result.totalFailed += step.recordCount;
      }
    }

    result.completedAt = new Date().toISOString();
    onProgress?.('Cleanup complete!', 100);
    return result;
  }

  /**
   * Delete records from a single table.
   */
  private async deleteFromTable(
    step: DeletionStep,
    onProgress?: (deleted: number, total: number) => void
  ): Promise<{ tableName: string; deleted: number; failed: number; available: number }> {
    let ids: string[];

    if (step.fetchXml) {
      // Use FetchXML to get record IDs
      ids = await this.queryByFetchXml(step.entitySetName, step.primaryIdAttribute, step.fetchXml);
    } else {
      // Standard query with sort order
      const queryCount = step.recordCount === 0 ? 5000 : step.recordCount;
      const orderBy = step.sortOrder === 'oldest' ? 'createdon asc' : 'createdon desc';

      const response = await this.client.request<{ value: Record<string, unknown>[] }>({
        method: 'GET',
        path: step.entitySetName,
        queryParams: {
          $select: step.primaryIdAttribute,
          $orderby: orderBy,
          $top: String(Math.min(queryCount, 5000)),
        },
      });

      ids = (response.data.value || [])
        .map((r) => r[step.primaryIdAttribute])
        .filter((id): id is string => typeof id === 'string');
    }

    const available = ids.length;
    const toDelete = step.fetchXml ? ids : (step.recordCount === 0 ? ids : ids.slice(0, step.recordCount));

    if (toDelete.length === 0) {
      return { tableName: step.logicalName, deleted: 0, failed: 0, available: 0 };
    }

    // 2. Batch DELETE in chunks of 50
    const BATCH_SIZE = 50;
    let deleted = 0;
    let failed = 0;

    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const chunk = toDelete.slice(i, i + BATCH_SIZE);
      const operations = chunk.map((id) => ({
        method: 'DELETE' as const,
        path: `${step.entitySetName}(${id})`,
      }));

      try {
        const responses = await this.client.batch(operations);
        for (const resp of responses) {
          if (resp.status >= 200 && resp.status < 300) {
            deleted++;
          } else {
            failed++;
          }
        }
      } catch {
        // Batch failed — try individually
        for (const op of operations) {
          try {
            await this.client.request({ method: 'DELETE', path: op.path });
            deleted++;
          } catch {
            failed++;
          }
        }
      }

      onProgress?.(deleted + failed, toDelete.length);
    }

    return { tableName: step.logicalName, deleted, failed, available };
  }

  /**
   * Query record IDs using a FetchXML filter.
   */
  private async queryByFetchXml(
    entitySetName: string,
    primaryIdAttribute: string,
    fetchXml: string
  ): Promise<string[]> {
    const encoded = encodeURIComponent(fetchXml);
    const response = await this.client.request<{ value: Record<string, unknown>[] }>({
      method: 'GET',
      path: `${entitySetName}?fetchXml=${encoded}`,
    });

    return (response.data.value || [])
      .map((r) => r[primaryIdAttribute])
      .filter((id): id is string => typeof id === 'string');
  }

  /**
   * Get the count of records in a table.
   */
  async getRecordCount(entitySetName: string): Promise<number> {
    try {
      const response = await this.client.request<{ '@odata.count': number; value: unknown[] }>({
        method: 'GET',
        path: entitySetName,
        queryParams: {
          $top: '0',
          $count: 'true',
        },
      });
      return response.data['@odata.count'] ?? 0;
    } catch {
      return -1; // Unknown
    }
  }
}
