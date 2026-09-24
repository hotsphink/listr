# Listr sync server

The sync server is optional. The client is a complete offline app without it.
This is what lets several devices see the same lists, and what runs the
screenshot import.

This file is about running one. For how sync works on the wire, see
[ARCHITECTURE.md](../../ARCHITECTURE.md).

## Running it

    cd packages/server
    pnpm dev      # dev variant, restarts on edit
    pnpm start    # prod variant

From the repo root those are `pnpm server:dev` and `pnpm server:prod`.

Then you'll have to figure out how to make that available from whatever network
your devices are on, possibly the public internet. There are access controls
now (see below), so that is less alarming than it used to be, but it is still
your server and your firewall.

Feel free to implement whatever additional list-munging magic you'd like on
your very own sync server. Your server could be awesome. It could maintain a
list of the expected weather for the next 10 days. It could maintain a master
list of the lists of everyone else on the same server (but don't make it
creepy). It could do superintelligent CRDT-based synchronization and merging of
a globally distributed network of lists of, I don't know, anime episodes or
something. You figure it out, it's your server. Though the basic sync server
here should be fine; if you're doing all of that fancy stuff, why are you even
using my crappy software?

## Configuration

A small YAML file at `~/.config/listr/<variant>.yaml`. The variant is `prod`
unless `LISTR_VARIANT` says otherwise, and `pnpm dev` sets it to `dev`, so a
dev and a prod server on one machine read different files and keep separate
databases. `LISTR_CONFIG_PATH` overrides the path entirely. Every key is
optional, and a missing file just means defaults.

| Key | Meaning |
| --- | --- |
| `port` | Defaults to 10000. |
| `tls` | HTTPS is the default. It reads `certs/tailscale.key` and `certs/tailscale.crt` from the repo root, so a fresh checkout with no certs needs `tls: false`. The cert is checked at startup and every 12 hours; run `pnpm certs:refresh` and restart when it warns. |
| `db_path` | Directory holding `listr.db`. Defaults to `data/` under the working directory. |
| `services.model_families` | What a group of models shares, one entry per family. `name` identifies it, `models` lists the models it covers, and `api_key` plus a `url` template are the usual shared contents, though any key may go here. |
| `services.vision.tiers` | Which models answer a screenshot import, as a list of tiers. Tiers are tried in order, and the models within one tier all run at once. With none configured, `/api/import` answers 503 and everything else works fine. |
| `allow_bootstrap` | Let the first client to connect claim an empty server as root. See below. `LISTR_ALLOW_BOOTSTRAP` overrides it. |
| `allowed_origins` | List of web origins whose pages may connect, such as `https://listr.aapx.org`. Clients that send no Origin header, which means non-browser clients, are always allowed. Missing means only the local dev client, `http(s)://localhost:3000`. |
| (environment only) | `LISTR_EXTRA_ORIGINS` adds comma-separated origins to `allowed_origins`. The e2e harness uses it for its own app port. |
| `services.<id>` | Settings for the integration with that id, such as `services.omdb.api_key`. Any key other than `model_families` and `vision` names an integration, and only integrations named here are offered to clients. `max_concurrent` (default 4) caps runs at once, `timeout_ms` (default 10000) caps each external call, and `daily_limit` and `daily_limit_per_key` cap external calls per UTC day overall and per sync key. OMDb defaults those limits to 1000 and 500. How often results refresh is set per board, in the integration's own config. |
| `integrations` | Older spelling of the same per-integration settings, keyed by integration id. `services` wins where both name one id. |
| `console` | The operator console, off unless `console.password_hash` is set. See [Operator console](#operator-console). |

A model inherits its family's keys and may override any of them. A `url` is a
template whose every `{placeholder}` names a field of the resolved model, so
the merged family and model keys are what it draws on:

```yaml
services:
  model_families:
  - name: gemini
    api_key: "..."
    url: "https://generativelanguage.googleapis.com/{version}/models/{model}:generateContent?key={api_key}"
    version: v1beta
    models:
      - "gemini-3.5-flash": {}
      - "gemini-2.5-flash":
          version: v1          # overrides the family
  vision:
    tiers:
    - ["gemini-3.5-flash"]                        # asked first, on its own
    - ["gemini-2.5-flash", "gemini-3.8-flash"]    # both at once if that failed
```

A tier's models race, the first usable answer wins, and the losers are
cancelled so a straggler neither delays the import nor spends quota on an
answer already in hand. Only when every model in a tier fails does the next
tier run, and the error reported to the client names each model that failed.

A `models` list entry names one model and carries its overrides underneath, so
`- "name": {}`, a bare `- "name"`, and a plain `name:` mapping of models all
work. An entry with a second top-level key is rejected, which is what an
override written at the model's own indent rather than under it looks like.
Entries that cannot be called, such as a tier naming a model no family
declares, are logged and skipped rather than failing the whole config. Fields whose name
looks like a credential are redacted from logs and from the error text
`/api/import` returns.

The variant is also announced to clients during the handshake, and a client
built for one variant refuses to sync with a server running another, so a
stray dev client cannot scribble on prod.

`systemd/listr-sync.service` is the unit I run it under, and `pnpm configure`
from the repo root installs and restarts it. Adjust the paths in it for your
own machine.

## Users and access control

### How it works

A **user** is a person. They have a set of capabilities, a state (`active`,
`suspended`, or `revoked`), and a home key: a private sync namespace the server
generates for them and nobody else can see.

A **client** is one browser profile on one device. The first time you enable
sync, the client generates an ECDSA keypair that never leaves the browser, and
its client ID is a fingerprint (an RFC 7638 thumbprint) of the public key. To
connect, a client signs a nonce the server hands it. There are no passwords, so
there is nothing on the server worth stealing and nothing for you to forget.
One person's phone and laptop are two clients of the same user.

Every user except the root was authorized by somebody, so users form a tree.
Suspending or revoking a user cuts off their whole subtree in one stroke, and
restoring them puts everyone back the way they were.

The capabilities are:

| Cap | Grants |
| --- | --- |
| `sync` | Push and pull lists. Everybody gets this. |
| `invite` | Create accounts for other people. |
| `moderate` | Reserved. Nothing enforces it yet. |
| `admin` | Reserved. Nothing enforces it yet, and it is only grantable from the CLI. |

### Getting the first user in

A brand-new server has no users at all, and that is a hole you cannot climb out
of from the app: registering needs a join link, issuing a join link needs a
user, and there isn't one. So do it from the box the server runs on, with the
server stopped:

    cd packages/server
    pnpm auth bootstrap-root --apply
    pnpm auth issue-grant --issuer=<the root user id it just printed> --kind=device --apply

The second command prints a single-use join link. Open it on your first device
and that device is now registered to the root user.

Alternatively, start the server once with `LISTR_ALLOW_BOOTSTRAP=1` (or
`allow_bootstrap: true` in the variant's config file) and the first client to
connect claims the server as root, no CLI involved. It disarms itself the
moment a user exists. Do not leave it switched on for a server the public can
reach, because it hands root to whoever gets there first.

A server that starts up with no users says so in its log, and tells you which
of these two to do. It is not subtle about it, because every client will sit
there saying "Not registered" until you deal with it.

### Join links

Everything after that first user happens in the app. Sync button, then
**+ Create join link**. Four kinds:

| Kind | What it does |
| --- | --- |
| Add device | Registers another browser or phone to your own account. |
| Invite user | Creates a real account for someone, as your child in the tree. There's a checkbox to let them invite people too. |
| New guest | Like an invite, but they can't invite anyone else. Good for texting somebody a shopping list. |
| Share board | Hands one more sync key to someone who already has an account here. No new identity involved. |

A link works exactly once and expires in 24 hours. Ten wrong guesses burn it.
The recipient pastes the link or scans the QR code, and their client checks
that the link names the same server it is talking to before it does anything
with it, so a link for one server cannot be redeemed against another.

### The admin CLI

`pnpm auth <command>` from `packages/server`, which runs `scripts/auth-cli.ts`.
Everything is a dry run until you pass `--apply`, and `--db=` defaults to
`~/.local/share/listr/listr.db`. Stop the sync server first: SQLite has one
writer.

| Command | What it does |
| --- | --- |
| `bootstrap-root` | Create the root user. Idempotent, so re-running is safe. |
| `list-users [--tree]` | Every user, optionally indented by who authorized whom, annotated with any state inherited from an ancestor. |
| `issue-grant --issuer= --kind=` | The CLI version of a join link. Prints the secret once and never again. |
| `list-keys` | Every sync key holding data, with row counts and who can reach it. |
| `add-key --user= --key= [--name=]` | Hand an existing sync key to a user. |
| `remove-key --user= --key=` | Take it back. The data is untouched. |
| `set-state --user= --state=` | Suspend, revoke, or restore, along with everyone below them. |
| `promote --user= [--caps=]` | Turn a guest into a real account, keeping their ID and their data. |
| `grant-admin --user=` | The only way to hand out `admin`. No grant can do it. |
| `set-parent --user= --parent=` | Re-parent somebody in the tree. Refuses to make a cycle. |
| `reset-server-id [--new=]` | Assign a fresh server identity, which a cloned database needs. |

### When a client says "Not registered"

The server does not know that client's keypair. Either it never joined, or it
joined a different server, or the server's identity tables were rebuilt out
from under it. Issue a `device` grant from a user that still works, or from the
CLI, and redeem it.

If the client registers fine but comes up **empty**, that's a different
problem: it is registered but has been handed no keys, so there is nothing for
it to ask for. A client only ever pulls keys it already knows about. Check what
the server is holding:

    pnpm auth list-keys

Anything marked UNCLAIMED is data no client will ever see, because no user can
reach it. Attach it to somebody:

    pnpm auth add-key --user=<user id> --key=<sync key> --name="Something readable" --apply

Their clients pick it up on the next connect and pull it down.

## Operator console

The server can serve a small web console for whoever runs it, at
`/console/` on its own port. It shows the trust graph (who invited whom, their
devices, outstanding join links, and who can reach which sync key), live
integration status with each outbound request and response, the listener and
its certificate, and every registered or connected client. It is read-only:
changes still go through `pnpm auth`.

It is off until you give it a password:

    cd packages/server
    pnpm auth console-password        # prompts, prints a config snippet
    pnpm console:build                # builds console/dist, once per update

Paste the printed lines into the variant's config file and restart:

```yaml
console:
  password_hash: "scrypt$N=16384,r=8,p=1$..."
  session_idle_hours: 12        # optional, the default
  capture_bodies: true          # optional; false keeps request metadata only
  external_urls:                # optional; public URLs that forward here
    - https://listr-sync.aapx.org/
```

Without a `password_hash`, everything under `/console` answers 404. Sessions
live in memory, so a restart signs you out. Five wrong passwords in a row lock
login for 30 seconds at a time, counted server-wide rather than per address,
because behind Funnel or a proxy every request comes from the proxy.

Everything live (connections, integration runs and their captured bodies,
counters) is kept in memory with fixed caps, and resets on restart. Credentials
from the integration's config are redacted before anything is stored. Sync keys
never reach the browser, only their first six characters.

For working on the console itself, `pnpm console:dev` serves it on :3200 with
hot reload and proxies the API to the dev sync server on :10443
(`LISTR_CONSOLE_API` overrides).
