/* Shared page-level audio engine: single AudioContext, master bus, and noise-floor control. */

import { createNoiseFloorKeepAlive, readStoredNoiseFloorEnabled } from "./noise-floor.js";

let audioContext = null;
let masterInput = null;
let compressor = null;
let highpass = null;
let noiseFloor = null;
let noiseFloorEnabled = readStoredNoiseFloorEnabled();

const getAudioContextCtor = () => window.AudioContext || window.webkitAudioContext;

const ensureContext = async () => {
    const Ctx = getAudioContextCtor();
    if (!Ctx) {
        return null;
    }
    if (!audioContext) {
        audioContext = new Ctx({
            latencyHint: "playback",
        });

        masterInput = audioContext.createGain();
        masterInput.gain.value = 1;

        compressor = audioContext.createDynamicsCompressor();
        compressor.threshold.value = -12;
        compressor.knee.value = 18;
        compressor.ratio.value = 6;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.08;

        highpass = audioContext.createBiquadFilter();
        highpass.type = "highpass";
        highpass.frequency.value = 20;
        highpass.Q.value = 0.707;

        masterInput.connect(compressor);
        compressor.connect(highpass);
        highpass.connect(audioContext.destination);

        noiseFloor = createNoiseFloorKeepAlive({
            audioContext,
            targetNode: masterInput,
        });
        noiseFloor.setEnabled(noiseFloorEnabled);
    }
    return audioContext;
};

const unlock = async () => {
    const ctx = await ensureContext();
    if (!ctx) {
        return false;
    }
    if (ctx.state !== "running") {
        await ctx.resume();
    }
    return true;
};

const createOutputGain = (initialGain = 1) => {
    if (!audioContext || !masterInput) {
        return null;
    }
    const node = audioContext.createGain();
    node.gain.value = Number.isFinite(initialGain) ? Number(initialGain) : 1;
    node.connect(masterInput);
    return node;
};

const disconnectNode = (node) => {
    if (!node) {
        return;
    }
    try {
        node.disconnect();
    } catch {}
};

const setNoiseFloorEnabled = (enabled) => {
    noiseFloorEnabled = enabled !== false;
    if (noiseFloor) {
        noiseFloor.setEnabled(noiseFloorEnabled);
    }
};

const isNoiseFloorEnabled = () => noiseFloorEnabled;

const getAudioCurrentTime = () => {
    if (!audioContext) {
        return NaN;
    }
    return audioContext.currentTime;
};

const getContext = () => audioContext;

export const getSharedAudioEngine = () => ({
    ensureContext,
    unlock,
    getContext,
    getAudioCurrentTime,
    createOutputGain,
    disconnectNode,
    setNoiseFloorEnabled,
    isNoiseFloorEnabled,
});
