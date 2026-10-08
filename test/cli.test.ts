import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

// The hooks end to end: the sh wrapper picks a Node, the script reads the hook JSON, the rollout
// and the settings, and answers on stdout exactly as Codex 0.160.1 parses it.
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

function run(args: string[], stdin: string | undefined, env: Record<string, string>) {
  const result = spawnSync(BIN, args, { input: stdin, env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("codex-cache-guard CLI", () => {
  const home = mkdtempSync(path.join(tmpdir(), "codex-cache-guard-cli-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, "codex");
  const sessions = path.join(codexHome, "sessions", "2026", "10", "07");
  const cwd = path.join(home, "project");
  mkdirSync(cwd, { recursive: true });
  const env = { HOME: home, CODEX_HOME: codexHome, XDG_CACHE_HOME: path.join(home, "cache"), XDG_CONFIG_HOME: path.join(home, "config") };
  const now = Date.now();
  const cold = path.join(sessions, "rollout-2026-10-07T08-00-00-01a10000-0000-7000-8000-000000000c01.jsonl");
  const hook = (over: Record<string, unknown> = {}) => JSON.stringify({
    session_id: "01a10000-0000-7000-8000-000000000c01", turn_id: "t2", transcript_path: cold, cwd,
    hook_event_name: "UserPromptSubmit", model: "gpt-6.1-sol", permission_mode: "default", prompt: "go on", ...over,
  });

  test("prompt: blocks a cold large thread once, then passes the resend", () => {
    rollout(cold, cwd, now - 4 * HOUR, "gpt-6.1-sol", 180_000);
    const first = run(["prompt"], hook(), env);
    expect(first.code).toBe(0);
    const parsed = JSON.parse(first.out);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toMatch(/^Idle 4h: .*180k tokens\. Up arrow recalls it: send it again within 2m/);
    expect(Object.keys(parsed).sort()).toEqual(["decision", "reason"]); // deny_unknown_fields upstream
    expect(readdirSync(path.join(home, "cache", "codex-cache-guard"))).toHaveLength(1);
    const again = run(["prompt"], hook(), env);
    expect(again).toEqual({ code: 0, out: "", err: "" });
    expect(readdirSync(path.join(home, "cache", "codex-cache-guard"))).toHaveLength(0);
  });

  test("prompt: passes a warm thread, a small one, and a mid-turn prompt; project settings apply", () => {
    const warm = path.join(sessions, "rollout-2026-10-07T09-00-00-01a10000-0000-7000-8000-000000000a01.jsonl");
    rollout(warm, cwd, now - 60_000, "gpt-6.1-sol", 180_000);
    expect(run(["prompt"], hook({ transcript_path: warm }), env)).toEqual({ code: 0, out: "", err: "" });
    rollout(cold, cwd, now - 4 * HOUR, "gpt-6.1-sol", 20_000);
    expect(run(["prompt"], hook(), env).out).toBe("");
    mkdirSync(path.join(cwd, ".agents"), { recursive: true });
    writeFileSync(path.join(cwd, ".agents", "cache-guard.json"), '{"warn":{"minTokens":1000}}');
    expect(JSON.parse(run(["prompt"], hook({ prompt: "a" }), env).out).decision).toBe("block");
    expect(JSON.parse(run(["prompt"], hook({ prompt: "a2", turn_id: "t1" }), env).out).decision).toBe("block"); // t1 completed: no turn in progress
    rmSync(path.join(cwd, ".agents"), { recursive: true });
  });

  test("prompt: a model switch blocks; garbage and missing input pass silently", () => {
    rollout(cold, cwd, now - 60_000, "gpt-6.1-sol", 180_000);
    const out = run(["prompt"], hook({ model: "gpt-6-astra", prompt: "b" }), env).out;
    expect(JSON.parse(out).reason).toContain("gpt-6-astra has no cache of this conversation");
    expect(run(["prompt"], "not json", env)).toEqual({ code: 0, out: "", err: "" });
    expect(run(["prompt"], hook({ transcript_path: "/nonexistent.jsonl", prompt: "c" }), env)).toEqual({ code: 0, out: "", err: "" });
    expect(run(["prompt"], "", env)).toEqual({ code: 0, out: "", err: "" });
  });

  test("session-start: a systemMessage on a cold resume only", () => {
    rollout(cold, cwd, now - 4 * HOUR, "gpt-6.1-sol", 180_000);
    const resumed = run(["session-start"], hook({ hook_event_name: "SessionStart", source: "resume", prompt: undefined }), env);
    expect(JSON.parse(resumed.out)).toEqual({ systemMessage: expect.stringMatching(/^cache-guard: idle 4h since the last response.*180k tokens uncached/) });
    expect(run(["session-start"], hook({ source: "startup" }), env).out).toBe("");
  });

  test("status: latest, by session, by cwd, tmux and json", () => {
    rollout(cold, cwd, now - 4 * HOUR, "gpt-6.1-sol", 180_000);
    const other = path.join(sessions, "rollout-2026-10-07T09-30-00-01a10000-0000-7000-8000-000000000b01.jsonl");
    rollout(other, "/elsewhere", now - 12 * 60_000, "gpt-6-astra", 50_000);
    expect(run(["status", "--path", cold], undefined, env).out).toBe("cache cold? 4h idle · 180k\n");
    expect(run(["status", "--session", "000000000b01"], undefined, env).out).toBe("cache warm 12m idle · 100% hit\n");
    expect(run(["status", "--cwd", cwd], undefined, env).out).toBe("cache cold? 4h idle · 180k\n");
    expect(run(["status", "--cwd", cwd, "--tmux"], undefined, env).out).toBe("#[fg=yellow]cache cold? 4h idle · 180k#[default]\n");
    const json = JSON.parse(run(["status", "--path", other, "--json"], undefined, env).out);
    expect(json).toMatchObject({ state: "warm", tokens: 50_000, model: "gpt-6-astra", session: "01a10000-0000-7000-8000-000000000b01", path: other });
    const missing = run(["status", "--session", "zzz"], undefined, env);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("no rollout for session zzz");
    expect(run(["status", "--cwd", "/nope"], undefined, env).code).toBe(1);
    expect(run(["nonsense"], undefined, env).code).toBe(2);
    expect(run([], undefined, env).code).toBe(0);
  });
});
