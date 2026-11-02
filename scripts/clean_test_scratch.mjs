// Removes what earlier unit-test runs left in test-results/ (temporary
// fixture folders, probe archives, screenshots), so it does not grow with
// every run. Native evidence (native-*) and packaged builds (desktop-build-*)
// stay: they are inspected after native runs and cleaned deliberately.
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("test-results");
let entries = [];
try {
  entries = await readdir(root);
} catch {
  process.exit(0);
}
for (const name of entries) {
  if (name.startsWith("native-") || name.startsWith("desktop-build-")) continue;
  await rm(resolve(root, name), { recursive: true, force: true });
}
