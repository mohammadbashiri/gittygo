# Git Review

A focused visual Git review tool that any coding agent—or human—can invoke.

Git Review opens a normal mouse-and-keyboard window for reviewing repository changes without launching an editor. It deliberately does not decide when it should be opened; that policy belongs to the user and their agent.

## Current prototype

- Staged and unstaged file groups
- Unified and side-by-side diffs
- Stage/unstage files, hunks, and selected changed-line ranges
- Discard files and hunks with native confirmation
- Commit or amend staged changes and safely undo the last commit while preserving changes
- Commit history with refs, metadata, and commit diffs
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

The response contains ordered semantic events, an authoritative snapshot, and `nextCursor`. The agent retains `nextCursor` for its next query. Repeating a cursor is safe. Run `git-review instructions` to print the protocol instructions separately.

`git-review .` remains shorthand for `git-review open .`. Use `--wait` only when a blocking process is explicitly desired.

## Product boundary

This repository currently builds one tool: visual Git review. It is not an IDE, a general agent UI framework, or an automatic workflow system. Agent coordination uses a self-describing CLI pull protocol so the tool remains independent of Pi, Claude, Codex, MCP, or any other harness.

## Development

```bash
npm test
```

The renderer runs with Electron context isolation and sandboxing enabled. All repository mutations are handled in the main process, and destructive actions require user confirmation.
