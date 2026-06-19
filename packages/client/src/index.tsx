import { render } from "solid-js/web";
import App from "./App.js";
import "./styles.css";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js");
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

render(() => <App />, root);
