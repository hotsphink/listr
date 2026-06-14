import { type Component, For, Show, createSignal, createEffect } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import type { Category, List } from "@listr/shared";
import { db } from "../db/database.js";
import { createList, createCategory, updateCategory } from "../db/operations.js";
import ListFormModal from "../components/ListFormModal.js";
import CategoryFormModal from "../components/CategoryFormModal.js";

const Dashboard: Component = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [showCreateList, setShowCreateList] = createSignal(false);
  const [showCreateCategory, setShowCreateCategory] = createSignal(false);
  const [editingCategory, setEditingCategory] = createSignal<Category | undefined>();

  const categories = from(liveQuery(() => db.categories.orderBy("position").toArray()));
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

  createEffect(() => {
    const state = location.state as any;
    if (state?.openCreate) {
      setShowCreateList(true);
      navigate("/", { replace: true });
    }
    if (state?.editCategory) {
      const cat = (categories() ?? []).find((c) => c.id === state.editCategory);
      if (cat) setEditingCategory(cat);
      navigate("/", { replace: true });
    }
  });

  const listsForCategory = (catId: string) =>
    (lists() ?? []).filter((l) => l.category_id === catId);

  const uncategorizedLists = () =>
    (lists() ?? []).filter((l) => !l.category_id);

  const handleCreateList = async (data: { name: string; category_id: string | null; format_string: string | null }) => {
    const list = await createList(data.name, data.category_id);
    if (data.format_string != null) {
      await db.lists.update(list.id, { format_string: data.format_string });
    }
    setShowCreateList(false);
    navigate(`/list/${list.id}`);
  };

  const handleCreateCategory = async (data: { name: string; color: string; format_string: string; schema: any[] }) => {
    await createCategory(data.name, data.color, data.schema, data.format_string);
    setShowCreateCategory(false);
  };

  const handleEditCategory = async (data: { name: string; color: string; format_string: string; schema: any[] }) => {
    const cat = editingCategory();
    if (!cat) return;
    await updateCategory(cat.id, data);
    setEditingCategory(undefined);
  };

  const renderListCard = (list: List) => (
    <a class="list-card" href={`/list/${list.id}`} onClick={(e) => { e.preventDefault(); navigate(`/list/${list.id}`); }}>
      <div class="list-card-name">{list.name}</div>
      <div class="list-card-count">
        {itemCounts()?.[list.id] ?? 0} items
      </div>
    </a>
  );

  return (
    <div class="main">
      <div class="page-header">
        <h1>Lists</h1>
        <div class="header-actions">
          <button class="btn-ghost" onClick={() => setShowCreateCategory(true)}>
            + Category
          </button>
          <button class="btn-primary" onClick={() => setShowCreateList(true)}>
            + New List
          </button>
        </div>
      </div>

      <div class="dashboard">
        <Show
          when={(categories() ?? []).length > 0 || (lists() ?? []).length > 0}
          fallback={
            <div class="empty-state">
              <p>No lists yet. Create a category and list to get started.</p>
              <button class="btn-primary" onClick={() => setShowCreateCategory(true)}>
                + New Category
              </button>
            </div>
          }
        >
          <For each={categories() ?? []}>
            {(cat) => (
              <div class="dashboard-category">
                <div class="dashboard-category-header">
                  <h2 style={`border-left: 3px solid ${cat.color}; padding-left: 8px`}>{cat.name}</h2>
                  <button class="btn-icon" onClick={() => setEditingCategory(cat)} title="Edit category">
                    ⚙
                  </button>
                </div>
                <Show
                  when={listsForCategory(cat.id).length > 0}
                  fallback={
                    <div style="color: var(--text-dim); font-size: 13px; padding: 4px 0 12px">
                      No lists yet
                    </div>
                  }
                >
                  <div class="list-grid">
                    <For each={listsForCategory(cat.id)}>
                      {(list) => renderListCard(list)}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </For>

          <Show when={uncategorizedLists().length > 0}>
            <h2 style="color: var(--text-muted); margin-bottom: 12px">Uncategorized</h2>
            <div class="list-grid">
              <For each={uncategorizedLists()}>
                {(list) => renderListCard(list)}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      <ListFormModal
        open={showCreateList()}
        onClose={() => setShowCreateList(false)}
        onSave={handleCreateList}
        categories={categories() ?? []}
      />

      <CategoryFormModal
        open={showCreateCategory()}
        onClose={() => setShowCreateCategory(false)}
        onSave={handleCreateCategory}
      />

      <CategoryFormModal
        open={editingCategory() !== undefined}
        onClose={() => setEditingCategory(undefined)}
        onSave={handleEditCategory}
        initial={editingCategory()}
      />
    </div>
  );
};

export default Dashboard;
