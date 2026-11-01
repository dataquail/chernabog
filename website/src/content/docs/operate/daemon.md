---
title: The daemon
description: Scheduling, limits, the workflow engine and where it logs.
---

One daemon per machine schedules every enrolled repo, runs the workflow engine, and serves the CLI over a local socket. `chernabog install` runs [`chernabog setup`](/chernabog/start/installation/#set-up-the-machine), then registers it as a launchd agent (macOS) or systemd user service (Linux) that restarts on exit.

## Ticks

Each flow's trigger runs on a cron schedule. When it runs is the person's call, so the repo's entry in machine config comes first (its persona's, where it has one): its `flows.<flow>.schedule`, then its `schedule`. Then the team's: `config.yaml`'s `flows.<flow>.schedule`, the flow module's own `schedule`, and `config.yaml`'s `schedule`. Without any of them it runs hourly, at a minute that spreads repos across the hour. Before a tick starts a run, the daemon checks, in order:

| Check              | Set by                       | Skip reason                         |
| ------------------ | ---------------------------- | ----------------------------------- |
| repo enabled       | repo entry's `enabled`       | `disabled in machine config`        |
| flow listed        | repo entry's `flows`         | `flow turned off`                   |
| pause              | `chernabog pause <repo>`     | `paused`                            |
| quiet hours        | machine `quietHours`         | `quiet hours (22:00-07:00)`         |
| active hours       | repo entry's `activeHours`   | `outside active hours (…)`          |
| routing | the flow's trigger, such as `Routing`'s `assignee` / `reviewRequested` settings | `only work for others: …` |
| concurrency        | machine, repo and flow `concurrency` | no free slot                |
| the flow's gate    | `defineFlow({ gate })`       | e.g. `usage gate: …`                |

Hours are `HH:MM-HH:MM` in local time, and may wrap midnight. Every skipped tick is recorded with its reason; `status` shows the latest. A repo can lower `concurrency`, never raise it past the machine's.

A run waiting on a signal holds no slot.

### Ticks on events

Cron is the backstop; two kinds of event tick a flow sooner. Each runs the same tick as cron and `t` do, every check above included, so an event never starts what a scheduled tick wouldn't. An event decides nothing itself: the trigger reads the real state.

- **A change a run here makes.** When a run on this machine opens or pushes to a pull request, requests or submits a review, merges, labels, comments, or ends, every flow of that repo is due, for each persona whose `events.local` is on (the default). This is how one persona's pull request reaches another's `review` on the same machine within seconds. A run that ends without finishing its work (failed, skipped, handed to a person) leaves its own flow to cron, so an item that fails fast is retried no more often than before.
- **A persona's GitHub notifications.** With `events.notifications` on, the daemon polls each persona's `GET /notifications` at the interval GitHub asks for (about a minute), with `If-Modified-Since`, so an answer that nothing changed is a 304 that costs no rate limit. A notification about an enrolled repo makes that persona's flows there due. This covers handoffs between machines: a review requested of you, a review on your pull request. The daemon never marks a notification read. A token that can't read notifications (fine-grained tokens can't) shows in `status` with the fix, and that persona's flows go on ticking on cron.

Several events within a few seconds make one tick, and the repo's `limits.eventTickMin` (default `30 seconds`) caps how often events tick one persona's flow. `status` shows what made each flow's last tick (`cron`, `manual`, `local: #73 review requested`, `notification: review_requested on #73`), and `next due now` while an event's tick waits to run.

### Runs whose work goes away

Every `limits.validityEvery` (default `5 minutes`), before a parked run wakes, and within seconds of a notification about its issue or pull request (closed, merged, reopened, a label or review request removed), the daemon asks each run in flight whose flow has a [`stillValid`](/chernabog/flows/flows/#work-that-goes-away) whether its issue or pull request is still there to work on. A run whose item went (closed, merged, claimed by another run) ends as `superseded`, with why, and is released as `chernabog cancel` releases a run; an agent step in progress stops, leaving its session open. A check that fails leaves the run running: the log says so, and `status` shows `stillValid failed N time(s) in a row` under the run until one succeeds. Notifications only make the check sooner: several about one item make one check, no more often than `limits.eventTickMin`, and the interval still checks every run whether a notification came or not.

### Leases

A run's claim on its issue or pull request (`refs/chernabog/claims/<item>`) is a lease: its claim commit says when it expires. The daemon renews the leases of its runs in flight, executing and parked alike, every `limits.leaseRenewEvery` (default `30 minutes`), for `limits.leaseTtl` (default `12 hours`) from then, or `limits.parkedLeaseTtl` (default `3 days`) for a run parked on review, CI or a person. A paused or draining daemon keeps renewing: its runs in flight still hold their work. `status` shows each run's lease, when it runs out and when it was last renewed, and a lease whose last renewal failed as `at risk`.

A claim whose lease ran out, because the machine that held it is closed for the weekend, wiped or gone, can be taken over: a run whose trigger finds the item claims it with a commit on top of the expired one. Renewing and taking over each replace the claim commit through a ref only one writer can create (`refs/chernabog/leases/<item>/<sha>`), so of a holder renewing late and a run taking over, exactly one wins. The run that takes over adopts the work branch and any pull request, and says on the issue or pull request whose run it took over and when that run's lease expired.

A run that loses its lease stops. Before each comment, label, assignment, review, merge, pull request or push, it checks that its claim still names it, and the daemon checks too, with each validity check and renewal. A run that finds its claim another run's ends as **`lost`**, with who took over, and leaves everything it put on the item, worktree included, to the run that took it over. A small window between the check and the write remains. A claim from before leases has no expiry and is never taken over.

The daemon reads machine config's enrolled repos when it starts, and checks them every ten seconds. When they change — a repo `chernabog enroll` adds, one dropped or moved, a flow turned on or off for a persona — the daemon restarts on them once nothing is executing, as it does on newly trusted config. Runs in flight resume, and `status` says a restart is pending. A new repo shows in `status` as `untrusted` until you run `chernabog trust` on it.

A repo whose checkout is gone shows as `missing`, with `checkout missing at <path>`, and starts no runs. Its settings stay in machine config. When the checkout comes back, or `chernabog init` at its new place points the entry there, the daemon restarts on it.

## The dashboard

The daemon serves a dashboard for a browser, on `127.0.0.1` only, and only while you've asked for it:

| Command | Does |
| ------- | ---- |
| `chernabog ui [--port N]` | starts it if it's off (or moves it to `N`), then opens it in the default browser (`open` on macOS, `xdg-open` on Linux); `--print` prints the URL instead |
| `chernabog ui start [--port N]` | starts it, and prints its URL |
| `chernabog ui stop` | stops it |
| `chernabog ui status` | says whether it's running, and where |
| `chernabog ui --rotate-token` | makes a new token first; the old URL stops working |

Without `--port` it opens on the port you last asked for, else `4848`. A port that's in use is refused; it never picks another. What you asked is kept in `~/.config/chernabog/dashboard.json`, so the daemon opens it again after a restart or an upgrade; if the port is taken then, `daemon.log` says so and the daemon carries on without it.

The URL carries a token, kept in `~/.config/chernabog/dashboard.token` (readable only by you, and the same across restarts, so a bookmark keeps working). Opening it sets a cookie, and the dashboard answers its API only to a browser holding that cookie. It also refuses a request addressed to any host but `127.0.0.1:<port>` or `localhost:<port>`, and a change sent from another origin or not as JSON, so a web page you visit can't use it.

From the dashboard you can pause and resume a repo, and change a persona's settings in it, as the [live view](/chernabog/work/live-view/) can: turn a flow on or off, give it a schedule of its own (checked as cron before it's sent; empty, the team's applies again), and pick the account the persona, or one of its roles, spends. Each change is for the persona whose flow or accounts it's on; filter by persona to see only theirs. If another process is changing machine config at that moment, the dashboard says it's busy: try again. Enrolling, unenrolling and trusting a repo stay on the command line: they name paths on disk, and trusting lets a repo's code run.

## The engine

The journal is `~/.config/chernabog/state.db`. A lock file next to it keeps a second engine from starting, which is why `run --from-checkout` needs the daemon stopped. Each step a team writes runs in a child process, so a step that crashes or hangs fails only its own activity. Runs in flight when the daemon stops resume when it starts.

## Logs

| File                                 | Holds            |
| ------------------------------------ | ---------------- |
| `~/.config/chernabog/daemon.log`     | the daemon, today (UTC) |
| `~/.config/chernabog/daemon.<YYYY-MM-DD>.log` | the daemon, on an earlier day; deleted after 30 days |
| `~/.config/chernabog/daemon.out.log` | what the service manager catches of the daemon's stdout and stderr, such as a crash; emptied past 10 MB |
| `~/.config/chernabog/runs/<run>.log` | one run; `chernabog logs <run> -f` |
| `~/.config/chernabog/telemetry/<day>/<process>-<pid>.jsonl` | the spans and logs of one process, the daemon's or a CLI command's, as JSON lines, in a folder for each UTC day |

The daemon keeps these to a retention policy, sweeping when it starts and every 24 hours:

- **Telemetry:** a day folder goes once it's more than 30 days old, and then the oldest go while the rest hold more than 500 MB. Today's is never removed.
- **Run logs:** a run's log goes 30 days after the run finished. A run still running, or parked waiting, keeps its log; a log with no run in `state.db` goes 30 days after it was last written.
- **`daemon.log`:** the daemon moves it to `daemon.<YYYY-MM-DD>.log` at its first write of each new UTC day, and the sweep deletes those older than 30 days.

A service unit installed by a chernabog from before `daemon.out.log` sent the daemon's output to `daemon.log`; the daemon rewrites it when it starts on a newer chernabog. systemd uses the rewritten unit from the daemon's next start, and launchd from the next login, or after `chernabog stop` and `chernabog start`.
