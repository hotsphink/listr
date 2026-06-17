import { type Component, createSignal, createEffect, onMount, Show } from "solid-js";
import { Router, Route, useNavigate } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import Sidebar from "./components/Sidebar.js";
import CategoryView from "./pages/CategoryView.js";
import TestRunner from "./pages/TestRunner.js";
import { db } from "./db/database.js";
import { syncClient } from "./sync/SyncClient.js";
import { initAssetStore } from "./sync/assetStore.js";
import { selectionMode } from "./store/selectionMode.js";

const Layout: Component<{ children?: any }> = (props) => {
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const close = () => setSidebarOpen(false);

  onMount(async () => {
    await initAssetStore();
    const config = await db.sync_config.get("default");
    if (config?.enabled && config.sync_url && config.sync_key) {
      syncClient.connect(config.sync_url, config.sync_key, config.client_id);
    }
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
        <Show when={!selectionMode()}>
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
  const categories = from(liveQuery(() => db.categories.orderBy("position").toArray()));

  createEffect(() => {
    const cats = categories();
    if (cats && cats.length > 0) navigate(`/category/${cats[0].id}`, { replace: true });
  });

  return (
    <Show when={(categories() ?? []).length === 0}>
      <div class="main">
        <div class="empty-state">
          <p>Create a category in the sidebar to get started.</p>
        </div>
      </div>
    </Show>
  );
};

const App: Component = () => (
  <Router root={Layout}>
    <Route path="/" component={Home} />
    <Route path="/category/:id" component={CategoryView} />
    <Route path="/test" component={TestRunner} />
  </Router>
);

export default App;
