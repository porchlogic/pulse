/* Shared tempo input/apply behavior that preserves user edits across live state updates. */

import { mountServerFieldController } from "./server-field-controller.js";

const clampTempoBpm = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return { ok: false, error: "Tempo must be a number" };
    }
    return {
        ok: true,
        value: Math.max(60, Math.min(220, Math.trunc(numeric))),
    };
};

export const mountTempoControl = ({
    inputEl,
    applyButton,
    getCurrentBpm = () => 120,
    canEdit = () => true,
    onApply = async () => {},
} = {}) => {
    if (!inputEl || !applyButton) {
        return {
            sync: () => {},
            destroy: () => {},
        };
    }

    return mountServerFieldController({
        inputEl,
        applyButton,
        readServerValue: () => {
            const parsed = clampTempoBpm(getCurrentBpm());
            return parsed.ok ? parsed.value : 120;
        },
        formatServerValue: (value) => String(value),
        parseDraftValue: (rawValue) => clampTempoBpm(rawValue),
        canEdit,
        commitValue: onApply,
    });
};
