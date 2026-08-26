/**
 * Maintenance CLI for the identity/authorization tables (auth-design.md
 * §5.5, §15 Phase 1). One entry point, several subcommands — unlike the
 * other scripts in this directory, which are each a single one-off
 * operation, this one needs a handful of related, ongoing admin actions
 * (bootstrap, grant issuance, moderation), so a subcommand dispatch is a
 * better fit than one file per action.
 *
 * Same dry-run/--apply/auto-backup convention as every other script here
 * (see scripts/cli.ts) — --apply is required for anything that writes, and
 * a timestamped backup is taken first. Run with the sync server STOPPED.
 *
 * Usage:
 *   pnpm exec tsx packages/server/scripts/auth-cli.ts <command> [options] [--apply] [--db=/path]
 *
 * Commands:
 *   bootstrap-root
 *       Create the root user (all caps including admin, authorized_by=null)
 *       if one does not already exist. Idempotent — safe to re-run.
 *
 *   list-users [--tree]
 *       List every user. With --tree, indent by authorized_by and annotate
 *       each with its effective state when that differs from its explicit
 *       one (i.e. it inherited suspension/revocation from an ancestor).
 *
 *   issue-grant --issuer=<user_id> --kind=<invite|device|share|guest>
 *               [--caps=cap1,cap2] [--payload=<sync_key>] [--greeting=text]
 *               [--ttl-ms=<n>] [--uses=<n>]
 *       Create a grant and print the redemption secret ONCE — the server
 *       never stores it in recoverable form (only its SHA-256), so this is
 *       the only chance to see it. --caps applies to `invite` only (subject
 *       to the attenuation check against the issuer's own caps); `guest`
 *       always gets caps=[sync] regardless of --caps; `payload` is the
 *       sync_key to hand over for `share`/`guest`.
 *
 *   set-state --user=<user_id> --state=<active|suspended|revoked>
 *       One UPDATE on one row (§5.3). Suspending/revoking cuts off the
 *       user's whole subtree in the same statement (effective state is
 *       computed at read time); restoring reverts descendants to their own
 *       explicit state automatically.
 *
 *   promote --user=<user_id> [--caps=cap1,cap2]
 *       Clear a guest's `provisional` flag and optionally add caps (§7.4).
 *       Nothing is re-created; the user keeps their user_id and home_key.
 *
 *   grant-admin --user=<user_id>
 *       Break-glass: add the admin cap directly. The only way `admin` is
 *       ever granted — never reachable through the grants table.
 *
 *   set-parent --user=<user_id> --parent=<user_id|none>
 *       Re-parent a user (set authorized_by). Needed because migration 5
 *       mints one unparented user per pre-existing home key when rekeying
 *       user_keys to user_id — §5.1 allows a forest of several unparented
 *       tips, but the operator will usually want to graft those onto the
 *       real tree by hand. `--parent=none` explicitly detaches (a second
 *       forest root); refused if it would create a cycle (the named parent
 *       is currently a descendant of --user).
 *
 *   reset-server-id [--new=<uuid>]
 *       Overwrite server_config's server_id. Cloning a DB today requires a
 *       hand edit here (auth-design.md §3.3); this makes it a supported
 *       operation instead.
 */
import { parseScriptArgs } from "./cli.js";
import { openDb, ALL_CAPS, type Cap, type GrantKind, type UserState } from "../src/db.js";

function parseNamedArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) continue; // bare flags (--apply) are handled by parseScriptArgs
    out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function parseCaps(raw: string | undefined): Cap[] {
  if (!raw) return [];
  const caps = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const cap of caps) {
    if (!(ALL_CAPS as readonly string[]).includes(cap)) {
      throw new Error(`Unknown cap '${cap}'. Valid caps: ${ALL_CAPS.join(", ")}`);
    }
  }
  return caps as Cap[];
}

function requireArg(named: Record<string, string>, key: string): string {
  const v = named[key];
  if (!v) throw new Error(`Missing required --${key}=...`);
  return v;
}

function main(): void {
  const command = process.argv[2];
  if (!command || command.startsWith("--")) {
    console.error("Usage: auth-cli.ts <command> [options] [--apply] [--db=/path]");
    console.error("Commands: bootstrap-root, list-users, issue-grant, set-state, promote, grant-admin, set-parent, reset-server-id");
    process.exit(1);
  }

  const { dbPath, apply } = parseScriptArgs(`auth-cli ${command}`);
  const named = parseNamedArgs(process.argv.slice(3));
  const db = openDb(dbPath);
  const now = Date.now();

  try {
    runCommand(db, command, named, apply, now);
  } catch (err) {
    console.error(`[auth-cli] ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

function runCommand(
  db: ReturnType<typeof openDb>,
  command: string,
  named: Record<string, string>,
  apply: boolean,
  now: number,
): void {
  switch (command) {
      case "bootstrap-root": {
        const existing = db.findRootUser();
        if (existing) {
          console.log(`[auth-cli] root user already exists: ${existing.user_id} (caps: ${existing.caps.join(", ")})`);
          break;
        }
        if (!apply) {
          console.log(`[auth-cli] dry-run: would create root user with all caps (${ALL_CAPS.join(", ")})`);
          break;
        }
        const root = db.bootstrapRootUser(now);
        console.log(`[auth-cli] created root user ${root.user_id} (caps: ${root.caps.join(", ")}, home_key: ${root.home_key})`);
        break;
      }

      case "list-users": {
        const users = db.listAllUsers();
        if (users.length === 0) {
          console.log("[auth-cli] no users yet — run bootstrap-root first");
          break;
        }
        if (named.tree !== undefined || process.argv.includes("--tree")) {
          const children = new Map<string | null, typeof users>();
          for (const u of users) {
            const key = u.authorized_by;
            if (!children.has(key)) children.set(key, []);
            children.get(key)!.push(u);
          }
          const printTree = (parentId: string | null, depth: number) => {
            for (const u of children.get(parentId) ?? []) {
              const effective = db.getEffectiveState(u.user_id);
              const stateLabel = effective !== u.state ? `${u.state} (effective: ${effective})` : u.state;
              const flags = [u.provisional ? "provisional" : null, u.note ? `note: "${u.note}"` : null].filter(Boolean).join(", ");
              console.log(
                `${"  ".repeat(depth)}${u.user_id}  [${stateLabel}]  caps=${u.caps.join("+") || "(none)"}${flags ? `  (${flags})` : ""}`,
              );
              printTree(u.user_id, depth + 1);
            }
          };
          printTree(null, 0);
        } else {
          for (const u of users) {
            console.log(
              `${u.user_id}  state=${u.state}  caps=${u.caps.join("+") || "(none)"}  authorized_by=${u.authorized_by ?? "(root)"}  provisional=${u.provisional}`,
            );
          }
        }
        break;
      }

      case "issue-grant": {
        const issuerUserId = requireArg(named, "issuer");
        const kind = requireArg(named, "kind") as GrantKind;
        if (!["invite", "device", "share", "guest"].includes(kind)) {
          throw new Error(`Invalid --kind=${kind}. Must be invite|device|share|guest`);
        }
        const caps = parseCaps(named.caps);
        const ttlMs = named["ttl-ms"] ? Number(named["ttl-ms"]) : undefined;
        const uses = named.uses ? Number(named.uses) : undefined;

        if (!apply) {
          console.log(
            `[auth-cli] dry-run: would issue a '${kind}' grant from ${issuerUserId}` +
              (caps.length ? ` with caps=${caps.join(",")}` : "") +
              (named.payload ? ` carrying a sync_key payload` : ""),
          );
          break;
        }
        const { grantId, secret } = db.createGrant(
          {
            kind,
            issuerUserId,
            caps: kind === "invite" ? caps : undefined,
            payload: named.payload,
            greeting: named.greeting,
            expiresAt: ttlMs !== undefined ? now + ttlMs : undefined,
            usesRemaining: uses,
          },
          now,
        );
        console.log(`[auth-cli] grant issued: id=${grantId}`);
        console.log(`[auth-cli] secret (shown once, not recoverable — hand this to the recipient): ${secret}`);
        break;
      }

      case "set-state": {
        const userId = requireArg(named, "user");
        const state = requireArg(named, "state") as UserState;
        if (!["active", "suspended", "revoked"].includes(state)) {
          throw new Error(`Invalid --state=${state}. Must be active|suspended|revoked`);
        }
        const user = db.getUser(userId);
        if (!user) throw new Error(`No such user: ${userId}`);
        if (!apply) {
          console.log(`[auth-cli] dry-run: would set ${userId}'s explicit state ${user.state} -> ${state}`);
          break;
        }
        db.setUserState(userId, state, now, "cli");
        console.log(`[auth-cli] ${userId} explicit state set to ${state}`);
        break;
      }

      case "promote": {
        const userId = requireArg(named, "user");
        const extraCaps = parseCaps(named.caps);
        const user = db.getUser(userId);
        if (!user) throw new Error(`No such user: ${userId}`);
        if (!user.provisional && extraCaps.length === 0) {
          console.log(`[auth-cli] ${userId} is already non-provisional and no --caps given; nothing to do`);
          break;
        }
        if (!apply) {
          console.log(`[auth-cli] dry-run: would promote ${userId} (clear provisional, add caps: ${extraCaps.join(",") || "(none)"})`);
          break;
        }
        const promoted = db.promoteProvisionalUser(userId, extraCaps, now, "cli");
        console.log(`[auth-cli] ${userId} promoted; caps now: ${promoted.caps.join(", ")}`);
        break;
      }

      case "grant-admin": {
        const userId = requireArg(named, "user");
        const user = db.getUser(userId);
        if (!user) throw new Error(`No such user: ${userId}`);
        if (!apply) {
          console.log(`[auth-cli] dry-run: would grant 'admin' to ${userId} (break-glass)`);
          break;
        }
        const updated = db.grantAdminCap(userId, now, "cli-break-glass");
        console.log(`[auth-cli] ${userId} caps now: ${updated.caps.join(", ")}`);
        break;
      }

      case "set-parent": {
        const userId = requireArg(named, "user");
        const parentArg = requireArg(named, "parent");
        const newParentId = parentArg === "none" ? null : parentArg;
        const user = db.getUser(userId);
        if (!user) throw new Error(`No such user: ${userId}`);
        if (newParentId && !db.getUser(newParentId)) throw new Error(`No such parent user: ${newParentId}`);
        if (!apply) {
          console.log(`[auth-cli] dry-run: would set ${userId}'s authorized_by ${user.authorized_by ?? "(none)"} -> ${newParentId ?? "(none)"}`);
          break;
        }
        const updated = db.setAuthorizedBy(userId, newParentId, now, "cli");
        console.log(`[auth-cli] ${userId} authorized_by now: ${updated.authorized_by ?? "(none)"}`);
        break;
      }

      case "reset-server-id": {
        if (!apply) {
          console.log(`[auth-cli] dry-run: would reset server_id${named.new ? ` to ${named.new}` : " (random)"}`);
          break;
        }
        const id = db.resetServerId(named.new);
        console.log(`[auth-cli] server_id reset to ${id}`);
        console.log(`[auth-cli] NOTE: existing clients will treat this as a different server (trust-on-first-use conflict) until reconfigured.`);
        break;
      }

      default:
        console.error(`[auth-cli] unknown command: ${command}`);
        process.exit(1);
    }
  }

main();
