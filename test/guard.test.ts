import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import { ConfirmMemo, DEFAULT_SETTINGS, mergeSettings } from "../src/core.ts";
import { coldReason, decidePrompt, formatStatus, resumeMessage, status } from "../src/guard.ts";
import { clearMemo, loadMemo, memoFile, saveMemo } from "../src/memo.ts";
import type { RolloutState } from "../src/rollout.ts";
import { settingsFiles } from "../src/settings.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const HOUR = 3_600_000;
const state = (over: Partial<RolloutState> = {}): RolloutState => ({
  lastAt: NOW - 4 * HOUR, tokens: 180_000, hitRatio: 0.97, model: "gpt-6.1-sol", effort: "low", ...over,
});
const input = { session_id: "s1", turn_id: "t9", model: "gpt-6.1-sol", prompt: "carry on " };

describe("coldReason", () => {
  test("idle past the threshold, a model switch, or nothing", () => {
    expect(coldReason(state(), "gpt-6.1-sol", NOW, DEFAULT_SETTINGS)).toEqual({ kind: "idle", idleMs: 4 * HOUR });
    expect(coldReason(state({ lastAt: NOW - HOUR }), "gpt-6.1-sol", NOW, DEFAULT_SETTINGS)).toBeUndefined();
    expect(coldReason(state({ lastAt: NOW - HOUR }), "gpt-6-astra", NOW, DEFAULT_SETTINGS)).toEqual({ kind: "model", from: "gpt-6.1-sol", to: "gpt-6-astra" });
    expect(coldReason(state({ lastAt: NOW - HOUR, model: undefined }), "gpt-6-astra", NOW, DEFAULT_SETTINGS)).toBeUndefined();
  });
});

describe("decidePrompt", () => {
  test("blocks once with the reason, then lets the same prompt through within the window", () => {
    const memo = new ConfirmMemo();
    const first = decidePrompt(input, state(), memo, NOW, DEFAULT_SETTINGS);
    expect(first.action).toBe("block");
    if (first.action !== "block") throw new Error("unreachable");
    expect(first.reason).toBe(
      "Idle 4h: the prompt cache has probably expired, so this prompt may re-cache 180k tokens. Up arrow recalls it: send it again within 2m to go ahead, run /compact first to continue on a summary, or /new first to start without the history.",
    );
    expect(first.arm).toEqual({ key: "s1", text: "carry on ", at: NOW });
    memo.arm(first.arm.key, first.arm.text, first.arm.at);
    expect(decidePrompt({ ...input, prompt: "carry on" }, state(), memo, NOW + 60_000, DEFAULT_SETTINGS)).toEqual({ action: "pass", clearMemo: true });
    memo.arm(first.arm.key, first.arm.text, first.arm.at);
    expect(decidePrompt(input, state(), memo, NOW + 200_000, DEFAULT_SETTINGS).action).toBe("block");
    memo.arm(first.arm.key, first.arm.text, first.arm.at);
    expect(decidePrompt({ ...input, prompt: "something else" }, state(), memo, NOW + 10_000, DEFAULT_SETTINGS).action).toBe("block");
  });

  test("passes small contexts, warm caches, mid-turn input, no state, and when disabled", () => {
    const memo = new ConfirmMemo();
    expect(decidePrompt(input, state({ tokens: 50_000 }), memo, NOW, DEFAULT_SETTINGS)).toEqual({ action: "pass", clearMemo: true });
    expect(decidePrompt(input, state({ lastAt: NOW - HOUR }), memo, NOW, DEFAULT_SETTINGS)).toEqual({ action: "pass", clearMemo: true });
    expect(decidePrompt(input, state({ openTurn: { turnId: "t1", active: true } }), memo, NOW, DEFAULT_SETTINGS)).toEqual({ action: "pass" });
    expect(decidePrompt(input, state({ openTurn: { turnId: "t9", active: false } }), memo, NOW, DEFAULT_SETTINGS).action).toBe("block");
    expect(decidePrompt(input, undefined, memo, NOW, DEFAULT_SETTINGS)).toEqual({ action: "pass" });
    const off = mergeSettings(DEFAULT_SETTINGS, ['{"warn":{"enabled":false}}']);
    expect(decidePrompt(input, state(), memo, NOW, off)).toEqual({ action: "pass" });
    const strict = mergeSettings(DEFAULT_SETTINGS, ['{"warn":{"minTokens":1000,"idleMinutes":30}}']);
    expect(decidePrompt(input, state({ tokens: 2_000, lastAt: NOW - HOUR }), memo, NOW, strict).action).toBe("block");
  });

  test("a model switch blocks regardless of idle time", () => {
    const d = decidePrompt({ ...input, model: "gpt-6-astra" }, state({ lastAt: NOW - 1_000 }), new ConfirmMemo(), NOW, DEFAULT_SETTINGS);
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.reason).toContain("gpt-6-astra has no cache of this conversation (it was cached for gpt-6.1-sol)");
  });
});

describe("resumeMessage", () => {
  test("warns on resume and fork only, when cold and large", () => {
    expect(resumeMessage({ source: "resume", model: "gpt-6.1-sol" }, state(), NOW, DEFAULT_SETTINGS)).toBe(
      "cache-guard: idle 4h since the last response, so the prompt cache has probably expired; the first prompt re-sends 180k tokens uncached. /compact or a new thread is cheaper.",
    );
    expect(resumeMessage({ source: "fork", model: "gpt-6-astra" }, state({ lastAt: NOW - 1_000 }), NOW, DEFAULT_SETTINGS)).toContain("gpt-6-astra has no cache of this thread");
    expect(resumeMessage({ source: "startup", model: "gpt-6.1-sol" }, state(), NOW, DEFAULT_SETTINGS)).toBeUndefined();
    expect(resumeMessage({ source: "resume", model: "gpt-6.1-sol" }, state({ lastAt: NOW - HOUR }), NOW, DEFAULT_SETTINGS)).toBeUndefined();
    expect(resumeMessage({ source: "resume", model: "gpt-6.1-sol" }, state({ tokens: 1_000 }), NOW, DEFAULT_SETTINGS)).toBeUndefined();
    expect(resumeMessage({ source: "resume" }, undefined, NOW, DEFAULT_SETTINGS)).toBeUndefined();
    // A thread killed mid-turn leaves an open turn behind; a resume still gets the warning.
    expect(resumeMessage({ source: "resume", model: "gpt-6.1-sol" }, state({ openTurn: { turnId: "t1", active: true } }), NOW, DEFAULT_SETTINGS)).toContain("idle 4h");
  });
});

describe("status", () => {
  test("warm, cold and running lines, plain and for tmux", () => {
    const warm = status(state({ lastAt: NOW - 12 * 60_000 }), NOW, DEFAULT_SETTINGS);
    expect(formatStatus(warm)).toBe("cache warm 12m idle · 97% hit");
    expect(formatStatus(warm, true)).toBe("#[fg=green]cache warm 12m idle · 97% hit#[default]");
    expect(formatStatus(status(state({ lastAt: NOW - 12 * 60_000, hitRatio: undefined }), NOW, DEFAULT_SETTINGS))).toBe("cache warm 12m idle");
    const cold = status(state(), NOW, DEFAULT_SETTINGS);
    expect(cold.state).toBe("cold");
    expect(formatStatus(cold)).toBe("cache cold? 4h idle · 180k");
    expect(formatStatus(cold, true)).toBe("#[fg=yellow]cache cold? 4h idle · 180k#[default]");
    expect(formatStatus(status(state({ openTurn: { turnId: "t1", active: true } }), NOW, DEFAULT_SETTINGS))).toBe("cache warm · running");
    expect(formatStatus(status(state({ openTurn: { turnId: "t1", active: false } }), NOW, DEFAULT_SETTINGS))).toBe("cache cold? 4h idle · 180k");
  });
});

describe("memo file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-cache-guard-memo-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("round-trips, clears, and ignores a missing or broken file", () => {
    const file = memoFile(dir, "01a1/../weird id");
    expect(path.dirname(file)).toBe(dir);
    expect(loadMemo(file).confirmed("s1", "x", NOW, 120_000)).toBe(false);
    saveMemo(file, { key: "s1", text: "carry on", at: NOW });
    expect(loadMemo(file).confirmed("s1", "carry on", NOW + 1_000, 120_000)).toBe(true);
    clearMemo(file);
    expect(loadMemo(file).confirmed("s1", "carry on", NOW + 1_000, 120_000)).toBe(false);
    clearMemo(file); // idempotent
    writeFileSync(file, "{nope");
    expect(loadMemo(file).confirmed("s1", "carry on", NOW, 120_000)).toBe(false);
  });
});

describe("settings", () => {
  test("files in precedence order, honoring CODEX_HOME and XDG_CONFIG_HOME", () => {
    const files = settingsFiles("/work/app", { CODEX_HOME: "/cx", XDG_CONFIG_HOME: "/xdg" });
    expect(files).toEqual([
      "/xdg/agents/cache-guard.json",
      "/cx/cache-guard.json",
      "/work/app/.agents/cache-guard.json",
      "/work/app/.codex/cache-guard.json",
    ]);
  });
});
