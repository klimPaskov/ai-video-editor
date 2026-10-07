import type { CodexView } from "../../../packages/domain/src/codex-view.ts";
import type { Reply } from "../src/bridge.ts";
import { setupProviderSettings } from "./provider-settings.ts";
import { setupClaudeSettings } from "./claude-settings.ts";

export function setupCodexSettings(dialog: HTMLDialogElement): () => void {
  const element = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id)! as T;
  const panel = element("codex-settings");
  const providerSettings = setupProviderSettings(dialog);
  const claudeSettings = setupClaudeSettings(dialog);
  let epoch = 0;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: CodexView | undefined;
  let localError: string | null = null;
  let deviceCode: { verificationUrl: string; userCode: string } | undefined;
  const deviceVerificationUrl = "https://auth.openai.com/codex/device";
  const active = () => dialog.open && !panel.hidden;
  function stop(): void {
    epoch++;
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  function setText(id: string, value: string): void {
    const target = element(id);
    if (target.textContent !== value) target.textContent = value;
  }
  function clearDeviceCode(): void {
    deviceCode = undefined;
    const link = element<HTMLAnchorElement>("codex-device-url");
    link.removeAttribute("href");
    link.textContent = "";
    setText("codex-device-code", "");
    element("codex-device-details").hidden = true;
  }
  function showDeviceCode(value: {
    verificationUrl: string;
    userCode: string;
  }): void {
    if (
      value.verificationUrl !== deviceVerificationUrl ||
      typeof value.userCode !== "string" ||
      value.userCode.length === 0 ||
      value.userCode.length > 128
    )
      throw new Error("Invalid sign-in details");
    deviceCode = value;
    const link = element<HTMLAnchorElement>("codex-device-url");
    link.href = value.verificationUrl;
    link.textContent = value.verificationUrl;
    setText("codex-device-code", value.userCode);
    element("codex-device-details").hidden = false;
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
  function render(view: CodexView): void {
    current = view;
    if (
      view.account !== "signing_in" ||
      view.connection !== "connected" ||
      view.message !== null
    )
      clearDeviceCode();
    const message = view.message ?? localError;
    setText(
      "codex-account",
      view.account === "signed_in"
        ? `ChatGPT · ${view.plan ? view.plan.charAt(0).toUpperCase() + view.plan.slice(1) : "Signed in"}`
        : view.account === "signing_in"
          ? deviceCode
            ? "Finish sign-in using the code"
            : "Waiting for ChatGPT sign-in…"
          : view.account === "signed_out"
            ? "Sign in to use Codex"
            : "Codex is unavailable",
    );
    const show = (id: string, visible: boolean) => {
      element(id).hidden = !visible;
    };
    show(
      "codex-login",
      view.connection === "connected" && view.account === "signed_out",
    );
    show(
      "codex-device-login",
      view.connection === "connected" && view.account === "signed_out",
    );
    show("codex-cancel-login", view.account === "signing_in");
    show("codex-logout", view.account === "signed_in");
    show(
      "codex-reconnect",
      view.connection !== "connected" || message !== null,
    );
    show("codex-disclosure", view.account !== "signed_in");
    show("codex-error", message !== null);
    setText("codex-error", message ?? "");
    show(
      "codex-model-settings",
      view.account === "signed_in" && view.models.length > 0,
    );
    options(
      element<HTMLSelectElement>("codex-model"),
      [
        { value: "", label: "Choose a model" },
        ...view.models.map((model) => ({ value: model.id, label: model.name })),
      ],
      view.selection?.modelId ?? "",
    );
    const model = view.models.find(
      (entry) => entry.id === view.selection?.modelId,
    );
    options(
      element<HTMLSelectElement>("codex-reasoning"),
      (model?.reasoning ?? []).map((value) => ({ value, label: value })),
      view.selection?.reasoning ?? "",
    );
    const usage = view.limits.map(
      (limit) =>
        `${limit.name}: ${Math.round(limit.remainingPercent)}% remaining${limit.resetsAt === null ? "" : ` · resets ${new Date(limit.resetsAt * 1000).toLocaleString()}`}`,
    );
    const skills = view.skills.map(
      (skill) => `${skill.name}${skill.enabled ? "" : " (disabled)"}`,
    );
    for (const [id, values] of [
      ["codex-limits", usage],
      ["codex-skills", skills],
    ] as const) {
      const target = element(id),
        key = JSON.stringify(values);
      if (target.dataset.items !== key) {
        target.replaceChildren(
          ...values.map((text) => {
            const li = document.createElement("li");
            li.textContent = text;
            return li;
          }),
        );
        target.dataset.items = key;
      }
    }
    show("codex-limits", usage.length > 0);
    show("codex-advanced", skills.length > 0);
    for (const control of panel.querySelectorAll<
      HTMLButtonElement | HTMLSelectElement
    >("button,select"))
      control.disabled = pending || view.busy;
    element("codex-device-url").setAttribute(
      "aria-disabled",
      String(pending || view.busy),
    );
  }
  function schedule(): void {
    if (active())
      timer = setTimeout(() => {
        void refresh();
      }, 1500);
  }
  async function refresh(): Promise<void> {
    if (!active() || pending) return;
    const request = epoch;
    try {
      const reply = await window.desktop.getCodex();
      if (request !== epoch || !active()) return;
      if (!reply.ok) throw new Error();
      render(reply.value);
    } catch {
      if (request === epoch && active()) {
        setText(
          "codex-error",
          "Codex settings could not be loaded. Reconnect to try again.",
        );
        element("codex-error").hidden = false;
        element("codex-reconnect").hidden = false;
      }
    }
    if (request === epoch) schedule();
  }
  async function action(work: () => Promise<Reply<CodexView>>): Promise<void> {
    if (!active() || pending) return;
    stop();
    clearDeviceCode();
    localError = null;
    const request = epoch;
    pending = true;
    if (current) render(current);
    let failed = false;
    try {
      const reply = await work();
      if (request !== epoch || !active()) return;
      if (!reply.ok) throw new Error();
      current = reply.value;
    } catch {
      failed = true;
      if (request === epoch)
        localError =
          "This Codex action could not finish. Reconnect or try again.";
    } finally {
      if (request === epoch && active()) {
        pending = false;
        if (current) render(current);
        if (failed) {
          setText(
            "codex-error",
            "This Codex action could not finish. Reconnect or try again.",
          );
          element("codex-error").hidden = false;
          element("codex-reconnect").hidden = false;
        }
        schedule();
      }
    }
  }
  async function deviceLogin(): Promise<void> {
    if (!active() || pending) return;
    stop();
    clearDeviceCode();
    localError = null;
    const request = epoch;
    pending = true;
    if (current) render(current);
    try {
      const reply = await window.desktop.loginCodexDeviceCode();
      if (request !== epoch || !active()) return;
      if (!reply.ok) throw new Error();
      const account = await window.desktop.getCodex();
      if (request !== epoch || !active()) return;
      if (!account.ok) throw new Error();
      current = account.value;
      if (account.value.account === "signing_in") showDeviceCode(reply.value);
      else if (account.value.account !== "signed_in") throw new Error();
    } catch {
      if (request === epoch) {
        clearDeviceCode();
        localError = "Sign-in could not start. Reconnect or try again.";
      }
    } finally {
      if (request === epoch && active()) {
        pending = false;
        if (current) render(current);
        schedule();
      }
    }
  }
  async function openDeviceVerification(): Promise<void> {
    if (!active() || pending || !deviceCode || current?.busy) return;
    stop();
    const request = epoch;
    pending = true;
    if (current) render(current);
    try {
      const reply = await window.desktop.openCodexDeviceVerification();
      if (request !== epoch || !active()) return;
      if (!reply.ok) throw new Error();
    } catch {
      if (request === epoch) {
        clearDeviceCode();
        localError =
          "The sign-in page could not open. Cancel sign-in and try again.";
      }
    } finally {
      if (request === epoch && active()) {
        pending = false;
        if (current) render(current);
        schedule();
      }
    }
  }
  element("codex-device-login").addEventListener("click", () => {
    void deviceLogin();
  });
  element<HTMLAnchorElement>("codex-device-url").addEventListener(
    "click",
    (event) => {
      event.preventDefault();
      void openDeviceVerification();
    },
  );
  for (const [id, work] of [
    ["codex-login", () => window.desktop.loginCodex()],
    ["codex-cancel-login", () => window.desktop.cancelCodexLogin()],
    ["codex-logout", () => window.desktop.logoutCodex()],
    ["codex-reconnect", () => window.desktop.reconnectCodex()],
  ] as const)
    element(id).addEventListener("click", () => {
      void action(work);
    });
  element<HTMLSelectElement>("codex-model").addEventListener(
    "change",
    (event) => {
      const model = current?.models.find(
        (entry) => entry.id === (event.target as HTMLSelectElement).value,
      );
      if (!model && current) render(current);
      if (model)
        void action(() =>
          window.desktop.selectCodexModel({
            modelId: model.id,
            reasoning: model.defaultReasoning,
          }),
        );
    },
  );
  element<HTMLSelectElement>("codex-reasoning").addEventListener(
    "change",
    (event) => {
      const modelId = current?.selection?.modelId,
        reasoning = (event.target as HTMLSelectElement).value;
      if (modelId)
        void action(() =>
          window.desktop.selectCodexModel({ modelId, reasoning }),
        );
    },
  );
  function section(selected: "appearance" | "claude" | "codex" | "api"): void {
    stop();
    clearDeviceCode();
    providerSettings.deactivate();
    claudeSettings.deactivate();
    pending = false;
    panel.hidden = selected !== "codex";
    element("claude-settings").hidden = selected !== "claude";
    element("api-provider-settings").hidden = selected !== "api";
    element("appearance-settings").hidden = selected !== "appearance";
    element("appearance-actions").hidden = selected !== "appearance";
    element("settings-error").hidden = true;
    element("settings-appearance").setAttribute(
      "aria-pressed",
      String(selected === "appearance"),
    );
    element("settings-claude").setAttribute(
      "aria-pressed",
      String(selected === "claude"),
    );
    element("settings-codex").setAttribute(
      "aria-pressed",
      String(selected === "codex"),
    );
    element("settings-api-providers").setAttribute(
      "aria-pressed",
      String(selected === "api"),
    );
    if (selected === "codex") {
      setText("codex-account", "Connecting to Codex…");
      void refresh();
    }
    if (selected === "api") providerSettings.activate();
    if (selected === "claude") claudeSettings.activate();
  }
  element("settings-appearance").addEventListener("click", () =>
    section("appearance"),
  );
  element("settings-claude").addEventListener("click", () => section("claude"));
  element("settings-codex").addEventListener("click", () => section("codex"));
  element("settings-api-providers").addEventListener("click", () =>
    section("api"),
  );
  dialog.addEventListener("close", () => {
    stop();
    clearDeviceCode();
  });
  return () => section("appearance");
}
