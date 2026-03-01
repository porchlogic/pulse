/* Global Pulse app state and singleton realtime transport ownership */

import { createPulseTransportClient } from "./components/clock/transport-client.js";
import { createApiClient } from "./components/util/api-client.js";
import { debugLog, debugWarn } from "./components/util/debug.js";
import {
    clampSpeakerLatencyTrimSeconds,
    clampSpeakerLatencySeconds,
    computeSpeakerLatencyCompensationSeconds,
    persistSpeakerLatencyBaseSeconds,
    persistSpeakerLatencyTrimSeconds,
    readStoredSpeakerLatencyBaseSeconds,
    readStoredSpeakerLatencyTrimSeconds,
} from "./components/audio/speaker-latency-calibrator.js";

const DEFAULT_TICK_LENGTH = 20833;
const DEFAULT_NUM_BAR_BEATS = 4;
const TRACK_COUNT = 8;

const makeEmptyTrack = (index) => ({
    index,
    title: "",
    fileName: "",
    sourceUrl: "",
});

const getDefaultPulseWsUrl = () => {
    if (typeof window !== "undefined" && typeof window.PULSE_WS_URL === "string" && window.PULSE_WS_URL.trim()) {
        return window.PULSE_WS_URL.trim();
    }
    if (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
        return "ws://127.0.0.1:3001/pulse/ws";
    }
    return "wss://api.porchlogic.com/pulse/ws";
};

const apiClient = createApiClient();
let djLibraryPromise = null;
const initialSpeakerLatencyBaseSeconds = readStoredSpeakerLatencyBaseSeconds();
const initialSpeakerLatencyTrimSeconds = readStoredSpeakerLatencyTrimSeconds();
const state = {
    pulse: {
        wsUrl: getDefaultPulseWsUrl(),
        connectionStatus: "disconnected",
        connectionError: "",
        clockOffset: 0,
        lastDownBeatTime: 0,
        tickLength: DEFAULT_TICK_LENGTH,
        numBarBeats: DEFAULT_NUM_BAR_BEATS,
        speakerLatencyBaseSeconds: initialSpeakerLatencyBaseSeconds,
        speakerLatencyTrimSeconds: initialSpeakerLatencyTrimSeconds,
        speakerLatencyCompensationSeconds: computeSpeakerLatencyCompensationSeconds(
            initialSpeakerLatencyBaseSeconds,
            initialSpeakerLatencyTrimSeconds,
        ),
        lastRoundTripTime: null,
        syncSampleCount: 0,
    },
    performance: {
        active: false,
        sessionToken: "",
        liveDjUserId: "",
        bpm: 120,
        tickLength: DEFAULT_TICK_LENGTH,
        updatedAt: "",
        lastAction: null,
    },
    auth: {
        initialized: false,
        loading: false,
        authenticated: false,
        user: null,
        error: "",
    },
    dj: {
        songs: [],
        activeSongId: "",
    },
    director: {
        error: "",
        djs: [],
    },
};

const listeners = new Set();
let transportClient = null;
let authInitPromise = null;

const notify = () => {
    for (const listener of listeners) {
        listener(state);
    }
};

const patchPulseState = (changes) => {
    state.pulse = {
        ...state.pulse,
        ...changes,
    };
    notify();
};

const getTransportClient = () => {
    if (transportClient) {
        return transportClient;
    }

    transportClient = createPulseTransportClient({
        url: state.pulse.wsUrl,
        onConnectionChange: ({ status, error }) => {
            patchPulseState({
                connectionStatus: status,
                connectionError: typeof error === "string" ? error : "",
            });
        },
        onTimingChange: (timing) => {
            patchPulseState(timing);
        },
        onClockOffsetChange: (clockOffset) => {
            patchPulseState({ clockOffset });
        },
        onSyncSample: ({ roundTripTime, sampleCount }) => {
            patchPulseState({
                lastRoundTripTime: roundTripTime,
                syncSampleCount: sampleCount,
            });
        },
        onRealtimeEvent: (message) => {
            if (message.type === "performance_state") {
                debugLog("state", "performance_state received", message);
                state.performance = {
                    ...state.performance,
                    active: Boolean(message.active),
                    sessionToken: message.sessionToken || "",
                    liveDjUserId: message.liveDjUserId || "",
                    bpm: Number(message.bpm || state.performance.bpm),
                    tickLength: Number(message.tickLength || state.performance.tickLength),
                    updatedAt: message.updatedAt || "",
                };
                notify();
            }
            if (message.type === "dj_perform_action") {
                debugLog("state", "dj_perform_action received", message);
                state.performance = {
                    ...state.performance,
                    lastAction: message,
                };
                notify();
            }
        },
    });

    return transportClient;
};

export const getAppState = () => state;

export const subscribeAppState = (listener) => {
    if (typeof listener !== "function") {
        return () => {};
    }
    listeners.add(listener);
    listener(state);
    return () => {
        listeners.delete(listener);
    };
};

export const ensurePulseTransportConnected = () => {
    getTransportClient().ensureConnected();
};

export const setSpeakerLatencyBaseSeconds = (seconds) => {
    const clamped = clampSpeakerLatencySeconds(seconds);
    const trim = state.pulse.speakerLatencyTrimSeconds;
    patchPulseState({
        speakerLatencyBaseSeconds: clamped,
        speakerLatencyCompensationSeconds: computeSpeakerLatencyCompensationSeconds(clamped, trim),
    });
    persistSpeakerLatencyBaseSeconds(clamped);
    return clamped;
};

export const setSpeakerLatencyTrimSeconds = (seconds) => {
    const clampedTrim = clampSpeakerLatencyTrimSeconds(seconds);
    const base = state.pulse.speakerLatencyBaseSeconds;
    patchPulseState({
        speakerLatencyTrimSeconds: clampedTrim,
        speakerLatencyCompensationSeconds: computeSpeakerLatencyCompensationSeconds(base, clampedTrim),
    });
    persistSpeakerLatencyTrimSeconds(clampedTrim);
    return clampedTrim;
};

export const setSpeakerLatencyCompensationSeconds = (seconds) => {
    const clamped = clampSpeakerLatencySeconds(seconds);
    patchPulseState({
        speakerLatencyBaseSeconds: clamped,
        speakerLatencyTrimSeconds: 0,
        speakerLatencyCompensationSeconds: clamped,
    });
    persistSpeakerLatencyBaseSeconds(clamped);
    persistSpeakerLatencyTrimSeconds(0);
    return clamped;
};

const patchAuthState = (changes) => {
    state.auth = {
        ...state.auth,
        ...changes,
    };
    notify();
};

const patchDjState = (changes) => {
    state.dj = {
        ...state.dj,
        ...changes,
    };
    notify();
};

const patchPerformanceState = (changes) => {
    state.performance = {
        ...state.performance,
        ...changes,
    };
    notify();
};

const patchDirectorState = (changes) => {
    state.director = {
        ...state.director,
        ...changes,
    };
    notify();
};

const normalizeTrack = (track, trackIndex) => ({
    index: trackIndex,
    title: typeof track?.title === "string" ? track.title : "",
    fileName: typeof track?.fileName === "string" ? track.fileName : "",
    sourceUrl: typeof track?.url === "string" && track.url
        ? (track.url.startsWith("http") ? track.url : `${apiClient.baseUrl}${track.url}`)
        : "",
});

const normalizeSong = (song, fallbackIndex = 0) => ({
    id: String(song?.id || `song_${fallbackIndex + 1}`),
    title: typeof song?.title === "string" && song.title ? song.title : `Song ${fallbackIndex + 1}`,
    mode: song?.mode === "radio" ? "radio" : "performance",
    tracks: Array.from({ length: TRACK_COUNT }, (_, trackIndex) => normalizeTrack(song?.tracks?.[trackIndex], trackIndex)),
});

const setSongsFromServer = (songs) => {
    const normalizedSongs = Array.isArray(songs) ? songs.map(normalizeSong) : [];
    const activeSongId = normalizedSongs.some((song) => song.id === state.dj.activeSongId)
        ? state.dj.activeSongId
        : (normalizedSongs[0]?.id || "");
    patchDjState({
        songs: normalizedSongs,
        activeSongId,
    });
};

export const initializeAuth = async () => {
    if (state.auth.initialized) {
        return;
    }
    if (authInitPromise) {
        return authInitPromise;
    }

    authInitPromise = (async () => {
        patchAuthState({ loading: true, error: "" });
        try {
            const payload = await apiClient.request("/auth/me");
            patchAuthState({
                initialized: true,
                loading: false,
                authenticated: payload?.authenticated === true,
                user: payload?.authenticated ? payload.user : null,
                error: "",
            });
        } catch (error) {
            patchAuthState({
                initialized: true,
                loading: false,
                authenticated: false,
                user: null,
                error: error.message || "Unable to load session",
            });
        }
    })();

    await authInitPromise;
    authInitPromise = null;
};

export const loginDj = async ({ email, password }) => {
    patchAuthState({ loading: true, error: "" });
    try {
        const payload = await apiClient.request("/auth/login", {
            method: "POST",
            body: { email, password },
        });
        patchAuthState({
            initialized: true,
            loading: false,
            authenticated: payload?.authenticated === true,
            user: payload?.user || null,
            error: "",
        });
        return { ok: true };
    } catch (error) {
        patchAuthState({
            loading: false,
            authenticated: false,
            user: null,
            error: error.message || "Login failed",
        });
        return { ok: false, error: error.message || "Login failed" };
    }
};

export const loginTroupeSim = async (sessionTokenOverride = "") => {
    patchAuthState({ loading: true, error: "" });
    try {
        const payload = await apiClient.request("/auth/login/troupe-sim", {
            method: "POST",
            body: {
                sessionToken: String(sessionTokenOverride || new URLSearchParams(window.location.search).get("session") || ""),
            },
        });
        patchAuthState({
            initialized: true,
            loading: false,
            authenticated: payload?.authenticated === true,
            user: payload?.user || null,
            error: "",
        });
        return { ok: true };
    } catch (error) {
        patchAuthState({
            loading: false,
            authenticated: false,
            user: null,
            error: error.message || "Login failed",
        });
        return { ok: false, error: error.message || "Login failed" };
    }
};

export const logout = async () => {
    try {
        await apiClient.request("/auth/logout", {
            method: "POST",
            body: {},
        });
    } catch {
        // Treat logout as best effort in this phase.
    }
    patchAuthState({
        initialized: true,
        loading: false,
        authenticated: false,
        user: null,
        error: "",
    });
    djLibraryPromise = null;
};

export const canAccessRoute = (route) => {
    const normalizedRoute = String(route || "").trim().toLowerCase();
    const role = state.auth.user?.role || "";
    const isAuthenticated = state.auth.authenticated === true;

    if (normalizedRoute === "default" || normalizedRoute === "login" || normalizedRoute === "join") {
        return true;
    }
    if (normalizedRoute === "troupe") {
        return isAuthenticated && (role === "troupe" || role === "dj");
    }
    if (normalizedRoute === "dj" || normalizedRoute === "perform") {
        return isAuthenticated && role === "dj";
    }
    if (normalizedRoute === "director") {
        return true;
    }
    return true;
};

export const getFallbackRouteForAuth = (route) => {
    const normalizedRoute = String(route || "").trim().toLowerCase();
    if (normalizedRoute === "troupe") {
        return "join";
    }
    if (normalizedRoute === "director") {
        return "login";
    }
    return "login";
};

export const addSong = () => {
    void apiClient.request("/pulse/songs", {
        method: "POST",
        body: {
            title: `Song ${state.dj.songs.length + 1}`,
        },
    }).then((payload) => {
        const nextSong = normalizeSong(payload?.song, state.dj.songs.length);
        patchDjState({
            songs: [...state.dj.songs, nextSong],
            activeSongId: nextSong.id,
        });
    }).catch(() => {});
};

export const updateSong = (songId, changes) => {
    const previousSongs = state.dj.songs;
    const optimisticSongs = previousSongs.map((song) => (
        song.id === songId ? { ...song, ...changes } : song
    ));
    patchDjState({
        songs: optimisticSongs,
    });
    void apiClient.request(`/pulse/songs/${songId}`, {
        method: "PATCH",
        body: changes,
    }).then((payload) => {
        if (!payload?.song) {
            return;
        }
        const nextSong = normalizeSong(payload.song);
        patchDjState({
            songs: state.dj.songs.map((song) => (song.id === songId ? nextSong : song)),
        });
    }).catch(() => {
        patchDjState({ songs: previousSongs });
    });
};

export const setActiveSong = (songId) => {
    patchDjState({
        activeSongId: songId,
    });
};

export const updateTrack = (songId, trackIndex, changes) => {
    const previousSongs = state.dj.songs;
    patchDjState({
        songs: previousSongs.map((song) => {
            if (song.id !== songId) {
                return song;
            }
            return {
                ...song,
                tracks: song.tracks.map((track) => (
                    track.index === trackIndex ? { ...track, ...changes } : track
                )),
            };
        }),
    });

    if (typeof changes.title !== "string") {
        return;
    }

    void apiClient.request(`/pulse/songs/${songId}/tracks/${trackIndex}`, {
        method: "PATCH",
        body: { title: changes.title },
    }).then((payload) => {
        if (!payload?.song) {
            return;
        }
        const nextSong = normalizeSong(payload.song);
        patchDjState({
            songs: state.dj.songs.map((song) => (song.id === songId ? nextSong : song)),
        });
    }).catch(() => {
        patchDjState({ songs: previousSongs });
    });
};

export const ensureDjLibraryLoaded = async () => {
    if (djLibraryPromise) {
        return djLibraryPromise;
    }
    djLibraryPromise = (async () => {
        const payload = await apiClient.request("/pulse/songs");
        const songs = Array.isArray(payload?.songs) ? payload.songs : [];
        if (songs.length > 0) {
            setSongsFromServer(songs);
            return;
        }
        const createPayload = await apiClient.request("/pulse/songs", {
            method: "POST",
            body: { title: "Song 1" },
        });
        const createdSong = createPayload?.song ? [createPayload.song] : [];
        setSongsFromServer(createdSong);
    })().finally(() => {
        djLibraryPromise = null;
    });
    return djLibraryPromise;
};

export const sendDjPerformAction = (payload) => {
    debugLog("dj", "sendDjPerformAction", payload);
    getTransportClient().sendRealtime({
        type: "dj_perform_action",
        ...payload,
    });
};

export const loadPerformanceState = async () => {
    try {
        const payload = await apiClient.request("/pulse/performance/state");
        if (payload?.performance) {
            patchPerformanceState(payload.performance);
        }
    } catch (error) {
        debugWarn("state", "loadPerformanceState failed", error?.message || error);
    }
};

export const loginDirector = async (password) => {
    patchAuthState({ loading: true, error: "" });
    try {
        const payload = await apiClient.request("/auth/login/director", {
            method: "POST",
            body: { password },
        });
        patchAuthState({
            initialized: true,
            loading: false,
            authenticated: payload?.authenticated === true,
            user: payload?.user || null,
            error: "",
        });
        return { ok: true };
    } catch (error) {
        patchAuthState({
            loading: false,
            authenticated: false,
            user: null,
            error: error.message || "Login failed",
        });
        return { ok: false, error: error.message || "Login failed" };
    }
};

export const loadDirectorState = async () => {
    try {
        const payload = await apiClient.request("/pulse/director/state");
        if (payload?.performance) {
            patchPerformanceState(payload.performance);
        }
        if (Array.isArray(payload?.djs)) {
            patchDirectorState({ djs: payload.djs });
        }
        return { ok: true };
    } catch (error) {
        patchDirectorState({ error: error.message || "Failed to load director state" });
        return { ok: false, error: error.message || "Failed to load director state" };
    }
};

export const directorStartPerformance = async () => {
    const payload = await apiClient.request("/pulse/director/performance/start", {
        method: "POST",
        body: {},
    });
    if (payload?.performance) {
        patchPerformanceState(payload.performance);
    }
};

export const directorEndPerformance = async () => {
    const payload = await apiClient.request("/pulse/director/performance/end", {
        method: "POST",
        body: {},
    });
    if (payload?.performance) {
        patchPerformanceState(payload.performance);
    }
};

export const directorSetLiveDj = async (userId) => {
    const payload = await apiClient.request("/pulse/director/live-dj", {
        method: "POST",
        body: { userId },
    });
    if (payload?.performance) {
        patchPerformanceState(payload.performance);
    }
};

export const directorSetTempo = async (bpm) => {
    const payload = await apiClient.request("/pulse/director/tempo", {
        method: "POST",
        body: { bpm },
    });
    if (payload?.performance) {
        patchPerformanceState(payload.performance);
    }
};

export const djSetTempo = async (bpm) => {
    const payload = await apiClient.request("/pulse/dj/tempo", {
        method: "POST",
        body: { bpm },
    });
    if (payload?.performance) {
        patchPerformanceState(payload.performance);
    }
};

export const fetchLivePerformanceTrack = async ({ songId, trackIndex }) => {
    const query = new URLSearchParams({
        songId,
        trackIndex: String(trackIndex),
    });
    const payload = await apiClient.request(`/pulse/performance/track?${query.toString()}`);
    const track = payload?.track || null;
    if (!track) {
        return null;
    }
    const preferredUrl = typeof track.contentUrl === "string" && track.contentUrl
        ? track.contentUrl
        : track.url;
    const url = typeof preferredUrl === "string" ? preferredUrl : "";
    return {
        ...track,
        url: url && !url.startsWith("http")
            ? `${apiClient.baseUrl}${url}`
            : url,
    };
};

export const uploadTrackFile = async ({ songId, trackIndex, file }) => {
    if (!file) {
        return { ok: false, error: "Missing file" };
    }
    const query = new URLSearchParams({
        file_name: file.name || `track_${trackIndex}.wav`,
    });
    try {
        const payload = await apiClient.request(
            `/pulse/songs/${songId}/tracks/${trackIndex}/upload?${query.toString()}`,
            {
                method: "PUT",
                headers: {
                    "Content-Type": file.type || "application/octet-stream",
                },
                rawBody: file,
            },
        );
        const nextSong = normalizeSong(payload?.song);
        patchDjState({
            songs: state.dj.songs.map((song) => (song.id === songId ? nextSong : song)),
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error.message || "Upload failed" };
    }
};

export const deleteTrackFile = async ({ songId, trackIndex }) => {
    try {
        const payload = await apiClient.request(`/pulse/songs/${songId}/tracks/${trackIndex}`, {
            method: "DELETE",
        });
        const nextSong = normalizeSong(payload?.song);
        patchDjState({
            songs: state.dj.songs.map((song) => (song.id === songId ? nextSong : song)),
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error.message || "Delete failed" };
    }
};
