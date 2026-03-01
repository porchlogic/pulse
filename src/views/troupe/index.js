/* Troupe route entry: subscribe to pulse state and render connection + current beat */

import {
    ensurePulseTransportConnected,
    fetchLivePerformanceTrack,
    getAppState,
    loadPerformanceState,
    logout,
    subscribeAppState,
} from "../../state.js";
import { getBeatWindowMs } from "../../components/clock/beat-time.js";
import { debugLog, debugWarn } from "../../components/util/debug.js";
import { mountBeatDisplay } from "../../components/clock/beat-display.js";
import { createPerformEventScheduler } from "../../components/audio/perform-event-scheduler.js";
import { createMultiTrackBufferPlayer } from "../../components/audio/multi-track-buffer-player.js";

export const mount = ({ mountNode, navigate }) => {
    const statusEl = mountNode.querySelector(".ui-status");
    const beatEl = mountNode.querySelector(".ui-beat-display");
    if (!statusEl || !beatEl) {
        return () => {};
    }

    let cleanupBeatDisplay = () => {};
    let performancePollTimer = 0;
    let latestState = getAppState();
    let selectedTrackIndex = 0;
    let cachedSongId = "";
    let cachedTrackIndex = -1;
    let cachedTrackUrl = "";
    const cacheName = "pulse-troupe-session-audio";
    let logoutInFlight = false;
    let previousPerformanceActive = Boolean(latestState.performance.active);
    let lastHandledAction = latestState.performance.lastAction || null;
    const loggedBufferWaitEvents = new Set();
    const bufferPlayer = createMultiTrackBufferPlayer({ trackCount: 1 });
    const eventScheduler = createPerformEventScheduler({
        getPulseState: () => latestState.pulse,
        getLatencySeconds: () => Number(latestState.pulse.speakerLatencyCompensationSeconds) || 0,
        getAudioCurrentTime: () => bufferPlayer.getAudioCurrentTime(),
        onScheduleEvent: ({ event, whenSec, beatServerTime, serverNow }) => {
            const beatWindowMs = getBeatWindowMs(latestState.pulse.tickLength);
            const barDurationSec = (beatWindowMs * Math.max(1, Number(latestState.pulse.numBarBeats) || 4)) / 1000;
            const elapsedSec = Math.max(0, (serverNow - beatServerTime) / 1000);

            if (event.action === "pause") {
                bufferPlayer.schedulePause(whenSec);
                return true;
            }

            if (event.action === "play") {
                if (!bufferPlayer.hasTrackBuffer(0)) {
                    if (!loggedBufferWaitEvents.has(event.eventId)) {
                        loggedBufferWaitEvents.add(event.eventId);
                        debugWarn("troupe-audio", "waiting for track buffer before play event", {
                            eventId: event.eventId,
                            absoluteBeat: event.absoluteBeat,
                            selectedTrackIndex,
                        });
                    }
                    return false;
                }
                const rows = Array.isArray(event.selectedRows) ? event.selectedRows : [];
                const rowIndex = Math.max(0, Math.trunc(Number(rows[selectedTrackIndex] || 0)));
                const offsetSec = rowIndex * 4 * barDurationSec + elapsedSec;
                debugLog("troupe-audio", "scheduling play event", {
                    eventId: event.eventId,
                    whenSec: Number(whenSec).toFixed(3),
                    offsetSec: Number(offsetSec).toFixed(3),
                });
                return bufferPlayer.schedulePlay(whenSec, [offsetSec]);
            }

            if (event.action === "jump") {
                if (Number(event.trackIndex) !== selectedTrackIndex) {
                    return true;
                }
                if (!bufferPlayer.hasTrackBuffer(0)) {
                    if (!loggedBufferWaitEvents.has(event.eventId)) {
                        loggedBufferWaitEvents.add(event.eventId);
                        debugWarn("troupe-audio", "waiting for track buffer before jump event", {
                            eventId: event.eventId,
                            absoluteBeat: event.absoluteBeat,
                            selectedTrackIndex,
                        });
                    }
                    return false;
                }
                const rowIndex = Math.max(0, Math.trunc(Number(event.rowIndex || 0)));
                const offsetSec = rowIndex * 4 * barDurationSec + elapsedSec;
                debugLog("troupe-audio", "scheduling jump event", {
                    eventId: event.eventId,
                    whenSec: Number(whenSec).toFixed(3),
                    offsetSec: Number(offsetSec).toFixed(3),
                });
                return bufferPlayer.scheduleJump(0, whenSec, offsetSec);
            }
            return true;
        },
    });

    const renderConnection = () => {
        const { connectionStatus } = latestState.pulse;
        const isConnected = connectionStatus === "connected";

        statusEl.classList.toggle("ui-status--connected", isConnected);
        statusEl.classList.toggle("ui-status--not-connected", !isConnected);
        statusEl.textContent = connectionStatus;
    };

    const ensureTrackLoaded = async (songId, trackIndex) => {
        debugLog("troupe", "ensureTrackLoaded", { songId, trackIndex });
        if (!songId) {
            debugWarn("troupe", "ensureTrackLoaded skipped: missing songId");
            return;
        }
        if (cachedSongId === songId && cachedTrackIndex === trackIndex && cachedTrackUrl) {
            debugLog("troupe", "using cached track", { songId, trackIndex, cachedTrackUrl });
            return;
        }
        const track = await fetchLivePerformanceTrack({
            songId,
            trackIndex,
        });
        if (!track?.url) {
            debugWarn("troupe", "track response missing url", track);
            return;
        }
        const decoded = await bufferPlayer.setTrackSource(0, track.url);
        if (!decoded) {
            debugWarn("troupe", "track buffer load failed", {
                songId,
                trackIndex,
                url: track.url,
            });
            return;
        }
        cachedSongId = songId;
        cachedTrackIndex = trackIndex;
        cachedTrackUrl = track.url;
        debugLog("troupe", "track buffer ready", { url: track.url });
    };

    const applyDjAction = async () => {
        const action = latestState.performance.lastAction;
        if (!action || !action.songId) {
            return;
        }
        debugLog("troupe", "applyDjAction", action);
        await ensureTrackLoaded(action.songId, selectedTrackIndex);
        const queued = eventScheduler.enqueue(action);
        debugLog("troupe-audio", "received perform action", {
            eventId: action.eventId,
            action: action.action,
            absoluteBeat: action.absoluteBeat,
            queued,
        });
    };

    const clearSessionAudio = async () => {
        debugLog("troupe", "clearSessionAudio");
        eventScheduler.clear();
        loggedBufferWaitEvents.clear();
        bufferPlayer.schedulePause(0);
        if (cachedTrackUrl && cachedTrackUrl.startsWith("blob:")) {
            URL.revokeObjectURL(cachedTrackUrl);
        }
        cachedSongId = "";
        cachedTrackIndex = -1;
        cachedTrackUrl = "";
        await caches.delete(cacheName);
    };

    const onTrackClick = (event) => {
        const button = event.target.closest("[data-track]");
        if (!button) {
            return;
        }
        void bufferPlayer.unlock();
        selectedTrackIndex = Math.max(0, Number(button.dataset.track) - 1);
        debugLog("troupe", "selected track", { selectedTrackIndex });
    };

    let unlockedByGesture = false;
    const onUserGesture = () => {
        if (unlockedByGesture) {
            return;
        }
        unlockedByGesture = true;
        void bufferPlayer.unlock();
    };

    const unsubscribe = subscribeAppState((nextState) => {
        const nextAction = nextState.performance.lastAction || null;
        const isActive = Boolean(nextState.performance.active);
        latestState = nextState;
        renderConnection();
        if (previousPerformanceActive && !isActive) {
            if (!logoutInFlight) {
                logoutInFlight = true;
                void clearSessionAudio().finally(() => {
                    void logout().then(() => navigate("default"));
                });
            }
            previousPerformanceActive = isActive;
            lastHandledAction = nextAction;
            return;
        }
        if (nextAction && nextAction !== lastHandledAction) {
            lastHandledAction = nextAction;
            void applyDjAction();
        }
        previousPerformanceActive = isActive;
    });

    mountNode.addEventListener("click", onTrackClick);
    mountNode.addEventListener("pointerdown", onUserGesture);
    eventScheduler.start();
    ensurePulseTransportConnected();
    void loadPerformanceState();
    performancePollTimer = window.setInterval(() => {
        void loadPerformanceState();
    }, 2000);
    renderConnection();
    cleanupBeatDisplay = mountBeatDisplay({
        beatEl,
        getPulseState: () => latestState.pulse,
    });

    return () => {
        cleanupBeatDisplay();
        eventScheduler.destroy();
        bufferPlayer.destroy();
        void clearSessionAudio();
        if (performancePollTimer) {
            window.clearInterval(performancePollTimer);
        }
        mountNode.removeEventListener("click", onTrackClick);
        mountNode.removeEventListener("pointerdown", onUserGesture);
        unsubscribe();
    };
};
