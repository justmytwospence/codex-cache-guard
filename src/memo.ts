// The block-once memo, persisted between hook runs: each run is a fresh process, so the prompt a
// previous run blocked lives in `~/.cache/codex-cache-guard/<session_id>.json`.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ConfirmMemo } from "./core.ts";

interface Stored {
  key: string;
  text: string;
  at: number;
}

export function memoFile(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/** A ConfirmMemo holding what the file says, if anything. */
export function loadMemo(file: string): ConfirmMemo {
  const memo = new ConfirmMemo();
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as Partial<Stored>;
    if (typeof stored.key === "string" && typeof stored.text === "string" && typeof stored.at === "number") {
      memo.arm(stored.key, stored.text, stored.at);
    }
  } catch {
    // No memo, or an unreadable one: nothing pending.
  }
  return memo;
}

export function saveMemo(file: string, stored: Stored): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(stored));
  // rename is atomic on the same file system; a concurrent hook sees old or new, never partial.
  renameSync(temporary, file);
}

export function clearMemo(file: string): void {
  rmSync(file, { force: true });
}
