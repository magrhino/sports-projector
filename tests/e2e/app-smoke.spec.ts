import { expect, test } from "@playwright/test";

test("renders the app shell and settings view without browser errors", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    browserErrors.push(error.message);
  });

  await page.route("**/api/games/live**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: { games: [], league: "nba", source: "espn" },
      status: 200
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sports Projector" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" })).toHaveAttribute("aria-pressed", "true");
  expect(browserErrors).toEqual([]);
});
