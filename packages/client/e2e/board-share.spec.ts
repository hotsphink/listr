import { test, expect, type Page } from "@playwright/test";
import { addItemToList, addSyncEndpoint, clearDatabase, createBoard, createListInBoard, readStore } from "./helpers.js";
import { startTestSyncServer, type TestSyncServer } from "./syncServer.js";
import { hashServerId } from "../src/sync/joinLink.js";

/**
 * Sharing a board, end to end against a real sync server: the sharer issues a
 * link from the share dialog, and a second browser with nothing configured
 * opens it and ends up looking at the board.
 *
 * This is the flow that used to dead-end. The old share link carried a sync
 * key and nothing else: no server to reach and no account to reach it with, so
 * a recipient with an empty database sat on a spinner forever. The link is now
 * a grant, which is what carries both.
 */

test.describe.configure({ mode: "serial" });

let server: TestSyncServer;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  server = await startTestSyncServer();
});

test.afterAll(async () => {
  await server?.stop();
});

/**
 * Empty a page's database but leave it knowing a route to the test server, so
 * a join link resolves with no host prompt. Stands for a recipient who has
 * spoken to this server before, and keeps tests that are not about server
 * resolution off the slow default-endpoint probe.
 */
async function seedRoute(page: Page): Promise<void> {
  await clearDatabase(page);
  await addSyncEndpoint(page, {
    host: "localhost",
    port: server.port,
    secure: false,
    lastServerId: server.serverId,
  });
}

/** Register a page against the test server by redeeming `link`. */
async function join(page: Page, link: string): Promise<void> {
  await seedRoute(page);
  await page.goto(link);
  await expect(page.locator(".receive-card h2")).toHaveText("You're invited", { timeout: 30_000 });
  await page.getByRole("button", { name: "Join" }).click();
}

test.describe("board sharing", () => {
  test("a shared board link carries the server, and a cold recipient lands on the board", async ({ page, browser }) => {
    test.setTimeout(120_000);

    // The sharer needs `invite` to mint the guest account the recipient gets.
    await join(page, server.issueGrant({ kind: "invite", caps: ["sync", "invite"], greeting: "Be a sharer" }));
    await expect(page.locator(".receive-saved")).toContainText("You're in!", { timeout: 30_000 });
    await page.getByRole("button", { name: "Go to app" }).click();

    // Content that predates the share. This is the case that broke: assigning
    // a sync_key bumps only the board's updated_at, so the list and item
    // re-push carrying their original timestamps, and a server that rejects
    // those outright leaves them behind in the sender's own namespace.
    await createBoard(page, "Camping Trip");
    await createListInBoard(page, "Gear", "Camping Trip");
    await addItemToList(page, "Tent");

    await page.locator(".sidebar-board", { hasText: "Camping Trip" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Share" }).click();

    await expect(page.locator(".modal h2")).toHaveText('Share "Camping Trip"');
    const shareUrl = await page.locator(".share-url-text").innerText({ timeout: 30_000 });

    // The whole point: the link names a server and a grant, not a bare key.
    // The old link carried neither, which is why a cold recipient had nowhere
    // to go.
    expect(shareUrl).toContain(`#/join/${await hashServerId(server.serverId)}/`);
    expect(shareUrl).toMatch(/\?b=[0-9a-f-]{36}$/);

    await page.getByRole("button", { name: "Done" }).click();

    // A second browser with an empty database and no configured endpoint, the
    // case the old link could not serve at all.
    const recipientContext = await browser.newContext();
    const recipient = await recipientContext.newPage();
    try {
      await clearDatabase(recipient);
      await recipient.goto(shareUrl);

      // The link resolves its server hash against the baked-in default first,
      // which is not this throwaway server, so allow for that round trip and
      // then supply the host, exactly as guest-link.spec.ts's cold test does.
      await expect(recipient.locator(".receive-card h2")).toHaveText("Server not found", { timeout: 60_000 });
      await recipient.locator(".join-manual-host input").first().fill("localhost");
      await recipient.locator('.join-manual-host input[type="number"]').fill(String(server.port));
      await recipient.getByRole("button", { name: "Try this host" }).click();

      await expect(recipient.locator(".receive-card h2")).toHaveText("You're invited", { timeout: 40_000 });
      await expect(recipient.locator(".offer-name")).toContainText("Camping Trip");
      await recipient.getByRole("button", { name: "Join" }).click();

      // Not merely "You're in!": the link lands on the board itself, with no
      // intermediate screen to tap through.
      await expect(recipient.locator(".page-title h1")).toHaveText("Camping Trip", { timeout: 60_000 });
      expect(recipient.url()).toContain("#/board/");

      // The board arrives with what was already in it, not empty.
      await expect(recipient.locator(".list-view-item", { hasText: "Tent" })).toBeVisible({ timeout: 60_000 });

      // And a later addition by the sender reaches the recipient, which it
      // cannot do while the parent list is stranded in the old namespace.
      await addItemToList(page, "Stove");
      await expect(recipient.locator(".list-view-item", { hasText: "Stove" })).toBeVisible({ timeout: 60_000 });

      // The recipient resolved a route with nothing configured, so the link's
      // server hash did its job.
      const endpoints = await readStore<{ host: string; last_server_id: string }>(recipient, "sync_endpoints");
      expect(endpoints.map((e) => e.last_server_id)).toContain(server.serverId);
    } finally {
      await recipientContext.close();
    }
  });

  test("a shared board group arrives on the recipient's device already named", async ({ page, browser }) => {
    test.setTimeout(120_000);

    await join(page, server.issueGrant({ kind: "invite", caps: ["sync", "invite"], greeting: "Be a group sharer" }));
    await expect(page.locator(".receive-saved")).toContainText("You're in!", { timeout: 30_000 });
    await page.getByRole("button", { name: "Go to app" }).click();

    await page.locator(".sidebar-item.sidebar-new", { hasText: "+ New Board Group" }).click();
    await page.locator(".modal .form-field input").first().fill("Team Trip");
    await page.getByRole("button", { name: "Create" }).click();

    const group = page.locator(".sidebar-group").filter({ has: page.locator(".sidebar-group-title", { hasText: "Team Trip" }) });
    await group.locator(".sidebar-group-share-btn").click();
    await expect(page.locator(".modal h2")).toHaveText('Share "Team Trip"');

    const shareUrl = await page.locator(".share-url-text").innerText({ timeout: 30_000 });
    // A group has no single board to land on, so no board id rides along.
    expect(shareUrl).not.toContain("?b=");
    await page.getByRole("button", { name: "Done" }).click();

    const recipientContext = await browser.newContext();
    try {
      const recipient = await recipientContext.newPage();
      await seedRoute(recipient);
      await recipient.goto(shareUrl);
      await expect(recipient.locator(".receive-card h2")).toHaveText("You're invited", { timeout: 40_000 });
      await recipient.getByRole("button", { name: "Join" }).click();
      await expect(recipient.locator(".receive-saved")).toContainText("You're in!", { timeout: 60_000 });
      await recipient.getByRole("button", { name: "Go to app" }).click();

      // The name travels with the key through the grant, so the group gets its
      // own heading rather than landing as an unnamed key in Shared Boards.
      await expect(
        recipient.locator(".sidebar-group-title", { hasText: "Team Trip" }),
      ).toBeVisible({ timeout: 60_000 });
      const groups = await readStore<{ name: string }>(recipient, "board_groups");
      expect(groups.map((g) => g.name)).toContain("Team Trip");
    } finally {
      await recipientContext.close();
    }
  });

  // A share link is issued as a `guest` grant, because the sender has no way
  // to know whether the recipient already has an account here. The one link
  // has to work either way, so the server hands over just the key when the
  // redeemer turns out to be someone it already knows.
  test("a share link works for a recipient who already has an account", async ({ page, browser }) => {
    test.setTimeout(120_000);

    await join(page, server.issueGrant({ kind: "invite", caps: ["sync", "invite"], greeting: "Be a sharer" }));
    await expect(page.locator(".receive-saved")).toContainText("You're in!", { timeout: 30_000 });
    await page.getByRole("button", { name: "Go to app" }).click();

    await createBoard(page, "Shared Later");
    await createListInBoard(page, "Tasks", "Shared Later");
    await addItemToList(page, "Book flights");

    await page.locator(".sidebar-board", { hasText: "Shared Later" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Share" }).click();
    const shareUrl = await page.locator(".share-url-text").innerText({ timeout: 30_000 });
    await page.getByRole("button", { name: "Done" }).click();

    const recipientContext = await browser.newContext();
    try {
      const recipient = await recipientContext.newPage();
      // Register this recipient first, so the share below is the case that
      // used to dead-end on "You already have an account on this server".
      await join(recipient, server.issueGrant({ kind: "invite", caps: ["sync"], greeting: "Existing user" }));
      await expect(recipient.locator(".receive-saved")).toContainText("You're in!", { timeout: 30_000 });
      await recipient.getByRole("button", { name: "Go to app" }).click();

      await recipient.goto(shareUrl);
      await expect(recipient.locator(".receive-card h2")).toHaveText("You're invited", { timeout: 40_000 });
      // The screen must not promise an account they already have.
      await expect(recipient.locator(".receive-card")).toContainText("You already have an account");
      await recipient.getByRole("button", { name: "Join" }).click();

      await expect(recipient.locator(".page-title h1")).toHaveText("Shared Later", { timeout: 60_000 });
      await expect(recipient.locator(".list-view-item", { hasText: "Book flights" })).toBeVisible({ timeout: 60_000 });
    } finally {
      await recipientContext.close();
    }
  });

  test("a one-person link cannot be redeemed twice", async ({ page, browser }) => {
    test.setTimeout(120_000);

    await join(page, server.issueGrant({ kind: "invite", caps: ["sync", "invite"], greeting: "Be another sharer" }));
    await expect(page.locator(".receive-saved")).toContainText("You're in!", { timeout: 30_000 });
    await page.getByRole("button", { name: "Go to app" }).click();

    await createBoard(page, "Packing List");
    await page.locator(".sidebar-board", { hasText: "Packing List" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Share" }).click();

    // "One person" is the default, so the link is spent by the first recipient.
    const shareUrl = await page.locator(".share-url-text").innerText({ timeout: 30_000 });
    await page.getByRole("button", { name: "Done" }).click();

    const first = await browser.newContext();
    const second = await browser.newContext();
    try {
      const a = await first.newPage();
      await seedRoute(a);
      await a.goto(shareUrl);
      await expect(a.locator(".receive-card h2")).toHaveText("You're invited", { timeout: 40_000 });
      await a.getByRole("button", { name: "Join" }).click();
      await expect(a.locator(".page-title h1")).toHaveText("Packing List", { timeout: 60_000 });

      const b = await second.newPage();
      await seedRoute(b);
      await b.goto(shareUrl);
      await expect(b.locator(".receive-card h2")).toHaveText("Couldn't join", { timeout: 60_000 });
      await expect(b.locator(".field-error")).toHaveText("This link has already been used.");
    } finally {
      await first.close();
      await second.close();
    }
  });
});
