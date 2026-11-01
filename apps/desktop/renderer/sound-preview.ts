import type { SoundLayerView } from "../../../packages/domain/src/sound-view.ts";
import { linearGain } from "../../../packages/domain/src/sounds.ts";

/**
 * Plays the draft's sound layers beside the preview video. It follows the
 * playhead the player reports and corrects any drift, so it never drives
 * playback. Display only: ducking under speech and the final mix are applied
 * by the export, which is authoritative.
 */
export function setupSoundPreview(options: {
  projectId(): string | undefined;
}): {
  /** Replace the layers (after the draft or the panel changed). */
  layers(next: readonly SoundLayerView[]): void;
  /** Called with every reported output position while the video plays. */
  follow(outputUs: number): void;
  /** Playback paused, stopped or the project changed. */
  stop(): void;
} {
  let layers: SoundLayerView[] = [];
  const players = new Map<string, HTMLAudioElement>();

  function url(layer: SoundLayerView, projectId: string): string {
    return new URL(`sounds/${projectId}/${layer.asset_id}`, location.href).href;
  }

  function stop(): void {
    for (const audio of players.values()) audio.pause();
  }

  return {
    layers(next) {
      const keep = new Set(next.map((layer) => layer.sound_id));
      for (const [id, audio] of players)
        if (!keep.has(id)) {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
          players.delete(id);
        }
      layers = [...next];
    },
    follow(outputUs) {
      const projectId = options.projectId();
      if (!projectId) return;
      for (const layer of layers) {
        const range = layer.timeline_range;
        let audio = players.get(layer.sound_id);
        if (!range || outputUs < range.start_us || outputUs >= range.end_us) {
          audio?.pause();
          continue;
        }
        if (!audio) {
          audio = new Audio();
          audio.preload = "auto";
          audio.loop = layer.loop;
          audio.src = url(layer, projectId);
          players.set(layer.sound_id, audio);
        }
        const into = outputUs - range.start_us;
        const fadeIn = layer.fade_in_us > 0 ? into / layer.fade_in_us : 1;
        const fadeOut =
          layer.fade_out_us > 0
            ? (range.end_us - outputUs) / layer.fade_out_us
            : 1;
        audio.volume = Math.min(
          1,
          linearGain(layer.gain_db) * Math.max(0, Math.min(1, fadeIn, fadeOut)),
        );
        const wanted = (layer.asset_start_us + into) / 1_000_000;
        const length = audio.duration;
        const target =
          Number.isFinite(length) && length > 0 && layer.loop
            ? wanted % length
            : wanted;
        if (audio.paused) {
          if (audio.readyState >= 1) audio.currentTime = target;
          void audio.play().catch(() => undefined);
        } else if (Math.abs(audio.currentTime - target) > 0.35) {
          audio.currentTime = target;
        }
      }
    },
    stop,
  };
}
