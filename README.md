# ActionLens

**Stop the commit-push-wait-fail cycle.** Debug GitHub Actions workflows locally — step through steps, set breakpoints, shell into the container, inspect variables — before you push.

```
actionlens run .github/workflows/ci.yml
```

```
┌─ Steps ──────────────────────────┐┌─ Output ──────────────────────────┐
│ ✓ 1. Checkout code        [uses] ││ $ npm ci                          │
│ ● 2. Install deps          [run] ││ added 243 packages in 4.2s       │
│   3. Run tests             [run] ││                                   │
│   4. Upload coverage      [uses] ││                                   │
│                                  ││                                   │
│ [R]un [S]kip [B]reakpoint [I]nto ││                                   │
└──────────────────────────────────┘└───────────────────────────────────┘
```

Step 2 is paused. You can inspect the container, check `node_modules`, modify env vars, then press `R` to continue. Or `I` to drop into a shell.

## Why not act / nektos?

| | **ActionLens** | **act** (69k stars) | **PipeStep** (18 stars) | **breakpoint** (305 stars) |
|---|---|---|---|---|
| Step-through debugging | Yes | No — batch only | Yes | No |
| `uses:` action execution | Yes — clones, parses action.yml, runs | Yes | No — `run:` only | N/A |
| Expression evaluation | `${{ secrets.*, env.*, steps.*.outputs.* }}` | Yes | No | N/A |
| Secrets from `.env` | Yes | Yes | No | N/A |
| Shell into container | Yes, mid-step | No | No | Yes, on failure only |
| Breakpoints | Yes | No | Yes | Reactive only |
| Conditionals / `if:` | Yes | Yes | No | N/A |
| Session recording | Yes | No | No | No |

**act** is great for running workflows locally. But when a step fails, you're back to reading logs. There's no way to pause, inspect, and iterate.

**PipeStep** has a similar TUI concept, but only handles `run:` steps. If your workflow uses `actions/checkout`, `actions/setup-node`, or any other `uses:` step, it can't run them.

**breakpoint** lets you SSH into a GitHub Actions runner — but only after failure, and only on actual GitHub-hosted runners. It's reactive, not proactive.

## Install

```bash
npm install -g actionlens
```

**Requires:** Node.js >= 18, Docker running (Docker Desktop or Engine)

## Usage

```bash
# List workflow structure
actionlens list .github/workflows/ci.yml

# Debug interactively
actionlens run .github/workflows/ci.yml

# Target a specific job
actionlens run .github/workflows/ci.yml --job build

# Start at step 3
actionlens run .github/workflows/ci.yml --step 3

# Set breakpoints from CLI
actionlens run .github/workflows/ci.yml --breakpoint 2,4

# Custom secrets file
actionlens run .github/workflows/ci.yml --env-file .env.local
```

## TUI Keybindings

| Key | Action |
|-----|--------|
| `R` | Run current step |
| `S` | Skip current step |
| `A` | Auto-run all remaining steps |
| `N` | Run to next breakpoint |
| `B` | Toggle breakpoint |
| `I` | Shell into container |
| `E` | View step environment variables |
| `V` | View expression variables |
| `↑/k` `↓/j` | Navigate steps |
| `Tab` | Switch focus (steps / output) |
| `Q` | Quit (cleans up container) |

## How it works

1. **Parse** — Reads `.github/workflows/*.yml`, normalizes jobs and steps
2. **Docker** — Pulls runner image, creates container with workspace mounted at `/github/workspace`
3. **Pause** — Each step waits for input. `R` to run, `S` to skip, `I` to shell in
4. **Execute** — `run:` steps via `docker exec`. `uses:` steps clone the action, parse `action.yml`, run it
5. **Evaluate** — Expressions like `${{ steps.build.outputs.artifact }}` resolve from collected context
6. **Record** — Results saved to `.actionlens/recordings/` for replay

## Limitations

This is **v0.1.0**. Be aware:

- **Docker required** — no podman support yet
- **Action toolkit shim** — covers common patterns but won't handle every edge case. Complex actions may need manual intervention (shell in with `I`)
- **Matrix builds** — not yet supported (planned for v0.2)
- **Artifact upload/download** — not yet supported (planned for v0.2)
- **Runner environment** — uses `ubuntu:22.04`, not GitHub's full runner image. Some pre-installed tools may be missing

If something doesn't work, you can always shell into the container and run it manually.

## Development

```bash
npm install
npm test          # 146 tests
```

## License

MIT
