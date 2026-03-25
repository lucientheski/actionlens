# ActionLens

Interactive CI pipeline debugger for GitHub Actions. Debug workflows locally with Docker — step through steps, pause, inspect, shell in, set breakpoints, inject secrets — without pushing and waiting.

## Status

**Phase 1** — Project scaffold complete. Core modules implemented:
- Workflow YAML parser with job/step normalization
- Expression evaluator (`${{ env.*, secrets.*, github.*, steps.*.outputs.* }}`)
- Docker container lifecycle management (via dockerode)
- Action runner for `uses:` steps (clone, parse action.yml, execute)
- Secrets loader from `.env` files
- Session recorder for replay

## Install

```bash
npm install -g actionlens
```

## Usage

```bash
# List jobs and steps in a workflow
actionlens list .github/workflows/ci.yml

# Run/debug a workflow
actionlens run .github/workflows/ci.yml

# Run a specific job
actionlens run .github/workflows/ci.yml --job build

# Use a custom secrets file
actionlens run .github/workflows/ci.yml --env-file .env.local
```

## Key Differentiator

Unlike other tools, ActionLens supports:
- **Real `uses:` action execution** — clones action repos, parses action.yml, runs JS/composite/Docker actions
- **Expression evaluation** — `${{ secrets.*, env.*, steps.*.outputs.* }}`
- **Secrets injection** — from local `.env` file
- **Session recording** — capture and replay step results

## Development

```bash
npm install
npm test
```

## License

MIT
