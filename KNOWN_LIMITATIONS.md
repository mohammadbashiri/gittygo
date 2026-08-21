# Known limitations — 0.1.0 alpha

- GittyGo is currently available only for Apple Silicon macOS.
- The free build is unsigned and not notarized by Apple. It makes no verified-developer claim.
- GittyGo is intended for repositories you trust. Git itself may invoke configured hooks, credential helpers, remote helpers, and network remotes.
- Merge, rebase, cherry-pick, and revert states are detected, but conflicts must be resolved with normal Git tools or an editor.
- Very large committed-file diffs are truncated for display. Extremely large working-tree diffs may exceed the current Git output limit.
- There is no automatic updater. Rerun the installer to update while preserving `~/.gittygo` state.
- There is no built-in crash reporting or telemetry. Problems must be reported manually.
- The first alpha targets one local user and one active UI process per review session.
- Destructive actions require confirmation and stale-state checks, but users should still test the alpha on backed-up or recoverable repositories.
