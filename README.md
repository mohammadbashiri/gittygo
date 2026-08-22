<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/gittygo_logo_darkbackground.svg">
    <img src="assets/gittygo_logo_lightbackground.svg" alt="GittyGo logo" width="160">
  </picture>
</p>

<p align="center"><strong>GittyGo</strong></p>

<p align="center"><strong>Turn Git diffs into a conversation with your coding agent.</strong></p>

GittyGo gives you and your agent a shared visual workspace for reviewing local changes. Ask your agent to show you the diff in GittyGo, then comment on exact lines or ranges. Your agent reads that feedback in context, addresses it, and the diff updates live.

**Agent changes code → you review → you comment → agent fixes → repeat → commit.**

<!-- Demo GIF/video here -->

## GittyGo is:

- **Standalone** — no editor-specific workflow required.
- **Agent-agnostic** — works with any shell-capable coding agent.
- **Local and controlled** — review uncommitted changes, stage exact files, hunks, or lines, and commit only what you approve.
- **Conversational** — line-level feedback becomes structured context for your agent.
- **Live** — watch the diff update as your agent edits.

## Install (Apple Silicon macOS)

Install or update GittyGo with:

```bash
curl -fsSL https://raw.githubusercontent.com/mohammadbashiri/gittygo/main/scripts/install.sh | sh
```

The installer verifies the release checksum, installs the unsigned `GittyGo.app` under `~/Applications`, installs `gittygo` under `~/.local/bin`, and copies the canonical skill into detected agent skill directories. It does not require Node.js or npm. The build is not Apple-verified or notarized.

Uninstall while preserving local review state:

```bash
gittygo-uninstall
```

Use `gittygo-uninstall --purge` only when the local `~/.gittygo` state should also be deleted.

Before testing, review the [known alpha limitations](KNOWN_LIMITATIONS.md). Invited testers can use the [ten-minute testing checklist](TESTING.md).

## Usage

From a Git repository, ask your coding agent:

> Show me the changes in GittyGo.

Or open it directly:

```bash
cd /path/to/repository
gittygo .
```

GittyGo opens a live, nonblocking review window. Comment on changed lines or ranges, return to your agent, and ask it to inspect your GittyGo comments. The agent can retrieve the exact diff context, focus comments for discussion, address them with its normal tools, and resolve them when finished.

`gittygo .` is shorthand for `gittygo open .`. Use `--wait` only when a blocking process is explicitly desired.

## Features

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

## Agent integration

The launcher returns control immediately and prints a repository-bound session ID, cursor, authoritative initial snapshot, and generic agent instruction:

```bash
gittygo open . --json
```

Any shell-capable agent can retrieve UI actions and current repository state without a harness-specific integration:

```bash
gittygo context --session <session-id> --after <cursor> --json
```

The response contains ordered semantic events, authoritative repository and review snapshots, and `nextCursor`. The agent retains `nextCursor` for its next query. Repeating a cursor is safe. Run `gittygo instructions` to print the protocol instructions separately.

Open review comments are delivered through the same context response. Events are notifications rather than instructions to act. Agents can inspect, focus, or resolve comments and propose a commit message without a harness-specific adapter:

```bash
gittygo review show --session <session-id> --json
gittygo review focus --session <session-id> --comment <comment-id> --json
gittygo review resolve --session <session-id> --comment <comment-id> --json
gittygo commit-message set --session <session-id> --message "Proposed message" --json
gittygo commit-message clear --session <session-id> --json
```

Resolved comments leave the active review store. GittyGo is a structured feedback queue rather than a permanent discussion archive; resolution events remain available for the lifetime of the coordination session.

## Troubleshooting

- **`gittygo: command not found`:** open a new terminal. The installer adds `~/.local/bin` to `~/.zprofile` when needed.
- **Git is unavailable:** run `xcode-select --install` to install Apple's command-line Git.
- **Repository operation failed:** run `git status` in the repository for the underlying Git state and error context.
- **State appears damaged:** quit GittyGo and move `~/.gittygo` to a backup location before reopening. Do not delete it until the problem is understood.
- **macOS blocks launch:** do not disable system security or remove quarantine manually; report the exact message and how the installer was obtained.

## Product boundary

GittyGo is a visual Git review tool. It is not an IDE, a general agent UI framework, or an automatic workflow system. Agent coordination uses a self-describing CLI pull protocol so the tool remains independent of Pi, Claude, Codex, MCP, or any other harness.

GittyGo does not decide when it should be opened. Invocation policy belongs to the user and their agent.

## Security and trust boundary

GittyGo is currently intended for **trusted local repositories**. Git operations can invoke behavior configured by Git itself, including hooks, credential helpers, remote helpers, and repository remotes. Electron renderer sandboxing does not sandbox the external `git` process.

The renderer runs with Electron context isolation and sandboxing enabled. All repository mutations are handled in the main process, and destructive actions require user confirmation. Confirmed destructive and network operations are cancelled if their reviewed repository state changes while confirmation is open.

GittyGo has no telemetry or application analytics. Repository coordination state and review comments are stored locally under `~/.gittygo` with user-only permissions. Network access occurs only through Git actions initiated by the user.

## Development

Requires Node.js 22+ and Git.

```bash
npm install
npm start -- /path/to/repository
```

To install the nonblocking CLI locally:

```bash
npm link
cd /path/to/repository
gittygo open . --json
```

Run the test suite:

```bash
npm test
```

Build an unsigned Apple Silicon ZIP for local verification:

```bash
npm run dist:mac:unsigned
```

The resulting artifact is unsigned and intentionally makes no Apple-verification or notarization claim. Public prerelease artifacts are distributed through the checksum-verifying installer above.

## License and branding

GittyGo's source code is available under the [MIT License](LICENSE). The [branding policy](BRANDING.md) allows truthful references and compatible forks while requiring modified distributions to avoid presenting themselves as official GittyGo releases.
