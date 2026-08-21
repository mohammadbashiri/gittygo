# Git Review

A focused visual Git review tool that any coding agent—or human—can invoke.

Git Review opens a normal mouse-and-keyboard window for reviewing repository changes without launching an editor. It deliberately does not decide when it should be opened; that policy belongs to the user and their agent.

## Current prototype

- Staged and unstaged file groups
- Unified and side-by-side diffs
- Stage/unstage files and individual hunks
- Discard files and hunks with native confirmation
- Commit staged changes
- Automatic refresh while an agent edits the repository
- System light/dark appearance

## Run locally

Requires Node.js 22+ and Git.

```bash
npm install
npm start -- /path/to/repository
```

To exercise the agent-style non-blocking launcher:

```bash
npm link
cd /path/to/repository
git-review
```

The launcher prints a small JSON acknowledgement and immediately returns control to the caller. Use `git-review . --wait` when a blocking process is preferred.

## Product boundary

This repository currently builds one tool: visual Git review. It is not an IDE, a general agent UI framework, or an automatic workflow system. Portable skill and MCP integrations will come after the core review experience is solid.

## Development

```bash
npm test
```

The renderer runs with Electron context isolation and sandboxing enabled. All repository mutations are handled in the main process, and destructive actions require user confirmation.
