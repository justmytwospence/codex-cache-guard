import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import { parseRollout, readRollout, readTail, turnInProgress } from "../src/rollout.ts";
import { findRollout, findRolloutByCwd, listRollouts, rolloutCwd, threadId } from "../src/sessions.ts";

// Synthetic rows in the shape of a Codex 0.160.1 rollout (`~/.codex/sessions/.../rollout-*.jsonl`).
const T0 = Date.parse("2026-10-07T12:00:00Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
let ordinal = 0;
const row = (timestamp: string, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp, ordinal: ordinal++, type, payload });
const meta = (cwd: string, id = "01a10000-0000-7000-8000-000000000001") =>
  row(at(0), "session_meta", { id, session_id: id, cwd, cli_version: "0.160.1", base_instructions: { text: "x".repeat(30_000) } });
const started = (ms: number, turn: string) => row(at(ms), "event_msg", { type: "task_started", turn_id: turn, started_at: 0 });
const context = (ms: number, turn: string, model: string, effort = "low") => row(at(ms), "turn_context", { turn_id: turn, model, effort });
const usage = (ms: number, input: number, cached: number, output: number) => [
  row(at(ms), "token_usage_record", { usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output } }),
  row(at(ms + 1), "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output }, total_token_usage: {} }, rate_limits: null }),
];
const complete = (ms: number, turn: string) => row(at(ms), "event_msg", { type: "task_complete", turn_id: turn, last_agent_message: "ok" });
const aborted = (ms: number, turn: string) => row(at(ms), "event_msg", { type: "turn_aborted", turn_id: turn });
const settings = (ms: number) => row(at(ms), "event_msg", { type: "thread_settings_applied", thread_settings: {} });

const finishedTurn = [
  meta("/work/app"),
  started(1_000, "t1"), context(1_100, "t1", "gpt-6.1-sol"), ...usage(5_000, 120_000, 110_000, 400), complete(5_050, "t1"),
].join("\n");

describe("parseRollout", () => {
  test("reads the last response's usage, time and model", () => {
    const state = parseRollout(finishedTurn)!;
    expect(state.lastAt).toBe(T0 + 5_001);
    expect(state.tokens).toBe(120_400);
    expect(state.hitRatio).toBeCloseTo(110_000 / 120_000);
    expect(state.model).toBe("gpt-6.1-sol");
    expect(state.effort).toBe("low");
    expect(state.openTurn).toBeUndefined();
  });

  test("a turn that started for this prompt is not a turn in progress; another turn's is", () => {
    const own = parseRollout([finishedTurn, settings(60_000), started(60_100, "t2")].join("\n"))!;
    expect(own.openTurn).toEqual({ turnId: "t2", active: false });
    expect(turnInProgress(own, "t2")).toBe(false);
    expect(turnInProgress(own, "t3")).toBe(true);
    expect(turnInProgress(own, undefined)).toBe(false);
    const working = parseRollout([finishedTurn, started(60_100, "t2"), context(60_200, "t2", "gpt-6.1-sol")].join("\n"))!;
    expect(turnInProgress(working, "t2")).toBe(false);
    expect(turnInProgress(working, undefined)).toBe(true);
    const done = parseRollout([finishedTurn, started(60_100, "t2"), context(60_200, "t2", "gpt-6.1-sol"), aborted(61_000, "t2")].join("\n"))!;
    expect(done.openTurn).toBeUndefined();
  });

  test("a blocked prompt's turn_context does not change the cached model", () => {
    const blocked = [finishedTurn, started(60_000, "t2"), context(60_100, "t2", "gpt-6-astra"), complete(60_200, "t2")].join("\n");
    expect(parseRollout(blocked)!.model).toBe("gpt-6.1-sol");
    const switched = [blocked, started(70_000, "t3"), context(70_100, "t3", "gpt-6-astra"), ...usage(75_000, 130_000, 12_000, 10), complete(75_100, "t3")].join("\n");
    expect(parseRollout(switched)!.model).toBe("gpt-6-astra");
  });

  test("tolerates garbage, blank lines, and a tail without usage", () => {
    expect(parseRollout("")).toBeUndefined();
    expect(parseRollout(["{broken", "", meta("/x")].join("\n"))).toBeUndefined();
    const state = parseRollout(["not json", finishedTurn, "", "{\"type\":\"event_msg\",\"payload\":null}"].join("\n"));
    expect(state?.tokens).toBe(120_400);
  });

  test("no input tokens means no hit ratio", () => {
    const state = parseRollout([meta("/x"), ...usage(1_000, 0, 0, 5)].join("\n"))!;
    expect(state.hitRatio).toBeUndefined();
    expect(state.tokens).toBe(5);
  });
});

describe("files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-cache-guard-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const sessions = path.join(dir, "sessions");
  const day = path.join(sessions, "2026", "10", "07");

  test("readTail starts at a line boundary and readRollout parses it", () => {
    const file = path.join(dir, "big.jsonl");
    const filler = Array.from({ length: 2_000 }, (_, i) => row(at(i), "response_item", { type: "message", text: "y".repeat(2_000) }));
    writeFileSync(file, [meta("/work/app"), ...filler, finishedTurn].join("\n"));
    const tail = readTail(file, 64 * 1024);
    expect(tail.length).toBeLessThan(64 * 1024);
    expect(tail.startsWith("{")).toBe(true);
    expect(readRollout(file)?.tokens).toBe(120_400);
    writeFileSync(file, finishedTurn);
    expect(readTail(file)).toBe(finishedTurn);
  });

  test("lists rollouts newest first, finds by id and by cwd", () => {
    mkdirSync(day, { recursive: true });
    const a = path.join(day, "rollout-2026-10-07T10-00-00-01a10000-0000-7000-8000-00000000000a.jsonl");
    const b = path.join(day, "rollout-2026-10-07T11-00-00-01a10000-0000-7000-8000-00000000000b.jsonl");
    writeFileSync(a, [meta("/work/app", "01a10000-0000-7000-8000-00000000000a"), finishedTurn].join("\n"));
    writeFileSync(b, [meta("/work/other", "01a10000-0000-7000-8000-00000000000b"), finishedTurn].join("\n"));
    writeFileSync(path.join(day, "notes.txt"), "ignored");
    utimesSync(a, new Date(T0 + 10_000), new Date(T0 + 10_000));
    utimesSync(b, new Date(T0 + 20_000), new Date(T0 + 20_000));
    expect(listRollouts(sessions)).toEqual([b, a]);
    expect(findRollout(sessions, "00000000000a")).toBe(a);
    expect(findRollout(sessions, "nope")).toBeUndefined();
    expect(threadId(b)).toBe("01a10000-0000-7000-8000-00000000000b");
    expect(rolloutCwd(a)).toBe("/work/app"); // the session_meta line is over 30 KB
    expect(findRolloutByCwd(sessions, "/work/app")).toBe(a);
    expect(findRolloutByCwd(sessions, "/elsewhere")).toBeUndefined();
    expect(listRollouts(path.join(dir, "missing"))).toEqual([]);
  });
});
