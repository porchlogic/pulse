# Pulse Web App

Pulse is Porchlogic's browser-based live performance control app.

It supports two primary user paths:
- `DJ`: log in, manage songs/tracks, and run the perform interface.
- `Troupe`: join a session (QR flow placeholder), connect, and select tracks.

The frontend is currently a lightweight multi-view app that loads route templates into a single shell. Runtime styling is loaded from `./assets/styles/foundation.css` (synced from `web/shared/styles/foundation.css`).

## Self-contained deploy artifact

For GitHub Pages or any deploy that only syncs `web/pulse.porchlogic.com`, first vendor shared assets:

```bash
bash web/pulse.porchlogic.com/scripts/sync-shared-assets.sh
```

This copies `web/shared/styles/foundation.css` to `web/pulse.porchlogic.com/assets/styles/foundation.css`.


## development

from WSL terminal:

`cd web`

`python3 -m http.server 8000` 


from another WSL terminal:

`cd web`

`ngrok http 8000` 

## Server-backed controls (required pattern)

For any control that edits server state (inputs with an Apply button, toggles with commits, etc.), use:

- `src/components/ui/server-field-controller.js`

Do not bind these controls directly to live app state. Use local draft + explicit commit:

1. Keep a local draft while user edits.
2. Do not overwrite draft from incoming state updates.
3. Commit only on explicit action (Apply/Enter).
4. Clear draft only after a successful server response.
5. Keep draft on failure so user can retry.

Tempo is the reference implementation:

- `src/components/ui/tempo-control.js`

Example:

```js
import { mountServerFieldController } from "../../components/ui/server-field-controller.js";

const control = mountServerFieldController({
    inputEl,
    applyButton,
    readServerValue: () => state.performance.bpm,
    formatServerValue: (value) => String(value),
    parseDraftValue: (raw) => {
        const value = Number(raw);
        if (!Number.isFinite(value)) {
            return { ok: false, error: "Invalid number" };
        }
        return { ok: true, value };
    },
    canEdit: () => state.auth.authenticated === true,
    commitValue: async (value) => {
        await sendValueToServer(value);
    },
});

// Call on every render/update.
control.sync();

// On unmount.
control.destroy();
```
