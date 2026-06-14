import { type Component, For, Show, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import type { List, Item } from "@listr/shared";
import { db } from "../db/database.js";
import { createList } from "../db/operations.js";
import ListFormModal from "../components/ListFormModal.js";

const Dashboard: Component = () => {
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = createSignal(false);

  const lists = from(liveQuery(() => db.lists.orderBy("position").toArray()));
  const itemCounts = from(
    liveQuery(async () => {
      const allItems = await db.items.toArray();
      const counts: Record<string, number> = {};
      for (const item of allItems) {
        counts[item.list_id] = (counts[item.list_id] ?? 0) + 1;
      }
      return counts;
    }),
  );

  const handleCreateList = async (data: { name: string; format_string: string; schema: any[] }) => {
    const list = await createList(data.name, data.schema);
    await db.lists.update(list.id, { format_string: data.format_string });
    setShowCreate(false);
    navigate(`/list/${list.id}`);
  };

  return (
    <div class="main">
      <div class="page-header">
        <h1>Lists</h1>
        <div class="header-actions">
          <button class="btn-primary" onClick={() => setShowCreate(true)}>
            + New List
          </button>
        </div>
      </div>

      <div class="dashboard">
        <Show
          when={(lists() ?? []).length > 0}
          fallback={
            <div class="empty-state">
              <p>No lists yet. Create one to get started.</p>
              <button class="btn-primary" onClick={() => setShowCreate(true)}>
                + New List
              </button>
            </div>
          }
        >
          <div class="list-grid">
            <For each={lists() ?? []}>
              {(list) => (
                <a class="list-card" href={`/list/${list.id}`} onClick={(e) => { e.preventDefault(); navigate(`/list/${list.id}`); }}>
                  <div class="list-card-name">{list.name}</div>
                  <div class="list-card-count">
                    {itemCounts()?.[list.id] ?? 0} items
                  </div>
                </a>
              )}
            </For>
          </div>
        </Show>
      </div>

      <ListFormModal
        open={showCreate()}
        onClose={() => setShowCreate(false)}
        onSave={handleCreateList}
      />
    </div>
  );
};

export default Dashboard;
