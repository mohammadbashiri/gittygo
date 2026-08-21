# GittyGo

Git review for humans and agents.

GittyGo opens a normal mouse-and-keyboard window for reviewing repository changes without launching an editor. It deliberately does not decide when it should be opened; that policy belongs to the user and their agent.

## Current prototype

- Staged and unstaged file groups
- Unified and side-by-side diffs
- Independently resizable and collapsible Changes and History sidebars with persisted state
- Stage/unstage all changes, individual files, hunks, and selected changed-line ranges
- Line/range review comments exposed immediately through agent context, with lightweight resolution and agent-driven navigation
- Discard files and hunks with native confirmation
- Agent-populated, user-editable commit messages plus commit/amend and safe undo
- Commit history with refs, comparison context, change totals, structured file inventory, and lazy read-only visual diffs
- Branch picker and branch creation
- Fetch, guarded fast-forward pull, and guarded push
- Add, inspect, and remove remotes
- Ahead/behind and upstream status
- Automatic refresh while an agent edits the repository
- System light/dark appearance

## One-command installation

After the first GitHub Release is published, Apple Silicon macOS users can install or update GittyGo with:

```bash
curl -fsSL https://raw.githubusercontent.com/mohammadbashiri/gittygo/main/scripts/install.sh | sh
```

The installer verifies the release checksum, installs the unsigned `GittyGo.app` under `~/Applications`, installs `gittygo` under `~/.local/bin`, and copies the canonical skill into detected agent skill directories. It does not require Node.js or npm. The build is not Apple-verified or notarized.

Uninstall while preserving local review state:

```bash
gittygo-uninstall
```

Use `gittygo-uninstall --purge` only when the local `~/.gittygo` state should also be deleted.

## Run locally

Requires Node.js 22+ and Git.

```bash
npm install
npm start -- /path/to/repository
```

To install the non-blocking CLI locally:

```bash
npm link
cd /path/to/repository
gittygo open . --json
```

The launcher opens the live window, immediately returns control to the caller, and prints a repository-bound session ID, cursor, authoritative initial snapshot, and generic agent instruction.

While the window remains active, any shell-capable agent can retrieve UI actions and current repository state without a harness-specific integration:

```bash
gittygo context --session <session-id> --after <cursor> --json
```

The response contains ordered semantic events, authoritative repository and review snapshots, and `nextCursor`. The agent retains `nextCursor` for its next query. Repeating a cursor is safe. Run `gittygo instructions` to print the protocol instructions separately.

Open review comments are delivered through the same context response. The user simply tells the agent when to inspect them; events are notifications rather than instructions to act. Agents can inspect or resolve comments without a harness-specific adapter:

```bash
gittygo review show --session <session-id> --json
gittygo review focus --session <session-id> --comment <comment-id> --json
gittygo review resolve --session <session-id> --comment <comment-id> --json
gittygo commit-message set --session <session-id> --message "Proposed message" --json
gittygo commit-message clear --session <session-id> --json
```

`gittygo .` remains shorthand for `gittygo open .`. Use `--wait` only when a blocking process is explicitly desired.

## Product boundary

This repository currently builds one tool: visual Git review. It is not an IDE, a general agent UI framework, or an automatic workflow system. Agent coordination uses a self-describing CLI pull protocol so the tool remains independent of Pi, Claude, Codex, MCP, or any other harness.

## Development

```bash
npm test
```

Resolved comments leave the active review store; GittyGo is a structured feedback queue rather than a permanent discussion archive. Resolution events remain available for the lifetime of the coordination session.

The renderer runs with Electron context isolation and sandboxing enabled. All repository mutations are handled in the main process, and destructive actions require user confirmation. Confirmed destructive and network operations are cancelled if their reviewed repository state changes while confirmation is open.

## Security and trust boundary

GittyGo is currently intended for **trusted local repositories**. Git operations can invoke behavior configured by Git itself, including hooks, credential helpers, remote helpers, and repository remotes. Electron renderer sandboxing does not sandbox the external `git` process.

GittyGo has no telemetry or application analytics. Repository coordination state and review comments are stored locally under `~/.gittygo` with user-only permissions. Network access occurs only through Git actions initiated by the user.

## Packaging development

An unsigned Apple Silicon ZIP can be built for local verification:

```bash
npm run dist:mac:unsigned
```

The resulting artifact is unsigned and intentionally makes no Apple-verification or notarization claim. The free-distribution path uses the checksum-verifying installer above. The first public alpha still requires a final icon and license, complete packaged workflow testing, and clean-user installation testing.
