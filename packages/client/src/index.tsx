import { render } from "solid-js/web";
import App from "./App.js";
import "./styles.css";

if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js");
  } else {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) reg.unregister();
    });
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

render(() => <App />, root);
