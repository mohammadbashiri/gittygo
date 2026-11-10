# Embedded browser theme contract (version 1)

GittyGo has no dependency on any host application's CSS. Its standalone/browser
and native appearance remains the system-selected dark/light theme in
`src/renderer/styles.css`. No Electron rebuild or installer is needed to use this
browser-only interface; serve the updated renderer assets. Electron's existing
preload remains authoritative and the browser adapter returns before installing
any theme handler when `window.gittyGo` already exists.

## Host setup and delivery

Embed the browser workspace on the **same origin** as its immediate parent, with
a nonempty `hostId` query parameter chosen by the host, e.g.
`/proxy/w/<workspaceId>/?hostId=<unique-instance-id>`. This is the same opt-in
identity/trust boundary as `gittygo:host-state`; host visibility messages remain
separate and unchanged. Theme does not depend on visibility, start polling, or
invoke RPC. `hostId` identifies the embedding instance, not an authorization
secret; the host must authorize its workspace/proxy independently.

After each iframe `load`, and whenever the host theme changes:

```js
iframe.contentWindow.postMessage({
  type: 'gittygo:theme',
  version: 1,
  hostId, // exactly the iframe's hostId parameter
  theme: {
    colorScheme: 'light', // exactly 'light' or 'dark'
    tokens: {
      bg: '#f7f8fa',
      panel: '#ffffff',
      text: 'rgb(36, 39, 45)',
      'accent-soft': 'rgba(53,107,214,.1)',
    },
  },
}, location.origin); // exact target origin, not '*'
```

Only messages whose source is the immediate parent, origin equals the iframe's
own origin, version is numeric `1`, and hostId exactly matches are accepted.
Sibling/self/cross-origin/unknown-version messages are ignored. A top-level
standalone page, or an iframe without a nonempty hostId, does not opt in. There
is no URL theme/CSS parameter or arbitrary stylesheet interface.

No acknowledgement is sent. Use the iframe load event to deliver initial state
and resend after a reload; no polling or retry/RPC protocol is necessary.

## Tokens and validation

All tokens are optional. `tokens` is required and must be an object (not an
array); `{}` selects the requested scheme's built-in defaults. Each message is a
**complete replacement**, not a patch: omitted tokens revert to built-in defaults
for the explicit scheme, even if the OS prefers the other scheme.

Exact public key → CSS custom property mapping:

| Public key | CSS property |
| --- | --- |
| `bg` | `--bg` |
| `panel` | `--panel` |
| `raised` | `--raised` |
| `border` | `--border` |
| `soft` | `--soft` |
| `text` | `--text` |
| `muted` | `--muted` |
| `faint` | `--faint` |
| `accent` | `--accent` |
| `accent-soft` | `--accent-soft` |
| `green` | `--green` |
| `green-bg` | `--green-bg` |
| `red` | `--red` |
| `red-bg` | `--red-bg` |
| `yellow` | `--yellow` |

Values are strings of at most 80 characters, in one of these formats:

- `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (case-insensitive hex).
- `rgb(R,G,B)` with integer channels from 0 through 255.
- `rgba(R,G,B,A)` with the same channels and alpha `0`, `1`, or a fractional
  decimal such as `.14` / `0.14`. Whitespace inside functions is allowed.

Functional values must also pass the browser's `CSS.supports('color', value)`.
The host must convert computed colors into these formats; named colors, hsl,
modern space-separated rgb, percentages, CSS variables, `color-mix`, `url`,
`expression`, declarations/semicolons and arbitrary CSS are deliberately not
accepted. Unknown token names (including `--`-prefixed names, font variables and
prototype-like keys), invalid values, unknown theme fields, missing fields or
invalid colorScheme reject the **whole message** without changing the current
theme. Top-level envelope fields other than the protocol identity/type are not
used. Token values are assigned individually through `style.setProperty`, never
inserted as CSS text or HTML.

## First visible render

After a valid theme application or reset, the embedded child replies to its immediate same-origin parent with `{ type: 'gittygo:theme-applied', version: 1, hostId }`. Invalid/untrusted messages receive no acknowledgement. This is a readiness signal after the allowlisted inline tokens/color scheme have been applied, not a Git RPC or a renderer remount.

A host can create the iframe with `visibility: hidden`, send its initial theme, and reveal it only after validating this reply's source window, origin, version and hostId. This avoids exposing the standalone palette while the initial theme message is in flight. Existing/standalone/native views remain unchanged; hosts should show a recoverable error if initialization fails instead of revealing an unthemed frame.

## Reset

Send the same envelope with `theme: null` to remove every host token and the
explicit color scheme, returning to the existing OS-selected standalone theme:

```js
iframe.contentWindow.postMessage({
  type: 'gittygo:theme', version: 1, hostId, theme: null,
}, location.origin);
```

Theme updates only change root color properties and `data-host-color-scheme`.
They do not re-render content, change focus/selection/drafts, reset navigation,
change worktree targeting, allocate request IDs, or invoke mutations. GittyGo derives an internal `--accent-ink` for filled accent controls, choosing
dark or white text by relative-luminance contrast against the accent composited
on the host background. This is not an additional public token; reset removes
the derived override. Standalone dark/light themes supply their own defaults.
The host still owns accessible palette choices for other surfaces; GittyGo
validates syntax and trust, not arbitrary palette contrast. Existing non-tokenized decorative colors are unchanged.

## Verification

`node --test test/theme.browser.test.mjs` launches isolated headless Chromium
against a disposable HTTP/RPC fixture. It covers authorized application/reset,
explicit dark/light versus OS defaults, whole-message invalidation, hostile
colors/keys, source/origin/hostId/version rejection, paused-host no-RPC behavior,
standalone/native-preload exclusion, preserved commit/review drafts, textarea
focus/caret/direction and diff selection. Screenshots are written to
`/tmp/gittygo-theme-{light,dark,default}.png`.
