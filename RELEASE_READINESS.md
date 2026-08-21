# GittyGo Release Readiness

Living checklist for the first unsigned macOS alpha and eventual public developer preview.

**Status legend:** ✅ Done · 🟡 Partial / needs verification · ⬜ Not started · 🔴 Blocker

## Current release decision

| Target | Status | Reason |
|---|---|---|
| Local development use | ✅ Ready | Core workflows work; 21 automated tests pass. |
| Unsigned `0.1.0-alpha.1` GitHub alpha | 🟡 Distribution blocked | Code, icon, package, installer, targeted tests, and packaged smoke test are ready; GitHub authentication/release and real download validation remain. |
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
| Automated test suite | ✅ | 26 targeted tests pass. |
| Git mutations serialized | ✅ | In-process mutation queue retained. |
| Cross-process session/review updates serialized | ✅ | `proper-lockfile` coordination; concurrent 20-event and 12-comment writer tests pass without lost updates. |
| Session journal crash recovery | ✅ | Sequence allocation derives from the fsynced journal; stale metadata and incomplete-tail recovery are tested. |
| Destructive actions require confirmation | ✅ | File/hunk discard and history-rewriting actions use explicit confirmation. |
| Stale destructive-operation protection | ✅ | File/repository/config fingerprints are rechecked after confirmation; changed state cancels the operation. A final external-Git TOCTOU window is unavoidable and treated as residual risk. |
| External edits refresh selected diff | ✅ | File/index metadata and request-generation checks tested with repeated external edits. |
| Session/review files are private | ✅ | State directories use `0700`; files use `0600` and atomic replacement. |
| Legacy state migration | ✅ | `~/.git-review` → `~/.gittygo` migration is manually verified and covered by an isolated permission/migration test. |
| Failure recovery | ✅ Alpha scope | Git errors, commit undo, abandoned-lock recovery, event-journal repair, and state-backup troubleshooting are covered. |

## 3. Security and privacy

| Check | Status | Evidence / next action |
|---|---|---|
| Electron sandbox and context isolation | ✅ | Renderer sandbox/context isolation enabled; Node integration disabled. |
| Navigation and permission restrictions | ✅ | External navigation denied; permission requests denied. |
| Content Security Policy | ✅ | Local-only CSP present; verify packaged behavior. |
| Repository strings/comments rendered safely | ✅ | Focused audit found escaped renderer output and explicit untrusted-data agent instructions; no direct HTML injection route found. |
| Git argument/command-injection resistance | ✅ Alpha scope | Focused audit found argument-array execution, option terminators, and branch validation with no direct shell-injection route. |
| Path traversal and symlink safety | ✅ Alpha scope | Focused audit found no direct traversal route; discard boundaries and state-root symlink rejection are implemented and tested. |
| Installer supply-chain integrity | 🟡 | HTTPS-only downloads, SHA-256 verification, private temporary extraction, and fail-closed checks are implemented; validate against an actual GitHub Release. |
| Dependency vulnerability audit | ✅ | `npm audit` reports zero vulnerabilities. |
| Dependency license audit | ✅ | Production tree is MIT/ISC; dependency texts remain in ASAR and Electron/Chromium notices plus project license/branding are bundled as app resources. |
| Telemetry/network behavior | ✅ | No telemetry or application analytics; trusted-repository/network boundary is documented in README. |
| Signing credentials protected | ✅ Not applicable | No Apple signing credentials are used for the chosen unsigned release path. |

## 4. Git behavior test matrix

| Scenario | Status | Evidence / next action |
|---|---|---|
| Staged/unstaged files and all/file/hunk/line operations | ✅ | Automated coverage plus manual UI testing. |
| Initial/unborn repository | ✅ | End-to-end stage, unstage, and initial-commit behavior is tested. |
| Renames, copies, binary files, root commits | ✅ | Structured History tests cover root, rename, text, and binary cases. |
| Merge commits and first-parent comparison | ✅ Alpha scope | First-parent comparison is implemented; deeper merge-history testing can follow friend feedback. |
| Conflicts and in-progress Git operations | ✅ Alpha scope | Real merge-conflict detection is tested; rebase/cherry-pick resolution remains intentionally outside the UI. |
| Linked worktrees | ✅ | Common-repository and distinct-worktree identity behavior is integration-tested. |
| Large diffs and large commits | ✅ Alpha scope | History patch cap exists and limits are documented; additional stress tuning can follow real usage. |
| Unusual filenames | ✅ Alpha scope | Spaces, Unicode, and leading-dash paths are tested; pathological newline filenames are deferred. |
| Concurrent agent/user edits | ✅ Alpha scope | Cross-process stores, stale rendering, mutation fingerprints, and concurrent writers are tested; deeper UI race automation is deferred. |
| Fetch/pull/push against real remotes | ✅ | Disposable bare-remote integration test covers initial push, fetch, behind state, fast-forward pull, and subsequent push. |

## 5. Packaging and macOS integration

| Check | Status | Evidence / next action |
|---|---|---|
| Target platform defined | ✅ | First private alpha: macOS Apple Silicon. |
| Product metadata | ✅ | Product name, author, copyright, MIT license, alpha version, bundle ID `io.github.mohammadbashiri.gittygo`, category, icon, and artifact naming are configured. |
| Final app icon | ✅ | Final light/dark logo SVGs plus the macOS squircle source, 1024px PNG, complete iconset, and `.icns` are generated and wired into Electron Builder. |
| Electron packaging configuration | ✅ Alpha scope | Electron Builder produces the intended unsigned branded arm64 ASAR ZIP with bundled CLI, skills, and license resources; DMG/signing are intentionally unnecessary for the friend alpha. |
| Packaged CLI wrapper | ✅ | Bundled `ELECTRON_RUN_AS_NODE` wrapper runs instructions/context and launches the packaged GUI without external Node/npm. |
| Apple Developer signing | ✅ Deferred by decision | The free release intentionally makes no verified-developer claim; revisit only if future demand justifies Apple’s annual fee. |
| Apple notarization and stapling | ✅ Deferred by decision | Not part of the unsigned GitHub distribution path. |
| Packaged smoke tests | ✅ Friend-alpha scope | Automated isolated-home smoke test covers checksum install, skill/CLI, GUI open, context, external edits, review show, commit-message requests, and state-preserving uninstall. |
| Clean-user install | ✅ Friend-alpha scope | Automated isolated-home install/update/CLI/uninstall passes without external Node/npm; the first friend installations provide the true clean-account validation. |
| Uninstall behavior | ✅ | `gittygo-uninstall` removes app/CLI and unchanged detected skills while preserving `~/.gittygo`; `--purge` explicitly removes state. |

## 6. Distribution

| Check | Status | Evidence / next action |
|---|---|---|
| Private GitHub repository | 🔴 | GitHub CLI token is invalid; renew authentication, create `mohammadbashiri/gittygo`, and push. |
| GitHub Release | ⬜ | Publish unsigned `v0.1.0-alpha.1` ZIP plus `SHA256SUMS` only after remaining gates pass. |
| Source-install fallback | ✅ Deferred | Packaged installer is the friend-alpha path; source installation remains available to developers but needs no additional work now. |
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
| Known limitations | ✅ | `KNOWN_LIMITATIONS.md` documents platform, unsigned status, trusted repositories, conflicts, large diffs, updates, telemetry, and alpha safety. |
| Troubleshooting and recovery | ✅ Alpha scope | README covers PATH, Git installation, Git errors, state backup/reset, and blocked launch guidance. |
| Private tester checklist | ✅ | `TESTING.md` provides a ten-minute workflow, safe-testing boundary, reporting fields, and uninstall instructions. |
| Self-use soak period | 🟡 In progress | Begin using the unsigned candidate now; trusted-friend testing does not need to wait for a long internal soak. |
| Trusted external testers | ⬜ | Test with 2–3 invited users before public release. |
| Public-preview decision | ⬜ | Make only after all blockers are closed and private feedback is reviewed. |
