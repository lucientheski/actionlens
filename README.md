# ActionLens

Interactive CI pipeline debugger for GitHub Actions. Debug workflows locally with Docker — step through steps, pause, inspect, shell in, set breakpoints, inject secrets — without pushing and waiting.

## Status

**Phase 3** — Docker runner integration complete. The TUI is fully wired to Docker:
- Workflow YAML parser with job/step normalization
- Expression evaluator (`${{ env.*, secrets.*, github.*, steps.*.outputs.* }}`)
- Docker container lifecycle: availability check, image pull with progress, container creation with workspace mount
- Real-time streaming output from step execution
- Action runner for `uses:` steps (clone, parse action.yml, execute)
- Secrets loader from `.env` files
- Session recorder for replay

## Prerequisites

- **Node.js** >= 18
- **Docker** — Docker Desktop or Docker Engine must be running

## Install

```bash
npm install -g actionlens
```

## Usage

### List workflow structure

```bash
actionlens list .github/workflows/ci.yml
```

Shows all jobs and steps with type indicators (`[run]` / `[uses]`).

### Debug a workflow interactively

```bash
actionlens run .github/workflows/ci.yml
```

This will:
1. Parse the workflow YAML
2. Check that Docker is running (clear error if not)
3. Pull the Docker image (`ubuntu:22.04` for `ubuntu-latest`) with progress
4. Create a container with your repo mounted at `/github/workspace`
5. Launch the interactive TUI debugger

### Run a specific job

```bash
actionlens run .github/workflows/ci.yml --job build
```

### Start at a specific step

```bash
actionlens run .github/workflows/ci.yml --step 3
```

### Set breakpoints from CLI

```bash
actionlens run .github/workflows/ci.yml --breakpoint 2,4
```

### Use a custom secrets file

```bash
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
| `I` | Shell into container (interactive bash) |
| `E` | View step environment variables |
| `V` | View expression variables |
| `↑/k` | Navigate up |
| `↓/j` | Navigate down |
| `Tab` | Switch focus (steps ↔ output) |
| `Q` | Quit (cleans up container) |

## How it works

1. **Parse** — Reads your `.github/workflows/*.yml` and normalizes jobs/steps
2. **Docker** — Pulls the runner image and creates a container with your workspace mounted
3. **Step-by-step** — Each step pauses for user input (`R` to run)
4. **Execute** — `run:` steps execute via `docker exec` in the container
5. **Stream** — Output streams to the TUI output panel in real-time
6. **Record** — Results are captured in `.actionlens/recordings/` for replay

## Key Differentiator

Unlike other tools, ActionLens supports:
- **Real `uses:` action execution** — clones action repos, parses action.yml, runs JS/composite/Docker actions
- **Expression evaluation** — `${{ secrets.*, env.*, steps.*.outputs.* }}`
- **Secrets injection** — from local `.env` file
- **Real-time streaming** — stdout/stderr stream to the TUI as steps execute
- **Session recording** — capture and replay step results

## Development

```bash
npm install
npm test
```

## License

MIT
