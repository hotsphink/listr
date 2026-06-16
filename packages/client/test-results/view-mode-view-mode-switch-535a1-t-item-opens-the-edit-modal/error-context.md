# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: view-mode.spec.ts >> view mode switching >> clicking a list item opens the edit modal
- Location: e2e/view-mode.spec.ts:78:3

# Error details

```
Test timeout of 30000ms exceeded while running "beforeEach" hook.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('.list-view-add')

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - navigation [ref=e4]:
    - generic [ref=e5] [cursor=pointer]: Listr
    - generic [ref=e6]:
      - generic [ref=e7]:
        - generic [ref=e8] [cursor=pointer]:
          - generic [ref=e9]: ▾
          - text: Movies
          - generic [ref=e10]: "1"
        - generic [ref=e11]:
          - generic [ref=e12] [cursor=pointer]: My Movies
          - generic [ref=e13] [cursor=pointer]: + New List
      - generic [ref=e14] [cursor=pointer]: + New Category
      - generic [ref=e15] [cursor=pointer]: ↓ Import
    - generic [ref=e17] [cursor=pointer]: Sync
  - generic [ref=e20]:
    - generic [ref=e21]:
      - heading "My Movies" [level=1] [ref=e22]
      - generic [ref=e23]:
        - textbox "Search..." [ref=e24]
        - tablist "View mode" [ref=e25]:
          - tab "List" [selected] [ref=e26] [cursor=pointer]
          - tab "Table" [ref=e27] [cursor=pointer]
          - tab "Cards" [ref=e28] [cursor=pointer]
          - tab "Board" [ref=e29] [cursor=pointer]
    - list [ref=e31]:
      - listitem [ref=e32] [cursor=pointer]: + Add Item
```

# Test source

```ts
  1   | import { test, expect } from "@playwright/test";
  2   | import { clearDatabase, createCategory, createListInCategory } from "./helpers.js";
  3   | 
  4   | test.describe("view mode switching", () => {
  5   |   test.beforeEach(async ({ page }) => {
  6   |     await clearDatabase(page);
  7   | 
  8   |     await createCategory(page, "Movies", [
  9   |       { key: "genre", label: "Genre" },
  10  |     ]);
  11  |     await createListInCategory(page, "My Movies", "Movies");
  12  |     await expect(page.locator(".page-header h1")).toHaveText("My Movies");
  13  | 
  14  |     // Add two items
> 15  |     await page.locator(".list-view-add").click();
      |                                          ^ Error: locator.click: Test timeout of 30000ms exceeded.
  16  |     await page.locator(".modal .form-field input").first().fill("Inception");
  17  |     await page.locator(".modal .form-field").nth(1).locator("input").fill("sci-fi");
  18  |     await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();
  19  | 
  20  |     await page.locator(".list-view-add").click();
  21  |     await page.locator(".modal .form-field input").first().fill("The Godfather");
  22  |     await page.locator(".modal .form-field").nth(1).locator("input").fill("crime");
  23  |     await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();
  24  | 
  25  |     await expect(page.locator(".list-view-item")).toHaveCount(2);
  26  |   });
  27  | 
  28  |   test("defaults to list view with formatted strings", async ({ page }) => {
  29  |     await expect(page.locator(".view-switcher-btn.active")).toHaveText("List");
  30  |     await expect(page.locator(".list-view")).toBeVisible();
  31  |     await expect(page.locator(".list-view-item")).toHaveCount(2);
  32  |     await expect(page.locator(".list-view-item").first()).toContainText("Inception");
  33  |     await expect(page.locator(".list-view-item").first()).toContainText("sci-fi");
  34  |     await expect(page.locator("table")).toHaveCount(0);
  35  |     await expect(page.locator(".card-grid")).toHaveCount(0);
  36  |   });
  37  | 
  38  |   test("switches to card view", async ({ page }) => {
  39  |     await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
  40  |     await expect(page.locator(".view-switcher-btn.active")).toHaveText("Cards");
  41  |     await expect(page.locator(".card-grid")).toBeVisible();
  42  |     await expect(page.locator(".item-card:not(.add-card)")).toHaveCount(2);
  43  |     await expect(page.locator("table")).toHaveCount(0);
  44  |     await expect(page.locator(".item-card-title").first()).toContainText("Inception");
  45  |     await expect(page.locator(".item-card").first()).toContainText("sci-fi");
  46  |   });
  47  | 
  48  |   test("switches between all views", async ({ page }) => {
  49  |     await expect(page.locator(".list-view")).toBeVisible();
  50  | 
  51  |     await page.locator(".view-switcher-btn", { hasText: "Table" }).click();
  52  |     await expect(page.locator("table")).toBeVisible();
  53  |     await expect(page.locator("tbody tr")).toHaveCount(2);
  54  |     await expect(page.locator(".list-view")).toHaveCount(0);
  55  | 
  56  |     await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
  57  |     await expect(page.locator(".card-grid")).toBeVisible();
  58  |     await expect(page.locator("table")).toHaveCount(0);
  59  | 
  60  |     await page.locator(".view-switcher-btn", { hasText: "List" }).click();
  61  |     await expect(page.locator(".list-view")).toBeVisible();
  62  |     await expect(page.locator(".card-grid")).toHaveCount(0);
  63  |   });
  64  | 
  65  |   test("view mode persists after navigation", async ({ page }) => {
  66  |     await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
  67  |     await expect(page.locator(".card-grid")).toBeVisible();
  68  | 
  69  |     await page.locator(".sidebar-header").click();
  70  |     await expect(page.locator(".page-header h1")).toHaveText("Lists");
  71  | 
  72  |     await page.locator(".list-card", { hasText: "My Movies" }).click();
  73  |     await expect(page.locator(".page-header h1")).toHaveText("My Movies");
  74  |     await expect(page.locator(".view-switcher-btn.active")).toHaveText("Cards");
  75  |     await expect(page.locator(".card-grid")).toBeVisible();
  76  |   });
  77  | 
  78  |   test("clicking a list item opens the edit modal", async ({ page }) => {
  79  |     await page.locator(".list-view-item").first().click();
  80  |     await expect(page.locator(".modal h2")).toHaveText("Edit Item");
  81  |     await expect(page.locator(".modal .form-field input").first()).toHaveValue("Inception");
  82  |   });
  83  | 
  84  |   test("clicking a card opens the edit modal", async ({ page }) => {
  85  |     await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
  86  |     await expect(page.locator(".card-grid")).toBeVisible();
  87  |     await page.locator(".item-card:not(.add-card)").first().click();
  88  |     await expect(page.locator(".modal h2")).toHaveText("Edit Item");
  89  |     await expect(page.locator(".modal .form-field input").first()).toHaveValue("Inception");
  90  |   });
  91  | 
  92  |   test("search filters items", async ({ page }) => {
  93  |     await page.locator(".search-input").fill("godfather");
  94  |     await expect(page.locator(".list-view-item")).toHaveCount(1);
  95  |     await expect(page.locator(".list-view-item").first()).toContainText("The Godfather");
  96  | 
  97  |     await page.locator(".search-input").fill("");
  98  |     await expect(page.locator(".list-view-item")).toHaveCount(2);
  99  |   });
  100 | });
  101 | 
```