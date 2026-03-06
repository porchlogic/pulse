/* Web Audio multi-track player for sample-accurate scheduled starts/stops. */

import { debugLog, debugWarn } from "../util/debug.js";
import { getSharedAudioEngine } from "./audio-engine.js";

const clampOffset = (buffer, offsetSec) => {
    if (!buffer) {
        return 0;
    }
    const maxOffset = Math.max(0, Number(buffer.duration || 0) - 0.01);
    return Math.max(0, Math.min(maxOffset, Number(offsetSec) || 0));
};

export const createMultiTrackBufferPlayer = ({
    trackCount = 8,
    getNoiseFloorEnabled = () => true,
} = {}) => {
    const audioEngine = getSharedAudioEngine();
    let audioContext = null;
    let master = null;
    const tracks = Array.from({ length: trackCount }, () => ({
        url: "",
        buffer: null,
        loadToken: 0,
        source: null,
        sourceGain: null,
        sourceStartedAtSec: NaN,
        sourceStartedOffsetSec: NaN,
    }));

    const ensureContext = async () => {
        try {
            const ready = await audioEngine.unlock();
            if (!ready) {
                return false;
            }
            audioContext = audioEngine.getContext();
            if (!audioContext) {
                return false;
            }
            if (!master) {
                master = audioEngine.createOutputGain(1);
            }
            if (!master) {
                return false;
            }
            audioEngine.setNoiseFloorEnabled(getNoiseFloorEnabled() !== false);
            return true;
        } catch {
            debugWarn("perform-audio", "AudioContext unavailable or blocked by autoplay policy");
            return false;
        }
    };

    const decodeTrackBuffer = async (trackIndex, url, arrayBuffer) => {
        const track = tracks[trackIndex];
        if (!track) {
            return null;
        }
        const normalizedUrl = String(url || "");
        if (!normalizedUrl) {
            track.url = "";
            track.buffer = null;
            return null;
        }
        if (track.url === normalizedUrl && track.buffer) {
            return track.buffer;
        }
        const token = track.loadToken + 1;
        track.loadToken = token;
        track.url = normalizedUrl;
        debugLog("perform-audio", "loading track buffer", { trackIndex, url: normalizedUrl });
        try {
            if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength === 0) {
                if (track.loadToken === token) {
                    track.buffer = null;
                }
                debugWarn("perform-audio", "track decode skipped: missing audio bytes", { trackIndex, url: normalizedUrl });
                return null;
            }
            const ready = await ensureContext();
            if (!ready) {
                debugWarn("perform-audio", "track decode skipped because audio context not ready", { trackIndex, url: normalizedUrl });
                return null;
            }
            const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
            if (track.loadToken !== token) {
                return null;
            }
            track.buffer = decoded;
            debugLog("perform-audio", "track buffer ready", { trackIndex, seconds: Number(decoded.duration || 0).toFixed(2), url: normalizedUrl });
            return decoded;
        } catch {
            if (track.loadToken === token) {
                track.buffer = null;
            }
            debugWarn("perform-audio", "track decode error", { trackIndex, url: normalizedUrl });
            return null;
        }
    };

    const setTrackSourceFromArrayBuffer = (trackIndex, url, arrayBuffer) => decodeTrackBuffer(trackIndex, url, arrayBuffer);

    const setTrackSource = async (trackIndex, url) => {
        const normalizedUrl = String(url || "");
        if (!normalizedUrl) {
            const track = tracks[trackIndex];
            if (track) {
                track.url = "";
                track.buffer = null;
            }
            return null;
        }
        try {
            const response = await fetch(normalizedUrl, {
                mode: "cors",
                credentials: "include",
                cache: "no-store",
            });
            if (!response.ok) {
                const track = tracks[trackIndex];
                if (track && track.url === normalizedUrl) {
                    track.buffer = null;
                }
                debugWarn("perform-audio", "track fetch failed", { trackIndex, status: response.status, url: normalizedUrl });
                return null;
            }
            const arrayBuffer = await response.arrayBuffer();
            return decodeTrackBuffer(trackIndex, normalizedUrl, arrayBuffer);
        } catch {
            const track = tracks[trackIndex];
            if (track && track.url === normalizedUrl) {
                track.buffer = null;
            }
            debugWarn("perform-audio", "track fetch/decode error", { trackIndex, url: normalizedUrl });
            return null;
        }
    };

    const stopTrack = (trackIndex, whenSec) => {
        const track = tracks[trackIndex];
        if (!track || !track.source) {
            return;
        }
        try {
            track.source.stop(Math.max(0, whenSec));
        } catch {
            // Source may already be stopped.
        }
        track.source = null;
        track.sourceGain = null;
        track.sourceStartedAtSec = NaN;
        track.sourceStartedOffsetSec = NaN;
    };

    const stopAll = (whenSec = 0) => {
        for (let i = 0; i < tracks.length; i += 1) {
            stopTrack(i, whenSec);
        }
    };

    const startTrack = (trackIndex, whenSec, offsetSec = 0) => {
        const track = tracks[trackIndex];
        if (!audioContext || !master || !track?.buffer) {
            return false;
        }
        const source = audioContext.createBufferSource();
        const sourceGain = audioContext.createGain();
        source.buffer = track.buffer;
        sourceGain.gain.value = 1;
        source.connect(sourceGain);
        sourceGain.connect(master);
        const safeWhenSec = Math.max(0, whenSec);
        const clampedOffsetSec = clampOffset(track.buffer, offsetSec);
        source.start(safeWhenSec, clampedOffsetSec);
        source.onended = () => {
            if (track.source === source) {
                track.source = null;
                track.sourceGain = null;
                track.sourceStartedAtSec = NaN;
                track.sourceStartedOffsetSec = NaN;
            }
        };
        track.source = source;
        track.sourceGain = sourceGain;
        track.sourceStartedAtSec = safeWhenSec;
        track.sourceStartedOffsetSec = clampedOffsetSec;
        return true;
    };

    const getTrackPlaybackOffsetAt = (trackIndex, atWhenSec = Number(getAudioCurrentTime())) => {
        const track = tracks[trackIndex];
        if (!track || !track.source || !track.buffer) {
            return NaN;
        }
        if (!Number.isFinite(atWhenSec) || !Number.isFinite(track.sourceStartedAtSec) || !Number.isFinite(track.sourceStartedOffsetSec)) {
            return NaN;
        }
        const elapsedSec = Math.max(0, atWhenSec - track.sourceStartedAtSec);
        const offsetSec = track.sourceStartedOffsetSec + elapsedSec;
        return clampOffset(track.buffer, offsetSec);
    };

    const getTrackPlaybackOffset = (trackIndex, atWhenSec) => getTrackPlaybackOffsetAt(trackIndex, atWhenSec);

    const retimeTrackSmooth = (trackIndex, whenSec, offsetSec, fadeSec = 0.02) => {
        const track = tracks[trackIndex];
        if (!audioContext || !master || !track?.buffer || !track.source || !track.sourceGain) {
            return false;
        }

        const oldSource = track.source;
        const oldGain = track.sourceGain;
        const source = audioContext.createBufferSource();
        const sourceGain = audioContext.createGain();
        source.buffer = track.buffer;
        source.connect(sourceGain);
        sourceGain.connect(master);

        const audioNow = audioContext.currentTime;
        const safeWhenSec = Math.max(audioNow + 0.005, Number(whenSec) || audioNow + 0.005);
        const safeFadeSec = Math.max(0.008, Number(fadeSec) || 0.02);
        const clampedOffsetSec = clampOffset(track.buffer, offsetSec);

        sourceGain.gain.setValueAtTime(0.00001, safeWhenSec);
        sourceGain.gain.linearRampToValueAtTime(1, safeWhenSec + safeFadeSec);
        source.start(safeWhenSec, clampedOffsetSec);

        oldGain.gain.cancelScheduledValues(safeWhenSec);
        oldGain.gain.setValueAtTime(Math.max(0.00001, oldGain.gain.value), safeWhenSec);
        oldGain.gain.linearRampToValueAtTime(0.00001, safeWhenSec + safeFadeSec);
        try {
            oldSource.stop(safeWhenSec + safeFadeSec + 0.01);
        } catch {
            // Source may already be stopping.
        }

        source.onended = () => {
            if (track.source === source) {
                track.source = null;
                track.sourceGain = null;
                track.sourceStartedAtSec = NaN;
                track.sourceStartedOffsetSec = NaN;
            }
        };

        track.source = source;
        track.sourceGain = sourceGain;
        track.sourceStartedAtSec = safeWhenSec;
        track.sourceStartedOffsetSec = clampedOffsetSec;
        return true;
    };

    const schedulePlay = (whenSec, offsetsByTrack = []) => {
        stopAll(whenSec);
        let started = 0;
        for (let i = 0; i < tracks.length; i += 1) {
            const offsetSec = Number(offsetsByTrack[i] || 0);
            if (startTrack(i, whenSec, offsetSec)) {
                started += 1;
            }
        }
        debugLog("perform-audio", "schedulePlay", {
            whenSec: Number(whenSec).toFixed(3),
            started,
            requestedTracks: tracks.length,
        });
        return started > 0;
    };

    const scheduleJump = (trackIndex, whenSec, offsetSec) => {
        stopTrack(trackIndex, whenSec);
        const started = startTrack(trackIndex, whenSec, offsetSec);
        debugLog("perform-audio", "scheduleJump", {
            trackIndex,
            whenSec: Number(whenSec).toFixed(3),
            offsetSec: Number(offsetSec).toFixed(3),
            started,
        });
        return started;
    };

    const schedulePause = (whenSec) => {
        stopAll(whenSec);
    };

    const retimeActiveTracksByDelta = (deltaSec, { whenSec, fadeSec } = {}) => {
        if (!audioContext) {
            return 0;
        }
        const targetWhen = Number.isFinite(whenSec) ? Number(whenSec) : (audioContext.currentTime + 0.015);
        const delta = Number(deltaSec) || 0;
        if (Math.abs(delta) < 0.0005) {
            return 0;
        }

        let retimed = 0;
        for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
            const currentOffset = getTrackPlaybackOffsetAt(trackIndex, targetWhen);
            if (!Number.isFinite(currentOffset)) {
                continue;
            }
            const nextOffset = Math.max(0, currentOffset + delta);
            if (retimeTrackSmooth(trackIndex, targetWhen, nextOffset, fadeSec)) {
                retimed += 1;
            }
        }

        if (retimed > 0) {
            debugLog("perform-audio", "retimeActiveTracksByDelta", {
                deltaSec: Number(delta).toFixed(4),
                whenSec: Number(targetWhen).toFixed(3),
                retimed,
            });
        }
        return retimed;
    };

    const getAudioCurrentTime = () => {
        if (!audioContext) {
            return NaN;
        }
        return audioContext.currentTime;
    };

    const unlock = async () => {
        const ready = await ensureContext();
        debugLog("perform-audio", ready ? "audio unlock success" : "audio unlock blocked");
        return ready;
    };

    const hasTrackBuffer = (trackIndex) => Boolean(tracks[trackIndex]?.buffer);

    const setNoiseFloorEnabled = (enabled) => {
        audioEngine.setNoiseFloorEnabled(Boolean(enabled));
    };

    const destroy = () => {
        stopAll(0);
        if (master) {
            audioEngine.disconnectNode(master);
        }
        master = null;
        audioContext = null;
    };

    return {
        destroy,
        getAudioCurrentTime,
        getTrackPlaybackOffset,
        scheduleJump,
        schedulePause,
        retimeActiveTracksByDelta,
        schedulePlay,
        setTrackSource,
        setTrackSourceFromArrayBuffer,
        hasTrackBuffer,
        setNoiseFloorEnabled,
        unlock,
    };
};
