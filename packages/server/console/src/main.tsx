import { render } from "solid-js/web";
import { Match, Show, Switch, createEffect, createSignal } from "solid-js";
import { authed, checkSession, closeStream, login, logout, openStream, streamUp } from "./api";
import { route } from "./router";
import { OverviewPage } from "./pages/Overview";
import { TrustPage } from "./pages/Trust";
import { IntegrationsPage } from "./pages/Integrations";
import { RunPage } from "./pages/Run";
import { PortsPage } from "./pages/Ports";
import { ClientsPage } from "./pages/Clients";
import { ClientPage } from "./pages/Client";
import "./styles.css";

function Login() {
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(password());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main class="login">
      <form onSubmit={submit} class="card login-card">
        <h1>Listr Console</h1>
        <p class="muted">Operator access to this sync server.</p>
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" autofocus
          value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
        <Show when={error()}><p class="error-text" role="alert">{error()}</p></Show>
        <button type="submit" class="primary" disabled={busy() || !password()}>{busy() ? "Signing in..." : "Sign in"}</button>
      </form>
    </main>
  );
}

const NAV: [string, string][] = [
  ["", "Overview"],
  ["trust", "Trust graph"],
  ["integrations", "Integrations"],
  ["clients", "Clients"],
  ["ports", "Ports"],
];

function Shell() {
  const section = () => route()[0] ?? "";
  return (
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="#/">Listr Console</a>
        <nav aria-label="Sections">
          {NAV.map(([id, label]) => (
            <a href={`#/${id}`} classList={{ active: section() === id }} aria-current={section() === id ? "page" : undefined}>{label}</a>
          ))}
        </nav>
        <div class="topbar-end">
          <span class={`live-dot ${streamUp() ? "up" : ""}`} title={streamUp() ? "Live updates connected" : "Live updates disconnected"}>
            {streamUp() ? "live" : "offline"}
          </span>
          <button type="button" class="ghost" onClick={() => void logout()}>Sign out</button>
        </div>
      </header>
      <main class="content">
        <Switch fallback={<p class="muted">No such page.</p>}>
          <Match when={section() === ""}><OverviewPage /></Match>
          <Match when={section() === "trust"}><TrustPage userId={route()[1] === "users" ? route()[2] : undefined} /></Match>
          <Match when={section() === "integrations" && route()[1] === "runs" && route()[2]}>
            <Show when={route()[2]} keyed>{(id) => <RunPage id={Number(id)} />}</Show>
          </Match>
          <Match when={section() === "integrations"}><IntegrationsPage /></Match>
          <Match when={section() === "clients" && route()[1]}>
            <Show when={route()[1]} keyed>{(id) => <ClientPage id={id} />}</Show>
          </Match>
          <Match when={section() === "clients"}><ClientsPage /></Match>
          <Match when={section() === "ports"}><PortsPage /></Match>
        </Switch>
      </main>
    </div>
  );
}

function App() {
  void checkSession();
  createEffect(() => {
    if (authed()) openStream();
    else closeStream();
  });
  return (
    <Switch>
      <Match when={authed() === null}><p class="muted boot">Loading...</p></Match>
      <Match when={authed() === false}><Login /></Match>
      <Match when={authed()}><Shell /></Match>
    </Switch>
  );
}

render(() => <App />, document.getElementById("root")!);
