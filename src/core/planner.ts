/**
 * Core Engine - Dependency Planner
 * Builds a directed graph from table relationships and produces
 * a topological insertion order. Handles cycles with two-phase strategy.
 */

import type { TableMetadata, RelationshipMetadata } from './metadata';

/** A layer of tables that can be inserted in parallel (no mutual dependencies within a layer) */
export interface InsertionLayer {
  /** Layer index (0 = first to insert) */
  index: number;
  /** Tables in this layer */
  tables: string[];
}

/** Describes a cyclic dependency that requires two-phase commit */
export interface CyclicDependency {
  /** The lookup column on the child table */
  referencingAttribute: string;
  /** The child table */
  referencingEntity: string;
  /** The parent table */
  referencedEntity: string;
  /** Navigation property for @odata.bind */
  navigationProperty: string;
}

/** The full execution plan */
export interface ExecutionPlan {
  /** Ordered layers for insertion (parents first) */
  insertionOrder: InsertionLayer[];
  /** Cyclic lookups that will be deferred to Phase 2 (patch after create) */
  deferredLookups: CyclicDependency[];
  /** N:N relationships that will be associated after all records exist */
  manyToManyAssociations: Array<{
    schemaName: string;
    entity1: string;
    entity2: string;
  }>;
  /** Record counts per table */
  recordCounts: Map<string, number>;
  /** Summary text for display */
  summary: string;
}

export class DependencyPlanner {
  /**
   * Build an execution plan from table metadata.
   *
   * @param tablesMetadata Map of logical name → full table metadata
   * @param recordCounts Map of logical name → desired record count
   */
  buildPlan(
    tablesMetadata: Map<string, TableMetadata>,
    recordCounts: Map<string, number>
  ): ExecutionPlan {
    const selectedTables = new Set(tablesMetadata.keys());

    // 1. Build adjacency list (directed: parent → child)
    //    Edge means: child depends on parent (child has lookup to parent)
    const graph = new Map<string, Set<string>>(); // parent → children
    const allEdges: Array<{ from: string; to: string; relationship: RelationshipMetadata }> = [];

    for (const table of selectedTables) {
      graph.set(table, new Set());
    }

    for (const [tableName, metadata] of tablesMetadata) {
      // Track which columns already have relationship edges
      const coveredColumns = new Set<string>();

      for (const rel of metadata.manyToOneRelationships) {
        const parent = rel.referencedEntity;
        const child = rel.referencingEntity;

        // Only consider relationships where both tables are in our selection
        if (selectedTables.has(parent) && selectedTables.has(child) && parent !== child) {
          allEdges.push({ from: parent, to: child, relationship: rel });
          coveredColumns.add(rel.referencingAttribute);
        }
      }

      // Handle lookup columns that may not have ManyToOne entries
      // (Customer/Owner polymorphic lookups, or lookups to tables added via auto-resolve)
      for (const col of metadata.columns) {
        if (!col.lookupTargets || col.lookupTargets.length === 0) continue;
        if (col.attributeType === 'Owner') continue; // Owner is system-managed
        if (coveredColumns.has(col.logicalName)) continue; // Already has relationship edges

        for (const target of col.lookupTargets) {
          if (selectedTables.has(target) && target !== tableName) {
            allEdges.push({
              from: target,
              to: tableName,
              relationship: {
                schemaName: `${tableName}_${col.logicalName}_${target}`,
                referencingAttribute: col.logicalName,
                referencingEntity: tableName,
                referencedEntity: target,
                referencedAttribute: 'id',
                referencingEntityNavigationPropertyName: `${col.logicalName}_${target}`,
                referencedEntityNavigationPropertyName: '',
              },
            });
          }
        }
      }
    }

    // Add edges to adjacency graph (Set dedupes naturally)
    for (const edge of allEdges) {
      graph.get(edge.from)!.add(edge.to);
    }

    // 2. Topological sort (Kahn's algorithm) with cycle detection
    //    Uses a "recompute from active edges" approach to avoid in-degree counting bugs
    //    when multiple relationships exist between the same pair of tables.
    const layers: InsertionLayer[] = [];
    const deferredLookups: CyclicDependency[] = [];
    const sorted = new Set<string>();

    // Helper: compute in-degrees from non-deferred, non-sorted edges
    const computeInDegrees = (): Map<string, number> => {
      const deferredSet = new Set(
        deferredLookups.map((d) => `${d.referencedEntity}→${d.referencingEntity}:${d.referencingAttribute}`)
      );
      const degrees = new Map<string, number>();
      for (const table of selectedTables) {
        if (!sorted.has(table)) {
          degrees.set(table, 0);
        }
      }
      for (const edge of allEdges) {
        if (sorted.has(edge.from) || sorted.has(edge.to)) continue;
        const deferKey = `${edge.from}→${edge.to}:${edge.relationship.referencingAttribute}`;
        if (deferredSet.has(deferKey)) continue;
        if (degrees.has(edge.to)) {
          degrees.set(edge.to, degrees.get(edge.to)! + 1);
        }
      }
      return degrees;
    };

    let layerIndex = 0;
    let maxIterations = allEdges.length + selectedTables.size + 1; // Safety limit
    while (sorted.size < selectedTables.size && maxIterations-- > 0) {
      const remaining = computeInDegrees();

      // Find all nodes with in-degree 0
      const zeroDegree: string[] = [];
      for (const [node, degree] of remaining) {
        if (degree === 0) {
          zeroDegree.push(node);
        }
      }

      if (zeroDegree.length === 0) {
        // Cycle detected — break it by deferring one lookup
        const cycleNodes = [...remaining.keys()];
        const prevDeferCount = deferredLookups.length;
        this.breakCycle(cycleNodes, allEdges, remaining, deferredLookups, tablesMetadata);

        // If breakCycle couldn't defer anything, force remaining into final layer
        if (deferredLookups.length === prevDeferCount) {
          layers.push({ index: layerIndex++, tables: cycleNodes.sort() });
          for (const node of cycleNodes) {
            sorted.add(node);
          }
        }
        continue;
        continue; // Recompute in-degrees and retry
      }

      // Add this layer
      layers.push({
        index: layerIndex++,
        tables: zeroDegree.sort(),
      });

      // Mark these nodes as sorted
      for (const node of zeroDegree) {
        sorted.add(node);
      }
    }

    // 3. Collect N:N relationships
    const manyToManyAssociations: Array<{ schemaName: string; entity1: string; entity2: string }> = [];
    const seenM2M = new Set<string>();

    for (const [, metadata] of tablesMetadata) {
      for (const rel of metadata.manyToManyRelationships) {
        if (
          selectedTables.has(rel.entity1LogicalName) &&
          selectedTables.has(rel.entity2LogicalName) &&
          !seenM2M.has(rel.schemaName)
        ) {
          seenM2M.add(rel.schemaName);
          manyToManyAssociations.push({
            schemaName: rel.schemaName,
            entity1: rel.entity1LogicalName,
            entity2: rel.entity2LogicalName,
          });
        }
      }
    }

    // 4. Build summary
    const summary = this.buildSummary(layers, deferredLookups, manyToManyAssociations, recordCounts);

    return {
      insertionOrder: layers,
      deferredLookups,
      manyToManyAssociations,
      recordCounts,
      summary,
    };
  }

  /**
   * Break a cycle by finding the least-costly edge to defer.
   * Prefers to defer non-required lookups to avoid create failures.
   */
  private breakCycle(
    cycleNodes: string[],
    allEdges: Array<{ from: string; to: string; relationship: RelationshipMetadata }>,
    _remaining: Map<string, number>,
    deferredLookups: CyclicDependency[],
    tablesMetadata: Map<string, TableMetadata>
  ): void {
    // Find edges within the cycle that haven't already been deferred
    const cycleSet = new Set(cycleNodes);
    const alreadyDeferred = new Set(
      deferredLookups.map((d) => `${d.referencedEntity}→${d.referencingEntity}:${d.referencingAttribute}`)
    );
    const cycleEdges = allEdges.filter(
      (e) =>
        cycleSet.has(e.from) &&
        cycleSet.has(e.to) &&
        !alreadyDeferred.has(`${e.from}→${e.to}:${e.relationship.referencingAttribute}`)
    );

    if (cycleEdges.length === 0) {
      // No more edges to defer — this shouldn't happen but handle gracefully
      // Force break by deferring all remaining required edges too
      return;
    }

    // Check actual column requiredness from metadata to prefer deferring optional lookups
    const nonRequiredEdge = cycleEdges.find((e) => {
      const tableMeta = tablesMetadata.get(e.to);
      if (!tableMeta) {
        return true; // If we can't check, assume it's safe to defer
      }
      const column = tableMeta.columns.find(
        (col) => col.logicalName === e.relationship.referencingAttribute
      );
      // If column not found or not required, it's safe to defer
      return !column || !column.isRequired;
    });

    const edgeToDefer = nonRequiredEdge || cycleEdges[0];

    // Defer this lookup (in-degrees will be recomputed by caller)
    deferredLookups.push({
      referencingAttribute: edgeToDefer.relationship.referencingAttribute,
      referencingEntity: edgeToDefer.to,
      referencedEntity: edgeToDefer.from,
      navigationProperty: edgeToDefer.relationship.referencingEntityNavigationPropertyName,
    });
  }

  private buildSummary(
    layers: InsertionLayer[],
    deferredLookups: CyclicDependency[],
    manyToMany: Array<{ schemaName: string; entity1: string; entity2: string }>,
    recordCounts: Map<string, number>
  ): string {
    const lines: string[] = [];
    lines.push('=== Execution Plan ===');
    lines.push('');

    let totalRecords = 0;
    for (const [, count] of recordCounts) {
      totalRecords += count;
    }
    lines.push(`Total records to create: ${totalRecords}`);
    lines.push('');

    lines.push('--- Insertion Order ---');
    for (const layer of layers) {
      const details = layer.tables
        .map((t) => `${t} (${recordCounts.get(t) || 0} records)`)
        .join(', ');
      lines.push(`Layer ${layer.index}: ${details}`);
    }

    if (deferredLookups.length > 0) {
      lines.push('');
      lines.push('--- Deferred Lookups (Phase 2: Patch) ---');
      for (const def of deferredLookups) {
        lines.push(
          `  ${def.referencingEntity}.${def.referencingAttribute} → ${def.referencedEntity} (will patch after create)`
        );
      }
    }

    if (manyToMany.length > 0) {
      lines.push('');
      lines.push('--- N:N Associations (Phase 3) ---');
      for (const m2m of manyToMany) {
        lines.push(`  ${m2m.entity1} ↔ ${m2m.entity2} (${m2m.schemaName})`);
      }
    }

    return lines.join('\n');
  }
}
