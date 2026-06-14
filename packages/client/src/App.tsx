import { type Component } from "solid-js";
import { Router, Route } from "@solidjs/router";
import Sidebar from "./components/Sidebar.js";
import Dashboard from "./pages/Dashboard.js";
import ListView from "./pages/ListView.js";
import TestRunner from "./pages/TestRunner.js";

const Layout: Component<{ children?: any }> = (props) => (
  <div class="app">
    <Sidebar />
    {props.children}
  </div>
);

const App: Component = () => (
  <Router root={Layout}>
    <Route path="/" component={Dashboard} />
    <Route path="/list/:id" component={ListView} />
    <Route path="/test" component={TestRunner} />
  </Router>
);

export default App;
