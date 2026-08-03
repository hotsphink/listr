import type { Item } from "@listr/shared";

export interface IntegrationRunResult {
  status: "complete" | "error" | "ambiguous";
  /** Attribute key → value pairs to merge into the item. Unknown keys are logged and dropped. */
  attribute_values: Record<string, unknown>;
  /** Arbitrary integration-internal state (e.g. candidate list for disambiguation). */
  integration_data?: Record<string, unknown>;
  error?: string;
  /**
   * If true, the runner re-runs onItemUpserted for the updated item so other
   * integrations can react to the changes. This integration itself is always
   * excluded from its own cascade to prevent self-loops; the full chain of
   * already-ran integration IDs is excluded to prevent multi-hop cycles.
   */
  cascade?: boolean;
}

export interface IntegrationModule {
  readonly id: string;

  /**
   * Called for every item create/update. changedKeys is null on item creation,
   * otherwise the set of changed field names (top-level fields + attribute keys).
   * Returns true if this integration should run for this item now.
   */
  needsUpdate(
    item: Item,
    changedKeys: Set<string> | null,
    listConfig?: Record<string, unknown>,
  ): boolean;

  run(
    item: Item,
    serverConfig: Record<string, unknown>,
    listConfig?: Record<string, unknown>,
  ): Promise<IntegrationRunResult>;
}
