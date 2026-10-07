// Finds rollouts under `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl`.
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Every rollout file, newest modified first. */
export function listRollouts(sessionsDir: string): string[] {
  const files: Array<{ file: string; mtime: number }> = [];
  const walk = (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
      } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        try {
          files.push({ file: full, mtime: statSync(full).mtimeMs });
        } catch {
          // Deleted between readdir and stat.
        }
      }
    }
  };
  walk(sessionsDir, 0);
  return files.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.file);
}

/** The rollout of thread `id` (a full id, or any part of one), newest first on a tie. */
export function findRollout(sessionsDir: string, id: string): string | undefined {
  return listRollouts(sessionsDir).find((file) => path.basename(file).includes(id));
}

/** The thread id in a rollout file name. */
export function threadId(file: string): string | undefined {
  return /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path.basename(file))?.[1];
}

/** The `cwd` a rollout's `session_meta` line names; undefined when the head is not one. */
export function rolloutCwd(file: string): string | undefined {
  const fd = openSync(file, "r");
  try {
    // The first line carries the base instructions and runs to tens of kilobytes.
    const chunk = Buffer.alloc(64 * 1024);
    let head = "";
    let offset = 0;
    while (head.indexOf("\n") < 0 && offset < 1024 * 1024) {
      const read = readSync(fd, chunk, 0, chunk.length, offset);
      if (read <= 0) break;
      head += chunk.toString("utf8", 0, read);
      offset += read;
    }
    const end = head.indexOf("\n");
    const row = JSON.parse(end < 0 ? head : head.slice(0, end));
    return row?.type === "session_meta" && typeof row.payload?.cwd === "string" ? row.payload.cwd : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The newest rollout started in `cwd`. */
export function findRolloutByCwd(sessionsDir: string, cwd: string): string | undefined {
  return listRollouts(sessionsDir).find((file) => rolloutCwd(file) === cwd);
}
