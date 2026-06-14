import { type Component, For } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import { db } from "../db/database.js";

const Sidebar: Component = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const lists = from(liveQuery(() => db.lists.orderBy("position").toArray()));

  return (
    <nav class="sidebar">
      <div
        class="sidebar-header"
        style="cursor: pointer"
        onClick={() => navigate("/")}
      >
        Listr
      </div>
      <div class="sidebar-content">
        <For each={lists() ?? []}>
          {(list) => (
            <div
              class="sidebar-item"
              classList={{ active: location.pathname === `/list/${list.id}` }}
              onClick={() => navigate(`/list/${list.id}`)}
            >
              {list.name}
            </div>
          )}
        </For>
      </div>
      <div class="sidebar-footer">
        <div
          class="sidebar-item"
          onClick={() => navigate("/")}
        >
          + New List
        </div>
      </div>
    </nav>
  );
};

export default Sidebar;
