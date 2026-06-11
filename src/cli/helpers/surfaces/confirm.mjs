import { text, log } from "../ui.mjs";

// Prompts user to confirm or override each detected surface. Returns confirmed surface map.
// `rl` is kept for signature compatibility; prompting now goes through clack.
export async function confirmSurfaces(detected, rl, opts = {}) {
  const isNx = detected !== null;
  const d = detected ?? {};

  if (opts.yes || !process.stdin.isTTY) {
    return {
      backend: d.backend ?? [],
      frontend: d.frontend ?? [],
      distributed: d.distributed ?? [],
      sharedSchema: d.sharedSchema ?? [],
      sharedTypes: d.sharedTypes ?? [],
      sharedUi: d.sharedUi ?? [],
    };
  }

  function parse(raw, defaults) {
    if (!raw || !raw.trim()) return defaults ?? [];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  async function ask(label, defaults) {
    const hint = defaults && defaults.length ? defaults.join(", ") : "";
    const raw = await text({
      message: label,
      placeholder: hint
        ? `${hint}  (Enter to accept)`
        : "none — leave blank to skip",
    });
    return parse(raw, defaults);
  }

  if (!isNx) {
    log.warn(
      "No nx.json found — this doesn't look like an Nx workspace.\nEnter your project surface paths manually, or leave blank to skip.",
    );
  } else {
    log.info(
      "Nx workspace detected. Confirm surface paths — leave blank to accept the detected value.",
    );
  }

  return {
    backend: await ask("Backend / serverless paths", d.backend ?? []),
    frontend: await ask("Frontend paths", d.frontend ?? []),
    distributed: await ask("Worker / queue paths", d.distributed ?? []),
    sharedSchema: await ask("Shared schema lib paths", d.sharedSchema ?? []),
    sharedTypes: await ask("Shared types lib paths", d.sharedTypes ?? []),
    sharedUi: await ask("Shared UI lib paths", d.sharedUi ?? []),
  };
}
