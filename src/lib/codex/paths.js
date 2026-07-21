import os from "node:os";
import path from "node:path";

export function resolveCodexHome({ env = process.env, homeDir = os.homedir() } = {}) {
  return path.resolve(env.CODEX_HOME || path.join(homeDir, ".codex"));
}

export function getCodexPaths(options = {}) {
  const home = resolveCodexHome(options);

  return {
    home,
    config: path.join(home, "config.toml"),
    catalog: path.join(home, "voidroute-catalog.json"),
    modelMap: path.join(home, "voidroute-model-map.json"),
    state: path.join(home, "voidroute-state.json"),
    backup: path.join(home, "voidroute-catalog.backup.json"),
    modelsCache: path.join(home, "models_cache.json"),
    auth: path.join(home, "auth.json"),
  };
}
