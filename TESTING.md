# GittyGo friend-testing checklist

Thank you for testing the `0.1.0` alpha. Please start with a repository that is backed up or easy to recreate.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/mohammadbashiri/gittygo/main/scripts/install.sh | sh
```

Open a new terminal after installation, then run inside a repository:

```bash
gittygo .
```

## Ten-minute test

1. Confirm staged, unstaged, and untracked files appear correctly.
2. Open several text diffs and switch between unified and side-by-side views.
3. Stage and unstage one file, one hunk, and selected changed lines.
4. Add a review comment and ask your agent to inspect the GittyGo context.
5. Let the agent focus the comment, then resolve it.
6. Commit a small change and inspect it in History.
7. Close and reopen GittyGo; confirm local state remains usable.

Only test discard, amend, undo, pull, or push on a repository where mistakes are recoverable.

## Report a problem

Include:

- macOS version and Mac model;
- installation or GittyGo command used;
- repository situation, without private source code;
- exact steps;
- expected and actual behavior;
- screenshot and exact error text where useful.

Do not include credentials, tokens, private keys, or confidential repository content.

## Uninstall

Preserve local review state:

```bash
gittygo-uninstall
```

Delete the app and all GittyGo state:

```bash
gittygo-uninstall --purge
```
