// Reads the prompt-cache clock off a Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`):
// the last response's token usage and when it arrived, the model of the last turn, and whether a
// turn is running now. Only the tail of the file is read; a rollout can run to many megabytes.
import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface RolloutState {
  /** When the last response arrived (its `token_count` event), epoch ms. */
  lastAt: number;
  /** Prompt tokens the next request re-sends: the last request's input plus its output. */
  tokens: number;
  /** Share of the last request's input the cache served, 0-1; undefined when it had no input. */
  hitRatio?: number;
  /**
   * Model the last response was requested from: the `turn_context` in force at its `token_count`.
   * A later `turn_context` without a response (a blocked prompt still writes one) does not count,
   * since no request was made with it, so the cache still belongs to this model.
   */
  model?: string;
  /** Reasoning effort of that request. */
  effort?: string;
  /**
   * The turn that has started and neither completed nor aborted since, if any. Codex writes
   * `task_started` for a prompt's own turn before its UserPromptSubmit hooks run, so the hook
   * compares this with its `turn_id`; `active` says the turn has done more than start (a
   * `turn_context`, a response, a tool call), which a turn still waiting on its hooks has not.
   */
  openTurn?: { turnId?: string; active: boolean };
}

export const TAIL_BYTES = 2 * 1024 * 1024;

/** The last `tailBytes` of `path` as text, starting at a line boundary. */
export function readTail(path: string, tailBytes = TAIL_BYTES): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - tailBytes);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (read <= 0) break;
      offset += read;
    }
    const text = buffer.toString("utf8", 0, offset);
    if (start === 0) return text;
    const newline = text.indexOf("\n");
    return newline < 0 ? "" : text.slice(newline + 1);
  } finally {
    closeSync(fd);
  }
}

interface Usage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

/** Parses rollout JSONL text (whole lines) into the state its last lines describe. */
export function parseRollout(text: string): RolloutState | undefined {
  let last: { at: number; usage: Usage; model?: string; effort?: string } | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let openTurn: RolloutState["openTurn"];
  const usage = (at: number, value: unknown) => {
    if (isUsage(value) && Number.isFinite(at)) last = { at, usage: value, model, effort };
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = row?.payload;
    if (!payload || typeof payload !== "object") continue;
    const at = Date.parse(row.timestamp);
    switch (row.type) {
      case "turn_context":
        if (typeof payload.model === "string") model = payload.model;
        if (typeof payload.effort === "string") effort = payload.effort;
        if (openTurn) openTurn.active = true;
        break;
      case "token_usage_record":
        usage(at, payload.usage);
        if (openTurn) openTurn.active = true;
        break;
      case "response_item":
        if (openTurn) openTurn.active = true;
        break;
      case "event_msg":
        switch (payload.type) {
          case "token_count":
            usage(at, payload.info?.last_token_usage);
            if (openTurn) openTurn.active = true;
            break;
          case "task_started":
            openTurn = { turnId: typeof payload.turn_id === "string" ? payload.turn_id : undefined, active: false };
            break;
          case "task_complete":
          case "turn_aborted":
            openTurn = undefined;
            break;
          case "thread_settings_applied":
            break;
          default:
            if (openTurn) openTurn.active = true;
        }
        break;
    }
  }
  if (!last) return undefined;
  const input = last.usage.input_tokens ?? 0;
  const cached = last.usage.cached_input_tokens ?? 0;
  return {
    lastAt: last.at,
    tokens: input + (last.usage.output_tokens ?? 0),
    hitRatio: input > 0 ? Math.min(1, cached / input) : undefined,
    // A tail that starts after the request's turn_context falls back to the latest one.
    model: last.model ?? model,
    effort: last.effort ?? effort,
    openTurn,
  };
}

/**
 * Whether another turn is running while this hook's prompt arrives (typed mid-turn): the open
 * turn is not the hook's own, or, when the hook names no turn, it has done work already.
 */
export function turnInProgress(state: RolloutState, turnId: string | undefined): boolean {
  if (!state.openTurn) return false;
  if (turnId !== undefined && state.openTurn.turnId !== undefined) return state.openTurn.turnId !== turnId;
  return state.openTurn.active;
}

function isUsage(value: unknown): value is Usage {
  return typeof value === "object" && value !== null && typeof (value as Usage).input_tokens === "number";
}

export function readRollout(path: string): RolloutState | undefined {
  return parseRollout(readTail(path));
}
