# Issue draft 2 → dsh-extension-manager (self / fork upstream)

**Title:** toggleMcp always writes `disabled:false` — client omits the flag and host defaults `!!undefined`

## Repro (v0.1.0)

1. Open the extension manager MCP tab. Any server showing enabled → click **Disable**.
2. Inspect the managed region of `profiles/web/cordis.patch.yml`.

Result: a `- {id, disabled: false}` row appears — i.e. "disable" actually wrote *enabled*, while the UI reports success ("已写入配置，重启后生效").

## Root cause

Client, `lib/client.js` (`doToggle`):

```js
return call("toggleMcp", { id: item.id })   // ← no disabled flag
```

Host, `lib/host.js`:

```js
return toggleMcp(input.id || input.name, !!input.disabled, ...)   // !!undefined === false
```

Compare with the sibling skills flow, which correctly passes `disabled: !!item.enabled`.

## Impact

- Users can never disable a server from this page; the button silently no-ops in one direction.
- Combined with a later real enable click, the patch region can drift into contradictory states versus what the UI shows.

## Fix shipped locally (v0.2.0 draft)

* Client passes the explicit target: `{ id, disabled: !!item.enabled }`.
* Host honors an explicit boolean and falls back to flipping the CURRENT persisted state when absent:

```js
const currentDisabled = toggleMap(this._patchPath())[id] === true
const disabled = typeof input.disabled === 'boolean' ? input.disabled : !currentDisabled
```

Regression tests included (`tests/server-modes.test.mjs` T-series + host-side flip semantics).

## Related observation

Every managed-region write rotates `.cordis.patch.yml.bak.*` with the previous file content. While secrets lived in plaintext inside that file (GitHub PAT), each click resurrected them into another on-disk copy. Two suggestions:

1. Document that backup ring rotation copies secrets unless configs are secret-free.
2. Consider supporting env-var references natively in emitted headers (the loader already evaluates `!!js` before plugin mount) so user files never need literal tokens.
