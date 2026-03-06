/* Shared debug logging helper for Pulse frontend modules. */

const readLocalDebugPreference = () => {
    if (typeof window === "undefined" || !window.localStorage) {
        return null;
    }
    const raw = window.localStorage.getItem("pulse_debug");
    if (typeof raw !== "string") {
        return null;
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === "0" || normalized === "false" || normalized === "off") {
        return false;
    }
    if (normalized === "1" || normalized === "true" || normalized === "on") {
        return true;
    }
    return null;
};

export const isPulseDebugEnabled = () => {
    if (typeof window === "undefined") {
        return true;
    }
    if (typeof window.PULSE_DEBUG === "boolean") {
        return window.PULSE_DEBUG;
    }
    const localPreference = readLocalDebugPreference();
    if (typeof localPreference === "boolean") {
        return localPreference;
    }
    return true;
};

export const debugLog = (scope, message, details) => {
    if (!isPulseDebugEnabled()) {
        return;
    }
    if (details === undefined) {
        console.log(`[pulse:${scope}] ${message}`);
        return;
    }
    console.log(`[pulse:${scope}] ${message}`, details);
};

export const debugWarn = (scope, message, details) => {
    if (!isPulseDebugEnabled()) {
        return;
    }
    if (details === undefined) {
        console.warn(`[pulse:${scope}] ${message}`);
        return;
    }
    console.warn(`[pulse:${scope}] ${message}`, details);
};
