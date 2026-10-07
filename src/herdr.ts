// Reports the cache-guard `cache` token to herdr for the pane this process runs in, so herdr's agents
// sidebar can show which sessions are doomed to a cache miss. Node-only companion of core.ts, shared
// verbatim by pi-cache-guard, opencode-cache-guard and codex-cache-guard (the Claude Code mod goes
// through the `herdr` CLI instead). Outside herdr (no HERDR_ENV / socket / pane) it does nothing.
//
// herdr protocol: one JSON line `{ id, method: "pane.report_metadata", params }` on the Unix socket
// at $HERDR_SOCKET_PATH. A null token value clears it; `agent` ties the token to the agent in the
// pane, so herdr drops it when that agent leaves.
import net from "node:net";

import { HERDR_SOURCE, HERDR_TOKEN } from "./core.ts";

/** A day, herdr's ceiling: a token outlives a crashed agent by at most this long. */
const TTL_MS = 86_400_000;

export interface HerdrTarget {
  socketPath: string;
  paneId: string;
}

export function herdrTarget(env: NodeJS.ProcessEnv = process.env): HerdrTarget | undefined {
  if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) return undefined;
  return { socketPath: env.HERDR_SOCKET_PATH, paneId: env.HERDR_PANE_ID };
}

let counter = 0;

/** The report_metadata request setting (or, with undefined, clearing) the `cache` token. */
export function herdrRequest(target: HerdrTarget, agent: string, value: string | undefined): Record<string, unknown> {
  const seq = Date.now() * 1000 + (counter++ % 1000);
  return {
    id: `${HERDR_SOURCE}:${seq}`,
    method: "pane.report_metadata",
    params: {
      pane_id: target.paneId,
      source: HERDR_SOURCE,
      agent,
      tokens: { [HERDR_TOKEN]: value ?? null },
      seq,
      ...(value === undefined ? {} : { ttl_ms: TTL_MS }),
    },
  };
}

/** Sends one request; resolves true on any reply, false on error or after 500 ms. Never throws. */
export function sendHerdr(target: HerdrTarget, request: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const socket = net.createConnection(process.platform === "win32" ? `\\\\.\\pipe\\${target.socketPath}` : target.socketPath);
    const timer = setTimeout(() => finish(false), 500);
    timer.unref?.();
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
  });
}

/** Reports the token when it changes; the first report (even "nothing") always goes out. */
export class HerdrReporter {
  private last: string | undefined | null = null;
  private readonly agent: string;
  private readonly target: HerdrTarget | undefined;
  private readonly send: typeof sendHerdr;

  // No parameter properties: Codex runs this file with Node's type stripping.
  constructor(agent: string, target: HerdrTarget | undefined = herdrTarget(), send: typeof sendHerdr = sendHerdr) {
    this.agent = agent;
    this.target = target;
    this.send = send;
  }

  get active(): boolean {
    return this.target !== undefined;
  }

  report(value: string | undefined): void {
    if (!this.target || value === this.last) return;
    this.last = value;
    void this.send(this.target, herdrRequest(this.target, this.agent, value));
  }

  /** Clears the token (session end) and forgets what was reported. */
  clear(): Promise<boolean> {
    if (!this.target || this.last === undefined || this.last === null) {
      this.last = null;
      return Promise.resolve(true);
    }
    this.last = null;
    return this.send(this.target, herdrRequest(this.target, this.agent, undefined));
  }
}
