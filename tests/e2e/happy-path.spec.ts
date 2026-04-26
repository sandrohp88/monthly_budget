import { test, expect } from "@playwright/test";

test("setup → add a bill → add an extra → see them in projection", async ({ page }) => {
  await page.goto("/setup");
  await expect(page.getByText("Welcome to your budget")).toBeVisible();

  await page.getByLabel("Display name").fill("Tester");
  await page.getByLabel("Email").fill("test@example.com");
  await page.getByLabel("Password (min 8 chars)").fill("supersecret1");
  await page.getByLabel("Starting balance").fill("1000");
  await page.getByLabel("Default paycheck").fill("2000");

  await page.getByRole("button", { name: "Create account" }).click();

  await page.waitForURL("/");
  await expect(page.getByText("Daily projected balance").first()).toBeVisible();
  await expect(page.getByText("Starting balance").first()).toBeVisible();

  await page.goto("/bills");
  await page.getByRole("button", { name: "Add your first bill" }).click();
  await page.getByLabel("Name").fill("Rent");
  await page.getByLabel("Amount").fill("700");
  await page.getByLabel("Due day (1-31)").fill("1");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("cell", { name: "Rent" })).toBeVisible();

  await page.goto("/extras");
  await page.getByRole("button", { name: "Add expense" }).click();
  await page.getByLabel("Description").fill("Concert tickets");
  await page.getByLabel("Amount").fill("90");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Concert tickets").first()).toBeVisible();

  await page.goto("/projection");
  await expect(page.getByText("Rent").first()).toBeVisible();
  await expect(page.getByText("Concert tickets").first()).toBeVisible();
});
