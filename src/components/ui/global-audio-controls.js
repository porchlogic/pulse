/* App-wide speaker/drum controls shown for authenticated users. */

import {
    getAppState,
    setSpeakerLatencyBaseSeconds,
    setSpeakerLatencyTrimSeconds,
    subscribeAppState,
} from "../../state.js";
import { debugLog, debugWarn } from "../util/debug.js";
import { createSpeakerLatencyCalibrator } from "../audio/speaker-latency-calibrator.js";
import {
    createDrumPulseSynth,
    persistDrumPulseEnabled,
    readStoredDrumPulseEnabled,
} from "../audio/drum-pulse-synth.js";

const buildHtml = () => `
    <section class="ui-section ui-global-audio" data-role="global-audio-root" hidden>
        <div class="ui-stack">
            <div class="ui-row-between">
                <strong>Audio</strong>
                <button type="button" class="ui-button ui-button--small" data-role="global-drum-toggle">Enable Drum Pulse</button>
            </div>
            <div class="ui-row-between">
                <button type="button" class="ui-button ui-button--small" data-role="global-calibrate">Calibrate Speaker</button>
                <p class="ui-label" data-role="global-latency-readout">Latency: 0.00s</p>
            </div>
            <div class="ui-field">
                <label class="ui-label" for="global-latency-trim">Speaker trim (-/+ seconds)</label>
                <input id="global-latency-trim" class="ui-input" type="range" min="-0.30" max="0.30" step="0.005" value="0" data-role="global-latency-trim">
                <p class="ui-label" data-role="global-trim-value">Trim: +0.000s</p>
            </div>
        </div>
    </section>
`;

export const mountGlobalAudioControls = ({ mountNode } = {}) => {
    if (!mountNode) {
        return () => {};
    }

    mountNode.innerHTML = buildHtml();

    const root = mountNode.querySelector("[data-role=\"global-audio-root\"]");
    const calibrateButton = mountNode.querySelector("[data-role=\"global-calibrate\"]");
    const drumToggleButton = mountNode.querySelector("[data-role=\"global-drum-toggle\"]");
    const latencyReadoutEl = mountNode.querySelector("[data-role=\"global-latency-readout\"]");
    const trimSliderEl = mountNode.querySelector("[data-role=\"global-latency-trim\"]");
    const trimValueEl = mountNode.querySelector("[data-role=\"global-trim-value\"]");
    if (!root || !calibrateButton || !drumToggleButton || !latencyReadoutEl || !trimSliderEl || !trimValueEl) {
        return () => {};
    }

    let latestState = getAppState();
    let calibrating = false;
    let togglingDrum = false;
    let triedRestoreDrumState = false;

    const drumPulseSynth = createDrumPulseSynth({
        getPulseState: () => latestState.pulse,
        getLatencySeconds: () => Number(latestState.pulse.speakerLatencyCompensationSeconds) || 0,
    });

    const speakerLatencyCalibrator = createSpeakerLatencyCalibrator({
        setStatus: (text) => {
            if (calibrating) {
                latencyReadoutEl.textContent = text;
            }
        },
    });

    const formatSignedSeconds = (value) => {
        const v = Number(value) || 0;
        const sign = v >= 0 ? "+" : "-";
        return `${sign}${Math.abs(v).toFixed(3)}s`;
    };

    const render = () => {
        const isAuthenticated = latestState.auth.authenticated === true;
        root.hidden = !isAuthenticated;
        if (!isAuthenticated && drumPulseSynth.isRunning()) {
            drumPulseSynth.stop();
        }
        if (!isAuthenticated) {
            return;
        }

        const base = Number(latestState.pulse.speakerLatencyBaseSeconds) || 0;
        const trim = Number(latestState.pulse.speakerLatencyTrimSeconds) || 0;
        const effective = Number(latestState.pulse.speakerLatencyCompensationSeconds) || 0;
        if (!calibrating) {
            latencyReadoutEl.textContent = `Latency: ${effective.toFixed(2)}s (base ${base.toFixed(2)} + trim ${formatSignedSeconds(trim)})`;
        }
        trimSliderEl.value = trim.toFixed(3);
        trimValueEl.textContent = `Trim: ${formatSignedSeconds(trim)}`;
        calibrateButton.disabled = calibrating;
        calibrateButton.textContent = calibrating ? "Calibrating..." : "Calibrate Speaker";
        drumToggleButton.disabled = togglingDrum;
        drumToggleButton.textContent = drumPulseSynth.isRunning() ? "Disable Drum Pulse" : "Enable Drum Pulse";
    };

    const withTimeout = async (promise, timeoutMs) => {
        let timeoutId = 0;
        try {
            return await Promise.race([
                promise,
                new Promise((resolve) => {
                    timeoutId = window.setTimeout(() => resolve(false), timeoutMs);
                }),
            ]);
        } finally {
            if (timeoutId) {
                window.clearTimeout(timeoutId);
            }
        }
    };

    const toggleDrum = async () => {
        if (togglingDrum || latestState.auth.authenticated !== true) {
            return;
        }
        togglingDrum = true;
        render();
        try {
            if (drumPulseSynth.isRunning()) {
                debugLog("drum-toggle", "stopping drum pulse");
                try {
                    drumPulseSynth.stop();
                } catch (error) {
                    debugWarn("drum-toggle", "drum stop error", error);
                }
                persistDrumPulseEnabled(false);
                return;
            }

            debugLog("drum-toggle", "starting drum pulse");
            const startPromise = Promise.resolve()
                .then(() => drumPulseSynth.start())
                .catch((error) => {
                    debugWarn("drum-toggle", "drum start error", error);
                    return false;
                });
            const started = await withTimeout(startPromise, 1500);
            if (!started) {
                debugWarn("drum-toggle", "drum start timed out or was blocked");
            }
            persistDrumPulseEnabled(Boolean(started));
            debugLog("drum-toggle", "drum toggle result", {
                started: Boolean(started),
                running: drumPulseSynth.isRunning(),
            });
        } finally {
            togglingDrum = false;
            render();
        }
    };

    const calibrate = async () => {
        if (calibrating || latestState.auth.authenticated !== true) {
            return;
        }
        calibrating = true;
        render();
        const result = await speakerLatencyCalibrator.calibrate();
        if (result) {
            setSpeakerLatencyBaseSeconds(result.seconds);
        }
        calibrating = false;
        latestState = getAppState();
        render();
    };

    const onTrimInput = () => {
        if (latestState.auth.authenticated !== true) {
            return;
        }
        setSpeakerLatencyTrimSeconds(Number.parseFloat(trimSliderEl.value));
        latestState = getAppState();
        render();
    };

    const unsubscribe = subscribeAppState((nextState) => {
        const wasAuthenticated = latestState.auth.authenticated === true;
        latestState = nextState;
        const isAuthenticated = latestState.auth.authenticated === true;
        if (isAuthenticated && (!wasAuthenticated || !triedRestoreDrumState)) {
            triedRestoreDrumState = true;
            // Avoid auto-starting audio without user gesture; keep stored pref only.
            if (readStoredDrumPulseEnabled()) {
                debugLog("drum-toggle", "stored drum preference detected; waiting for user tap to start");
            }
        }
        if (!isAuthenticated) {
            triedRestoreDrumState = false;
        }
        render();
    });

    const onCalibrateClick = () => {
        void calibrate();
    };
    const onDrumToggleClick = (event) => {
        event.preventDefault();
        debugLog("drum-toggle", "button pressed", {
            runningBefore: drumPulseSynth.isRunning(),
            togglingDrum,
        });
        void toggleDrum();
    };

    calibrateButton.addEventListener("click", onCalibrateClick);
    drumToggleButton.addEventListener("click", onDrumToggleClick);
    trimSliderEl.addEventListener("input", onTrimInput);
    render();

    return () => {
        unsubscribe();
        drumPulseSynth.destroy();
        calibrateButton.removeEventListener("click", onCalibrateClick);
        drumToggleButton.removeEventListener("click", onDrumToggleClick);
        trimSliderEl.removeEventListener("input", onTrimInput);
    };
};
