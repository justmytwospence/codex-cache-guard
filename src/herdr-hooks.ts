// herdr reporting from Codex hooks. Codex has no long-lived plugin process: each hook is a fresh
// process that runs and exits, so the `cache` pane token is set at the moments the hooks see
// (a blocked prompt, a cold resume), cleared when a request goes out, and set by a detached sleeper
// the Stop hook leaves behind, which wakes after `warn.idleMinutes` and reports the thread cold if
// nothing happened since. The sleeper's pid lives in `<cache dir>/<session>.sleeper.json`, so the
// next Stop (or SessionEnd) kills it before starting another.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { herdrCacheValue } from "./core.ts";
import type { ColdReason, Settings } from "./core.ts";
import { herdrRequest, herdrTarget, sendHerdr } from "./herdr.ts";

/** The sleeper's own delay (ms) instead of `warn.idleMinutes`; for tests. */
export const SLEEP_OVERRIDE = "CODEX_CACHE_GUARD_SLEEP_MS";

/** Sets, or with undefined clears, the pane token; resolves true on a reply. Nothing outside herdr. */
export function reportToHerdr(value: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const target = herdrTarget(env);
  if (!target) return Promise.resolve(false);
  return sendHerdr(target, herdrRequest(target, "codex", value));
}

/** The token value for a thread that would re-send `tokens` uncached for `reason`, or undefined. */
export function tokenValue(reason: ColdReason | undefined, tokens: number, settings: Settings): string | undefined {
  // Codex carries no prices: the size threshold decides.
  return herdrCacheValue(reason, tokens, undefined, settings);
}

export interface Sleeper {
  pid: number;
  /** When the Stop hook that started it ran; a sleeper whose record changed underneath it stands down. */
  stoppedAt: number;
}

export function sleeperFile(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.sleeper.json`);
}

export function loadSleeper(file: string): Sleeper | undefined {
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as Partial<Sleeper>;
    if (typeof stored.pid === "number" && typeof stored.stoppedAt === "number") return { pid: stored.pid, stoppedAt: stored.stoppedAt };
  } catch {
    // No sleeper recorded.
  }
  return undefined;
}

export function saveSleeper(file: string, sleeper: Sleeper): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(sleeper));
  renameSync(temporary, file);
}

/** Kills the recorded sleeper, if any, and forgets it. */
export function killSleeper(file: string): void {
  const sleeper = loadSleeper(file);
  rmSync(file, { force: true });
  if (!sleeper) return;
  try {
    process.kill(sleeper.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

export interface SleeperSpawn {
  /** The script to run (`bin/codex-cache-guard.ts`) and the Node to run it with. */
  script: string;
  node: string;
  sessionId: string;
  rollout: string;
  stoppedAt: number;
  env: NodeJS.ProcessEnv;
}

/**
 * Starts the detached sleeper: its own session and no stdio, so the Stop hook's pipes close when
 * the hook exits and Codex does not wait for it. Returns its pid.
 */
export function spawnSleeper(spec: SleeperSpawn): number | undefined {
  const child = spawn(
    spec.node,
    ["--no-warnings", "--experimental-strip-types", spec.script, "herdr-check", "--session", spec.sessionId, "--path", spec.rollout, "--stopped-at", String(spec.stoppedAt)],
    { detached: true, stdio: "ignore", env: spec.env },
  );
  child.unref();
  return child.pid;
}

/** How long the sleeper waits before judging the thread: `warn.idleMinutes`, or the test override. */
export function sleepMs(settings: Settings, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env[SLEEP_OVERRIDE]);
  if (Number.isFinite(override) && override >= 0) return override;
  return settings.warn.idleMinutes * 60_000;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
