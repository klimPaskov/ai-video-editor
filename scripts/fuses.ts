import {
  flipFuses,
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from "@electron/fuses";

/**
 * Electron fuses for RELEASE builds (`--release`). The test and development
 * build leaves them alone: Playwright launches Electron with `--inspect=0`,
 * which needs EnableNodeCliInspectArguments.
 *
 * RunAsNode stays enabled on purpose: the Claude and Codex editor-tool child
 * processes are this executable started with ELECTRON_RUN_AS_NODE
 * (apps/desktop/src/claude.ts, packages/codex-tools). Everything else the
 * security review asked for is set here.
 */
export const releaseFuses = {
  [FuseV1Options.RunAsNode]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
} as const;

export type FuseName = keyof typeof FuseV1Options;

const stateNames: Record<number, string> = {
  [FuseState.ENABLE]: "enabled",
  [FuseState.DISABLE]: "disabled",
  [FuseState.REMOVED]: "removed",
  [FuseState.INHERIT]: "inherit",
};

/** Fuse states by readable name, as stored in a built Electron binary. */
export async function readFuses(
  electronBinary: string,
): Promise<Record<string, string>> {
  const wire = await getCurrentFuseWire(electronBinary);
  const result: Record<string, string> = {};
  for (const [name, index] of Object.entries(FuseV1Options)) {
    if (typeof index !== "number") continue;
    const state = wire[index as FuseV1Options];
    if (state !== undefined) result[name] = stateNames[state] ?? String(state);
  }
  return result;
}

export function expectedReleaseFuses(): Record<string, string> {
  const expected: Record<string, string> = {};
  for (const [index, value] of Object.entries(releaseFuses))
    expected[FuseV1Options[Number(index)] as string] = value
      ? "enabled"
      : "disabled";
  return expected;
}

export async function applyReleaseFuses(
  electronBinary: string,
): Promise<Record<string, string>> {
  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    ...releaseFuses,
  });
  const state = await readFuses(electronBinary);
  for (const [name, wanted] of Object.entries(expectedReleaseFuses()))
    if (state[name] !== wanted)
      throw new Error(`Fuse ${name} is ${state[name]}, expected ${wanted}`);
  return state;
}
