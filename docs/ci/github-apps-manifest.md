# CI: making the GitHub Apps from manifests, tried for real

The four questions #481 asked of GitHub's App manifest flow, which its docs
don't answer, and what `chernabog ci apps` met when it first registered #477's
two Apps. Everything here was observed on `dataquail/chernabog-rehearsal` on
2026-11-11, unless marked **not observed**.

## Verdict

**The manifest flow works as `chernabog ci apps` uses it, with three
changes.** GitHub accepts a listener on `127.0.0.1` for both redirects, and
an App made with an inactive webhook subscribes to no events. Two things
weren't as expected:

- GitHub refuses a new App's JWT for a moment after it makes the App.
- GitHub's install page offers every repo of the owner first.

The changes are listed under [Changes made](#changes-made).

## What was made

`chernabog ci apps --repo dataquail/chernabog-rehearsal --prefix chernabog --environments`,
run from the branch with `CHERNABOG_HOME=~/.config/chernabog-rehearsal`:

| App                | Id      | Installation | Environment                     |
| ------------------ | ------- | ------------ | ------------------------------- |
| `chernabog-author` | 5714322 | 180921803    | `chernabog-author`, any branch  |
| `chernabog-review` | 5714350 | 180922055    | `chernabog-review`, `main` only |

Each App's permissions are #477's table, as GitHub reports them
(`GET /apps/<slug>`). The author has checks read and the reviewer checks
write; neither has workflows, and `events` is `[]` for both. Each Environment
holds `CHERNABOG_APP_ID` and the secret `CHERNABOG_APP_KEY`. Both personas got
a real installation token through #479's `app` token source. Each token was
good for an hour, with a refresh due 55 minutes out.

## The questions

### 1. Does GitHub accept `http://127.0.0.1:<port>` as `redirect_url` and `setup_url`?

**Yes, for both.** After **Create GitHub App**, GitHub redirected to
`http://127.0.0.1:<port>/created?code=…&state=…`. After **Install**, it
redirected to `/installed`. The listener chooses its port when it starts, so a
manifest's URLs are good only for that run, which is all they're used for.

### 2. Can the install page preselect the repo?

**Not observed, and GitHub doesn't by default.** `/apps/<slug>/installations/new`
opens on **All repositories** of the owner. To keep an App to one repo, the
person has to choose **Only select repositories** and then pick the repo.
`suggested_target_id` and `repository_ids[]` weren't tried.

This matters more than it looks. Each installation in this run ended up
covering six of the org's repos, `dataquail/chernabog` among them. An
installation's token, and so the key in a repo's Environment, can write to
every repo the installation covers. A CI job in the rehearsal repo could have
written to this one.

### 3. Does `hook_attributes: { url, active: false }` register an App with no webhook deliveries?

**Yes.** Both Apps registered with `url` set to the repo's page and
`active: false`, and subscribe to no events. Whether `url` may be left out
was **not observed**.

### 4. What does the redirect to `setup_url` carry, and does it come for an organization's repo?

**It comes after an install on an organization's repo.** Its query parameters
weren't recorded, so whether it carries `setup_action` is **not observed**.
It doesn't matter here: the command never reads `installation_id`, which can
be forged, and asks GitHub as the App for its installation on the repo
instead.

## Also found

- **A new App's JWT is refused for a moment.** The reviewer's first
  installation check, signed right after the conversion, got
  `401 {"message":"Integration must generate a public key"}`. The author's
  didn't. The command stopped, leaving the reviewer installed but without a
  persona or an Environment. It was recovered by adding the persona to
  machine config by hand and running `--role reviewer` again, which took the
  reuse path.
- **Reusing an App works.** That rerun found the App already installed on the
  repo, set up its Environment and opened no browser.

## Changes made

1. **The command waits out a new App's 401** (`AppKeyNotReady`) and checks
   again, as it does for an App that isn't installed yet.
2. **It warns about the repos an installation covers besides `--repo`**,
   listing them from the installation's own token, and says where to narrow
   them: the App's **Configure**, **Repository access**.
3. **The docs tell the person to choose Only select repositories** on the
   install page.

## Still to do

- Narrow the two installations to `chernabog-rehearsal`. A person does this on
  GitHub.
- Narrow each token to the repo it's for. Both `POST
/app/installations/{id}/access_tokens` and `actions/create-github-app-token`
  take the repos to limit it to. This belongs to #477's plan-and-run chunk,
  and to the `app` token source for a daemon.
- Try `suggested_target_id` and `repository_ids[]` on the install page.
