import type { MediaSummary } from "../../../packages/domain/src/library.ts";
import type {
  RecordingDevices,
  RecordingView,
} from "../../../packages/domain/src/recording-view.ts";
import { iconElement } from "./icons.ts";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error("Missing control");
  return value as T;
}

function clock(us: number): string {
  const total = Math.floor(us / 1_000_000);
  const hours = Math.floor(total / 3600),
    minutes = Math.floor((total % 3600) / 60),
    seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * New recording dialog: choose a screen and microphone, count down, then
 * record, pause and stop. Stopping hands the imported take to `finished`.
 */
export function setupRecordPanel(options: {
  finished: (media: MediaSummary) => Promise<void>;
}): void {
  const dialog = element<HTMLDialogElement>("record-dialog");
  const openButton = element<HTMLButtonElement>("record-new");
  const setup = element("record-setup");
  const live = element("record-live");
  const displays = element("record-displays");
  const microphone = element<HTMLSelectElement>("record-microphone");
  const start = element<HTMLButtonElement>("record-start");
  const cancel = element<HTMLButtonElement>("record-cancel");
  const close = element<HTMLButtonElement>("record-close");
  const countdown = element("record-countdown");
  const status = element("record-status");
  const elapsed = element("record-elapsed");
  const health = element("record-health");
  const pause = element<HTMLButtonElement>("record-pause");
  const stop = element<HTMLButtonElement>("record-stop");
  const error = element("record-error");
  let selectedDisplay: string | null = null;
  let poll: number | undefined;
  let busy = false;
  let active = false;
  let counting = false;

  openButton.hidden = false;

  function showError(message: string | null): void {
    error.textContent = message ?? "";
    error.hidden = !message;
  }

  function selectDisplay(id: string): void {
    selectedDisplay = id;
    for (const button of displays.querySelectorAll<HTMLButtonElement>(
      "[role=radio]",
    )) {
      const checked = button.dataset.displayId === id;
      button.setAttribute("aria-checked", String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
    start.disabled = false;
  }

  function renderDevices(devices: RecordingDevices): void {
    displays.replaceChildren();
    for (const display of devices.displays) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "radio");
      button.dataset.displayId = display.id;
      const name = document.createElement("span");
      name.textContent = display.label;
      const size = document.createElement("small");
      size.textContent = `${display.width}×${display.height}`;
      button.append(iconElement("monitor"), name, size);
      button.addEventListener("click", () => selectDisplay(display.id));
      button.addEventListener("keydown", (event) => {
        const buttons = [
          ...displays.querySelectorAll<HTMLButtonElement>("[role=radio]"),
        ];
        const index = buttons.indexOf(button);
        const step =
          event.key === "ArrowRight" || event.key === "ArrowDown"
            ? 1
            : event.key === "ArrowLeft" || event.key === "ArrowUp"
              ? -1
              : 0;
        if (!step) return;
        event.preventDefault();
        const next = buttons[(index + step + buttons.length) % buttons.length]!;
        selectDisplay(next.dataset.displayId!);
        next.focus();
      });
      displays.append(button);
    }
    microphone.replaceChildren();
    for (const item of devices.microphones) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      microphone.append(option);
    }
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "No microphone";
    microphone.append(none);
    const first =
      devices.displays.find((display) => display.primary) ??
      devices.displays[0];
    if (first) selectDisplay(first.id);
    else start.disabled = true;
    if (devices.message) {
      start.disabled = true;
      showError(devices.message);
    }
  }

  function renderView(view: RecordingView): void {
    elapsed.textContent = clock(view.elapsedUs);
    live.dataset.state = view.status;
    const recording = view.status === "recording";
    const paused = view.status === "paused";
    pause.hidden = !(recording || paused);
    pause.disabled = busy;
    pause.textContent = paused ? "Resume" : "Pause";
    pause.dataset.icon = paused ? "record" : "pause";
    stop.disabled = busy || !(recording || paused);
    stop.textContent = view.status === "finishing" ? "Saving…" : "Stop";
    health.textContent =
      view.status === "finishing"
        ? "Saving the recording…"
        : paused
          ? "Paused"
          : view.missedFrames > 0
            ? `${view.missedFrames} ${view.missedFrames === 1 ? "frame was" : "frames were"} missed; the take stays in sync.`
            : "Recording";
    showError(view.message);
  }

  function stopPolling(): void {
    if (poll !== undefined) window.clearInterval(poll);
    poll = undefined;
  }

  function startPolling(): void {
    stopPolling();
    poll = window.setInterval(async () => {
      const reply = await window.desktop.getRecording().catch(() => null);
      if (!reply?.ok || !active) return;
      renderView(reply.value);
    }, 250);
  }

  function showSetup(): void {
    active = false;
    stopPolling();
    setup.hidden = false;
    live.hidden = true;
    close.disabled = false;
  }

  async function openDialog(): Promise<void> {
    if (dialog.open) return;
    showError(null);
    showSetup();
    start.disabled = true;
    displays.replaceChildren();
    dialog.showModal();
    const reply = await window.desktop.getRecordingDevices().catch(() => null);
    if (!dialog.open) return;
    if (!reply?.ok) {
      showError(
        reply && !reply.ok
          ? reply.message
          : "Screens and microphones could not be listed. Try again.",
      );
      return;
    }
    renderDevices(reply.value);
    displays.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }

  async function begin(): Promise<void> {
    if (!selectedDisplay || busy) return;
    busy = true;
    active = true;
    showError(null);
    setup.hidden = true;
    live.hidden = false;
    close.disabled = true;
    status.hidden = true;
    pause.hidden = true;
    // Stop cancels the countdown before anything is captured.
    counting = true;
    stop.disabled = false;
    stop.textContent = "Cancel";
    health.textContent = "";
    countdown.hidden = false;
    for (const value of [3, 2, 1]) {
      countdown.textContent = String(value);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!active) {
        counting = false;
        busy = false;
        return;
      }
    }
    counting = false;
    stop.disabled = true;
    stop.textContent = "Stop";
    countdown.hidden = true;
    status.hidden = false;
    elapsed.textContent = "0:00";
    health.textContent = "Starting…";
    const reply = await window.desktop
      .startRecording({
        schema_version: "1.0",
        display_id: selectedDisplay,
        microphone_id: microphone.value || null,
      })
      .catch(() => null);
    busy = false;
    if (!reply?.ok) {
      showSetup();
      showError(
        reply && !reply.ok ? reply.message : "Recording could not start.",
      );
      return;
    }
    renderView(reply.value);
    startPolling();
    stop.focus();
  }

  async function finish(): Promise<void> {
    if (counting) {
      showSetup();
      start.focus();
      return;
    }
    if (busy) return;
    busy = true;
    stopPolling();
    stop.disabled = true;
    pause.disabled = true;
    stop.textContent = "Saving…";
    health.textContent = "Saving the recording…";
    const reply = await window.desktop.stopRecording().catch(() => null);
    busy = false;
    if (!reply?.ok || reply.value.status !== "finished" || !reply.value.media) {
      const message =
        reply?.ok && reply.value.message
          ? reply.value.message
          : reply && !reply.ok
            ? reply.message
            : "The recording could not be saved. Try recording again.";
      await window.desktop.cancelRecording().catch(() => null);
      showSetup();
      showError(message);
      return;
    }
    const media = reply.value.media;
    await window.desktop.cancelRecording().catch(() => null);
    active = false;
    dialog.close();
    await options.finished(media);
  }

  openButton.addEventListener("click", () => void openDialog());
  start.addEventListener("click", () => void begin());
  stop.addEventListener("click", () => void finish());
  pause.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    pause.disabled = true;
    const paused = live.dataset.state === "paused";
    const reply = await (
      paused
        ? window.desktop.resumeRecording()
        : window.desktop.pauseRecording()
    ).catch(() => null);
    busy = false;
    if (reply?.ok) renderView(reply.value);
    else {
      pause.disabled = false;
      showError(
        reply && !reply.ok ? reply.message : "The recording did not respond.",
      );
    }
  });
  const dismiss = () => {
    if (!live.hidden && !close.disabled) return;
    if (live.hidden) dialog.close();
  };
  cancel.addEventListener("click", dismiss);
  close.addEventListener("click", dismiss);
  dialog.addEventListener("cancel", (event) => {
    // A running take ends only through Stop, so nothing is lost by Escape.
    if (!live.hidden) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    stopPolling();
    if (!active) openButton.focus();
  });
}
