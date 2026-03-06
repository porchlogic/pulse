/* Shared keep-alive noise floor utilities for Bluetooth speaker noise-gate mitigation. */

const NOISE_FLOOR_STORAGE_KEY = "pulse_noise_floor_enabled";
const NOISE_FLOOR_GAIN = 0.0018;

export const readStoredNoiseFloorEnabled = () => {
    if (typeof window === "undefined" || !window.localStorage) {
        return true;
    }
    const raw = String(window.localStorage.getItem(NOISE_FLOOR_STORAGE_KEY) || "").trim().toLowerCase();
    if (raw === "0" || raw === "false" || raw === "off") {
        return false;
    }
    if (raw === "1" || raw === "true" || raw === "on") {
        return true;
    }
    return true;
};

export const persistNoiseFloorEnabled = (enabled) => {
    if (typeof window === "undefined" || !window.localStorage) {
        return;
    }
    window.localStorage.setItem(NOISE_FLOOR_STORAGE_KEY, enabled ? "1" : "0");
};

export const createNoiseFloorKeepAlive = ({ audioContext, targetNode } = {}) => {
    let source = null;
    let gain = null;
    let enabled = false;

    const destroyNodes = () => {
        if (source) {
            source.onended = null;
            try {
                source.disconnect();
            } catch {}
            source = null;
        }
        if (gain) {
            try {
                gain.disconnect();
            } catch {}
            gain = null;
        }
    };

    const buildNoiseBuffer = () => {
        const sampleRate = audioContext.sampleRate;
        const len = Math.max(1, Math.trunc(sampleRate));
        const buffer = audioContext.createBuffer(1, len, sampleRate);
        const data = buffer.getChannelData(0);
        let y = 0;
        const smoothing = 0.03;
        for (let i = 0; i < len; i += 1) {
            const x = (Math.random() * 2) - 1;
            y += smoothing * (x - y);
            data[i] = y;
        }
        return buffer;
    };

    const start = () => {
        if (!audioContext || !targetNode || source || audioContext.state === "closed") {
            return;
        }
        const noiseBuffer = buildNoiseBuffer();
        source = audioContext.createBufferSource();
        source.buffer = noiseBuffer;
        source.loop = true;
        gain = audioContext.createGain();
        gain.gain.value = NOISE_FLOOR_GAIN;
        source.connect(gain);
        gain.connect(targetNode);
        source.start();
        source.onended = () => {
            destroyNodes();
        };
    };

    const stop = () => {
        if (!source || !gain) {
            destroyNodes();
            return;
        }
        const now = audioContext.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(Math.max(0.00001, gain.gain.value), now);
        gain.gain.linearRampToValueAtTime(0.00001, now + 0.02);
        try {
            source.stop(now + 0.03);
        } catch {
            destroyNodes();
        }
    };

    const setEnabled = (nextEnabled) => {
        enabled = Boolean(nextEnabled);
        if (enabled) {
            start();
        } else {
            stop();
        }
    };

    const destroy = () => {
        enabled = false;
        stop();
        destroyNodes();
    };

    return {
        destroy,
        isEnabled: () => enabled,
        setEnabled,
    };
};
