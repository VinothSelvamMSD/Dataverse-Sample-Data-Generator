/**
 * Core Engine - Public API
 * Single entry point that wires together all core modules.
 */

export { AuthManager } from './auth';
export type { DataverseAuthConfig, DataverseConnection } from './auth';

export { DataverseClient, DataverseApiError } from './client';
export type { DataverseRequestOptions, DataverseResponse, BatchOperation, BatchResponse } from './client';

export { MetadataReader } from './metadata';
export type {
  TableMetadata,
  ColumnMetadata,
  OptionMetadata,
  RelationshipMetadata,
  ManyToManyMetadata,
} from './metadata';

export { DependencyPlanner } from './planner';
export type { InsertionLayer, CyclicDependency, ExecutionPlan } from './planner';

export { DataGenerator } from './generator';
export type { GeneratorConfig, GeneratedRecord } from './generator';

export { AIDataGenerator } from './ai-generator';
export type { LMCompletionFn, AIGeneratorConfig } from './ai-generator';

export { Writer } from './writer';
export type { RecordProvider, ProgressCallback, TableInsertResult, RunResult } from './writer';

export { RecordCleaner } from './cleaner';
export type { CleanupTableConfig, DeletionStep, DeletionPlan, CleanupResult } from './cleaner';
