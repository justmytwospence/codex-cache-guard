import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_SETTINGS, mergeSettings } from "../src/core.ts";
import { killSleeper, loadSleeper, saveSleeper, sleepMs, sleeperFile, tokenValue } from "../src/herdr-hooks.ts";
import { herdrRequest, herdrTarget, sendHerdr } from "../src/herdr.ts";

// The hooks with herdr beneath them: a Unix socket server standing in for herdr's, the same env a
// Codex pane inside herdr has (HERDR_ENV, HERDR_SOCKET_PATH, HERDR_PANE_ID), and the sleeper the
// Stop hook leaves behind, shortened by CODEX_CACHE_GUARD_SLEEP_MS.
const BIN = path.join(import.meta.dirname, "..", "bin", "codex-cache-guard");
const HOUR = 3_600_000;
let ordinal = 0;
const row = (at: number, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), ordinal: ordinal++, type, payload });

function rollout(file: string, cwd: string, lastAt: number, model: string, tokens: number) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, [
    row(lastAt - 60_000, "session_meta", { id: "01a1", cwd }),
    row(lastAt - 50_000, "event_msg", { type: "task_started", turn_id: "t1" }),
    row(lastAt - 49_000, "turn_context", { turn_id: "t1", model, effort: "low" }),
    row(lastAt, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: tokens - 10, cached_input_tokens: tokens - 20, output_tokens: 10 } } }),
    row(lastAt + 10, "event_msg", { type: "task_complete", turn_id: "t1" }),
  ].join("\n"));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("herdr token", () => {
  test("only big cold threads, always the idle guess for Codex", () => {
    expect(tokenValue({ kind: "idle", idleMs: 4 * HOUR }, 180_000, DEFAULT_SETTINGS)).toBe("cold? 180k");
    expect(tokenValue({ kind: "model", from: "a", to: "b" }, 180_000, DEFAULT_SETTINGS)).toBe("cold 180k");
    expect(tokenValue({ kind: "idle", idleMs: 4 * HOUR }, 20_000, DEFAULT_SETTINGS)).toBeUndefined();
    expect(tokenValue(undefined, 180_000, DEFAULT_SETTINGS)).toBeUndefined();
    expect(tokenValue({ kind: "idle", idleMs: 1 }, 180_000, mergeSettings(DEFAULT_SETTINGS, ['{"herdr":{"enabled":false}}']))).toBeUndefined();
  });

  test("the sleeper's delay is warn.idleMinutes unless overridden", () => {
    expect(sleepMs(DEFAULT_SETTINGS, {})).toBe(180 * 60_000);
    expect(sleepMs(DEFAULT_SETTINGS, { CODEX_CACHE_GUARD_SLEEP_MS: "250" })).toBe(250);
    expect(sleepMs(DEFAULT_SETTINGS, { CODEX_CACHE_GUARD_SLEEP_MS: "nope" })).toBe(180 * 60_000);
  });

  test("sleeper bookkeeping: save, load, kill a pid that is gone", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-cache-guard-sleeper-"));
    try {
      const file = sleeperFile(dir, "s/1");
      expect(path.basename(file)).toBe("s_1.sleeper.json");
      expect(loadSleeper(file)).toBeUndefined();
      saveSleeper(file, { pid: 2 ** 22 - 1, stoppedAt: 5 }); // no such process
      expect(loadSleeper(file)).toEqual({ pid: 2 ** 22 - 1, stoppedAt: 5 });
      killSleeper(file);
      expect(existsSync(file)).toBe(false);
      killSleeper(file); // nothing recorded: fine
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("outside herdr nothing is sent", async () => {
    expect(herdrTarget({})).toBeUndefined();
    expect(herdrTarget({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" })).toEqual({ socketPath: "/s", paneId: "w1:p1" });
    expect(await sendHerdr({ socketPath: "/nonexistent.sock", paneId: "x" }, herdrRequest({ socketPath: "/nonexistent.sock", paneId: "x" }, "codex", "cold 1k"))).toBe(false);
  });
});

describe("hooks against a herdr socket", () => {
  const home = mkdtempSync(path.join(tmpdir(), "codex-cache-guard-herdr-"));
  const socketPath = path.join(home, "herdr.sock");
  const cacheHome = path.join(home, "cache");
  const sessions = path.join(home, "codex", "sessions", "2026", "10", "07");
  const cwd = path.join(home, "project");
  const reports: Array<Record<string, any>> = [];
  let server: net.Server;

  beforeAll(async () => {
    mkdirSync(cwd, { recursive: true });
    server = net.createServer((socket) => {
      socket.on("error", () => undefined); // the client hangs up as soon as it has its reply
      socket.on("data", (data) => {
        for (const line of String(data).split("\n")) {
          if (line.trim()) reports.push(JSON.parse(line));
        }
        socket.end('{"id":"x","result":{}}\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });

  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    CODEX_HOME: path.join(home, "codex"),
    XDG_CACHE_HOME: cacheHome,
    XDG_CONFIG_HOME: path.join(home, "config"),
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: "w9:p3",
  };
  const session = "01a10000-0000-7000-8000-00000000c0de";
  const file = path.join(sessions, `rollout-2026-10-07T08-00-00-${session}.jsonl`);
  const sleeper = sleeperFile(path.join(cacheHome, "codex-cache-guard"), session);
  const hook = (event: string, over: Record<string, unknown> = {}) => JSON.stringify({
    session_id: session, turn_id: "t2", transcript_path: file, cwd, hook_event_name: event,
    model: "gpt-6.1-sol", permission_mode: "default", ...over,
  });
  // spawnSync would block the event loop while the hook's report sits in the socket's buffer, so
  // the hook runs asynchronously and the test lets the server read before looking at `reports`.
  const run = async (args: string[], stdin: string | undefined, extra: Record<string, string> = {}) => {
    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(BIN, args, { env: { ...env, ...extra } });
      let out = "";
      let err = "";
      child.stdout.on("data", (data) => { out += String(data); });
      child.stderr.on("data", (data) => { err += String(data); });
      child.on("close", (code) => resolve({ code, out, err }));
      child.stdin.end(stdin ?? "");
    });
    await wait(50);
    return result;
  };
  const tokens = () => reports.map((r) => r.params.tokens.cache);
  const last = () => reports.at(-1)!.params;

  test("a blocked prompt reports the thread cold; a sent one clears the token", async () => {
    rollout(file, cwd, Date.now() - 4 * HOUR, "gpt-6.1-sol", 180_000);
    const blocked = await run(["prompt"], hook("UserPromptSubmit", { prompt: "go on" }));
    expect(JSON.parse(blocked.out).decision).toBe("block");
    expect(last()).toMatchObject({ pane_id: "w9:p3", source: "cache-guard", agent: "codex", tokens: { cache: "cold? 180k" }, ttl_ms: 86_400_000 });
    expect(reports.at(-1)!.method).toBe("pane.report_metadata");
    const sent = await run(["prompt"], hook("UserPromptSubmit", { prompt: "go on" }));
    expect(sent).toEqual({ code: 0, out: "", err: "" });
    expect(last().tokens).toEqual({ cache: null });
    expect(last().ttl_ms).toBeUndefined();
  });

  test("session-start: cold on a resume, clear on startup", async () => {
    reports.length = 0;
    rollout(file, cwd, Date.now() - 4 * HOUR, "gpt-6.1-sol", 180_000);
    expect((await run(["session-start"], hook("SessionStart", { source: "resume" }))).out).toContain("systemMessage");
    expect(tokens()).toEqual(["cold? 180k"]);
    rollout(file, cwd, Date.now() - 4 * HOUR, "gpt-6.1-sol", 20_000);
    await run(["session-start"], hook("SessionStart", { source: "resume" }));
    expect(tokens()).toEqual(["cold? 180k", null]);
    await run(["session-start"], hook("SessionStart", { source: "startup" }));
    expect(tokens()).toEqual(["cold? 180k", null, null]);
  });

  test("stop: clears, leaves a sleeper that reports the thread cold once idle; session-end kills it", async () => {
    reports.length = 0;
    rollout(file, cwd, Date.now() - 4 * HOUR, "gpt-6.1-sol", 180_000);
    const stop = await run(["stop"], hook("Stop", { stop_hook_active: false, last_assistant_message: "done" }), { CODEX_CACHE_GUARD_SLEEP_MS: "300" });
    expect(stop).toEqual({ code: 0, out: "", err: "" }); // nothing on stdout: a valid Stop answer
    expect(tokens()).toEqual([null]);
    const recorded = loadSleeper(sleeper)!;
    expect(recorded.pid).toBeGreaterThan(0);
    expect(() => process.kill(recorded.pid, 0)).not.toThrow(); // alive, detached from the hook
    await wait(1_500);
    expect(tokens()).toEqual([null, "cold? 180k"]);
    expect(() => process.kill(recorded.pid, 0)).toThrow(); // exited after reporting

    // A second Stop replaces the sleeper; SessionEnd kills the new one before it fires.
    reports.length = 0;
    await run(["stop"], hook("Stop", { stop_hook_active: false, last_assistant_message: "done" }), { CODEX_CACHE_GUARD_SLEEP_MS: "5000" });
    const second = loadSleeper(sleeper)!;
    expect(second.pid).not.toBe(recorded.pid);
    expect(() => process.kill(second.pid, 0)).not.toThrow();
    const end = await run(["session-end"], hook("SessionEnd", { reason: "other" }));
    expect(end).toEqual({ code: 0, out: "", err: "" });
    await wait(200);
    expect(() => process.kill(second.pid, 0)).toThrow();
    expect(existsSync(sleeper)).toBe(false);
    expect(tokens()).toEqual([null, null]);
  });

  test("the sleeper stands down when a newer Stop replaced its record, or the thread is warm", async () => {
    reports.length = 0;
    rollout(file, cwd, Date.now() - 4 * HOUR, "gpt-6.1-sol", 180_000);
    await run(["stop"], hook("Stop", { stop_hook_active: false, last_assistant_message: "done" }), { CODEX_CACHE_GUARD_SLEEP_MS: "400" });
    const first = loadSleeper(sleeper)!;
    // Pretend a newer Stop ran (without killing): the record changes underneath the sleeper.
    saveSleeper(sleeper, { pid: first.pid, stoppedAt: first.stoppedAt + 1 });
    await wait(1_500);
    expect(tokens()).toEqual([null]);
    expect(() => process.kill(first.pid, 0)).toThrow();

    reports.length = 0;
    rollout(file, cwd, Date.now() - 60_000, "gpt-6.1-sol", 180_000); // warm
    await run(["stop"], hook("Stop", { stop_hook_active: false, last_assistant_message: "done" }), { CODEX_CACHE_GUARD_SLEEP_MS: "300" });
    await wait(1_500);
    expect(tokens()).toEqual([null]);
    killSleeper(sleeper);
  });

  test("a prompt into a running turn leaves the token alone", async () => {
    reports.length = 0;
    rollout(file, cwd, Date.now() - 60_000, "gpt-6.1-sol", 180_000);
    writeFileSync(file, `${readFileSync(file, "utf8")}\n${row(Date.now(), "event_msg", { type: "task_started", turn_id: "t5" })}\n${row(Date.now(), "turn_context", { turn_id: "t5", model: "gpt-6.1-sol" })}`);
    expect((await run(["prompt"], hook("UserPromptSubmit", { prompt: "and also", turn_id: "t6" }))).out).toBe("");
    expect(reports).toEqual([]);
  });

  test("herdr off in settings: hooks still answer Codex, nothing reaches herdr", async () => {
    reports.length = 0;
    mkdirSync(path.join(cwd, ".agents"), { recursive: true });
    writeFileSync(path.join(cwd, ".agents", "cache-guard.json"), '{"herdr":{"enabled":false}}');
    rollout(file, cwd, Date.now() - 4 * HOUR, "gpt-6.1-sol", 180_000);
    expect(JSON.parse((await run(["prompt"], hook("UserPromptSubmit", { prompt: "x" }))).out).decision).toBe("block");
    await run(["stop"], hook("Stop", { stop_hook_active: false, last_assistant_message: "done" }), { CODEX_CACHE_GUARD_SLEEP_MS: "100" });
    expect(existsSync(sleeper)).toBe(false); // no sleeper when herdr is off
    // The clear on Stop still goes out (cheap, and leaves no stale token behind); no values do.
    expect(tokens().filter((value) => value !== null)).toEqual([]);
    rmSync(path.join(cwd, ".agents"), { recursive: true });
  });
});
