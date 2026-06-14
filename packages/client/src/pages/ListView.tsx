import { type Component, For, Show, createSignal, createMemo } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import { renderFormatString } from "@listr/shared";
import type { Item, List } from "@listr/shared";
import { db } from "../db/database.js";
import {
  createItem,
  updateItem,
  updateItemAttribute,
  deleteItem,
  updateList,
  deleteList,
} from "../db/operations.js";
import ItemFormModal from "../components/ItemFormModal.js";
import ListFormModal from "../components/ListFormModal.js";

const ListView: Component = () => {
  const params = useParams();
  const navigate = useNavigate();

  const [showAddItem, setShowAddItem] = createSignal(false);
  const [editingItem, setEditingItem] = createSignal<Item | undefined>();
  const [showEditList, setShowEditList] = createSignal(false);

  const list = from(liveQuery(() => db.lists.get(params.id)));
  const items = from(
    liveQuery(() => db.items.where("list_id").equals(params.id).sortBy("position")),
  );

  const visibleSchema = createMemo(() => {
    const l = list();
    if (!l) return [];
    return [...l.schema].sort((a, b) => a.position - b.position);
  });

  const handleAddItem = async (data: { title: string; attributes: Record<string, unknown> }) => {
    await createItem(params.id, data.title, data.attributes);
    setShowAddItem(false);
  };

  const handleEditItem = async (data: { title: string; attributes: Record<string, unknown> }) => {
    const item = editingItem();
    if (!item) return;
    await updateItem(item.id, { title: data.title, attributes: data.attributes });
    setEditingItem(undefined);
  };

  const handleDeleteItem = async () => {
    const item = editingItem();
    if (!item) return;
    await deleteItem(item.id);
    setEditingItem(undefined);
  };

  const handleEditList = async (data: { name: string; format_string: string; schema: any[] }) => {
    await updateList(params.id, data);
    setShowEditList(false);
  };

  const handleDeleteList = async () => {
    if (!confirm("Delete this list and all its items?")) return;
    await deleteList(params.id);
    navigate("/");
  };

  const formatItem = (item: Item): string => {
    const l = list();
    if (!l) return item.title;
    return renderFormatString(l.format_string, item, l.schema);
  };

  const formatCellValue = (value: unknown, type: string): string => {
    if (value == null || value === "") return "—";
    if (type === "boolean") return value ? "Yes" : "No";
    if (type === "duration") {
      const n = Number(value);
      const h = Math.floor(n / 60);
      const m = n % 60;
      return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
    }
    if (type === "rating") {
      const n = Number(value);
      return "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n));
    }
    if (type === "tags" && Array.isArray(value)) return value.join(", ");
    return String(value);
  };

  return (
    <div class="main">
      <Show when={list()} fallback={<div class="empty-state"><p>List not found.</p></div>}>
        {(l) => (
          <>
            <div class="page-header">
              <h1>{l().name}</h1>
              <div class="header-actions">
                <button class="btn-ghost" onClick={() => setShowEditList(true)}>
                  Settings
                </button>
                <button class="btn-primary" onClick={() => setShowAddItem(true)}>
                  + Add Item
                </button>
              </div>
            </div>

            <div class="table-container">
              <Show
                when={(items() ?? []).length > 0}
                fallback={
                  <div class="empty-state">
                    <p>No items yet.</p>
                    <button class="btn-primary" onClick={() => setShowAddItem(true)}>
                      + Add Item
                    </button>
                  </div>
                }
              >
                <table>
                  <thead>
                    <tr>
                      <th>Title</th>
                      <For each={visibleSchema()}>
                        {(attr) => <th>{attr.label || attr.key}</th>}
                      </For>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={items() ?? []}>
                      {(item) => (
                        <tr onClick={() => setEditingItem(item)}>
                          <td style="font-weight: 500">{formatItem(item)}</td>
                          <For each={visibleSchema()}>
                            {(attr) => (
                              <td>
                                <Show when={attr.type === "rating"}>
                                  <span class="stars">
                                    {formatCellValue(item.attributes[attr.key], attr.type)}
                                  </span>
                                </Show>
                                <Show when={attr.type !== "rating"}>
                                  {formatCellValue(item.attributes[attr.key], attr.type)}
                                </Show>
                              </td>
                            )}
                          </For>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            </div>

            <ItemFormModal
              open={showAddItem()}
              onClose={() => setShowAddItem(false)}
              onSave={handleAddItem}
              schema={l().schema}
            />

            <ItemFormModal
              open={editingItem() !== undefined}
              onClose={() => setEditingItem(undefined)}
              onSave={handleEditItem}
              onDelete={handleDeleteItem}
              schema={l().schema}
              initial={editingItem()}
            />

            <ListFormModal
              open={showEditList()}
              onClose={() => setShowEditList(false)}
              onSave={handleEditList}
              initial={l()}
            />
          </>
        )}
      </Show>
    </div>
  );
};

export default ListView;
