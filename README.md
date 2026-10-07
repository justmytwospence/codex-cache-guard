# codex-cache-guard

[Codex CLI](https://github.com/openai/codex) hooks that warn before a prompt would re-send a large
thread uncached, report doomed threads to herdr's agents sidebar, and print a one-line cache status
for tmux. Part of the cache-guard family:
[pi-cache-guard](https://github.com/justmytwospence/pi-cache-guard),
[claude-cache-guard](https://github.com/justmytwospence/claude-cache-guard) and
[opencode-cache-guard](https://github.com/justmytwospence/opencode-cache-guard) share its core
(`src/core.ts`) and settings file.

## What it does

**Warns before a likely miss.** The `UserPromptSubmit` hook reads the thread's rollout
(`~/.codex/sessions/.../rollout-*.jsonl`): the last response's token usage and when it arrived, and
the model it was requested from. When the next prompt would probably miss the prompt cache and the
thread is large (`warn.minTokens`, default 100k tokens), the hook blocks it once:

```
• Blocked by hook
  └ Idle 4h: the prompt cache has probably expired, so this prompt may re-cache 180k tokens.
    Send the same prompt again within 2m to send it anyway (Up arrow recalls it), or /compact
    or /new first.
```

Codex clears the composer; Up recalls the prompt, and the same text sent again within
`warn.confirmSeconds` (default 120) goes through. A different prompt is held again. Two causes:

- **Idle.** OpenAI publishes no lifetime for the cache behind a ChatGPT login, and in practice hits
  survive for hours (and sometimes do not), so the hook can only say "probably": it holds a prompt
  after `warn.idleMinutes` (default 180) since the last response.
- **Model switch.** Each model has its own cache, so a prompt to a model the thread was not last
  cached for is certain to re-send everything. This holds regardless of idle time. A held prompt's
  turn still writes a `turn_context` for the new model; the hook compares against the model of the
  last request that actually ran, not that.

Input typed while a turn runs reaches the model inside that turn, which keeps the cache fresh, so
it is never held. The hook fails open: any error, a missing rollout, or no usage yet means the prompt
goes through with no output.

**Warns on resume.** The `SessionStart` hook (sources `resume` and `fork`) prints a warning line
when the resumed thread is both idle past the threshold and large:

```
↳ Hook · cache-guard: idle 4h since the last response, so the prompt cache has probably expired;
  the first prompt re-sends 180k tokens uncached. /compact or a new thread is cheaper.
```

**Tells herdr.** Inside a [herdr](https://herdr.dev) pane the hooks report the pane token
`cache`, so herdr's agents sidebar can show which threads are doomed to a miss: `cold? 180k`
while the next prompt would re-send that much uncached (at least `warn.minTokens`), `cold 180k`
after a model switch, and nothing while the thread is warm or small. Codex has no long-lived
plugin process, so the token follows the hooks:

- `UserPromptSubmit`: a held prompt reports the value; a prompt that goes out clears it (its
  request reads or rewrites the cache either way).
- `SessionStart`: a resumed or forked thread reports what its rollout says; a new, cleared or
  compacted one clears.
- `Stop`: clears, then leaves a detached sleeper (`codex-cache-guard herdr-check`, its pid in
  `~/.cache/codex-cache-guard/<session>.sleeper.json`) that wakes after `warn.idleMinutes`,
  re-reads the rollout and reports the thread cold if nothing happened since. The next `Stop`
  replaces it; a sleeper whose record changed underneath it stands down.
- `SessionEnd`: kills the sleeper and clears the token.

Show it in herdr's agents sidebar with a custom token in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", { token = "$cache", fg = "#5f87d7", rules = [{ starts_with = "cold?", dim = true }] }]]
```

`src/herdr.ts` speaks herdr's socket protocol (`pane.report_metadata`, source `cache-guard`) and
is shared verbatim with the pi and opencode ports. `"herdr": { "enabled": false }` turns it off;
outside herdr (no `HERDR_ENV`) nothing is sent. The token carries a one-day TTL, so a thread
whose process died without its `SessionEnd` drops off the sidebar by itself.

**Status for tmux.** Codex's own status line is a fixed list of items, so the clock lives outside
it:

```sh
codex-cache-guard status                       # the most recently modified thread
codex-cache-guard status --cwd "$PWD"          # the newest thread started in a directory
codex-cache-guard status --session <id>        # any part of the thread id
codex-cache-guard status --tmux                # with tmux colors, for status-right
codex-cache-guard status --json
```

prints `cache warm 12m idle · 97% hit`, `cache cold? 4h idle · 180k` or `cache warm · running`.
In `.tmux.conf`:

```
set-option -g status-right "#(~/.local/share/plugins/codex-cache-guard/bin/codex-cache-guard status --cwd '#{pane_current_path}' --tmux)"
set-option -g status-interval 30
```

**Keeps the cache warm: no.** On a ChatGPT plan Codex has no cache-write charge and a hit is
billed at 10% of input, so a miss costs 10x the hit, not 12.5x as on Anthropic's 5-minute tier;
there is no `prompt_cache_retention` setting on the ChatGPT path and no published TTL. Measured on
one account's rollouts, hits survived gaps of 78 minutes, 15 hours and 74 hours while misses came
at 33 minutes and 7 hours: elapsed time does not predict a miss, so a keep-alive ping cannot be
timed, only sent blindly, and every ping draws plan usage. The 3-hour idle warning is the useful
part; `/compact` before a long break is the fix.

## Install

Node 22.6 or later (22.18+ or 23.6+ strip types without a flag; the wrapper passes
`--experimental-strip-types` either way, and falls back to Homebrew's Node when the one first on
PATH is too old). Clone it, then add the hooks to `~/.codex/hooks.json` and trust them in `/hooks`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "command": "if [ -x \"$HOME/.local/share/plugins/codex-cache-guard/bin/codex-cache-guard\" ]; then \"$HOME/.local/share/plugins/codex-cache-guard/bin/codex-cache-guard\" prompt; fi", "timeout": 10, "type": "command" } ] }
    ],
    "SessionStart": [
      { "hooks": [ { "command": "if [ -x \"$HOME/.local/share/plugins/codex-cache-guard/bin/codex-cache-guard\" ]; then \"$HOME/.local/share/plugins/codex-cache-guard/bin/codex-cache-guard\" session-start; fi", "timeout": 10, "type": "command" } ] }
    ],
    "Stop": [
      { "hooks": [ { "command": "if [ -x \"$HOME/.local/share/plugins/codex-cache-guard/bin/codex-cache-guard\" ]; then \"$HOME/.local/share/plugins/codex-cache-guard/bin/codex-cache-guard\" stop; fi", "timeout": 10, "type": "command" } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "command": "if [ -x \"$HOME/.local/share/plugins/codex-cache-guard/bin/codex-cache-guard\" ]; then \"$HOME/.local/share/plugins/codex-cache-guard/bin/codex-cache-guard\" session-end; fi", "timeout": 3, "type": "command" } ] }
    ]
  }
}
```

The `if [ -x ... ]` guard keeps a host without the checkout quiet. `Stop` and `SessionEnd` only
feed herdr; without herdr they are harmless (a clear that goes nowhere, a sleeper that is not
started). Codex caps `SessionEnd` hooks at 3 seconds.

In the dotfiles this is one line in `dot_config/plugins/pins.tmpl`,

```
git justmytwospence/codex-cache-guard <commit>
```

and the four handlers above added to the matching arrays in `dot_codex/hooks.managed.json`. Hooks
from `hooks.json` run only once trusted in `/hooks`, and a changed hook (the command line, not the
script) must be trusted again.

## Settings

`~/.config/agents/cache-guard.json` (shared with the other ports), then `~/.codex/cache-guard.json`,
then the project's `.agents/cache-guard.json` and `.codex/cache-guard.json`. Later files win;
objects merge. Codex reads `enabled` and `warn`:

```json
{ "enabled": true, "warn": { "enabled": true, "minTokens": 100000, "idleMinutes": 180, "confirmSeconds": 120 } }
```

`minCost` is unused here: Codex carries no prices. The thread's size is the last request's input
plus its output, which is what the next request re-sends. `"herdr": { "enabled": true }` is the
herdr token.

## Limits

- The rollout format is not a stable interface; this reads Codex 0.160's
  (`token_count` and `token_usage_record` rows, `turn_context`, `task_started`, `task_complete`,
  `turn_aborted`). Only the last 2 MB of the file are read.
- Idle is measured from the last response, so a thread killed mid-turn (no `task_complete`) is
  treated as idle since its last response.
- A reasoning-effort change also misses the cache, but the hook input does not carry the new
  effort, so it is not detected.
- The hook runs in `$SHELL -lc` with the session's environment, so a `node` from nvm that is
  older than 22.6 and first on PATH is skipped in favor of `/opt/homebrew/bin/node` or
  `/usr/local/bin/node`.
- The herdr sleeper is a Node process that waits `warn.idleMinutes` with a timer, so a laptop
  asleep for the whole window reports late (after the next tick), and a thread whose Codex was
  killed without `SessionEnd` keeps its sleeper until it fires once; the token then expires
  after a day.

## Development

```sh
npm ci && npm run check      # tsc, then vitest (unit tests, the CLI end to end, the hooks against a fake herdr socket)
codex exec --skip-git-repo-check -C /tmp/scratch --dangerously-bypass-hook-trust \
  -c 'hooks.UserPromptSubmit=[{hooks=[{type="command",command="'"$PWD"'/bin/codex-cache-guard prompt",timeout=10}]}]' \
  resume <thread id> 'a prompt'
```
