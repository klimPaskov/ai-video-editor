import type { ClaudeView } from "../../../packages/domain/src/claude-view.ts";
import type { Reply } from "../src/bridge.ts";

const effortLabels: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

export function claudeAccountText(view: ClaudeView): string {
  if (view.status === "signed_in" && view.account) {
    const plan = view.account.plan
      ? view.account.plan.charAt(0).toUpperCase() + view.account.plan.slice(1)
      : null;
    if (view.account.billing === "api")
      return "Claude · Anthropic Console (API billing)";
    if (view.account.billing === "subscription")
      return plan ? `Claude · ${plan}` : "Claude · Signed in";
    return "Claude · Signed in";
  }
  return {
    checking: "Checking Claude…",
    unavailable: "Claude Code is needed to use Claude",
    signed_out: "Sign in to use Claude",
    signing_in: "Finish signing in in your browser…",
    signed_in: "Claude · Signed in",
    error: "Claude is unavailable",
  }[view.status];
}

export interface ClaudeSettingsSection {
  activate(): void;
  deactivate(): void;
}

export function setupClaudeSettings(
  dialog: HTMLDialogElement,
): ClaudeSettingsSection {
  const element = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id)! as T;
  const panel = element("claude-settings");
  let epoch = 0;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: ClaudeView | undefined;
  let localError: string | null = null;
  const active = () => dialog.open && !panel.hidden;
  const failure = "This Claude action could not finish. Choose Check again.";
  function stop(): void {
    epoch++;
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  function setText(id: string, value: string): void {
    const target = element(id);
    if (target.textContent !== value) target.textContent = value;
  }
  function options(
    select: HTMLSelectElement,
    entries: { value: string; label: string }[],
    selected: string,
  ): void {
    const key = JSON.stringify(entries);
    if (select.dataset.options !== key) {
      select.replaceChildren(
        ...entries.map((entry) => {
          const option = document.createElement("option");
          option.value = entry.value;
          option.textContent = entry.label;
          return option;
        }),
      );
      select.dataset.options = key;
    }
    select.value = selected;
  }
  function render(view: ClaudeView): void {
    current = view;
    const message = view.message ?? localError;
    setText("claude-account", claudeAccountText(view));
    const show = (id: string, visible: boolean) => {
      element(id).hidden = !visible;
    };
    show("claude-sign-in", view.status === "signed_out");
    show("claude-cancel-sign-in", view.status === "signing_in");
    show("claude-sign-out", view.status === "signed_in");
    show("claude-install", view.status === "unavailable");
    show(
      "claude-check",
      ["unavailable", "error"].includes(view.status) || message !== null,
    );
    show("claude-disclosure", view.status !== "signed_in");
    show("claude-error", message !== null);
    setText("claude-error", message ?? "");
    show(
      "claude-model-settings",
      view.status === "signed_in" && view.models.length > 0,
    );
    options(
      element<HTMLSelectElement>("claude-model"),
      [
        ...(view.selection ? [] : [{ value: "", label: "Choose a model" }]),
        ...view.models.map((model) => ({
          value: model.value,
          label: model.detail
            ? `${model.label} · ${model.detail}`
            : model.label,
        })),
      ],
      view.selection?.model ?? "",
    );
    const model = view.models.find(
      (entry) => entry.value === view.selection?.model,
    );
    const efforts = model?.efforts ?? [];
    options(
      element<HTMLSelectElement>("claude-effort"),
      [
        { value: "", label: "Model default" },
        ...efforts.map((value) => ({
          value,
          label: effortLabels[value] ?? value,
        })),
      ],
      view.selection?.effort ?? "",
    );
    element("claude-effort").hidden = efforts.length === 0;
    element("claude-effort").previousElementSibling?.toggleAttribute(
      "hidden",
      efforts.length === 0,
    );
    for (const control of panel.querySelectorAll<
      HTMLButtonElement | HTMLSelectElement
    >("button,select"))
      control.disabled = pending || view.status === "checking";
    if (view.status === "signing_in")
      element<HTMLButtonElement>("claude-cancel-sign-in").disabled = pending;
  }
  function schedule(): void {
    if (!active()) return;
    const busy =
      current?.status === "checking" || current?.status === "signing_in";
    timer = setTimeout(
      () => {
        void refresh();
      },
      busy ? 1000 : 4000,
    );
  }
  async function refresh(): Promise<void> {
    if (!active() || pending) return;
    const request = epoch;
    try {
      const reply = await window.desktop.getClaude();
      if (request !== epoch || !active()) return;
      if (!reply.ok) throw new Error();
      render(reply.value);
    } catch {
      if (request === epoch && active()) {
        setText("claude-error", failure);
        element("claude-error").hidden = false;
        element("claude-check").hidden = false;
      }
    }
    if (request === epoch) schedule();
  }
  async function action(work: () => Promise<Reply<ClaudeView>>): Promise<void> {
    if (!active() || pending) return;
    stop();
    localError = null;
    const request = epoch;
    pending = true;
    if (current) render(current);
    try {
      const reply = await work();
      if (request !== epoch || !active()) return;
      if (!reply.ok) {
        localError = reply.message;
        throw new Error();
      }
      current = reply.value;
    } catch {
      if (request === epoch) localError ??= failure;
    } finally {
      if (request === epoch && active()) {
        pending = false;
        if (current) render(current);
        else {
          setText("claude-error", localError ?? failure);
          element("claude-error").hidden = false;
        }
        schedule();
      }
    }
  }
  for (const [id, work] of [
    ["claude-sign-in", () => window.desktop.signInClaude()],
    ["claude-cancel-sign-in", () => window.desktop.cancelClaudeSignIn()],
    ["claude-sign-out", () => window.desktop.signOutClaude()],
    ["claude-check", () => window.desktop.checkClaude()],
  ] as const)
    element(id).addEventListener("click", () => {
      void action(work);
    });
  element("claude-install").addEventListener("click", () => {
    void action(async () => {
      const reply = await window.desktop.openClaudeInstallGuide();
      if (!reply.ok) return reply;
      return window.desktop.getClaude();
    });
  });
  element<HTMLSelectElement>("claude-model").addEventListener(
    "change",
    (event) => {
      const model = current?.models.find(
        (entry) => entry.value === (event.target as HTMLSelectElement).value,
      );
      if (!model) {
        if (current) render(current);
        return;
      }
      void action(() =>
        window.desktop.selectClaudeModel({ model: model.value, effort: null }),
      );
    },
  );
  element<HTMLSelectElement>("claude-effort").addEventListener(
    "change",
    (event) => {
      const model = current?.selection?.model;
      const value = (event.target as HTMLSelectElement).value;
      if (!model) return;
      void action(() =>
        window.desktop.selectClaudeModel({
          model,
          effort: value
            ? (value as NonNullable<ClaudeView["selection"]>["effort"])
            : null,
        }),
      );
    },
  );
  dialog.addEventListener("close", stop);
  return {
    activate() {
      stop();
      pending = false;
      localError = null;
      setText("claude-account", "Checking Claude…");
      void refresh();
    },
    deactivate() {
      stop();
      pending = false;
    },
  };
}
