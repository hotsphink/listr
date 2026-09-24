import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { addItemToList, addSyncEndpoint, clearDatabase, createListInBoard } from "./helpers.js";
import { startTestSyncServer, type TestSyncServer } from "./syncServer.js";

/**
 * Integrations end to end: a real sync server runs OMDb against a fake OMDb
 * API, and the client shows the overlaid values and resolves an ambiguous
 * match with the picker.
 */

test.describe.configure({ mode: "serial" });

const SEARCH = {
  Response: "True",
  Search: [
    { Title: "The Matrix", Year: "1999", imdbID: "tt0133093", Type: "movie" },
    { Title: "The Matrix Reloaded", Year: "2003", imdbID: "tt0234215", Type: "movie" },
  ],
};
const DETAILS: Record<string, object> = {
  tt0133093: { Response: "True", imdbID: "tt0133093", Title: "The Matrix", Year: "1999", Type: "movie" },
  tt0234215: { Response: "True", imdbID: "tt0234215", Title: "The Matrix Reloaded", Year: "2003", Type: "movie" },
};

let omdb: Server;
let requests: URLSearchParams[] = [];
let server: TestSyncServer;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  omdb = createServer((req, res) => {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    requests.push(q);
    const body = q.has("i") ? DETAILS[q.get("i")!] ?? { Response: "False", Error: "Incorrect IMDb ID." }
      : q.get("s")?.toLowerCase().includes("matrix") ? SEARCH
      : { Response: "False", Error: "Movie not found!" };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => omdb.listen(0, "127.0.0.1", resolve));
  const omdbPort = (omdb.address() as AddressInfo).port;
  server = await startTestSyncServer({
    extraConfig: `services:\n  omdb:\n    api_key: test\n    base_url: "http://127.0.0.1:${omdbPort}/"\n`,
  });
});

test.afterAll(async () => {
  await server?.stop();
  await new Promise((resolve) => omdb?.close(resolve));
});

async function joinServer(page: Page): Promise<void> {
  await clearDatabase(page);
  await addSyncEndpoint(page, { host: "localhost", port: server.port, secure: false, lastServerId: server.serverId });
  await page.goto(server.issueGrant({ kind: "invite", caps: ["sync"] }));
  await expect(page.locator(".receive-card h2")).toHaveText("You're invited", { timeout: 30_000 });
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.locator(".receive-saved")).toContainText("You're in!", { timeout: 30_000 });
  await page.getByRole("button", { name: "Go to app" }).click();
}

test("an ambiguous OMDb match is resolved with the picker, and the official title shows", async ({ page }) => {
  test.setTimeout(120_000);
  await joinServer(page);

  // A board with OMDb enabled and its attributes added to the schema.
  await page.locator(".sidebar-item.sidebar-new.board").click();
  const modal = page.locator(".modal");
  await expect(modal.locator("h2")).toHaveText("New Board");
  await modal.locator(".form-field input").first().fill("Movies");
  await modal.getByRole("button", { name: "+ Add integration" }).click({ timeout: 30_000 });
  const config = modal.getByLabel("OMDb (movies and TV) config, as TOML");
  await expect(config).toHaveValue(/# refresh_days = 30/);

  // Invalid TOML blocks Save, and fixing it unblocks it.
  await config.fill("refresh_days = ");
  await expect(modal.getByRole("alert")).toContainText("TOML error");
  await expect(modal.getByRole("button", { name: "Create" })).toBeDisabled();
  await config.fill("refresh_days = 7\n");
  await modal.getByRole("button", { name: "Add missing settings" }).click();
  await expect(config).toHaveValue(/refresh_days = 7\n\n# Only match.*\n# type = ""/);

  await modal.getByRole("button", { name: "Add OMDb (movies and TV) attributes to schema" }).click();
  await expect(modal.locator(".schema-entry")).toHaveCount(16);
  await modal.getByRole("button", { name: "Create" }).click();
  await modal.waitFor({ state: "hidden" });

  await createListInBoard(page, "Watch", "Movies");
  await addItemToList(page, "matrix");

  // Two search results and no exact title match: ambiguous.
  const pick = page.getByRole("button", { name: "Several integration matches. Choose one." });
  await expect(pick).toBeVisible({ timeout: 30_000 });
  await pick.click();
  await expect(modal.locator("h2")).toHaveText("Choose a match");
  await modal.getByRole("button", { name: "The Matrix Reloaded (2003, movie)" }).click();

  // The pick releases the typed title, so OMDb's official title shows.
  const item = page.locator(".list-view-item:not(.inline-add-item)").first();
  await expect(item).toContainText("The Matrix Reloaded", { timeout: 30_000 });
  await expect(pick).toHaveCount(0);
  expect(requests.some((q) => q.get("i") === "tt0234215")).toBe(true);

  // The editor shows integration values as hints, never as the user's own values.
  await item.dblclick();
  await expect(modal.locator("h2")).toHaveText("Edit Item");
  await expect(modal.locator(".form-field input").first()).toHaveValue("");
  await expect(modal.locator(".form-field input").first()).toHaveAttribute("placeholder", "The Matrix Reloaded");
  await expect(modal.locator(".field-hint", { hasText: "From integration: 2003" })).toBeVisible();
});

test("an auto-chosen match can be replaced from the item's context menu", async ({ page }) => {
  test.setTimeout(120_000);
  await joinServer(page);
  await page.locator(".sidebar-item.sidebar-new.board").click();
  const modal = page.locator(".modal");
  await modal.locator(".form-field input").first().fill("Cinema");
  await modal.getByRole("button", { name: "+ Add integration" }).click({ timeout: 30_000 });
  await modal.getByRole("button", { name: "Add OMDb (movies and TV) attributes to schema" }).click();
  await modal.getByRole("button", { name: "Create" }).click();
  await modal.waitFor({ state: "hidden" });
  await createListInBoard(page, "Seen", "Cinema");

  // One exact title match among two results: OMDb picks it, so no badge shows.
  await addItemToList(page, "The Matrix");
  const item = page.locator(".list-view-item:not(.inline-add-item)").first();
  await expect(item).toContainText("1999", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Several integration matches. Choose one." })).toHaveCount(0);

  await item.click({ button: "right" });
  await page.locator(".context-menu-item", { hasText: "Choose match" }).click();
  await expect(modal.locator("h2")).toHaveText("Choose a match");
  await expect(modal.getByRole("button", { name: "The Matrix (1999, movie) (current)" })).toHaveAttribute("aria-current", "true");
  await modal.getByRole("button", { name: "The Matrix Reloaded (2003, movie)" }).click();

  await expect(item).toContainText("The Matrix Reloaded", { timeout: 30_000 });
  await expect(item).toContainText("2003");
});

test("the context menu offers no match choice without options", async ({ page }) => {
  test.setTimeout(120_000);
  await joinServer(page);
  await page.locator(".sidebar-item.sidebar-new.board").click();
  const modal = page.locator(".modal");
  await modal.locator(".form-field input").first().fill("Plain");
  await modal.getByRole("button", { name: "Create" }).click();
  await modal.waitFor({ state: "hidden" });
  await createListInBoard(page, "Things", "Plain");
  await addItemToList(page, "The Matrix");
  await page.locator(".list-view-item:not(.inline-add-item)").first().click({ button: "right" });
  await expect(page.locator(".context-menu-item", { hasText: "Edit Item" })).toBeVisible();
  await expect(page.locator(".context-menu-item", { hasText: "Choose match" })).toHaveCount(0);
});

test("cloning a board copies its integrations as asked", async ({ page }) => {
  test.setTimeout(120_000);
  await joinServer(page);
  await page.locator(".sidebar-item.sidebar-new.board").click();
  const modal = page.locator(".modal");
  await modal.locator(".form-field input").first().fill("Originals");
  await modal.getByRole("button", { name: "+ Add integration" }).click({ timeout: 30_000 });
  await modal.getByRole("button", { name: "Create" }).click();
  await modal.waitFor({ state: "hidden" });

  const cloneAs = async (name: string, choice: string) => {
    await page.locator(".sidebar-board", { hasText: "Originals" }).first().click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Clone" }).click();
    await modal.getByLabel("Name", { exact: true }).fill(name);
    await modal.getByRole("group", { name: "Integrations" }).getByLabel(choice).check();
    await modal.getByRole("button", { name: "Clone", exact: true }).click();
    await expect(page.locator(".page-header h1")).toHaveText(name);
    await page.getByRole("button", { name: `Actions for board ${name}` }).click();
    await page.locator(".context-menu-item", { hasText: "Edit" }).first().click();
    await expect(modal.locator("h2")).toHaveText("Edit Board");
  };
  const config = modal.getByLabel("OMDb (movies and TV) config, as TOML");

  await cloneAs("As Is", "Integrations as they are");
  await expect(config).toBeVisible();
  await expect(modal.getByLabel("Enabled")).toBeChecked();
  await modal.getByRole("button", { name: "Cancel" }).click();

  await cloneAs("Disabled", "Integrations, all disabled");
  await expect(config).toBeVisible();
  await expect(modal.getByLabel("Enabled")).not.toBeChecked();
  await modal.getByRole("button", { name: "Cancel" }).click();

  await cloneAs("Without", "No integrations");
  await expect(config).toHaveCount(0);
});

test("a board whose only integration is disabled still offers to clone it", async ({ page }) => {
  test.setTimeout(120_000);
  await joinServer(page);
  await page.locator(".sidebar-item.sidebar-new.board").click();
  const modal = page.locator(".modal");
  await modal.locator(".form-field input").first().fill("Paused");
  await modal.getByRole("button", { name: "+ Add integration" }).click({ timeout: 30_000 });
  await modal.getByLabel("Enabled").uncheck();
  await modal.getByRole("button", { name: "Create" }).click();
  await modal.waitFor({ state: "hidden" });

  await page.locator(".sidebar-board", { hasText: "Paused" }).first().click({ button: "right" });
  await page.locator(".context-menu-item", { hasText: "Clone" }).click();
  await expect(modal.getByLabel("Integrations as they are")).toBeChecked();
  await modal.getByRole("button", { name: "Clone", exact: true }).click();
  await expect(page.locator(".page-header h1")).toHaveText("Clone of Paused");

  await page.getByRole("button", { name: "Actions for board Clone of Paused" }).click();
  await page.locator(".context-menu-item", { hasText: "Edit" }).first().click();
  await expect(modal.getByLabel("OMDb (movies and TV) config, as TOML")).toBeVisible();
  await expect(modal.getByLabel("Enabled")).not.toBeChecked();
});

test("a title with no match shows the not-found badge", async ({ page }) => {
  test.setTimeout(120_000);
  await joinServer(page);
  await page.locator(".sidebar-item.sidebar-new.board").click();
  const modal = page.locator(".modal");
  await modal.locator(".form-field input").first().fill("Films");
  await modal.getByRole("button", { name: "+ Add integration" }).click({ timeout: 30_000 });
  await modal.getByRole("button", { name: "Create" }).click();
  await modal.waitFor({ state: "hidden" });
  await createListInBoard(page, "Queue", "Films");
  await addItemToList(page, "zzz no such film");
  await expect(page.locator('[title="Integration found no match"]')).toBeVisible({ timeout: 30_000 });
});
