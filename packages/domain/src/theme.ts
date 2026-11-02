/**
 * The interface theme (ADR 0024). A theme is more than a palette: Cinematic
 * also changes the layout (the video fills the window and the controls float
 * over it). The built-in themes are defined in the renderer's style sheet by
 * their id; a custom theme carries four colours and a layout, and the rest of
 * its palette is derived from them in CSS. Only colours and a layout name are
 * stored: no style, script or path.
 */
export const themeIds = [
  "light_canvas",
  "studio_dark",
  "paper",
  "cinematic",
  "custom",
] as const;
export type ThemeId = (typeof themeIds)[number];

export const themeLayouts = ["classic", "cinematic"] as const;
export type ThemeLayout = (typeof themeLayouts)[number];

export interface CustomTheme {
  background: string;
  surface: string;
  text: string;
  accent: string;
  layout: ThemeLayout;
}

export interface ThemeChoice {
  id: ThemeId;
  /** Present exactly when `id` is "custom". */
  custom?: CustomTheme;
}

export const defaultThemeChoice: ThemeChoice = Object.freeze({
  id: "light_canvas",
});

/** The layout a theme uses. */
export function themeLayout(choice: ThemeChoice): ThemeLayout {
  if (choice.id === "cinematic") return "cinematic";
  if (choice.id === "custom") return choice.custom?.layout ?? "classic";
  return "classic";
}

const colorPattern = /^#[0-9a-f]{6}$/u;

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a #rrggbb colour (WCAG 2.x). */
export function luminance(color: string): number {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return (
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  );
}

/** WCAG contrast ratio between two #rrggbb colours, 1 to 21. */
export function contrastRatio(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The text colour for a button filled with the accent: white or near-black. */
export function onAccent(accent: string): "#ffffff" | "#111111" {
  return contrastRatio("#ffffff", accent) >= contrastRatio("#111111", accent)
    ? "#ffffff"
    : "#111111";
}

/** Why a custom theme cannot be used, or null when it can be read. */
export function customThemeProblem(custom: CustomTheme): string | null {
  if (contrastRatio(custom.text, custom.background) < 4.5)
    return "The text colour is too close to the background to read.";
  if (contrastRatio(custom.text, custom.surface) < 4.5)
    return "The text colour is too close to the card colour to read.";
  if (contrastRatio(custom.accent, custom.background) < 3)
    return "The accent is too close to the background to see.";
  return null;
}

function plain(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Choose one of the listed themes.");
  return value as Record<string, unknown>;
}

export function assertCustomTheme(
  value: unknown,
): asserts value is CustomTheme {
  const keys = ["background", "surface", "text", "accent", "layout"];
  const custom = plain(value, keys);
  if (
    keys.some((key) => !Object.hasOwn(custom, key)) ||
    !themeLayouts.includes(custom.layout as ThemeLayout) ||
    ["background", "surface", "text", "accent"].some(
      (key) =>
        typeof custom[key] !== "string" ||
        !colorPattern.test(custom[key] as string),
    )
  )
    throw new Error("Choose valid colours for the custom theme.");
  const problem = customThemeProblem(custom as unknown as CustomTheme);
  if (problem) throw new Error(problem);
}

export function assertThemeChoice(
  value: unknown,
): asserts value is ThemeChoice {
  const choice = plain(value, ["id", "custom"]);
  if (!themeIds.includes(choice.id as ThemeId))
    throw new Error("Choose one of the listed themes.");
  if (choice.id === "custom") {
    if (!Object.hasOwn(choice, "custom"))
      throw new Error("Choose valid colours for the custom theme.");
    assertCustomTheme(choice.custom);
  } else if (Object.hasOwn(choice, "custom"))
    throw new Error("Choose one of the listed themes.");
}
