/**
 * A throwaway sync server for the e2e tests that need one.
 *
 * Most specs here are client-only (see helpers.ts), because the app is
 * offline-first and almost everything can be tested with no server at all. The
 * join flow is the exception: peek_grant, redeem_grant and the resulting `ok`
 * are all real WebSocket round trips, so the only way to cover the path a
 * texted guest link actually takes is to run a server.
 *
 * Everything is disposable and lives in a temp directory: its own SQLite
 * database, its own config file, its own port, and its own root user. Nothing
 * touches the developer's dev or prod database, and the whole directory goes
 * away in stop(). Grants are issued through auth-cli.ts rather than by writing
 * grant rows here, so the test exercises the same code path the operator does.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(E2E_DIR, "../../server");
const TSX = join(SERVER_DIR, "node_modules/.bin/tsx");
const AUTH_CLI = join(SERVER_DIR, "scripts/auth-cli.ts");
const SERVER_ENTRY = join(SERVER_DIR, "src/index.ts");

/** Where the *app* is served. The join link carries no route, so this only has
 * to be a page that loads the client; the recipient resolves the sync server
 * themselves. Matches playwright.config.ts's baseURL. */
const APP_URL = "https://localhost:3000/";

export interface GrantOptions {
  kind: "invite" | "device" | "share" | "guest";
  /** share and guest only: the sync key handed over on redemption. */
  payload?: string;
  greeting?: string;
  /** invite only: the caps the new user gets. A sharer needs `invite` to be
   * able to issue guest grants of their own. */
  caps?: string[];
}

export interface TestSyncServer {
  port: number;
  rootUserId: string;
  /** This server's identity, which a join link names as a 6-char hash. A test
   * can seed it into `sync_endpoints.last_server_id` to stand for a client
   * that has spoken to this server before. */
  serverId: string;
  /** Issue a grant and return its join link as a path, ready for page.goto. */
  issueGrant(options: GrantOptions): string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`test sync server did not come up on port ${port}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function startTestSyncServer(): Promise<TestSyncServer> {
  const dir = mkdtempSync(join(tmpdir(), "listr-e2e-sync-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir);
  const dbPath = join(dataDir, "listr.db");
  const configPath = join(dir, "dev.yaml");
  const port = await freePort();
  // tls: false keeps the certs out of it. The page is https, but a ws:// URL
  // to loopback is not treated as mixed content, which is the same rule
  // JoinPage's manual-host form applies when it derives `secure`.
  writeFileSync(configPath, `tls: false\nport: ${port}\ndb_path: ${dataDir}\n`);

  const env = { ...process.env, LISTR_VARIANT: "dev", LISTR_CONFIG_PATH: configPath };

  // The server comes up first, because it is what creates the database and
  // runs the migrations; auth-cli refuses to operate on a file that is not
  // there. SQLite handles the CLI writing to it afterwards while the server
  // holds it open.
  let child: ChildProcess | null = spawn(TSX, [SERVER_ENTRY], { env, stdio: ["ignore", "pipe", "pipe"] });
  const output: string[] = [];
  child.stdout?.on("data", (c: Buffer) => output.push(c.toString()));
  child.stderr?.on("data", (c: Buffer) => output.push(c.toString()));
  const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));

  try {
    await waitForServer(port, 30_000);
  } catch (err) {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`${(err as Error).message}\nserver output:\n${output.join("")}`);
  }

  const bootstrap = execFileSync(TSX, [AUTH_CLI, "bootstrap-root", `--db=${dbPath}`, "--apply"], {
    env,
    encoding: "utf8",
  });
  const rootUserId = bootstrap.match(/created root user ([0-9a-f-]{36})/)?.[1];
  if (!rootUserId) throw new Error(`could not find the root user id in:\n${bootstrap}`);

  // No CLI subcommand prints the server_id, and it is only needed by tests, so
  // read it straight out of the database rather than growing the CLI a command
  // that exists for the harness.
  const serverId = execFileSync(
    TSX,
    [
      "-e",
      `import { openDb } from ${JSON.stringify(join(SERVER_DIR, "src/db.ts"))};` +
        `process.stdout.write(openDb(${JSON.stringify(dbPath)}).getServerId());`,
    ],
    { env, encoding: "utf8" },
  ).trim();

  return {
    port,
    rootUserId,
    serverId,

    issueGrant(options: GrantOptions): string {
      const args = [
        AUTH_CLI,
        "issue-grant",
        `--issuer=${rootUserId}`,
        `--kind=${options.kind}`,
        `--app-url=${APP_URL}`,
        `--db=${dbPath}`,
        "--apply",
      ];
      if (options.payload) args.push(`--payload=${options.payload}`);
      if (options.greeting) args.push(`--greeting=${options.greeting}`);
      if (options.caps?.length) args.push(`--caps=${options.caps.join(",")}`);
      const out = execFileSync(TSX, args, { env, encoding: "utf8" });
      const link = out.match(/(#\/join\/\S+)/)?.[1];
      if (!link) throw new Error(`could not find a join link in:\n${out}`);
      return `/${link}`;
    },

    async stop(): Promise<void> {
      if (child) {
        child.kill("SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
        child.kill("SIGKILL");
        child = null;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
