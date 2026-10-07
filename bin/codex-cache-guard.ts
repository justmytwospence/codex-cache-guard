#!/usr/bin/env node
// codex-cache-guard: Codex hooks that warn before a prompt re-sends a large thread uncached, a
// status line for tmux, and the `cache` pane token for herdr. Runs on Node's type stripping; no
// build step.
//
//   codex-cache-guard prompt          UserPromptSubmit hook (JSON on stdin)
//   codex-cache-guard session-start   SessionStart hook (JSON on stdin)
//   codex-cache-guard stop            Stop hook (JSON on stdin): leaves a sleeper that reports the
//                                     thread cold to herdr once it has sat idle
//   codex-cache-guard session-end     SessionEnd hook (JSON on stdin)
//   codex-cache-guard herdr-check --session <id> --path <rollout> [--stopped-at <ms>]
//                                     what the sleeper runs
//   codex-cache-guard status [--session <id> | --cwd <dir> | --path <rollout>] [--tmux] [--json]
//
// The hooks fail open: on any error they print nothing and exit 0, so a bug here never blocks a
// prompt or spoils a session.
import { readFileSync } from "node:fs";
import path from "node:path";

import { coldReason, decidePrompt, formatStatus, resumeMessage, status } from "../src/guard.ts";
import { SLEEP_OVERRIDE, killSleeper, loadSleeper, reportToHerdr, saveSleeper, sleep, sleepMs, sleeperFile, spawnSleeper, tokenValue } from "../src/herdr-hooks.ts";
import { clearMemo, loadMemo, memoFile, saveMemo } from "../src/memo.ts";
import { readRollout, turnInProgress } from "../src/rollout.ts";
import { findRollout, findRolloutByCwd, listRollouts, threadId } from "../src/sessions.ts";
import { cacheDir, codexHome, loadSettings } from "../src/settings.ts";

interface HookInput {
  session_id?: string;
  turn_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
  permission_mode?: string;
  prompt?: string;
  source?: string;
}

function readStdin(): HookInput {
  try {
    const text = readFileSync(0, "utf8");
    const value: unknown = text.trim() ? JSON.parse(text) : {};
    return typeof value === "object" && value !== null ? (value as HookInput) : {};
  } catch {
    return {};
  }
}

async function prompt(): Promise<void> {
  const input = readStdin();
  if (!input.session_id || !input.transcript_path || typeof input.prompt !== "string") return;
  const settings = loadSettings(input.cwd ?? process.cwd());
  const state = readRollout(input.transcript_path);
  const file = memoFile(cacheDir(), input.session_id);
  const now = Date.now();
  const decision = decidePrompt(
    { session_id: input.session_id, turn_id: input.turn_id, model: input.model, prompt: input.prompt },
    state,
    loadMemo(file),
    now,
    settings,
  );
  if (decision.action === "block") {
    saveMemo(file, decision.arm);
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: decision.reason })}\n`);
    // Doomed, and still idle: tell herdr.
    if (state) await reportToHerdr(tokenValue(coldReason(state, input.model, now, settings), state.tokens, settings));
    return;
  }
  if (decision.clearMemo) clearMemo(file);
  // The prompt goes out: its request reads or rewrites the cache either way, so the thread is no
  // longer doomed. Input into a running turn changes nothing; the Stop at its end reports.
  if (!state || !turnInProgress(state, input.turn_id)) {
    killSleeper(sleeperFile(cacheDir(), input.session_id));
    await reportToHerdr(undefined);
  }
}

async function sessionStart(): Promise<void> {
  const input = readStdin();
  if (!input.transcript_path) return;
  const settings = loadSettings(input.cwd ?? process.cwd());
  const state = readRollout(input.transcript_path);
  const now = Date.now();
  const message = resumeMessage({ source: input.source, model: input.model }, state, now, settings);
  if (message) process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
  // A resumed or forked thread is as cold as its rollout says; a new, cleared or compacted one is warm.
  const resumed = input.source === "resume" || input.source === "fork";
  await reportToHerdr(resumed && state ? tokenValue(coldReason(state, input.model, now, settings), state.tokens, settings) : undefined);
}

/** Stop: the turn's requests just used the cache. Clear the token and leave a sleeper to report the thread cold later. */
async function stop(): Promise<void> {
  const input = readStdin();
  if (!input.session_id) return;
  const file = sleeperFile(cacheDir(), input.session_id);
  killSleeper(file);
  await reportToHerdr(undefined);
  const settings = loadSettings(input.cwd ?? process.cwd());
  if (!settings.enabled || !settings.herdr.enabled || !input.transcript_path) return;
  const stoppedAt = Date.now();
  const pid = spawnSleeper({
    node: process.execPath,
    script: process.argv[1] ?? "",
    sessionId: input.session_id,
    rollout: input.transcript_path,
    stoppedAt,
    env: process.env,
  });
  if (pid !== undefined) saveSleeper(file, { pid, stoppedAt });
}

async function sessionEnd(): Promise<void> {
  const input = readStdin();
  if (!input.session_id) return;
  killSleeper(sleeperFile(cacheDir(), input.session_id));
  clearMemo(memoFile(cacheDir(), input.session_id));
  await reportToHerdr(undefined);
}

/** The sleeper: wait out the idle threshold, then report the thread cold if it still is. */
async function herdrCheck(args: string[]): Promise<void> {
  let sessionId: string | undefined;
  let rollout: string | undefined;
  let stoppedAt: number | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--session") sessionId = args[++index];
    else if (args[index] === "--path") rollout = args[++index];
    else if (args[index] === "--stopped-at") stoppedAt = Number(args[++index]);
  }
  if (!sessionId || !rollout) return;
  const file = sleeperFile(cacheDir(), sessionId);
  const settings = loadSettings(process.cwd());
  await sleep(sleepMs(settings));
  // A later Stop replaced this sleeper (and should have killed it); SessionEnd removed the record.
  const current = loadSleeper(file);
  if (!current || (stoppedAt !== undefined && current.stoppedAt !== stoppedAt)) return;
  const state = readRollout(rollout);
  if (!state || turnInProgress(state, undefined)) return;
  const value = tokenValue(coldReason(state, undefined, Date.now(), settings), state.tokens, settings);
  if (value !== undefined) await reportToHerdr(value);
}

function statusCommand(args: string[]): number {
  let file: string | undefined;
  let tmux = false;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--tmux") tmux = true;
    else if (arg === "--json") json = true;
    else if (arg === "--latest") file = undefined;
    else if (arg === "--path") file = args[++index];
    else if (arg === "--cwd") {
      const dir = path.resolve(args[++index] ?? ".");
      file = findRolloutByCwd(path.join(codexHome(), "sessions"), dir);
      if (!file) {
        process.stderr.write(`codex-cache-guard: no rollout started in ${dir}\n`);
        return 1;
      }
    } else if (arg === "--session") {
      const id = args[++index];
      file = id ? findRollout(path.join(codexHome(), "sessions"), id) : undefined;
      if (!file) {
        process.stderr.write(`codex-cache-guard: no rollout for session ${id ?? "(none)"}\n`);
        return 1;
      }
    } else {
      process.stderr.write(`codex-cache-guard: unknown option ${arg}\n`);
      return 2;
    }
  }
  file ??= listRollouts(path.join(codexHome(), "sessions"))[0];
  if (!file) {
    process.stderr.write("codex-cache-guard: no rollouts found\n");
    return 1;
  }
  const state = readRollout(file);
  if (!state) {
    if (json) process.stdout.write(`${JSON.stringify({ path: file, session: threadId(file), state: null })}\n`);
    return 0;
  }
  const s = status(state, Date.now(), loadSettings(process.cwd()));
  if (json) process.stdout.write(`${JSON.stringify({ ...s, path: file, session: threadId(file), text: formatStatus(s) })}\n`);
  else process.stdout.write(`${formatStatus(s, tmux)}\n`);
  return 0;
}

const USAGE = [
  "usage: codex-cache-guard prompt | session-start | stop | session-end",
  "       codex-cache-guard herdr-check --session <id> --path <rollout> [--stopped-at <ms>]",
  "       codex-cache-guard status [--session <id> | --cwd <dir> | --path <rollout>] [--tmux] [--json]",
  `       (${SLEEP_OVERRIDE} overrides the sleeper's delay)`,
].join("\n");

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "prompt":
      await prompt();
      break;
    case "session-start":
      await sessionStart();
      break;
    case "stop":
      await stop();
      break;
    case "session-end":
      await sessionEnd();
      break;
    case "herdr-check":
      await herdrCheck(rest);
      break;
    case "status":
      process.exitCode = statusCommand(rest);
      break;
    default:
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 2;
  }
} catch (error) {
  // Hooks fail open; status reports.
  if (command === "status") {
    process.stderr.write(`codex-cache-guard: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
