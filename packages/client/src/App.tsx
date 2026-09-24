import { type Component, createEffect, onMount, Show, onCleanup } from "solid-js";
import { HashRouter, Route, useNavigate, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import Sidebar from "./components/Sidebar.js";
import ExportModal from "./components/ExportModal.js";
import ListView from "./pages/ListView.js";
import AdminPage from "./pages/AdminPage.js";
import TestRunner from "./pages/TestRunner.js";
import JoinPage from "./pages/JoinPage.js";
import { db } from "./db/database.js";
import { healLegacyItems } from "./db/operations.js";
import { syncClient } from "./sync/SyncClient.js";
import { initAssetStore } from "./sync/assetStore.js";
import { selectionMode } from "./store/selectionMode.js";
import { sidebarOpen, setSidebarOpen } from "./store/sidebarStore.js";
import { isDragging } from "./hooks/useSortable.js";

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
    // SyncClient manages its own client_identity keypair lazily and learns its
    // home key per server from the `ok` message (see clientKeys.ts,
    // database.ts's ClientIdentity/ServerIdentity).
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
      syncClient.updateSharedKeys(rows.map((r) => ({ key: r.key, server_id: r.server_id ?? null })));
    });
    // Local, never-synced board-to-server binding. Keeps SyncClient's copy
    // current so keysForEndpoint and doInitialSync can scope boards to the one
    // server each belongs to.
    const bindingSub = liveQuery(() => db.board_server_binding.toArray()).subscribe((rows) => {
      syncClient.updateBoardBindings(rows);
    });
    // Per-server registration state. This is where a server-assigned home key
    // becomes visible to SyncClient's key resolution.
    const identitySub = liveQuery(() => db.server_identity.toArray()).subscribe((rows) => {
      syncClient.updateServerIdentities(rows);
    });
    onCleanup(() => {
      epSub.unsubscribe();
      boardSub.unsubscribe();
      listSub.unsubscribe();
      sharedKeysSub.unsubscribe();
      bindingSub.unsubscribe();
      identitySub.unsubscribe();
    });
  });

  return (
    <div class="app">
      {/* A button, not an anchor: the app routes on the URL hash, so a
          fragment link would navigate instead of moving focus. */}
      <button
        type="button"
        class="skip-link"
        onClick={() => document.getElementById("main-content")?.focus()}
      >
        Skip to content
      </button>
      <div
        class="overlay sidebar-backdrop"
        classList={{ open: sidebarOpen() }}
        onClick={close}
        aria-hidden="true"
      />
      <Sidebar open={sidebarOpen()} onClose={close} />
      <main class="app-body" id="main-content" tabindex={-1}>
        <Show when={!selectionMode() && location.pathname !== "/admin"}>
          <button
            class="btn-icon btn-icon-lg mobile-menu-btn"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            aria-expanded={sidebarOpen()}
            aria-controls="sidebar"
          >
            <span aria-hidden="true">☰</span>
          </button>
        </Show>
        {props.children}
      </main>
      <ExportModal />
      <div id="drag-cancel-zone" class="drag-cancel-zone" classList={{ active: isDragging() }} aria-hidden="true">
        ✕ Cancel
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
    <Route path="/join/:hash/:credentials" component={JoinPage} />
    <Route path="/test" component={TestRunner} />
  </HashRouter>
);

export default App;
