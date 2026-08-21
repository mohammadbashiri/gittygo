# Git Review

A focused visual Git review tool that any coding agent—or human—can invoke.

Git Review opens a normal mouse-and-keyboard window for reviewing repository changes without launching an editor. It deliberately does not decide when it should be opened; that policy belongs to the user and their agent.

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
git-review open . --json
```

The launcher opens the live window, immediately returns control to the caller, and prints a repository-bound session ID, cursor, authoritative initial snapshot, and generic agent instruction.

While the window remains active, any shell-capable agent can retrieve UI actions and current repository state without a harness-specific integration:

```bash
git-review context --session <session-id> --after <cursor> --json
```

The response contains ordered semantic events, authoritative repository and review snapshots, and `nextCursor`. The agent retains `nextCursor` for its next query. Repeating a cursor is safe. Run `git-review instructions` to print the protocol instructions separately.

Open review comments are delivered through the same context response. The user simply tells the agent when to inspect them; events are notifications rather than instructions to act. Agents can inspect or resolve comments without a harness-specific adapter:

```bash
git-review review show --session <session-id> --json
git-review review focus --session <session-id> --comment <comment-id> --json
git-review review resolve --session <session-id> --comment <comment-id> --json
git-review commit-message --session <session-id> --message "Proposed message" --json
```

`git-review .` remains shorthand for `git-review open .`. Use `--wait` only when a blocking process is explicitly desired.

## Product boundary

This repository currently builds one tool: visual Git review. It is not an IDE, a general agent UI framework, or an automatic workflow system. Agent coordination uses a self-describing CLI pull protocol so the tool remains independent of Pi, Claude, Codex, MCP, or any other harness.

## Development

```bash
npm test
```

Resolved comments leave the active review store; Git Review is a structured feedback queue rather than a permanent discussion archive. Resolution events remain available for the lifetime of the coordination session.

The renderer runs with Electron context isolation and sandboxing enabled. All repository mutations are handled in the main process, and destructive actions require user confirmation.
