// The decisions, free of I/O: what the UserPromptSubmit hook answers, what the SessionStart hook
// says on a resume, and the one-line status. The caller reads the rollout and the memo.
import { describeMiss, formatDuration, formatTokens, worthWarning } from "./core.ts";
import type { ColdReason, ConfirmMemo, Settings } from "./core.ts";
import { turnInProgress } from "./rollout.ts";
import type { RolloutState } from "./rollout.ts";

/**
 * Why the next request on this thread misses the cache, if it does. Codex publishes no TTL
 * and ChatGPT-plan hits often survive hours, so idle is a likelihood, not a clock; a model
 * switch is certain (each model has its own cache). A running turn refreshes the cache itself.
 */
export function coldReason(state: RolloutState, model: string | undefined, now: number, settings: Settings): ColdReason | undefined {
  if (model && state.model && model !== state.model) return { kind: "model", from: state.model, to: model };
  const idleMs = Math.max(0, now - state.lastAt);
  if (idleMs >= settings.warn.idleMinutes * 60_000) return { kind: "idle", idleMs };
  return undefined;
}

export type PromptDecision =
  | { action: "pass"; clearMemo?: boolean }
  | { action: "block"; reason: string; arm: { key: string; text: string; at: number } };

/**
 * UserPromptSubmit: block once when the prompt would re-send a large context uncached; the same
 * prompt sent again within `warn.confirmSeconds` goes through.
 */
export function decidePrompt(
  input: { session_id: string; turn_id?: string; model?: string; prompt: string },
  state: RolloutState | undefined,
  memo: ConfirmMemo,
  now: number,
  settings: Settings,
): PromptDecision {
  if (!settings.enabled || !settings.warn.enabled || !state) return { action: "pass" };
  // Input typed while a turn runs reaches the model inside that turn, whose requests keep the
  // cache fresh; only a prompt that starts a turn can pay for a miss.
  if (turnInProgress(state, input.turn_id)) return { action: "pass" };
  const cold = coldReason(state, input.model, now, settings);
  if (!cold || !worthWarning(state.tokens, undefined, settings)) return { action: "pass", clearMemo: true };
  if (memo.confirmed(input.session_id, input.prompt, now, settings.warn.confirmSeconds * 1000)) {
    return { action: "pass", clearMemo: true };
  }
  const window = formatDuration(settings.warn.confirmSeconds * 1000);
  return {
    action: "block",
    reason: `${describeMiss(cold, state.tokens, undefined)} Up arrow recalls it: send it again within ${window} to go ahead, run /compact first to continue on a summary, or /new first to start without the history.`,
    arm: { key: input.session_id, text: input.prompt, at: now },
  };
}

/** SessionStart on a resume or fork: the warning line, or nothing. */
export function resumeMessage(
  input: { source?: string; model?: string },
  state: RolloutState | undefined,
  now: number,
  settings: Settings,
): string | undefined {
  if (!settings.enabled || !settings.warn.enabled || !state) return undefined;
  if (input.source !== "resume" && input.source !== "fork") return undefined;
  const cold = coldReason(state, input.model, now, settings);
  if (!cold || !worthWarning(state.tokens, undefined, settings)) return undefined;
  const tokens = formatTokens(state.tokens);
  const cause = cold.kind === "model"
    ? `${cold.to} has no cache of this thread (it was cached for ${cold.from})`
    : `idle ${formatDuration(cold.idleMs)} since the last response, so the prompt cache has probably expired`;
  return `cache-guard: ${cause}; the first prompt re-sends ${tokens} tokens uncached. /compact or a new thread is cheaper.`;
}

export interface Status {
  state: "running" | "warm" | "cold";
  idleMs: number;
  tokens: number;
  hitRatio?: number;
  model?: string;
  lastAt: number;
}

export function status(state: RolloutState, now: number, settings: Settings): Status {
  const idleMs = Math.max(0, now - state.lastAt);
  const kind = turnInProgress(state, undefined) ? "running" : idleMs >= settings.warn.idleMinutes * 60_000 ? "cold" : "warm";
  return { state: kind, idleMs, tokens: state.tokens, hitRatio: state.hitRatio, model: state.model, lastAt: state.lastAt };
}

/** `cache warm 12m idle · 97% hit`, `cache cold? 4h idle · 180k`, `cache warm · running`. */
export function formatStatus(s: Status, tmux = false): string {
  const color = (name: string, text: string) => (tmux ? `#[fg=${name}]${text}#[default]` : text);
  if (s.state === "running") return color("green", "cache warm · running");
  if (s.state === "cold") return color("yellow", `cache cold? ${formatDuration(s.idleMs)} idle · ${formatTokens(s.tokens)}`);
  const hit = s.hitRatio === undefined ? "" : ` · ${Math.round(s.hitRatio * 100)}% hit`;
  return color("green", `cache warm ${formatDuration(s.idleMs)} idle${hit}`);
}
