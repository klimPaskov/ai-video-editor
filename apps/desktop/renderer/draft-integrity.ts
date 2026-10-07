export type DraftIntegrityFreshness =
  "active-head-changed" | "checked-head-changed" | "current";

export function draftIntegrityFreshness(
  requestedHead: string,
  activeHead: string,
  checkedHead: string,
): DraftIntegrityFreshness {
  if (activeHead !== requestedHead) return "active-head-changed";
  if (checkedHead !== requestedHead) return "checked-head-changed";
  return "current";
}
