---
title: Dashboard
description: The daemon's views in a browser, on 127.0.0.1, behind a token, and only while you've asked for it.
---

The daemon serves a dashboard for a browser: what the [live view](/chernabog/work/live-view/) shows, and most of what it does. It listens on `127.0.0.1` only, and only while you've asked for it. A person who wants only the terminal never has a TCP port open.

## Starting and stopping it

| Command | Does |
| ------- | ---- |
| `chernabog ui [--port N]` | starts it if it's off (or moves it to `N`), then opens it in the default browser (`open` on macOS, `xdg-open` on Linux); `--print` prints the URL instead |
| `chernabog ui start [--port N]` | starts it, and prints its URL; started on another port, it moves |
| `chernabog ui stop` | stops it; open pages say it was stopped |
| `chernabog ui status` | says whether it's running, and where |
| `chernabog ui --rotate-token` | makes a new token first; the old URL stops working |

Without `--port` it opens on the port you last asked for, else `4848`. A port that's in use is refused; it never picks another. Each of these asks the daemon, so with no daemon running each says so: `chernabog start` starts it.

**It stays up until you stop it.** The daemon restarts often: on newly trusted config, a repo enrolled or dropped, and an upgrade. What you asked is kept in `~/.config/chernabog/dashboard.json` (whether it's to run, and its port), so the daemon opens the dashboard again each time it starts, until `chernabog ui stop`. If the port is taken by then, `daemon.log` says so and the daemon carries on without it. A page left open reconnects on its own once the daemon is back.

## The token

The dashboard's URL carries a token, `?token=…`. Opening it sets a cookie (`HttpOnly`, `SameSite=Strict`) and drops the token from the address bar, and the dashboard answers its API only to a browser holding that cookie.

**Why.** Any program on your machine, and any web page your browser opens, can reach `127.0.0.1`. Without the token, a page you visit could read your runs and repos, or pause a repo, by sending requests to the port. The token lives in `~/.config/chernabog/dashboard.token`, readable only by you, so only you, and what runs as you, can hand it to a browser. The listener also refuses:

- a request addressed to any host but `127.0.0.1:<port>` or `localhost:<port>`, which stops a page from reaching it through a name of its own pointed at `127.0.0.1` (DNS rebinding);
- a change sent from another origin, or not as JSON, which stops a page from posting a form to it.

**Rotating it.** The token stays the same across restarts, so a bookmark keeps working. `chernabog ui --rotate-token` makes a new one, starts the dashboard if it's off, and opens it: every browser holding the old URL or cookie is refused from then on. Rotate it if the URL ends up somewhere it shouldn't, such as a screenshot or a shared terminal log.

## What it does

- **The overview, in tabs.** The header shows the daemon, its pid and since when, and a pending reload or drain. Under it, one folded line counts what needs a person (holds, markers left behind, failing validity checks, leases at risk, notification problems); open it for the list. It's absent when nothing does. Then the tabs, each its own address:
  - **Active** (`#/`, the home page): the runs in flight.
  - **Recent** (`#/recent`): the runs that ended lately, and how.
  - **Flows** (`#/flows`): every flow in one table, with the repo and persona it runs in and as, its schedule, when it ticks next and last, what its work waits on, and why its last tick started nothing. Flows that are off fold away below.
  - **Repos** (`#/repos`): each repo's own settings: whether it's paused, its launcher, the accounts its personas spend, and Run now.

  Filter any tab by repo and persona. On Active and Recent, `j` / `k` move through the runs, `enter` opens one, and `/` focuses the filter.
- **A run's page**, `#/runs/<id>` (a unique prefix of the id will do, as with `chernabog logs`): the run; the **item** it's on (the issue or pull request that started it), linked; the **subjects** it named besides that item (the pull requests it opened, say), each linked where GitHub has it; its summary; what it's parked on; and its log as it grows, which stays at the bottom unless you scroll up and keeps the last 10,000 lines. Its **steps** are drawn as a graph, left to right: the run's own line, then one lane for each line of work that ran beside the others (an epic's tasks: a step named `implement#task-284` is in lane `task-284`), with an arrow from each lane to the lanes that waited on it. Each step shows whether it succeeded, failed or still runs, and how long it took, where the daemon kept that. The page updates as the run enters a step, parks or finishes.
- **A run's usage**, on its page:
  - **Tokens**: what its agent calls spent, summed across input, output, cache read and cache write, with each beside it, and a table by model. Cache reads usually make up most of the total. These are raw token counts, never dollars.
  - **Compute time**: the time at least one of its steps was running. Steps that ran side by side count once, and time spent parked or sleeping between CI polls doesn't count, so it's usually far less than the time since the run started.

  Totals move when an agent call ends, not during one. A call through an agent that can't say what it spent (a custom agent, a rehearsal) makes the total read "at least N", with a note that it's a floor; when no call could say, it reads "Not reported by its agent". A run from before the daemon kept these says it wasn't recorded.
- **A step's page**, `#/runs/<id>/steps/<step>`: click a step in the graph. The run's page with that step marked, when it started and ended, that step's tokens by model, and that step's log alone. A run from before the daemon kept which step wrote each line can be split by step only if its steps ran one after another; for one whose lanes ran at once, the page says so and links the whole log.
- **Run now.** On a repo, a flow that's on, with a persona picker when several run it and an item (required for a [manual flow](/chernabog/flows/flows/#manual-flows)), as `chernabog run` starts it.
- **Cancel.** A run in flight, once you confirm in the page, optionally closing its agent sessions, as [`chernabog cancel`](/chernabog/work/commands/) does.
- **Attach.** A browser can't take over a terminal, so the dashboard gives you two ways to an agent session instead: **Copy attach command** puts `chernabog attach <run>` on the clipboard to paste in a terminal, and **Open in launcher**, where the repo's [launcher](/chernabog/agents/launchers/) can open a session itself, brings the run's latest session up on the daemon's machine: Orca switches to its tab, tmux switches a client to it.
- **Pause and resume** a repo, and **change a persona's settings** in it: turn a flow on or off, give it a schedule of its own (checked as cron before it's sent; empty, the team's applies again), and pick the account the persona, or one of its roles, spends. Each change is for the persona whose flow or accounts it's on. If another process is changing machine config at that moment, the dashboard says it's busy: try again.

The page learns of changes as they happen, from the daemon's event stream, rather than by asking over and over: a change made in the CLI, the TUI or another browser shows within a second, and so does a hand edit of machine config or a foreground `run --from-checkout`. When the daemon refuses something, the refusal shows beside the button that asked, and nothing is retried.

## What it doesn't do

- **No terminal.** Agent sessions are never embedded in the page; attach copies the command or opens the launcher, as above.
- **Enrolling, unenrolling and trusting stay on the command line.** They name paths on disk, and trusting lets a repo's code run on your machine, so the daemon refuses them from a browser even with the cookie. Use `chernabog enroll`, `unenroll` and `trust`, or the live view.
- **Nothing beyond this machine.** It listens on `127.0.0.1` only, with no setting to change that. To see another machine's daemon, open its dashboard there.
- **No notifications.** It shows what's happening while it's open, and says nothing when it isn't.
