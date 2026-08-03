import type { Item, IntegrationResult, Integration } from "@listr/shared";
import type { IntegrationModule } from "./integrations/types.js";
import type { IntegrationServerConfig } from "./config.js";
import type { createDbApi } from "./db.js";

type DbApi = ReturnType<typeof createDbApi>;
type BroadcastFn = (syncKey: string, sender: null, msg: unknown) => void;

export class IntegrationRunner {
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private db: DbApi,
    private integrations: Map<string, IntegrationModule>,
    private serverConfig: Record<string, IntegrationServerConfig>,
    private broadcast: BroadcastFn,
  ) {}

  /** Called by index.ts after a successful item upsert. Fire-and-forget. */
  onItemUpserted(item: Item, previousItem: Item | null, syncKey: string, alreadyRan?: Set<string>): void {
    const changedKeys = previousItem ? computeChangedKeys(item, previousItem) : null;
    this._processItemIntegrations(item, changedKeys, syncKey, alreadyRan).catch((err) => {
      console.error(`[integrations] error processing item ${item.id}:`, err);
    });
  }

  private async _processItemIntegrations(
    item: Item,
    changedKeys: Set<string> | null,
    syncKey: string,
    alreadyRan?: Set<string>,
  ): Promise<void> {
    const list = this.db.getEntityById("list", item.list_id) as any;
    if (!list) return;
    const board = this.db.getEntityById("board", list.board_id) as any;
    if (!board) return;

    const integrationConfigs: Integration[] = list.integrations ?? board.integrations ?? [];
    for (const cfg of integrationConfigs) {
      if (!cfg.enabled) continue;
      if (alreadyRan?.has(cfg.integration_id)) continue;
      const module = this.integrations.get(cfg.integration_id);
      if (!module) {
        console.warn(`[integrations] unknown integration_id: ${cfg.integration_id}`);
        continue;
      }
      if (!module.needsUpdate(item, changedKeys, cfg.config)) continue;
      await this._processItem(item, module, cfg, board, syncKey, alreadyRan);
    }
  }

  private async _processItem(
    item: Item,
    module: IntegrationModule,
    cfg: Integration,
    board: any,
    syncKey: string,
    alreadyRan?: Set<string>,
  ): Promise<void> {
    const resultId = `${item.id}:${cfg.integration_id}`;
    const now = Date.now();

    // created_at is set here; if a row already exists the DB's ON CONFLICT clause
    // preserves the original created_at (it's not in the SET list).
    const pendingResult: IntegrationResult = {
      id: resultId,
      item_id: item.id,
      integration_id: cfg.integration_id,
      sync_key: syncKey,
      status: "unprocessed",
      attribute_values: {},
      integration_data: {},
      created_at: now,
      updated_at: now,
    };
    this.db.upsertIntegrationResult(pendingResult);
    this.broadcast(syncKey, null, { type: "entity", entity_type: "integration_result", data: pendingResult });

    try {
      const serverCfg = this.serverConfig[cfg.integration_id] ?? {};
      const result = await module.run(item, serverCfg, cfg.config);

      // Filter attribute_values against the board's schema to catch unknown keys
      const validKeys = new Set<string>((board.schema ?? []).map((attr: any) => attr.key as string));
      const filteredValues: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(result.attribute_values)) {
        if (validKeys.has(key)) {
          filteredValues[key] = value;
        } else {
          console.warn(`[integrations] ${cfg.integration_id}: ignoring unknown attribute key '${key}' (not in board ${board.id} schema)`);
        }
      }

      // Apply filtered values to the item and push the update
      let writtenItem: Item | null = null;
      let baseItem: Item = item;
      if (Object.keys(filteredValues).length > 0) {
        // Re-fetch item in case it was updated while we were running
        const freshItem = this.db.getEntityById("item", item.id) as Item | null;
        baseItem = freshItem ?? item;
        const candidate: Item = {
          ...baseItem,
          attributes: { ...baseItem.attributes, ...filteredValues },
          updated_at: Date.now(),
        };
        const { accepted } = this.db.upsertEntity("item", candidate as unknown as Record<string, unknown>, syncKey);
        if (accepted) {
          writtenItem = candidate;
          this.broadcast(syncKey, null, { type: "entity", entity_type: "item", data: candidate });
        }
      }

      // Cascade: let other integrations react to what this one wrote.
      // This integration and all ancestors are excluded to prevent cycles.
      if (result.cascade && writtenItem) {
        const nextAlreadyRan = new Set([...(alreadyRan ?? []), module.id]);
        this.onItemUpserted(writtenItem, baseItem, syncKey, nextAlreadyRan);
      }

      const completedResult: IntegrationResult = {
        ...pendingResult,
        status: result.status,
        attribute_values: filteredValues,
        integration_data: result.integration_data ?? {},
        error: result.error,
        updated_at: Date.now(),
      };
      this.db.upsertIntegrationResult(completedResult);
      this.broadcast(syncKey, null, { type: "entity", entity_type: "integration_result", data: completedResult });

      console.log(`[integrations] ${cfg.integration_id} ${result.status} for item ${item.id}`);
    } catch (err) {
      console.error(`[integrations] ${cfg.integration_id} failed for item ${item.id}:`, err);
      const errorResult: IntegrationResult = {
        ...pendingResult,
        status: "error",
        error: String(err),
        updated_at: Date.now(),
      };
      this.db.upsertIntegrationResult(errorResult);
      this.broadcast(syncKey, null, { type: "entity", entity_type: "integration_result", data: errorResult });
    }
  }

  startPeriodicRefresh(): void {
    for (const [integrationId, module] of this.integrations) {
      const serverCfg = this.serverConfig[integrationId];
      const refreshIntervalSecs = serverCfg?.refresh_interval ?? 0;
      if (!refreshIntervalSecs) continue;
      const refreshIntervalMs = refreshIntervalSecs * 1000;
      console.log(`[integrations] ${integrationId}: periodic refresh every ${refreshIntervalSecs}s`);

      const doRefresh = async () => {
        try {
          const stale = this.db.getIntegrationResultsForRefresh(integrationId, Date.now() - refreshIntervalMs);
          for (const result of stale) {
            const item = this.db.getEntityById("item", result.item_id) as Item | null;
            if (!item) continue;
            const list = this.db.getEntityById("list", item.list_id) as any;
            if (!list) continue;
            const board = this.db.getEntityById("board", list.board_id) as any;
            if (!board) continue;
            const cfgs: Integration[] = list.integrations ?? board.integrations ?? [];
            const cfg = cfgs.find((c) => c.integration_id === integrationId && c.enabled);
            if (!cfg) continue;
            await this._processItem(item, module, cfg, board, result.sync_key);
          }
        } catch (err) {
          console.error(`[integrations] periodic refresh error for ${integrationId}:`, err);
        }
        const timer = setTimeout(doRefresh, refreshIntervalMs);
        this.timers.push(timer);
      };

      const timer = setTimeout(doRefresh, refreshIntervalMs);
      this.timers.push(timer);
    }
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}

function computeChangedKeys(newItem: Item, oldItem: Item): Set<string> {
  const changed = new Set<string>();
  for (const key of ["title", "after_id", "list_id"] as const) {
    if (newItem[key] !== oldItem[key]) changed.add(key);
  }
  const allAttrKeys = new Set([...Object.keys(newItem.attributes), ...Object.keys(oldItem.attributes)]);
  for (const key of allAttrKeys) {
    if (newItem.attributes[key] !== oldItem.attributes[key]) changed.add(key);
  }
  return changed;
}
