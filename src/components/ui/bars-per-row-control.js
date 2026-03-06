/* Shared bars-per-row input/apply behavior for quantized perform grids. */

import { mountServerFieldController } from "./server-field-controller.js";

const clampBarsPerRow = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return { ok: false, error: "Bars per row must be a number" };
    }
    return {
        ok: true,
        value: Math.max(1, Math.min(16, Math.trunc(numeric))),
    };
};

export const mountBarsPerRowControl = ({
    inputEl,
    applyButton,
    getCurrentBarsPerRow = () => 4,
    isServerValueReady = () => true,
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
        isServerValueReady,
        formatPendingValue: () => "",
        readServerValue: () => {
            const parsed = clampBarsPerRow(getCurrentBarsPerRow());
            return parsed.ok ? parsed.value : 4;
        },
        formatServerValue: (value) => String(value),
        parseDraftValue: (rawValue) => clampBarsPerRow(rawValue),
        canEdit,
        commitValue: onApply,
    });
};
