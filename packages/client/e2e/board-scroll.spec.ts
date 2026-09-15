import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { clearDatabase, createBoard, createListInBoard } from "./helpers.js";

// Scrolling a board fully right must rest with the last list flush against the
// left edge, never part way through it, while a board that fits stays unscrolled.
test.describe("board horizontal scroll", () => {
  const probe = async (page: Page) =>
    page.evaluate(async () => {
      const v = document.querySelector<HTMLElement>(".multi-list-view")!;
      const cols = v.querySelectorAll<HTMLElement>(":scope > .multi-list-column");
      const last = cols[cols.length - 1];
      const btn = v.querySelector<HTMLElement>(".multi-list-new-column")!;
      v.scrollTo({ left: 99999, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 500));
      const sl = v.scrollLeft;
      return {
        lastColLeft: Math.round(last.offsetLeft - sl),
        btnVisible: Math.round(
          Math.min(btn.offsetLeft + btn.offsetWidth - sl, v.clientWidth) - Math.max(btn.offsetLeft - sl, 0),
        ),
      };
    });

  test("stops on the last list at every width", async ({ page }) => {
    await clearDatabase(page);
    await createBoard(page, "Wide");
    for (const name of ["One", "Two", "Three", "Four", "Five"]) {
      await createListInBoard(page, name, "Wide");
    }
    await expect(page.locator(".multi-list-column")).toHaveCount(5);

    for (const width of [1280, 900, 700, 620, 500, 400]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(250);
      const r = await probe(page);
      expect(r.lastColLeft, `width ${width}`).toBe(0);
      expect(r.btnVisible, `width ${width}`).toBeGreaterThan(40);
    }
  });

  test("a board that fits does not scroll", async ({ page }) => {
    await clearDatabase(page);
    await createBoard(page, "Narrow");
    await createListInBoard(page, "Only", "Narrow");
    await createListInBoard(page, "Second", "Narrow");
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.waitForTimeout(250);
    const scrollable = await page.evaluate(() => {
      const v = document.querySelector<HTMLElement>(".multi-list-view")!;
      return v.scrollWidth - v.clientWidth;
    });
    expect(scrollable).toBeLessThanOrEqual(1);
  });
});
