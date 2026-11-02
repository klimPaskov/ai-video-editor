import { expect } from "playwright/test";
import type { Page } from "playwright/test";

/**
 * Opens the "More options", "More tools" and "Short clips" disclosures, which
 * the interface keeps closed so only a few controls show at a time. Tests that
 * exercise a control inside one call this once after the window loads; the
 * state stays across steps.
 */
export async function openDisclosures(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details.more"))
      (details as HTMLDetailsElement).open = true;
  });
}

export type StepName = "Import" | "Magic Edit" | "Refine" | "Clips" | "Export";

/** Chooses a step; the complete editor (ADR 0031) is left first. */
export async function openStep(page: Page, name: StepName): Promise<void> {
  const done = page.locator("#full-editor-done");
  if (await done.isVisible()) await done.click();
  await page.getByRole("button", { name, exact: true }).click();
}

/**
 * Refine with the complete editor open: every manual tool (marks, cut range,
 * zoom, speed, restore, Undo and Redo) is in it.
 */
export async function openFullEditor(page: Page): Promise<void> {
  await openStep(page, "Refine");
  const done = page.locator("#full-editor-done");
  if (!(await done.isVisible()))
    await page.locator("#action-secondary").click();
  await expect(done).toBeVisible();
}

/** Opens one of Refine's pop-over tools (captions, music or volume). */
export async function openRefineTool(
  page: Page,
  tool: "captions" | "music" | "volume",
): Promise<void> {
  await openStep(page, "Refine");
  const pop = page.locator(`#rt-${tool}-pop`);
  if (!(await pop.isVisible())) await page.locator(`#rt-${tool}`).click();
  await expect(pop).toBeVisible();
}
