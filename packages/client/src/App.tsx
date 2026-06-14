import { type Component, createSignal } from "solid-js";
import { Router, Route } from "@solidjs/router";
import Sidebar from "./components/Sidebar.js";
import Dashboard from "./pages/Dashboard.js";
import ListView from "./pages/ListView.js";
import TestRunner from "./pages/TestRunner.js";

const Layout: Component<{ children?: any }> = (props) => {
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const close = () => setSidebarOpen(false);

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
