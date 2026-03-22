# NanoClaw — nanoclaw-discord (Robocop)

Discord bot assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process connecting Discord channels to Claude Agent SDK running in Apple Containers. Each Discord channel (group) has an isolated filesystem and memory. Storage lives on the Helix NAS volume.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/discord.ts` | Discord connection, auth, send/receive |
| `src/channels/discord-voice.ts` | Voice channel join/leave, TTS |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals, DATA_ROOT |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group agent memory (isolated) |

## Storage Layout

```
DATA_ROOT = /Volumes/Helix/Work/agents-work/nanoclaw ethnobot/
├── store/messages.db          # SQLite message history
├── groups/                    # Per-channel working folders (→ /workspace/group inside container)
│   ├── main/
│   ├── ethnobot-dev/
│   └── ...
└── data/registered_groups.json
```

Groups also exist at `nanoclaw-discord/groups/` (local) — these hold CLAUDE.md and logs only. Runtime data (SQLite, registered_groups) is on the NAS.

## Container Mounts (per agent)

| Container path | Host path | Access |
|----------------|-----------|--------|
| `/workspace/project` | nanoclaw-discord install dir | read-only |
| `/workspace/group` | DATA_ROOT/groups/{name} | read-write |
| `/workspace/groups` | DATA_ROOT/groups/ | read-only (cross-channel view) |
| `/workspace/data` | DATA_ROOT | read-only (main group only) |
| `/workspace/extra/ethno-vault` | /Volumes/Helix/Work/agents-work/nanoclaw ethnobot/vault | read-write |
| `/workspace/extra/ethnobot` | ~/Documents/Git/ethnobot | read-write |
| `/workspace/extra/ppx-agent` | /Volumes/Helix/helix-ops/build/ppx-agent | read-only |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream NanoClaw changes, merge with customizations, run migrations |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-discord   # restart
tail -f logs/nanoclaw.log                                   # logs
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
