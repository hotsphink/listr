import { type Component, createSignal, onMount } from "solid-js";
import { Router, Route } from "@solidjs/router";
import Sidebar from "./components/Sidebar.js";
import Dashboard from "./pages/Dashboard.js";
import ListView from "./pages/ListView.js";
import TestRunner from "./pages/TestRunner.js";
import { db } from "./db/database.js";
import { syncClient } from "./sync/SyncClient.js";
import { initAssetStore } from "./sync/assetStore.js";

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
        <button class="mobile-menu-btn" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
          ☰
        </button>
        {props.children}
      </div>
    </div>
  );
};

const App: Component = () => (
  <Router root={Layout}>
    <Route path="/" component={Dashboard} />
    <Route path="/list/:id" component={ListView} />
    <Route path="/test" component={TestRunner} />
  </Router>
);

export default App;
