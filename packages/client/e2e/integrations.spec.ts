import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { addItemToList, addSyncEndpoint, clearDatabase, createBoard, createListInBoard } from "./helpers.js";
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
  tt0133093: {
    Response: "True", imdbID: "tt0133093", Title: "The Matrix", Year: "1999", Type: "movie", Runtime: "136 min", imdbRating: "8.7",
    Ratings: [{ Source: "Rotten Tomatoes", Value: "83%" }],
  },
  tt0234215: { Response: "True", imdbID: "tt0234215", Title: "The Matrix Reloaded", Year: "2003", Type: "movie", Genre: "Action, Sci-Fi" },
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
  await expect(modal.locator(".schema-entry")).toHaveCount(17);
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

  // The editor shows integration values as placeholders, never as the user's own values,
  // styled as integration values and naming where they came from.
  await item.dblclick();
  await expect(modal.locator("h2")).toHaveText("Edit Item");
  const title = modal.getByLabel("Title", { exact: true });
  await expect(title).toHaveValue("");
  await expect(title).toHaveAttribute("placeholder", "The Matrix Reloaded");
  const titleField = modal.locator(".form-field", { has: page.getByLabel("Title", { exact: true }) });
  await expect(titleField).toHaveClass(/from-integration/);
  await expect(titleField.locator(".integration-note")).toHaveText("From OMDb (movies and TV). Enter a title to override it.");

  const year = modal.getByLabel("Year", { exact: true });
  await expect(year).toHaveValue("");
  await expect(year).toHaveAttribute("placeholder", "2003");
  const yearField = modal.locator(".form-field", { has: page.getByLabel("Year", { exact: true }) });
  await expect(yearField).toHaveClass(/from-integration/);
  await expect(yearField.locator(".integration-note")).toHaveText("From OMDb (movies and TV). Enter a value to override it.");

  // Tags have no placeholder, so the note carries the value.
  const genre = modal.locator(".form-field", { has: page.locator(".field-label", { hasText: /^Genre$/ }) });
  await expect(genre.locator(".integration-note")).toHaveText("Action, Sci-Fi, from OMDb (movies and TV). Setting a value overrides it.");

  // Entering a value makes it the user's own: the integration styling and note go
  // away once the field commits it, which number fields do when focus leaves.
  await year.fill("2004");
  await year.press("Tab");
  await expect(yearField).not.toHaveClass(/from-integration/);
  await expect(yearField.locator(".integration-note")).toHaveCount(0);
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

test("values for attributes the board names differently show once mapped, with no new lookups", async ({ page }) => {
  test.setTimeout(120_000);
  await joinServer(page);
  // Attribute keys that differ from OMDb's imdb_rating, rotten_tomatoes and runtime_minutes.
  await createBoard(page, "Renamed", [
    { key: "imdb", label: "IMDB Rating", type: "number" },
    { key: "rotten", label: "Rotten Tomatoes Rating", type: "number" },
    { key: "duration", label: "Duration", type: "duration" },
    { key: "imdb_id", label: "IMDB ID" },
  ]);
  const modal = page.locator(".modal");
  const editBoard = async () => {
    await page.locator(".sidebar-board", { hasText: "Renamed" }).first().click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Edit" }).first().click();
    await expect(modal.locator("h2")).toHaveText("Edit Board");
  };
  await editBoard();
  await modal.getByRole("button", { name: "+ Add integration" }).click({ timeout: 30_000 });
  await modal.getByRole("button", { name: "Save" }).click();
  await modal.waitFor({ state: "hidden" });
  await createListInBoard(page, "Queue", "Renamed");

  // One exact match, so OMDb settles on it by itself.
  await addItemToList(page, "The Matrix");
  const item = page.locator(".list-view-item:not(.inline-add-item)").first();
  await expect(item).toContainText("tt0133093", { timeout: 30_000 });
  await expect(item).not.toContainText("8.7");

  // The editor says which values aren't shown and why.
  await item.dblclick();
  const unshown = modal.locator(".integration-unshown");
  await expect(unshown).toContainText("OMDb (movies and TV) values this board doesn't show:");
  await expect(unshown).toContainText("imdb_rating (8.7) has no imdb_rating attribute on this board.");
  await expect(unshown).toContainText("rotten_tomatoes (83) has no rotten_tomatoes attribute on this board");
  await expect(unshown).toContainText("runtime_minutes (136) has no runtime_minutes attribute on this board");
  await modal.getByRole("button", { name: "Cancel" }).click();

  // Map them in the board's config. The values then show without another call to OMDb.
  const calls = requests.length;
  await editBoard();
  const config = modal.getByLabel("OMDb (movies and TV) config, as TOML");
  await expect(config).toHaveValue(/# attributes\.imdb_rating = "imdb_rating"/);
  await config.fill('attributes.imdb_rating = "imdb"\nattributes.rotten_tomatoes = "rotten"\nattributes.runtime_minutes = "duration"\nattributes.plot = ""\n');
  await modal.getByRole("button", { name: "Save" }).click();
  await modal.waitFor({ state: "hidden" });
  await expect(item).toContainText("8.7");
  await expect(item).toContainText("83");

  await item.dblclick();
  await expect(modal.getByLabel("IMDB Rating", { exact: true })).toHaveAttribute("placeholder", "8.7");
  await expect(modal.getByLabel("Rotten Tomatoes Rating", { exact: true })).toHaveAttribute("placeholder", "83");
  await expect(unshown).not.toContainText("imdb_rating");
  await expect(unshown).not.toContainText("plot");
  await modal.getByRole("button", { name: "Cancel" }).click();
  expect(requests.length).toBe(calls);
});

test("the board editor rejects an attribute map value that isn't a key", async ({ page }) => {
  test.setTimeout(120_000);
  await joinServer(page);
  await page.locator(".sidebar-item.sidebar-new.board").click();
  const modal = page.locator(".modal");
  await modal.locator(".form-field input").first().fill("Bad Map");
  await modal.getByRole("button", { name: "+ Add integration" }).click({ timeout: 30_000 });
  await modal.getByLabel("OMDb (movies and TV) config, as TOML").fill("attributes.imdb_rating = 3\n");
  await expect(modal.getByRole("alert")).toContainText('attributes.imdb_rating must be an attribute key in quotes');
  await expect(modal.getByRole("button", { name: "Create" })).toBeDisabled();
});

test("exports and imports integration settings and values only as chosen", async ({ page }) => {
  test.setTimeout(180_000);
  await joinServer(page);
  await createBoard(page, "Exported", [
    { key: "imdb", label: "IMDB Rating", type: "number" },
    { key: "imdb_id", label: "IMDB ID" },
  ]);
  const modal = page.locator(".modal");
  await page.locator(".sidebar-board", { hasText: "Exported" }).first().click({ button: "right" });
  await page.locator(".context-menu-item", { hasText: "Edit" }).first().click();
  await modal.getByRole("button", { name: "+ Add integration" }).click({ timeout: 30_000 });
  await modal.getByLabel("OMDb (movies and TV) config, as TOML").fill('attributes.imdb_rating = "imdb"\n');
  await modal.getByRole("button", { name: "Save" }).click();
  await modal.waitFor({ state: "hidden" });
  await createListInBoard(page, "Films", "Exported");

  // One item OMDb matched by itself, and one whose pick released the typed title.
  await addItemToList(page, "The Matrix");
  const items = page.locator(".list-view-item:not(.inline-add-item)");
  await expect(items.first()).toContainText("8.7", { timeout: 30_000 });
  await addItemToList(page, "neo matrix");
  await page.getByRole("button", { name: "Several integration matches. Choose one." }).click({ timeout: 30_000 });
  await modal.getByRole("button", { name: "The Matrix Reloaded (2003, movie)" }).click();
  await expect(items.nth(1)).toContainText("The Matrix Reloaded", { timeout: 30_000 });

  const exportBoard = async (withValues: boolean) => {
    await page.locator(".sidebar-board", { hasText: "Exported" }).first().click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Export" }).click();
    await expect(modal.locator("h2")).toHaveText('Export "Exported"');
    await expect(modal.getByLabel("Integration settings")).toBeChecked();
    await modal.getByLabel("Values integrations filled in").setChecked(withValues);
    const download = page.waitForEvent("download");
    await modal.getByRole("button", { name: "Export", exact: true }).click();
    const doc = JSON.parse(readFileSync((await (await download).path())!, "utf-8"));
    await expect(modal).toHaveCount(0);
    return doc;
  };

  // Settings only: the config travels, integration values don't, and the pick does.
  const settingsOnly = await exportBoard(false);
  const [board] = settingsOnly.boards;
  expect(board.integrations).toEqual([expect.objectContaining({ integration_id: "omdb", enabled: true, config: 'attributes.imdb_rating = "imdb"\n' })]);
  const [matched, picked] = board.lists[0].items;
  expect(matched).toMatchObject({ title: "The Matrix", attributes: {} });
  expect(picked).toMatchObject({ title: "", choices: { imdb_id: { value: "tt0234215", query: { title: "neo matrix" } } } });

  // With values: integration values are written into the items as ordinary values.
  const withValues = await exportBoard(true);
  expect(withValues.boards[0].lists[0].items[0].attributes).toMatchObject({ imdb: 8.7, imdb_id: "tt0133093" });
  expect(withValues.boards[0].lists[0].items[1].title).toBe("The Matrix Reloaded");

  const importInto = async (choice: string) => {
    await clearDatabase(page);
    await joinServer(page);
    await page.locator(".sidebar-item", { hasText: "Import" }).click();
    await page.locator('input[type="file"][accept="image/*,.json"]').setInputFiles({
      name: "export.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(settingsOnly)),
    });
    const group = modal.getByRole("group", { name: "Integrations" });
    await expect(group).toContainText("One board in this file has integration settings.");
    await group.getByLabel(choice).check();
    await modal.getByRole("button", { name: "Apply" }).click();
    await modal.getByRole("button", { name: "Done" }).click();
    await page.locator(".sidebar-board", { hasText: "Exported" }).first().click();
  };

  // All disabled: nothing will fill in the released title, so it goes back to what was typed.
  await importInto("Import them all disabled");
  await expect(items.nth(1)).toHaveText(/neo matrix/);
  await page.locator(".sidebar-board", { hasText: "Exported" }).first().click({ button: "right" });
  await page.locator(".context-menu-item", { hasText: "Edit" }).first().click();
  await expect(modal.getByLabel("OMDb (movies and TV) config, as TOML")).toHaveValue('attributes.imdb_rating = "imdb"\n');
  await expect(modal.getByLabel("Enabled")).not.toBeChecked();
  await modal.getByRole("button", { name: "Cancel" }).click();

  // As they are: the integration runs, and the official title and mapped rating come back.
  await importInto("Import them as they are");
  await expect(items.first()).toContainText("8.7", { timeout: 30_000 });
  await expect(items.nth(1)).toContainText("The Matrix Reloaded", { timeout: 30_000 });
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
