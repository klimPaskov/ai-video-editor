import { contextBridge, ipcRenderer } from "electron";

/**
 * Preload for the area picker overlay. It can only report one rectangle,
 * as fractions of the display, or a cancellation; nothing else.
 */
contextBridge.exposeInMainWorld("regionPicker", {
  done(area: { x: number; y: number; width: number; height: number } | null) {
    const valid =
      area === null ||
      (typeof area === "object" &&
        ["x", "y", "width", "height"].every(
          (key) =>
            typeof area[key as keyof typeof area] === "number" &&
            Number.isFinite(area[key as keyof typeof area]),
        ));
    ipcRenderer.send(
      "region:done",
      valid && area
        ? { x: area.x, y: area.y, width: area.width, height: area.height }
        : null,
    );
  },
});
