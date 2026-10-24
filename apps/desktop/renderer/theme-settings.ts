import {
  assertThemeChoice,
  customThemeProblem,
  defaultThemeChoice,
  luminance,
  onAccent,
  themeLayout,
  type CustomTheme,
  type ThemeChoice,
  type ThemeId,
} from "../../../packages/domain/src/theme.ts";

const cacheKey = "ai-video-editor-theme";

/** Applies a theme to the whole window: palette, layout and custom colours. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  root.dataset.theme = choice.id;
  root.dataset.layout = themeLayout(choice);
  const names = [
    "--c-bg",
    "--c-surface",
    "--c-text",
    "--c-accent",
    "--on-accent",
  ];
  if (choice.id === "custom" && choice.custom) {
    const custom = choice.custom;
    root.style.setProperty("--c-bg", custom.background);
    root.style.setProperty("--c-surface", custom.surface);
    root.style.setProperty("--c-text", custom.text);
    root.style.setProperty("--c-accent", custom.accent);
    root.style.setProperty("--on-accent", onAccent(custom.accent));
    root.style.colorScheme =
      luminance(custom.background) < 0.4 ? "dark" : "light";
  } else {
    for (const name of names) root.style.removeProperty(name);
    root.style.removeProperty("color-scheme");
  }
}

/** The last applied theme is kept so the next start paints it at once. */
export function rememberTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(cacheKey, JSON.stringify(choice));
  } catch {
    /* The saved preference is the source of truth. */
  }
}

export function applyRememberedTheme(): void {
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return;
    const value: unknown = JSON.parse(raw);
    assertThemeChoice(value);
    applyTheme(value);
  } catch {
    /* Light Canvas until the preference loads. */
  }
}

interface Tile {
  id: ThemeId;
  name: string;
  /** Fixed colours for the tile's little picture; not the live theme. */
  bg: string;
  card: string;
  accent: string;
  text: string;
  floating?: boolean;
}

const tiles: Tile[] = [
  {
    id: "light_canvas",
    name: "Light Canvas",
    bg: "#f6f5f2",
    card: "#ffffff",
    accent: "#1766f0",
    text: "#14161c",
  },
  {
    id: "studio_dark",
    name: "Studio Dark",
    bg: "#0b0d13",
    card: "#181c27",
    accent: "#6d4aff",
    text: "#eceef4",
  },
  {
    id: "cinematic",
    name: "Cinematic",
    bg: "#07080b",
    card: "#242833",
    accent: "#c8481c",
    text: "#f2f2f4",
    floating: true,
  },
  {
    id: "paper",
    name: "Paper",
    bg: "#f3ece0",
    card: "#fbf7ef",
    accent: "#b5532a",
    text: "#2a2118",
  },
  {
    id: "custom",
    name: "Custom",
    bg: "#ffffff",
    card: "#f1f0ec",
    accent: "#8a8f9c",
    text: "#14161c",
  },
];

const starterCustom: CustomTheme = {
  background: "#f6f5f2",
  surface: "#ffffff",
  text: "#14161c",
  accent: "#1766f0",
  layout: "classic",
};

/**
 * The Theme choice in Settings: five tiles and, for Custom, four colours and
 * a layout. A choice applies to the window at once so it can be judged, and
 * is kept only when the settings are saved; closing the dialog restores the
 * saved theme.
 */
export function setupThemeSettings(): {
  /** Shows the saved theme as the current choice. */
  load(choice: ThemeChoice | undefined): void;
  /** The choice as it stands, and why it cannot be saved, if it cannot. */
  current(): { choice: ThemeChoice; problem: string | null };
  /** The choice can be changed only once the saved theme is shown. */
  enable(on: boolean): void;
  /** Back to the saved theme (the dialog closed without saving). */
  revert(): void;
  /** The saved theme changed (saved). */
  saved(choice: ThemeChoice): void;
} {
  const element = <T extends HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const group = element<HTMLElement>("theme-tiles");
  const custom = element<HTMLElement>("custom-theme");
  const problemText = element<HTMLElement>("custom-problem");
  const inputs = {
    background: element<HTMLInputElement>("custom-background"),
    surface: element<HTMLInputElement>("custom-surface"),
    text: element<HTMLInputElement>("custom-text"),
    accent: element<HTMLInputElement>("custom-accent"),
  };
  const layout = element<HTMLSelectElement>("custom-layout");
  let savedChoice: ThemeChoice = defaultThemeChoice;
  let selected: ThemeId = "light_canvas";
  let customValue: CustomTheme = { ...starterCustom };
  const buttons = new Map<ThemeId, HTMLButtonElement>();

  for (const tile of tiles) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-tile";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-label", tile.name);
    const picture = document.createElement("span");
    picture.className = "theme-picture";
    picture.setAttribute("aria-hidden", "true");
    picture.style.setProperty("--tile-bg", tile.bg);
    picture.style.setProperty("--tile-card", tile.card);
    picture.style.setProperty("--tile-accent", tile.accent);
    picture.style.setProperty("--tile-text", tile.text);
    picture.dataset.floating = tile.floating ? "true" : "false";
    for (const part of ["bar", "frame", "dock", "pill"]) {
      const piece = document.createElement("span");
      piece.className = `tp-${part}`;
      picture.append(piece);
    }
    const label = document.createElement("span");
    label.className = "theme-name";
    label.setAttribute("aria-hidden", "true");
    label.textContent = tile.name;
    button.append(picture, label);
    button.addEventListener("click", () => choose(tile.id));
    group.append(button);
    buttons.set(tile.id, button);
  }

  function value(): ThemeChoice {
    return selected === "custom"
      ? { id: "custom", custom: { ...customValue } }
      : { id: selected };
  }

  function paint(): void {
    for (const [id, button] of buttons) {
      button.setAttribute("aria-checked", String(id === selected));
      button.tabIndex = id === selected ? 0 : -1;
    }
    custom.hidden = selected !== "custom";
    inputs.background.value = customValue.background;
    inputs.surface.value = customValue.surface;
    inputs.text.value = customValue.text;
    inputs.accent.value = customValue.accent;
    layout.value = customValue.layout;
    const problem =
      selected === "custom" ? customThemeProblem(customValue) : null;
    problemText.textContent = problem ?? "";
    problemText.hidden = !problem;
  }

  function preview(): void {
    paint();
    // A refusal shown for earlier colours no longer applies.
    const refusal = document.getElementById("settings-error");
    if (refusal) refusal.hidden = true;
    // A palette that cannot be read is not shown; the problem is.
    if (selected !== "custom" || !customThemeProblem(customValue))
      applyTheme(value());
  }

  function choose(id: ThemeId): void {
    selected = id;
    preview();
  }

  group.addEventListener("keydown", (event) => {
    const ids = tiles.map((tile) => tile.id);
    const at = ids.indexOf(selected);
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = ids[(at + step + ids.length) % ids.length]!;
    choose(next);
    buttons.get(next)?.focus();
  });
  for (const key of ["background", "surface", "text", "accent"] as const)
    inputs[key].addEventListener("input", () => {
      customValue = { ...customValue, [key]: inputs[key].value };
      preview();
    });
  layout.addEventListener("change", () => {
    customValue = {
      ...customValue,
      layout: layout.value === "cinematic" ? "cinematic" : "classic",
    };
    preview();
  });

  return {
    load(choice) {
      savedChoice = choice ?? defaultThemeChoice;
      selected = savedChoice.id;
      customValue = savedChoice.custom
        ? { ...savedChoice.custom }
        : { ...starterCustom };
      paint();
    },
    current() {
      const choice = value();
      return {
        choice,
        problem: selected === "custom" ? customThemeProblem(customValue) : null,
      };
    },
    enable(on) {
      for (const button of buttons.values()) button.disabled = !on;
      for (const control of [...Object.values(inputs), layout])
        control.disabled = !on;
    },
    revert() {
      applyTheme(savedChoice);
    },
    saved(choice) {
      savedChoice = choice;
      applyTheme(choice);
      rememberTheme(choice);
    },
  };
}
