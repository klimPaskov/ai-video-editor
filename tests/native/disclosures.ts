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
