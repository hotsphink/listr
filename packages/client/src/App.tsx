import { type Component, createEffect, onMount, Show, onCleanup } from "solid-js";
import { HashRouter, Route, useNavigate, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import Sidebar from "./components/Sidebar.js";
import ListView from "./pages/ListView.js";
import AdminPage from "./pages/AdminPage.js";
import TestRunner from "./pages/TestRunner.js";
import ReceivePage from "./pages/ReceivePage.js";
import { db } from "./db/database.js";
import { healLegacyItems } from "./db/operations.js";
import { syncClient } from "./sync/SyncClient.js";
import { initAssetStore } from "./sync/assetStore.js";
import { selectionMode } from "./store/selectionMode.js";
import { sidebarOpen, setSidebarOpen } from "./store/sidebarStore.js";

const Layout: Component<{ children?: any }> = (props) => {
  const location = useLocation();
  const close = () => setSidebarOpen(false);

  onMount(async () => {
    await initAssetStore();
    // Convert any legacy (pre-after_id) item rows this client is holding — e.g.
    // pulled from a not-yet-migrated server — so they display and sync correctly.
    healLegacyItems().catch(console.error);
  });

  createEffect(() => {
    const configSub = liveQuery(() => db.sync_config.get("default")).subscribe((config) => {
      if (config?.sync_key) syncClient.setCredentials(config.sync_key, config.client_id);
    });
    const epSub = liveQuery(() => db.sync_endpoints.orderBy("position").toArray()).subscribe((eps) => {
      syncClient.setEndpoints(
        eps.map((ep) => ({
          id: ep.id,
          host: ep.host,
          port: ep.port,
          enabled: ep.enabled,
          secure: ep.secure,
          lastServerId: ep.last_server_id,
        })),
      );
    });
    // Keep entity-routing caches current so sync_key can be derived for pushes/deletes
    const boardSub = liveQuery(() => db.boards.toArray()).subscribe((boards) => {
      syncClient.updateBoardKeys(boards);
    });
    const listSub = liveQuery(() => db.lists.toArray()).subscribe((lists) => {
      syncClient.updateListBoards(lists);
    });
    const sharedKeysSub = liveQuery(() => db.shared_keys.toArray()).subscribe((rows) => {
      syncClient.updateSharedKeys(rows.map((r) => r.key));
    });
    onCleanup(() => {
      configSub.unsubscribe();
      epSub.unsubscribe();
      boardSub.unsubscribe();
      listSub.unsubscribe();
      sharedKeysSub.unsubscribe();
    });
  });

  return (
    <div class="app">
      <div
        class="sidebar-backdrop"
        classList={{ open: sidebarOpen() }}
        onClick={close}
      />
      <Sidebar open={sidebarOpen()} onClose={close} />
      <div class="app-body">
        <Show when={!selectionMode() && location.pathname !== "/admin"}>
          <button class="mobile-menu-btn" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            ☰
          </button>
        </Show>
        {props.children}
      </div>
    </div>
  );
};

const Home: Component = () => {
  const navigate = useNavigate();
  const boards = from(liveQuery(() => db.boards.orderBy("position").toArray()));

  createEffect(() => {
    const allBoards = boards();
    if (allBoards && allBoards.length > 0) navigate(`/board/${allBoards[0].id}`, { replace: true });
  });

  return (
    <Show when={(boards() ?? []).length === 0}>
      <div class="main">
        <div class="empty-state">
          <p>Create a board in the sidebar to get started.</p>
        </div>
      </div>
    </Show>
  );
};

const App: Component = () => (
  <HashRouter root={Layout}>
    <Route path="/" component={Home} />
    <Route path="/board/:id" component={ListView} />
    <Route path="/admin" component={AdminPage} />
    <Route path="/receive/:token" component={ReceivePage} />
    <Route path="/test" component={TestRunner} />
  </HashRouter>
);

export default App;
