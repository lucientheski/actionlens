# Show HN: ActionLens – Interactive debugger for GitHub Actions workflows

**URL:** https://github.com/lucientheski/actionlens

**Text:**

I built ActionLens because I was tired of the commit-push-wait-read-logs-repeat cycle when debugging CI pipelines.

ActionLens lets you step through GitHub Actions workflows locally with Docker. Think of it as a debugger for your CI — you can pause before each step, inspect the container environment, shell in, set breakpoints, modify variables, and re-run failed steps.

**What makes it different from act/PipeStep:**

- **Real `uses:` action execution** — it clones action repos, parses action.yml, and runs JavaScript/composite/Docker actions locally. Not just `run:` steps.
- **Expression evaluation** — `${{ secrets.*, env.*, github.*, steps.*.outputs.* }}` with built-in functions
- **Secrets injection** — from a local `.env` file (no more hardcoding test values)
- **Interactive TUI** — step-through with breakpoints, shell access, variable inspection
- **Session recording** — captures what happened for replay

**Usage:**
```bash
npm install -g actionlens
actionlens run .github/workflows/ci.yml
```

Known limitations: This is v0.1.0 — the action toolkit shim won't cover every edge case, and some complex actions may need manual intervention (you can always shell in). Matrix builds and artifact upload/download are planned for v0.2.

Built with Node.js, zero runtime dependencies beyond dockerode. MIT licensed.

Interested in feedback — especially from people who have real CI debugging pain points.
