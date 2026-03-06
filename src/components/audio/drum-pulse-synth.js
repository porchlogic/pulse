/* Simple woodblock-style drum pulse synth with beat-grid scheduling. */

import { getAbsoluteBeatNow, getBeatWindowMs } from "../clock/beat-time.js";
import { getEstimatedServerNow } from "../clock/sync-clock.js";
import { debugLog, debugWarn } from "../util/debug.js";
import { getSharedAudioEngine } from "./audio-engine.js";

const SCHEDULER_INTERVAL_MS = 25;
const SCHEDULER_LOOKAHEAD_MS = 140;
const SCHEDULER_GUARD_MS = 35;
const DRUM_ENABLED_STORAGE_KEY = "pulse_troupe_drum_enabled";

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export const readStoredDrumPulseEnabled = () => {
    if (typeof window === "undefined" || !window.localStorage) {
        return false;
    }
    const raw = window.localStorage.getItem(DRUM_ENABLED_STORAGE_KEY);
    return raw === "1";
};

export const persistDrumPulseEnabled = (enabled) => {
    if (typeof window === "undefined" || !window.localStorage) {
        return;
    }
    window.localStorage.setItem(DRUM_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
};

export const createDrumPulseSynth = ({
    getPulseState = () => ({}),
    getLatencySeconds = () => 0,
    getNoiseFloorEnabled = () => true,
    level = 0.6,
} = {}) => {
    const audioEngine = getSharedAudioEngine();
    let audioContext = null;
    let master = null;
    let schedulerTimerId = 0;
    let running = false;
    let nextAbsoluteBeat = NaN;
    let transportSignature = "";
    let warnedInvalidTransport = false;

    const ensureContext = async () => {
        try {
            const ready = await audioEngine.unlock();
            if (!ready) {
                debugWarn("drum-pulse", "AudioContext unavailable in this browser");
                return false;
            }
            audioContext = audioEngine.getContext();
            if (!audioContext) {
                return false;
            }
            if (!master) {
                master = audioEngine.createOutputGain(clamp01(level));
            }
            if (!master) {
                return false;
            }
            audioEngine.setNoiseFloorEnabled(getNoiseFloorEnabled() !== false);
            return true;
        } catch (error) {
            debugWarn("drum-pulse", "failed to initialize audio context", error);
            return false;
        }
    };

    const triggerWoodBlock = (whenSec, isDownbeat) => {
        if (!audioContext || !master) {
            return;
        }

        const osc = audioContext.createOscillator();
        const filter = audioContext.createBiquadFilter();
        const amp = audioContext.createGain();

        const toneFreq = isDownbeat ? 1700 : 1320;
        const decaySec = isDownbeat ? 0.14 : 0.1;
        const peak = isDownbeat ? 0.34 : 0.24;

        osc.type = "triangle";
        osc.frequency.setValueAtTime(toneFreq, whenSec);

        filter.type = "bandpass";
        filter.Q.value = isDownbeat ? 9 : 7;
        filter.frequency.setValueAtTime(toneFreq, whenSec);

        amp.gain.setValueAtTime(0.0001, Math.max(0, whenSec - 0.003));
        amp.gain.exponentialRampToValueAtTime(peak, whenSec + 0.004);
        amp.gain.exponentialRampToValueAtTime(0.0001, whenSec + decaySec);

        osc.connect(filter);
        filter.connect(amp);
        amp.connect(master);

        osc.start(Math.max(0, whenSec - 0.003));
        osc.stop(whenSec + decaySec + 0.02);
    };

    const getTransportSignature = (pulseState) => {
        return [
            Number(pulseState.lastDownBeatTime || 0).toFixed(3),
            Number(pulseState.tickLength || 0).toFixed(3),
            Math.trunc(Number(pulseState.numBarBeats) || 4),
        ].join("|");
    };

    const resetSchedulerCursor = (pulseState) => {
        const nowBeat = getAbsoluteBeatNow(pulseState);
        nextAbsoluteBeat = Math.max(0, nowBeat + 1);
    };

    const scheduleTick = () => {
        if (!running || !audioContext) {
            return;
        }

        const pulseState = getPulseState();
        const beatWindowMs = getBeatWindowMs(pulseState.tickLength);
        if (!Number.isFinite(beatWindowMs) || beatWindowMs <= 0 || !Number.isFinite(pulseState.lastDownBeatTime)) {
            if (!warnedInvalidTransport) {
                warnedInvalidTransport = true;
                debugWarn("drum-pulse", "transport unavailable for scheduling", {
                    tickLength: pulseState.tickLength,
                    lastDownBeatTime: pulseState.lastDownBeatTime,
                });
            }
            return;
        }
        warnedInvalidTransport = false;

        const signature = getTransportSignature(pulseState);
        if (signature !== transportSignature || !Number.isFinite(nextAbsoluteBeat)) {
            transportSignature = signature;
            resetSchedulerCursor(pulseState);
        }

        const serverNow = getEstimatedServerNow(pulseState);
        const currentAbsoluteBeat = getAbsoluteBeatNow(pulseState);
        const latencyMs = Math.max(0, Math.min(2000, Number(getLatencySeconds()) * 1000 || 0));
        const horizonServerMs = serverNow + SCHEDULER_LOOKAHEAD_MS + latencyMs + SCHEDULER_GUARD_MS;
        const beatsPerBar = Math.max(1, Math.trunc(Number(pulseState.numBarBeats) || 4));

        if (!Number.isFinite(nextAbsoluteBeat)) {
            nextAbsoluteBeat = currentAbsoluteBeat;
        }
        if (nextAbsoluteBeat < currentAbsoluteBeat - 1) {
            nextAbsoluteBeat = currentAbsoluteBeat;
        }

        while (nextAbsoluteBeat <= currentAbsoluteBeat + 64) {
            const beatServerTime = Number(pulseState.lastDownBeatTime) + nextAbsoluteBeat * beatWindowMs;
            if (beatServerTime > horizonServerMs) {
                break;
            }

            const audioNow = audioContext.currentTime;
            const whenSec = audioNow + (beatServerTime - serverNow) / 1000 - latencyMs / 1000;
            if (whenSec >= audioNow - 0.04) {
                const beatInBar = ((nextAbsoluteBeat % beatsPerBar) + beatsPerBar) % beatsPerBar;
                triggerWoodBlock(whenSec, beatInBar === 0);
            }

            nextAbsoluteBeat += 1;
        }
    };

    const startScheduler = () => {
        if (schedulerTimerId) {
            window.clearInterval(schedulerTimerId);
        }
        scheduleTick();
        schedulerTimerId = window.setInterval(scheduleTick, SCHEDULER_INTERVAL_MS);
    };

    const stopScheduler = () => {
        if (schedulerTimerId) {
            window.clearInterval(schedulerTimerId);
            schedulerTimerId = 0;
        }
    };

    const start = async () => {
        const ready = await ensureContext();
        if (!ready) {
            debugWarn("drum-pulse", "AudioContext unavailable or blocked");
            return false;
        }
        running = true;
        resetSchedulerCursor(getPulseState());
        startScheduler();
        debugLog("drum-pulse", "started");
        return true;
    };

    const stop = () => {
        running = false;
        stopScheduler();
        debugLog("drum-pulse", "stopped");
    };

    const isRunning = () => running;

    const setNoiseFloorEnabled = (enabled) => {
        audioEngine.setNoiseFloorEnabled(Boolean(enabled));
    };

    const destroy = () => {
        stop();
        if (master) {
            audioEngine.disconnectNode(master);
        }
        master = null;
        audioContext = null;
    };

    return {
        start,
        stop,
        isRunning,
        setNoiseFloorEnabled,
        destroy,
    };
};
