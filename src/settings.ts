import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { DEFAULT_SETTINGS, NAME, mergeSettings } from "./core.ts";
import type { Settings } from "./core.ts";

/** `$CODEX_HOME`, default `~/.codex`: where Codex keeps config, hooks and sessions. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || path.join(homedir(), ".codex");
}

/** `$XDG_CONFIG_HOME/agents` (default `~/.config/agents`): settings shared with the other ports. */
export function sharedConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "agents");
}

/** `$XDG_CACHE_HOME/codex-cache-guard` (default `~/.cache/codex-cache-guard`): per-session memos. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), `codex-${NAME}`);
}

/** The settings files for a session in `cwd`, lowest precedence first. */
export function settingsFiles(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    path.join(sharedConfigDir(env), `${NAME}.json`),
    path.join(codexHome(env), `${NAME}.json`),
    path.join(cwd, ".agents", `${NAME}.json`),
    path.join(cwd, ".codex", `${NAME}.json`),
  ];
}

/** The defaults with each file merged on top in order; unreadable or invalid files are ignored. */
export function loadSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): Settings {
  return mergeSettings(DEFAULT_SETTINGS, settingsFiles(cwd, env).map((file) => {
    try {
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    } catch {
      return undefined;
    }
  }));
}
