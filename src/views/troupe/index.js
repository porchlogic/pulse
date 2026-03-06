/* Troupe route entry: subscribe to pulse state and render connection + current beat */

import {
    ensurePulseTransportConnected,
    fetchLivePerformanceTrack,
    getAppState,
    loadPerformanceState,
    logout,
    sendTroupeTrackSelection,
    subscribeAppState,
} from "../../state.js";
import { getBeatWindowMs } from "../../components/clock/beat-time.js";
import { debugLog, debugWarn } from "../../components/util/debug.js";
import { mountBeatDisplay } from "../../components/clock/beat-display.js";
import { createPerformEventScheduler } from "../../components/audio/perform-event-scheduler.js";
import { createMultiTrackBufferPlayer } from "../../components/audio/multi-track-buffer-player.js";

const getBarsPerRow = (event, performanceState) => {
    const parsed = Math.trunc(Number(event?.barsPerRow || performanceState?.barsPerRow || 4));
    if (!Number.isFinite(parsed)) {
        return 4;
    }
    return Math.max(1, Math.min(16, parsed));
};

const SESSION_AUDIO_CACHE_PREFIX = "pulse-troupe-session-audio:";
const TRACK_COUNT = 8;
const SELECTED_TRACK_STORAGE_KEY = "pulse_troupe_selected_track_indexes_v2";
const LEGACY_SELECTED_TRACK_STORAGE_KEY = "pulse_troupe_selected_track_index";
const MAX_PRESENCE_DOTS = 6;

const clampTrackIndex = (value) => {
    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed)) {
        return 0;
    }
    return Math.max(0, Math.min(TRACK_COUNT - 1, parsed));
};

const normalizeTrackIndexes = (value) => {
    const list = Array.isArray(value) ? value : [value];
    return [...new Set(list.map((item) => clampTrackIndex(item)))];
};

const readStoredSelectedTrackIndexes = () => {
    if (typeof window === "undefined" || !window.localStorage) {
        return [];
    }
    try {
        const nextRaw = window.localStorage.getItem(SELECTED_TRACK_STORAGE_KEY);
        if (nextRaw) {
            const parsed = JSON.parse(nextRaw);
            const normalized = normalizeTrackIndexes(parsed);
            if (normalized.length > 0) {
                return normalized;
            }
        }
    } catch {
        // Ignore parse failures and fall back.
    }

    const legacyRaw = window.localStorage.getItem(LEGACY_SELECTED_TRACK_STORAGE_KEY);
    return legacyRaw === null ? [] : [clampTrackIndex(legacyRaw)];
};

const persistSelectedTrackIndexes = (trackIndexes) => {
    if (typeof window === "undefined" || !window.localStorage) {
        return;
    }
    const normalized = normalizeTrackIndexes(trackIndexes);
    window.localStorage.setItem(SELECTED_TRACK_STORAGE_KEY, JSON.stringify(normalized));
    window.localStorage.setItem(LEGACY_SELECTED_TRACK_STORAGE_KEY, String(normalized[0] ?? 0));
};

export const mount = ({ mountNode, navigate }) => {
    const statusEl = mountNode.querySelector(".ui-status");
    const beatEl = mountNode.querySelector(".ui-beat-display");
    if (!statusEl || !beatEl) {
        return () => {};
    }

    let cleanupBeatDisplay = () => {};
    let performancePollTimer = 0;
    let latestState = getAppState();
    let selectedTrackIndexes = readStoredSelectedTrackIndexes();
    let cachedSongId = "";
    let cachedTrackUrls = Array.from({ length: TRACK_COUNT }, () => "");
    let logoutInFlight = false;
    let previousPerformanceActive = Boolean(latestState.performance.active);
    let previousSessionToken = String(latestState.performance.sessionToken || "");
    let previousConnectionStatus = String(latestState.pulse.connectionStatus || "");
    let lastHandledAction = latestState.performance.lastAction || null;
    let playbackActive = false;
    let trackSwitchToken = 0;
    let lastLatencyCompensationSec = Number(latestState.pulse.speakerLatencyCompensationSeconds) || 0;
    const loggedBufferWaitEvents = new Set();

    const getSelectedTrackIndexes = () => selectedTrackIndexes.slice(0, TRACK_COUNT);

    const bufferPlayer = createMultiTrackBufferPlayer({
        trackCount: TRACK_COUNT,
        getNoiseFloorEnabled: () => latestState.pulse.noiseFloorEnabled !== false,
    });

    const eventScheduler = createPerformEventScheduler({
        getPulseState: () => latestState.pulse,
        getLatencySeconds: () => Number(latestState.pulse.speakerLatencyCompensationSeconds) || 0,
        getAudioCurrentTime: () => bufferPlayer.getAudioCurrentTime(),
        onScheduleEvent: ({ event, whenSec, beatServerTime, serverNow }) => {
            const beatWindowMs = getBeatWindowMs(latestState.pulse.tickLength);
            const barDurationSec = (beatWindowMs * Math.max(1, Number(latestState.pulse.numBarBeats) || 4)) / 1000;
            const elapsedSec = Math.max(0, (serverNow - beatServerTime) / 1000);
            const barsPerRow = getBarsPerRow(event, latestState.performance);
            const activeSelectedIndexes = getSelectedTrackIndexes();

            if (event.action === "pause") {
                bufferPlayer.schedulePause(whenSec);
                return true;
            }

            if (event.action === "play") {
                if (activeSelectedIndexes.length === 0) {
                    return true;
                }
                const hasAnySelectedBuffer = activeSelectedIndexes.some((trackIndex) => bufferPlayer.hasTrackBuffer(trackIndex));
                if (!hasAnySelectedBuffer) {
                    if (!loggedBufferWaitEvents.has(event.eventId)) {
                        loggedBufferWaitEvents.add(event.eventId);
                        debugWarn("troupe-audio", "waiting for selected track buffers before play event", {
                            eventId: event.eventId,
                            absoluteBeat: event.absoluteBeat,
                            selectedTrackIndexes: activeSelectedIndexes,
                        });
                    }
                    return false;
                }
                const rows = Array.isArray(event.selectedRows) ? event.selectedRows : [];
                const offsetsByTrack = Array.from({ length: TRACK_COUNT }, () => 0);
                for (const trackIndex of activeSelectedIndexes) {
                    const rowIndex = Math.max(0, Math.trunc(Number(rows[trackIndex] || 0)));
                    offsetsByTrack[trackIndex] = rowIndex * barsPerRow * barDurationSec;
                }
                debugLog("troupe-audio", "scheduling play event", {
                    eventId: event.eventId,
                    whenSec: Number(whenSec).toFixed(3),
                    selectedTrackIndexes: activeSelectedIndexes,
                });
                return bufferPlayer.schedulePlay(whenSec, offsetsByTrack);
            }

            if (event.action === "jump") {
                const targetTrackIndex = clampTrackIndex(event.trackIndex);
                if (!activeSelectedIndexes.includes(targetTrackIndex)) {
                    return true;
                }
                if (!bufferPlayer.hasTrackBuffer(targetTrackIndex)) {
                    if (!loggedBufferWaitEvents.has(event.eventId)) {
                        loggedBufferWaitEvents.add(event.eventId);
                        debugWarn("troupe-audio", "waiting for track buffer before jump event", {
                            eventId: event.eventId,
                            absoluteBeat: event.absoluteBeat,
                            targetTrackIndex,
                        });
                    }
                    return false;
                }
                const rowIndex = Math.max(0, Math.trunc(Number(event.rowIndex || 0)));
                const offsetSec = rowIndex * barsPerRow * barDurationSec + elapsedSec;
                debugLog("troupe-audio", "scheduling jump event", {
                    eventId: event.eventId,
                    whenSec: Number(whenSec).toFixed(3),
                    trackIndex: targetTrackIndex,
                    offsetSec: Number(offsetSec).toFixed(3),
                });
                return bufferPlayer.scheduleJump(targetTrackIndex, whenSec, offsetSec);
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

    const renderSelectedTrack = () => {
        const selected = new Set(getSelectedTrackIndexes());
        const buttons = mountNode.querySelectorAll("[data-track]");
        for (const button of buttons) {
            const trackIndex = clampTrackIndex(Number(button.dataset.track) - 1);
            const isSelected = selected.has(trackIndex);
            button.classList.toggle("ui-button--active", isSelected);
            button.classList.toggle("on", isSelected);
            button.setAttribute("aria-pressed", isSelected ? "true" : "false");
        }
    };

    const renderTrackSelectionCounts = () => {
        const counts = Array.isArray(latestState.troupe?.trackSelectionCounts)
            ? latestState.troupe.trackSelectionCounts
            : [];
        const badges = mountNode.querySelectorAll("[data-track-presence]");
        for (const badge of badges) {
            const trackNumber = Math.max(1, Math.min(TRACK_COUNT, Math.trunc(Number(badge.dataset.trackPresence) || 1)));
            const trackIndex = trackNumber - 1;
            const count = Math.max(0, Math.trunc(Number(counts[trackIndex] || 0)));
            badge.hidden = count <= 0;
            if (count <= 0) {
                badge.innerHTML = "";
                continue;
            }
            const dotCount = Math.min(MAX_PRESENCE_DOTS, count);
            badge.innerHTML = Array.from({ length: dotCount }, () => "<span></span>").join("");
            badge.setAttribute("aria-label", `${count} clients on this track`);
            badge.title = `${count}`;
        }
    };

    const sendCurrentTrackSelection = () => {
        if (latestState.pulse.connectionStatus !== "connected") {
            return;
        }
        sendTroupeTrackSelection(getSelectedTrackIndexes());
    };

    const supportsCacheStorage = () => typeof window !== "undefined"
        && typeof window.caches !== "undefined"
        && typeof window.caches.open === "function";

    const getCacheNameForSession = (sessionToken) => `${SESSION_AUDIO_CACHE_PREFIX}${sessionToken || "inactive"}`;

    const clearObsoleteSessionCaches = async (activeSessionToken = "") => {
        if (!supportsCacheStorage()) {
            return;
        }
        const cacheNames = await caches.keys();
        const keepName = activeSessionToken ? getCacheNameForSession(activeSessionToken) : "";
        await Promise.all(cacheNames
            .filter((name) => name.startsWith(SESSION_AUDIO_CACHE_PREFIX) && name !== keepName)
            .map((name) => caches.delete(name)));
    };

    const fetchTrackArrayBuffer = async (trackUrl, sessionToken = "") => {
        const requestUrl = String(trackUrl || "");
        if (!requestUrl) {
            return null;
        }
        if (!supportsCacheStorage() || !sessionToken) {
            const response = await fetch(requestUrl, {
                mode: "cors",
                credentials: "include",
                cache: "no-store",
            });
            if (!response.ok) {
                return null;
            }
            return response.arrayBuffer();
        }

        const cache = await caches.open(getCacheNameForSession(sessionToken));
        const request = new Request(requestUrl, {
            method: "GET",
            mode: "cors",
            credentials: "include",
        });
        const cached = await cache.match(request);
        if (cached && cached.ok) {
            return cached.arrayBuffer();
        }

        const response = await fetch(request, { cache: "no-store" });
        if (!response.ok) {
            return null;
        }
        await cache.put(request, response.clone());
        return response.arrayBuffer();
    };

    const ensureTrackLoaded = async (songId, trackIndex) => {
        debugLog("troupe", "ensureTrackLoaded", { songId, trackIndex });
        if (!songId) {
            debugWarn("troupe", "ensureTrackLoaded skipped: missing songId");
            return;
        }
        if (cachedSongId === songId && cachedTrackUrls[trackIndex]) {
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
        const trackBytes = await fetchTrackArrayBuffer(track.url, latestState.performance.sessionToken || "");
        if (!trackBytes) {
            debugWarn("troupe", "track download failed", {
                songId,
                trackIndex,
                url: track.url,
            });
            return;
        }
        const decoded = await bufferPlayer.setTrackSourceFromArrayBuffer(trackIndex, track.url, trackBytes);
        if (!decoded) {
            debugWarn("troupe", "track buffer load failed", {
                songId,
                trackIndex,
                url: track.url,
            });
            return;
        }
        if (cachedSongId && cachedSongId !== songId) {
            cachedTrackUrls = Array.from({ length: TRACK_COUNT }, () => "");
        }
        cachedSongId = songId;
        cachedTrackUrls[trackIndex] = track.url;
        debugLog("troupe", "track buffer ready", { trackIndex, url: track.url });
    };

    const ensureSelectedTracksLoaded = async (songId) => {
        const selected = getSelectedTrackIndexes();
        await Promise.all(selected.map((trackIndex) => ensureTrackLoaded(songId, trackIndex)));
    };

    const applyDjAction = async () => {
        const action = latestState.performance.lastAction;
        if (!action) {
            return;
        }
        debugLog("troupe", "applyDjAction", action);
        if ((action.action === "play" || action.action === "jump") && action.songId) {
            await ensureSelectedTracksLoaded(action.songId);
        }
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
        cachedSongId = "";
        cachedTrackUrls = Array.from({ length: TRACK_COUNT }, () => "");
        await clearObsoleteSessionCaches("");
    };

    const syncLiveTrackSelection = (trackIndexes) => {
        const normalized = normalizeTrackIndexes(trackIndexes);
        selectedTrackIndexes = normalized;
        persistSelectedTrackIndexes(selectedTrackIndexes);
        renderSelectedTrack();
        sendCurrentTrackSelection();
        debugLog("troupe", "selected tracks", { selectedTrackIndexes });
    };

    const applySelectionWhilePlaying = async () => {
        const activeSongId = String(latestState.performance.lastAction?.songId || cachedSongId || "");
        const shouldSwitchImmediately = Boolean(playbackActive && activeSongId);
        if (!shouldSwitchImmediately) {
            return;
        }
        const selected = getSelectedTrackIndexes();
        if (selected.length === 0) {
            const whenSec = Number(bufferPlayer.getAudioCurrentTime()) + 0.02;
            bufferPlayer.schedulePause(whenSec);
            return;
        }
        const token = trackSwitchToken + 1;
        trackSwitchToken = token;

        await bufferPlayer.unlock();
        await ensureSelectedTracksLoaded(activeSongId);
        if (token !== trackSwitchToken || !playbackActive) {
            return;
        }

        const whenSec = Number(bufferPlayer.getAudioCurrentTime()) + 0.02;
        const referenceTrack = selected.find((trackIndex) => Number.isFinite(bufferPlayer.getTrackPlaybackOffset(trackIndex, whenSec)));
        if (referenceTrack === undefined) {
            return;
        }
        const switchOffsetSec = bufferPlayer.getTrackPlaybackOffset(referenceTrack, whenSec);
        if (!Number.isFinite(switchOffsetSec)) {
            return;
        }

        const offsetsByTrack = Array.from({ length: TRACK_COUNT }, () => 0);
        for (const trackIndex of selected) {
            offsetsByTrack[trackIndex] = Math.max(0, switchOffsetSec);
        }
        const switched = bufferPlayer.schedulePlay(whenSec, offsetsByTrack);
        debugLog("troupe-audio", "track selection switched mid-playback", {
            selectedTrackIndexes: getSelectedTrackIndexes(),
            offsetSec: Number(switchOffsetSec).toFixed(3),
            switched,
        });
    };

    const resolveTrackFromEvent = (event) => {
        const target = event.target.closest("[data-track]");
        if (!target) {
            return null;
        }
        return clampTrackIndex(Number(target.dataset.track) - 1);
    };

    const onTrackToggle = (event) => {
        const trackIndex = resolveTrackFromEvent(event);
        if (trackIndex === null) {
            return;
        }

        const current = new Set(getSelectedTrackIndexes());
        if (current.has(trackIndex)) {
            current.delete(trackIndex);
        } else {
            current.add(trackIndex);
        }

        syncLiveTrackSelection([...current]);
        void applySelectionWhilePlaying();
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
        const nextLatencyCompensationSec = Number(nextState.pulse.speakerLatencyCompensationSeconds) || 0;
        const latencyDeltaSec = nextLatencyCompensationSec - lastLatencyCompensationSec;
        lastLatencyCompensationSec = nextLatencyCompensationSec;
        const nextAction = nextState.performance.lastAction || null;
        const isActive = Boolean(nextState.performance.active);
        const nextSessionToken = String(nextState.performance.sessionToken || "");
        latestState = nextState;
        renderConnection();
        renderTrackSelectionCounts();
        bufferPlayer.setNoiseFloorEnabled(latestState.pulse.noiseFloorEnabled !== false);
        if (latestState.pulse.connectionStatus === "connected" && previousConnectionStatus !== "connected") {
            sendCurrentTrackSelection();
        }
        previousConnectionStatus = String(latestState.pulse.connectionStatus || "");
        if (nextSessionToken !== previousSessionToken) {
            const tokenToKeep = isActive ? nextSessionToken : "";
            void clearObsoleteSessionCaches(tokenToKeep);
            cachedSongId = "";
            cachedTrackUrls = Array.from({ length: TRACK_COUNT }, () => "");
            previousSessionToken = nextSessionToken;
        }
        if (Math.abs(latencyDeltaSec) >= 0.001) {
            const retimed = bufferPlayer.retimeActiveTracksByDelta(latencyDeltaSec, {
                whenSec: Number(bufferPlayer.getAudioCurrentTime()) + 0.015,
                fadeSec: 0.02,
            });
            if (retimed > 0) {
                debugLog("troupe-audio", "retimed active tracks for latency change", {
                    latencyDeltaSec: Number(latencyDeltaSec).toFixed(4),
                    retimed,
                });
            }
        }
        if (previousPerformanceActive && !isActive) {
            playbackActive = false;
            const isTempTroupe = latestState.auth.user?.role === "troupe" && latestState.auth.user?.id === "troupe_user_01";
            if (isTempTroupe && !logoutInFlight) {
                logoutInFlight = true;
                void clearSessionAudio().finally(() => {
                    void logout().then(() => navigate("default"));
                });
            } else {
                void clearSessionAudio();
            }
            previousPerformanceActive = isActive;
            lastHandledAction = nextAction;
            return;
        }
        if (nextAction && nextAction !== lastHandledAction) {
            lastHandledAction = nextAction;
            if (nextAction.action === "pause") {
                playbackActive = false;
            } else if (nextAction.action === "play" || nextAction.action === "jump") {
                playbackActive = true;
            }
            void applyDjAction();
        }
        previousPerformanceActive = isActive;
    });

    mountNode.addEventListener("click", onTrackToggle);
    mountNode.addEventListener("pointerdown", onUserGesture);
    eventScheduler.start();
    ensurePulseTransportConnected();
    void loadPerformanceState();
    void clearObsoleteSessionCaches(latestState.performance.active ? (latestState.performance.sessionToken || "") : "");
    performancePollTimer = window.setInterval(() => {
        void loadPerformanceState();
    }, 2000);
    renderConnection();
    renderSelectedTrack();
    renderTrackSelectionCounts();
    sendCurrentTrackSelection();
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
        mountNode.removeEventListener("click", onTrackToggle);
        mountNode.removeEventListener("pointerdown", onUserGesture);
        unsubscribe();
    };
};
