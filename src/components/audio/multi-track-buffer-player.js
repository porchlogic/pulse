/* Web Audio multi-track player for sample-accurate scheduled starts/stops. */

import { debugLog, debugWarn } from "../util/debug.js";

const resolveAudioContextCtor = () => window.AudioContext || window.webkitAudioContext;

const clampOffset = (buffer, offsetSec) => {
    if (!buffer) {
        return 0;
    }
    const maxOffset = Math.max(0, Number(buffer.duration || 0) - 0.01);
    return Math.max(0, Math.min(maxOffset, Number(offsetSec) || 0));
};

export const createMultiTrackBufferPlayer = ({
    trackCount = 8,
} = {}) => {
    let audioContext = null;
    let master = null;
    const tracks = Array.from({ length: trackCount }, () => ({
        url: "",
        buffer: null,
        loadToken: 0,
        source: null,
    }));

    const ensureContext = async () => {
        try {
            const Ctx = resolveAudioContextCtor();
            if (!Ctx) {
                return false;
            }
            if (!audioContext) {
                audioContext = new Ctx();
                master = audioContext.createGain();
                master.gain.value = 1;
                master.connect(audioContext.destination);
            }
            if (audioContext.state !== "running") {
                await audioContext.resume();
            }
            return true;
        } catch {
            debugWarn("perform-audio", "AudioContext unavailable or blocked by autoplay policy");
            return false;
        }
    };

    const setTrackSource = async (trackIndex, url) => {
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
            const response = await fetch(normalizedUrl, {
                mode: "cors",
                credentials: "include",
                cache: "no-store",
            });
            if (!response.ok) {
                if (track.loadToken === token) {
                    track.buffer = null;
                }
                debugWarn("perform-audio", "track fetch failed", { trackIndex, status: response.status, url: normalizedUrl });
                return null;
            }
            const arrayBuffer = await response.arrayBuffer();
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
        source.buffer = track.buffer;
        source.connect(master);
        source.start(Math.max(0, whenSec), clampOffset(track.buffer, offsetSec));
        source.onended = () => {
            if (track.source === source) {
                track.source = null;
            }
        };
        track.source = source;
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

    const destroy = () => {
        stopAll(0);
        if (audioContext) {
            void audioContext.close();
        }
        audioContext = null;
        master = null;
    };

    return {
        destroy,
        getAudioCurrentTime,
        scheduleJump,
        schedulePause,
        schedulePlay,
        setTrackSource,
        hasTrackBuffer,
        unlock,
    };
};
