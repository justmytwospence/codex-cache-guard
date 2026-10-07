#!/usr/bin/env node
// codex-cache-guard: Codex hooks that warn before a prompt re-sends a large thread uncached, and a
// status line for tmux. Runs on Node's type stripping; no build step.
//
//   codex-cache-guard prompt          UserPromptSubmit hook (JSON on stdin)
//   codex-cache-guard session-start   SessionStart hook (JSON on stdin)
//   codex-cache-guard status [--session <id> | --cwd <dir> | --path <rollout>] [--tmux] [--json]
//
// The hooks fail open: on any error they print nothing and exit 0, so a bug here never blocks a
// prompt or spoils a session.
import { readFileSync } from "node:fs";
import path from "node:path";

import { decidePrompt, formatStatus, resumeMessage, status } from "../src/guard.ts";
import { clearMemo, loadMemo, memoFile, saveMemo } from "../src/memo.ts";
import { readRollout } from "../src/rollout.ts";
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

function prompt(): void {
  const input = readStdin();
  if (!input.session_id || !input.transcript_path || typeof input.prompt !== "string") return;
  const settings = loadSettings(input.cwd ?? process.cwd());
  const state = readRollout(input.transcript_path);
  const file = memoFile(cacheDir(), input.session_id);
  const decision = decidePrompt(
    { session_id: input.session_id, turn_id: input.turn_id, model: input.model, prompt: input.prompt },
    state,
    loadMemo(file),
    Date.now(),
    settings,
  );
  if (decision.action === "block") {
    saveMemo(file, decision.arm);
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: decision.reason })}\n`);
  } else if (decision.clearMemo) {
    clearMemo(file);
  }
}

function sessionStart(): void {
  const input = readStdin();
  if (!input.transcript_path) return;
  const settings = loadSettings(input.cwd ?? process.cwd());
  const message = resumeMessage({ source: input.source, model: input.model }, readRollout(input.transcript_path), Date.now(), settings);
  if (message) process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
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

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "prompt":
      prompt();
      break;
    case "session-start":
      sessionStart();
      break;
    case "status":
      process.exitCode = statusCommand(rest);
      break;
    default:
      process.stderr.write("usage: codex-cache-guard prompt | session-start | status [--session <id> | --cwd <dir> | --path <rollout>] [--tmux] [--json]\n");
      process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 2;
  }
} catch (error) {
  // Hooks fail open; status reports.
  if (command === "status") {
    process.stderr.write(`codex-cache-guard: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
