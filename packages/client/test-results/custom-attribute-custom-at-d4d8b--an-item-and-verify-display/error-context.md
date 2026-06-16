# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: custom-attribute.spec.ts >> custom attributes >> create a list with a custom attribute, add an item, and verify display
- Location: e2e/custom-attribute.spec.ts:9:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('.table-add')

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
          - tab "List" [ref=e26] [cursor=pointer]
          - tab "Table" [active] [selected] [ref=e27] [cursor=pointer]
          - tab "Cards" [ref=e28] [cursor=pointer]
          - tab "Board" [ref=e29] [cursor=pointer]
    - generic [ref=e30]:
      - table [ref=e31]:
        - rowgroup [ref=e32]:
          - row "Title Rating Genre" [ref=e33]:
            - columnheader [ref=e34]
            - columnheader "Title" [ref=e35]
            - columnheader "Rating" [ref=e36]
            - columnheader "Genre" [ref=e37]
        - rowgroup
      - generic [ref=e38] [cursor=pointer]: + Add Item
```

# Test source

```ts
  1  | import { test, expect } from "@playwright/test";
  2  | import { clearDatabase, createCategory, createListInCategory } from "./helpers.js";
  3  | 
  4  | test.describe("custom attributes", () => {
  5  |   test.beforeEach(async ({ page }) => {
  6  |     await clearDatabase(page);
  7  |   });
  8  | 
  9  |   test("create a list with a custom attribute, add an item, and verify display", async ({ page }) => {
  10 |     // Create a category with attributes
  11 |     await createCategory(page, "Movies", [
  12 |       { key: "rating", label: "Rating", type: "number" },
  13 |       { key: "genre", label: "Genre" },
  14 |     ]);
  15 | 
  16 |     // Create a list in that category
  17 |     await createListInCategory(page, "My Movies", "Movies");
  18 |     await expect(page.locator(".page-header h1")).toHaveText("My Movies");
  19 | 
  20 |     // Switch to table view to see attribute columns
  21 |     await page.locator(".view-switcher-btn", { hasText: "Table" }).click();
  22 | 
  23 |     // Add an item via the table's add row
> 24 |     await page.locator(".table-add").click();
     |                                      ^ Error: locator.click: Test timeout of 30000ms exceeded.
  25 |     await expect(page.locator(".modal h2")).toHaveText("New Item");
  26 | 
  27 |     const labels = page.locator(".modal .form-field label");
  28 |     await expect(labels.nth(0)).toHaveText("Title");
  29 |     await expect(labels.nth(1)).toHaveText("Rating");
  30 |     await expect(labels.nth(2)).toHaveText("Genre");
  31 | 
  32 |     await page.locator(".modal .form-field input").first().fill("Inception");
  33 |     await page.locator(".modal .form-field").nth(1).locator("input").fill("4");
  34 |     await page.locator(".modal .form-field").nth(2).locator("input").fill("sci-fi");
  35 | 
  36 |     await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();
  37 | 
  38 |     await expect(page.locator("tbody tr")).toHaveCount(1);
  39 |     const firstRow = page.locator("tbody tr").first();
  40 |     await expect(firstRow.locator("td").nth(1)).toContainText("Inception");
  41 |     await expect(firstRow.locator("td").nth(2)).toContainText("4");
  42 |     await expect(firstRow.locator("td").nth(3)).toContainText("sci-fi");
  43 | 
  44 |     await expect(page.locator("thead th").nth(1)).toHaveText("Title");
  45 |     await expect(page.locator("thead th").nth(2)).toHaveText("Rating");
  46 |     await expect(page.locator("thead th").nth(3)).toHaveText("Genre");
  47 |   });
  48 | 
  49 |   test("custom attribute appears in item edit modal", async ({ page }) => {
  50 |     await createCategory(page, "Films", [
  51 |       { key: "director", label: "Director" },
  52 |     ]);
  53 |     await createListInCategory(page, "My Films", "Films");
  54 |     await expect(page.locator(".page-header h1")).toHaveText("My Films");
  55 | 
  56 |     await page.locator(".view-switcher-btn", { hasText: "Table" }).click();
  57 | 
  58 |     await page.locator(".table-add").click();
  59 |     await page.locator(".modal .form-field input").first().fill("Blade Runner");
  60 |     await page.locator(".modal .form-field").nth(1).locator("input").fill("Ridley Scott");
  61 |     await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();
  62 | 
  63 |     const row = page.locator("tbody tr").first();
  64 |     await expect(row.locator("td").nth(1)).toContainText("Blade Runner");
  65 |     await expect(row.locator("td").nth(2)).toContainText("Ridley Scott");
  66 | 
  67 |     await row.click();
  68 |     await expect(page.locator(".modal h2")).toHaveText("Edit Item");
  69 |     const directorInput = page.locator(".modal .form-field").nth(1).locator("input");
  70 |     await expect(directorInput).toHaveValue("Ridley Scott");
  71 |   });
  72 | 
  73 |   test("category format string is used in list display", async ({ page }) => {
  74 |     await createCategory(page, "Rated Movies", [
  75 |       { key: "year", label: "Year", type: "number" },
  76 |     ], "{title} ({year})");
  77 |     await createListInCategory(page, "Watchlist", "Rated Movies");
  78 |     await expect(page.locator(".page-header h1")).toHaveText("Watchlist");
  79 | 
  80 |     // Default is list view — add an item
  81 |     await page.locator(".list-view-add").click();
  82 |     await page.locator(".modal .form-field input").first().fill("Alien");
  83 |     await page.locator(".modal .form-field").nth(1).locator("input").fill("1979");
  84 |     await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();
  85 | 
  86 |     // List view should show the formatted string from the category
  87 |     await expect(page.locator(".list-view-item").first()).toContainText("Alien (1979)");
  88 |   });
  89 | });
  90 | 
```