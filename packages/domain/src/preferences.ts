import { assertShortcutChoices, type ShortcutChoices } from "./shortcuts.ts";
import { assertThemeChoice, type ThemeChoice } from "./theme.ts";

export interface Preferences {
  interfaceScale: 1 | 1.25 | 1.5 | 2;
  /**
   * Which media Claude may use in an edit. "any" (the default when absent)
   * includes copyrighted material the user has in Media; the user accepts
   * that such a video may not be monetizable. "copyright_free" limits Claude
   * to material free of copyright restrictions.
   */
  assetPolicy?: AssetPolicy;
  /** The interface theme (ADR 0024); Light Canvas when absent. */
  theme?: ThemeChoice;
  /** Keyboard shortcuts the user changed; the defaults apply to the rest. */
  shortcuts?: ShortcutChoices;
}

export type AssetPolicy = "any" | "copyright_free";
export const assetPolicies: readonly AssetPolicy[] = ["any", "copyright_free"];

export function assertPreferences(
  value: unknown,
): asserts value is Preferences {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        key !== "interfaceScale" &&
        key !== "assetPolicy" &&
        key !== "theme" &&
        key !== "shortcuts",
    ) ||
    !Object.hasOwn(value, "interfaceScale") ||
    !("interfaceScale" in value) ||
    ![1, 1.25, 1.5, 2].includes(value.interfaceScale as number)
  ) {
    throw new Error("Choose an interface scale of 100%, 125%, 150%, or 200%.");
  }
  if (
    "assetPolicy" in value &&
    !assetPolicies.includes(value.assetPolicy as AssetPolicy)
  )
    throw new Error("Choose which material Claude may use.");
  if ("theme" in value) assertThemeChoice(value.theme);
  if ("shortcuts" in value) assertShortcutChoices(value.shortcuts);
}

/** The asset policy in effect: any material unless the user chose otherwise. */
export function effectiveAssetPolicy(preferences: Preferences): AssetPolicy {
  return preferences.assetPolicy ?? "any";
}
