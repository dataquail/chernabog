# The chernabog action

What a repo's chernabog workflow runs on GitHub Actions: it installs a pinned
chernabog release and runs [`chernabog ci plan`](https://dataquail.github.io/chernabog/work/commands/#ci-plan)
or [`chernabog ci run`](https://dataquail.github.io/chernabog/work/commands/#ci-run).
The logic is in chernabog; this is only the glue.

Don't write the workflow by hand: `chernabog init`, or
`chernabog ci workflow --write`, writes `.github/workflows/chernabog.yml` from
the repo's `.chernabog/config.yaml`, and `chernabog doctor` checks it still
matches.

```yaml
- uses: dataquail/chernabog/action@v0.16.0
  with:
    step: plan # or run, with flow, persona and item from the plan's matrix
    version: 0.16.0
  env:
    GH_TOKEN: ${{ secrets.CHERNABOG_TOKEN }}
    CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

It lives in this repo and is versioned with the binary: each binary release's
tag, `v<version>`, is also the action's, so the action a workflow names and the
chernabog it installs always come from the same commit.
