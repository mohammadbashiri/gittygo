# GittyGo Release Readiness

Living checklist for the first unsigned macOS alpha and eventual public developer preview.

**Status legend:** ✅ Done · 🟡 Partial / needs verification · ⬜ Not started · 🔴 Blocker

## Current release decision

| Target | Status | Reason |
|---|---|---|
| Local development use | ✅ Ready | Core workflows work; 21 automated tests pass. |
| Unsigned `0.1.0-alpha.1` GitHub alpha | 🔴 Not ready | Final icon, GitHub publication, complete packaged smoke testing, and clean-user testing remain. |
| Public developer preview | 🔴 Not ready | Private-alpha gates plus broader security, compatibility, documentation, and tester feedback remain. |

## 1. Product foundation

| Check | Status | Evidence / next action |
|---|---|---|
| Product identity is consistently GittyGo | ✅ | App, CLI, package, state directory, session prefix, docs, and tests renamed. |
| Canonical repository extracted | 🟡 | Local repository exists at `/Users/mo/Projects/gittygo`; private GitHub repository awaits renewed `gh` authentication. |
| Historical timestamps shifted after working hours | ✅ | Existing product history shifted exactly six hours while preserving order and intervals. |
| Untouched history backup exists | ✅ | `/Users/mo/Projects/agentic-ui-tools-pre-gittygo.bundle` verified as complete. |
| Canonical portable agent skill | ✅ | `skills/gittygo/SKILL.md`; explicit invocation only, normal Git commands remain the agent interface. |
| Versioning policy | ✅ | Package and planned first tag use `0.1.0-alpha.1` / `v0.1.0-alpha.1`. |
| License selected and included | ✅ | MIT License, copyright © 2026 Mohammad Bashiri; package metadata declares MIT. |
| Official branding protected | ✅ | `BRANDING.md` permits truthful references but requires modified distributions to avoid implying official status or endorsement. |

## 2. Core correctness and data safety

| Check | Status | Evidence / next action |
|---|---|---|
| Automated test suite | ✅ | 21 tests pass. |
| Git mutations serialized | ✅ | In-process mutation queue retained. |
| Cross-process session/review updates serialized | ✅ | `proper-lockfile` coordination; concurrent 20-event and 12-comment writer tests pass without lost updates. |
| Session journal crash recovery | ✅ | Sequence allocation derives from the fsynced journal; stale metadata and incomplete-tail recovery are tested. |
| Destructive actions require confirmation | ✅ | File/hunk discard and history-rewriting actions use explicit confirmation. |
| Stale destructive-operation protection | ✅ | File/repository/config fingerprints are rechecked after confirmation; changed state cancels the operation. A final external-Git TOCTOU window is unavoidable and treated as residual risk. |
| External edits refresh selected diff | ✅ | File/index metadata and request-generation checks tested with repeated external edits. |
| Session/review files are private | ✅ | State directories use `0700`; files use `0600` and atomic replacement. |
| Legacy state migration | ✅ | `~/.git-review` → `~/.gittygo` migration is manually verified and covered by an isolated permission/migration test. |
| Failure recovery | 🟡 | Git errors, commit undo, abandoned lock recovery, and event-journal repair exist; document user-facing recovery expectations. |

## 3. Security and privacy

| Check | Status | Evidence / next action |
|---|---|---|
| Electron sandbox and context isolation | ✅ | Renderer sandbox/context isolation enabled; Node integration disabled. |
| Navigation and permission restrictions | ✅ | External navigation denied; permission requests denied. |
| Content Security Policy | ✅ | Local-only CSP present; verify packaged behavior. |
| Repository strings/comments rendered safely | ✅ | Focused audit found escaped renderer output and explicit untrusted-data agent instructions; no direct HTML injection route found. |
| Git argument/command-injection resistance | 🟡 | Focused audit found argument-array execution and branch validation with no shell-injection route; add hostile-input regression tests. |
| Path traversal and symlink safety | 🟡 | Discard logic contains path checks; perform complete filesystem-boundary audit and tests. |
| Installer supply-chain integrity | 🟡 | HTTPS-only downloads, SHA-256 verification, private temporary extraction, and fail-closed checks are implemented; validate against an actual GitHub Release. |
| Dependency vulnerability audit | ✅ | `npm audit` reports zero vulnerabilities. |
| Dependency license audit | 🟡 | Production tree is MIT/ISC only (`proper-lockfile`, `graceful-fs`, `retry`, `signal-exit`); preserve notices and audit packaged Electron licenses. |
| Telemetry/network behavior | ✅ | No telemetry or application analytics; trusted-repository/network boundary is documented in README. |
| Signing credentials protected | ✅ Not applicable | No Apple signing credentials are used for the chosen unsigned release path. |

## 4. Git behavior test matrix

| Scenario | Status | Evidence / next action |
|---|---|---|
| Staged/unstaged files and all/file/hunk/line operations | ✅ | Automated coverage plus manual UI testing. |
| Initial/unborn repository | 🟡 | Some root-commit and unstage logic exists; add end-to-end empty/unborn-repository tests. |
| Renames, copies, binary files, root commits | ✅ | Structured History tests cover root, rename, text, and binary cases. |
| Merge commits and first-parent comparison | 🟡 | Implemented; add explicit merge-commit test. |
| Conflicts and in-progress Git operations | 🟡 | Detected in UI; add realistic merge/rebase/cherry-pick scenario tests. |
| Linked worktrees | 🟡 | Repository identity accounts for worktrees; add integration tests. |
| Large diffs and large commits | 🟡 | History patch cap exists; Changes rendering needs explicit limits and stress testing. |
| Unusual filenames | 🟡 | Null-delimited parsing exists; add spaces, Unicode, tabs/newlines, and leading-dash tests. |
| Concurrent agent/user edits | 🟡 | Cross-process stores, stale rendering, and mutation fingerprints are tested; add an IPC-level modal-confirmation regression test. |
| Fetch/pull/push against real remotes | 🟡 | Guarded behavior implemented; add disposable local-remote integration tests. |

## 5. Packaging and macOS integration

| Check | Status | Evidence / next action |
|---|---|---|
| Target platform defined | ✅ | First private alpha: macOS Apple Silicon. |
| Product metadata | 🟡 | Product name, author, alpha version, bundle ID `io.github.mohammadbashiri.gittygo`, category, and artifact naming are configured; finalize copyright/license. |
| Final app icon | 🟡 | Final light/dark logo SVGs are complete; compose the macOS app tile and export `.icns` plus required PNG sizes. |
| Electron packaging configuration | 🟡 | Electron Builder produces an unsigned arm64 ASAR ZIP; finalize icon, entitlements/signing, and DMG verification. |
| Packaged CLI wrapper | ✅ | Bundled `ELECTRON_RUN_AS_NODE` wrapper runs instructions/context and launches the packaged GUI without external Node/npm. |
| Apple Developer signing | ✅ Deferred by decision | The free release intentionally makes no verified-developer claim; revisit only if future demand justifies Apple’s annual fee. |
| Apple notarization and stapling | ✅ Deferred by decision | Not part of the unsigned GitHub distribution path. |
| Packaged smoke tests | 🟡 | Unsigned packaged app launch plus CLI `instructions`, `open`, and `context` pass; remaining review/mutation/migration flows need packaged testing. |
| Clean-user install | 🟡 | Isolated-home install/update/CLI test passes without using external Node/npm; still test through a genuinely fresh macOS account. |
| Uninstall behavior | ✅ | `gittygo-uninstall` removes app/CLI and unchanged detected skills while preserving `~/.gittygo`; `--purge` explicitly removes state. |

## 6. Distribution

| Check | Status | Evidence / next action |
|---|---|---|
| Private GitHub repository | 🔴 | GitHub CLI token is invalid; renew authentication, create `mohammadbashiri/gittygo`, and push. |
| GitHub Release | ⬜ | Publish unsigned `v0.1.0-alpha.1` ZIP plus `SHA256SUMS` only after remaining gates pass. |
| Source-install fallback | 🟡 | `npm install`, `npm link`, and `gittygo .` work; optional source installer can wait. |
| One-command packaged installer | ✅ Locally validated | `scripts/install.sh` verifies SHA-256, installs under `~/Applications`/`~/.local/bin`, avoids `sudo`, and rolls forward by rerunning. Remote URL awaits GitHub release. |
| Agent-skill installation | ✅ | Installer copies the bundled canonical skill into detected Pi/Claude/Codex skill roots and reports each change. |
| Update path | ✅ | Rerunning the installer stages and replaces the app while preserving local state. |
| Website/domain | ✅ Not required | GitHub repository, Releases, and raw installer URL are sufficient. |
| Docker distribution | ✅ Deferred | Not appropriate as primary native-GUI installation path. |

## 7. Documentation and private-alpha gate

| Check | Status | Evidence / next action |
|---|---|---|
| README accurately describes current source workflow | ✅ | Renamed and tested commands documented. |
| Installation documentation | 🟡 | README documents planned one-command install, update-by-rerun, and state-preserving/purge uninstall; verify final public URLs after release. |
| Security/privacy statement | 🟡 | README documents trusted repositories, Git execution boundary, local state, permissions, no telemetry, and user-initiated network activity; add reporting channel before public preview. |
| Known limitations | ⬜ | Document developer-preview boundaries, especially large diffs and unsupported conflict resolution. |
| Troubleshooting and recovery | ⬜ | Cover startup, Git errors, state reset, update, and uninstall. |
| Private tester checklist | ⬜ | Create concise install/core-workflow/uninstall feedback script. |
| Self-use soak period | ⬜ | Use signed package for 1–2 weeks after private alpha build. |
| Trusted external testers | ⬜ | Test with 2–3 invited users before public release. |
| Public-preview decision | ⬜ | Make only after all blockers are closed and private feedback is reviewed. |
