import {
  assertCaptionSettings,
  defaultCaptionSettings,
  type CaptionSettings,
} from "../../../packages/domain/src/captions.ts";
import { ProjectSettingsStore } from "./project-settings.ts";

/** Per-project caption choices in the app's data folder. */
export class CaptionSettingsStore extends ProjectSettingsStore<CaptionSettings> {
  constructor(root: string) {
    super(root, assertCaptionSettings, defaultCaptionSettings);
  }
}
