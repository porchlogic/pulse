/* App-wide speaker/drum controls shown for authenticated users. */

import {
    getAppState,
    setNoiseFloorEnabled,
    setSpeakerLatencyCompensationSeconds,
    subscribeAppState,
} from "../../state.js";
import { debugLog, debugWarn } from "../util/debug.js";
import {
    createDrumPulseSynth,
    persistDrumPulseEnabled,
    readStoredDrumPulseEnabled,
} from "../audio/drum-pulse-synth.js";

const MAX_SPEAKER_OFFSET_MS = 250;

const buildHtml = () => `
    <section class="ui-section ui-global-audio" data-role="global-audio-root" hidden>
        <div class="ui-stack">
            <div class="ui-row-between">
                <strong>Settings</strong>
                <button type="button" class="ui-button ui-button--small" data-role="global-drum-toggle">Enable Metronome</button>
            </div>
            <div class="ui-field">
                <label class="ui-label" for="global-speaker-offset">Speaker offset (earlier playback)</label>
                <input id="global-speaker-offset" class="ui-input" type="range" min="0" max="${MAX_SPEAKER_OFFSET_MS}" step="1" value="${MAX_SPEAKER_OFFSET_MS}" data-role="global-speaker-offset">
                <div class="ui-row-between">
                    <span class="ui-label">250ms</span>
                    <span class="ui-label">0ms</span>
                </div>
                <p class="ui-label" data-role="global-latency-readout">Speaker offset: 0ms earlier</p>
            </div>
            <label class="ui-row-between" style="align-items: center;">
                <span class="ui-label">Noise Floor Fix</span>
                <input type="checkbox" data-role="global-noise-floor-toggle">
            </label>
        </div>
    </section>
`;

export const mountGlobalAudioControls = ({ mountNode } = {}) => {
    if (!mountNode) {
        return () => {};
    }

    mountNode.innerHTML = buildHtml();

    const root = mountNode.querySelector("[data-role=\"global-audio-root\"]");
    const drumToggleButton = mountNode.querySelector("[data-role=\"global-drum-toggle\"]");
    const latencyReadoutEl = mountNode.querySelector("[data-role=\"global-latency-readout\"]");
    const offsetSliderEl = mountNode.querySelector("[data-role=\"global-speaker-offset\"]");
    const noiseFloorToggleEl = mountNode.querySelector("[data-role=\"global-noise-floor-toggle\"]");
    if (!root || !drumToggleButton || !latencyReadoutEl || !offsetSliderEl || !noiseFloorToggleEl) {
        return () => {};
    }

    let latestState = getAppState();
    let togglingDrum = false;
    let triedRestoreDrumState = false;

    const drumPulseSynth = createDrumPulseSynth({
        getPulseState: () => latestState.pulse,
        getLatencySeconds: () => Number(latestState.pulse.speakerLatencyCompensationSeconds) || 0,
        getNoiseFloorEnabled: () => latestState.pulse.noiseFloorEnabled !== false,
    });

    const render = () => {
        const isAuthenticated = latestState.auth.authenticated === true;
        root.hidden = !isAuthenticated;
        if (!isAuthenticated && drumPulseSynth.isRunning()) {
            drumPulseSynth.stop();
        }
        if (!isAuthenticated) {
            return;
        }

        const effective = Number(latestState.pulse.speakerLatencyCompensationSeconds) || 0;
        const offsetMs = Math.max(0, Math.min(MAX_SPEAKER_OFFSET_MS, Math.round(effective * 1000)));
        const sliderValue = MAX_SPEAKER_OFFSET_MS - offsetMs;
        offsetSliderEl.value = String(sliderValue);
        latencyReadoutEl.textContent = `Speaker offset: ${offsetMs}ms earlier`;
        offsetSliderEl.disabled = false;
        drumToggleButton.disabled = togglingDrum;
        drumToggleButton.textContent = drumPulseSynth.isRunning() ? "Disable Metronome" : "Enable Metronome";
        noiseFloorToggleEl.checked = latestState.pulse.noiseFloorEnabled !== false;
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

    const onOffsetInput = () => {
        if (latestState.auth.authenticated !== true) {
            return;
        }
        const sliderValue = Number.parseInt(offsetSliderEl.value, 10);
        const safeSliderValue = Number.isFinite(sliderValue)
            ? Math.max(0, Math.min(MAX_SPEAKER_OFFSET_MS, sliderValue))
            : MAX_SPEAKER_OFFSET_MS;
        const offsetMs = MAX_SPEAKER_OFFSET_MS - safeSliderValue;
        setSpeakerLatencyCompensationSeconds(offsetMs / 1000);
        latestState = getAppState();
        render();
    };

    const onNoiseFloorToggleInput = () => {
        if (latestState.auth.authenticated !== true) {
            return;
        }
        const enabled = noiseFloorToggleEl.checked;
        setNoiseFloorEnabled(enabled);
        latestState = getAppState();
        drumPulseSynth.setNoiseFloorEnabled(enabled);
        debugLog("noise-floor", enabled ? "enabled" : "disabled");
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
        drumPulseSynth.setNoiseFloorEnabled(latestState.pulse.noiseFloorEnabled !== false);
        render();
    });

    const onDrumToggleClick = (event) => {
        event.preventDefault();
        debugLog("drum-toggle", "button pressed", {
            runningBefore: drumPulseSynth.isRunning(),
            togglingDrum,
        });
        void toggleDrum();
    };

    drumToggleButton.addEventListener("click", onDrumToggleClick);
    offsetSliderEl.addEventListener("input", onOffsetInput);
    noiseFloorToggleEl.addEventListener("input", onNoiseFloorToggleInput);
    render();

    return () => {
        unsubscribe();
        drumPulseSynth.destroy();
        drumToggleButton.removeEventListener("click", onDrumToggleClick);
        offsetSliderEl.removeEventListener("input", onOffsetInput);
        noiseFloorToggleEl.removeEventListener("input", onNoiseFloorToggleInput);
    };
};
