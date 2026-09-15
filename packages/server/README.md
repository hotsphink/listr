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
| `tls` | HTTPS is the default. It reads `certs/tailscale.key` and `certs/tailscale.crt` from the repo root, so a fresh checkout with no certs needs `tls: false`. |
| `db_path` | Directory holding `listr.db`. Defaults to `data/` under the working directory. |
| `gemini`, `gemini_model` | API key and model for screenshot import. With no key, `/api/import` answers 503 and everything else works fine. |
| `allow_bootstrap` | Let the first client to connect claim an empty server as root. See below. `LISTR_ALLOW_BOOTSTRAP` overrides it. |
| `integrations` | Per-integration settings, keyed by integration id. |

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
