/* Artist launcher control surface (single-song unified layout). */

import {
    addSong,
    ensureDjLibraryLoaded,
    ensurePulseTransportConnected,
    getAppState,
    loadPerformanceState,
    sendDjPerformAction,
    subscribeAppState,
    updateSong,
    updateTrack,
    uploadTrackFile,
} from "../../state.js";
import { getAbsoluteBeatNow } from "../../components/clock/beat-time.js";

const TRACK_COUNT = 8;
const SONG_COUNT = 3;
const SONG_STATE_STORAGE_KEY = "pulse_artist_launcher_state_v1";
const SONG_ORDER_STORAGE_KEY = "pulse_artist_song_order_v1";
const DEFAULT_THEME_COLORS = ["#0b0d12", "#151a22", "#7df0c8", "#f2f6ff", "#8f9db6"];

const clampInt = (value, min, max, fallback) => {
    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
};

const isArtistRole = (role) => role === "artist" || role === "dj";

const readJsonStorage = (key, fallback) => {
    if (typeof window === "undefined" || !window.localStorage) {
        return fallback;
    }
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) {
            return fallback;
        }
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
        return fallback;
    }
};

const persistJsonStorage = (key, value) => {
    if (typeof window === "undefined" || !window.localStorage) {
        return;
    }
    window.localStorage.setItem(key, JSON.stringify(value));
};

const normalizeSongSettings = (value = {}) => ({
    bpm: clampInt(value.bpm, 60, 220, 120),
    beatsPerPhrase: clampInt(value.beatsPerPhrase, 1, 16, 4),
    phrasesPerRow: clampInt(value.phrasesPerRow, 1, 16, 4),
    rowsPerSong: clampInt(value.rowsPerSong, 1, 16, 6),
    playingRows: Array.from({ length: TRACK_COUNT }, (_, idx) => clampInt(value?.playingRows?.[idx], 0, 15, 0)),
    queuedRows: Array.from({ length: TRACK_COUNT }, (_, idx) => {
        const raw = value?.queuedRows?.[idx];
        if (raw === null || raw === undefined) {
            return null;
        }
        return clampInt(raw, 0, 15, 0);
    }),
    themeColors: Array.isArray(value?.themeColors) && value.themeColors.length === 5
        ? value.themeColors.map((item) => String(item || "").trim())
        : [...DEFAULT_THEME_COLORS],
});

const buildSongBlockHtml = (
    song,
    index,
    songState,
    {
        queuedSongId = "",
        activeSongId = "",
        isPlaying = false,
        titleDraftBySongId = {},
        trackTitleDraftBySongTrack = {},
    } = {},
) => {
    const songTitle = String(titleDraftBySongId[song.id] ?? song.title ?? `Song ${index + 1}`);
    const isQueued = queuedSongId === song.id;
    const isCurrent = activeSongId === song.id;
    const trackColumns = song.tracks.map((track) => `
        <div class="track-col" data-role="artist-track-col" data-song-id="${song.id}" data-track-index="${track.index}">
            <input class="field" type="text" value="${String(trackTitleDraftBySongTrack[`${song.id}:${track.index}`] ?? track.title ?? "").replace(/"/g, "&quot;")}" data-role="artist-track-name" data-song-id="${song.id}" data-track-index="${track.index}" placeholder="Track ${track.index + 1}">
            <button type="button" class="btn track-upload" data-role="artist-track-upload" data-song-id="${song.id}" data-track-index="${track.index}">${track.fileName ? `Upload (${String(track.fileName)})` : "Upload"}</button>
            <input class="ui-launcher-hidden-input" type="file" accept=".wav,.wave,.mp3,audio/wav,audio/mpeg" data-role="artist-track-file" data-song-id="${song.id}" data-track-index="${track.index}">
        </div>
    `).join("");
    const themeRow = songState.themeColors.map((color, swatchIndex) => `
        <span class="theme-swatch-wrap">
            <button
                type="button"
                class="theme-swatch"
                data-role="artist-theme-swatch"
                data-song-id="${song.id}"
                data-swatch-index="${swatchIndex}"
                style="background:${color};"
                aria-label="Theme swatch ${swatchIndex + 1}"
                title="${color}"
            ></button>
            <input
                class="theme-color-input"
                type="color"
                data-role="artist-theme-color-input"
                data-song-id="${song.id}"
                data-swatch-index="${swatchIndex}"
                value="${color}"
            >
        </span>
    `).join("");

    return `
        <div class="song-block${isCurrent ? " is-current-song" : ""}" data-role="artist-song" data-song-id="${song.id}">
            <div class="song-head">
                <input class="field song-name-field" type="text" value="${songTitle.replace(/"/g, "&quot;")}" data-role="artist-song-title" data-song-id="${song.id}">
                <button type="button" class="btn queue-btn${isQueued ? " is-queued" : ""}" data-role="artist-song-queue" data-song-id="${song.id}">${isQueued ? "Queued" : "Queue"}</button>
                <div class="int-control"><span class="int-label">BPM</span>
                    <input class="int-field" type="number" min="60" max="220" step="1" data-role="artist-song-bpm" data-song-id="${song.id}" value="${songState.bpm}">
                </div>
                <div class="int-control"><span class="int-label">Beats/Phrase</span>
                    <input class="int-field" type="number" min="1" max="16" step="1" data-role="artist-beats-per-phrase" data-song-id="${song.id}" value="${songState.beatsPerPhrase}">
                </div>
                <div class="int-control"><span class="int-label">Phrases/Row</span>
                    <input class="int-field" type="number" min="1" max="16" step="1" data-role="artist-phrases-per-row" data-song-id="${song.id}" value="${songState.phrasesPerRow}">
                </div>
                <div class="int-control"><span class="int-label">Rows/Song</span>
                    <input class="int-field" type="number" min="1" max="16" step="1" data-role="artist-rows-per-song" data-song-id="${song.id}" value="${songState.rowsPerSong}">
                </div>
                <div class="pill-row">
                    <button type="button" class="arrow-btn" data-role="artist-song-up" data-song-id="${song.id}" aria-label="Move song up"${isPlaying ? " hidden" : ""}>↑</button>
                    <button type="button" class="arrow-btn" data-role="artist-song-down" data-song-id="${song.id}" aria-label="Move song down"${isPlaying ? " hidden" : ""}>↓</button>
                </div>
            </div>
            <div class="theme-row" data-role="artist-theme-row" data-song-id="${song.id}">
                ${themeRow}
            </div>
            <div class="launcher">
                <div class="cols">${trackColumns}</div>
                <div class="pad-grid" data-role="artist-launcher-grid" data-song-id="${song.id}"></div>
            </div>
            <p class="subtle" data-role="artist-song-upload-message" data-song-id="${song.id}" hidden></p>
        </div>
    `;
};

const buildLauncherCell = ({ songId, row, track, barsPerSection }) => {
    const barSegments = Array.from({ length: Math.max(1, barsPerSection) }, () => "<div class=\"padBar\"></div>").join("");
    return `
        <button type="button" class="pad" data-role="artist-launcher-pad" data-song-id="${songId}" data-row="${row}" data-launcher-track="${track}">
            <span class="padBars">${barSegments}</span>
        </button>
    `;
};

export const mountArtistLaunchers = ({ mountNode } = {}) => {
    if (!mountNode) {
        return () => {};
    }

    mountNode.innerHTML = "<div data-role=\"artist-song-list\"></div>";

    const playPauseButton = document.getElementById("artist-play-toggle");
    const stopButton = document.getElementById("artist-stop-toggle");
    const songListEl = mountNode.querySelector("[data-role=\"artist-song-list\"]");
    if (!playPauseButton || !stopButton || !songListEl) {
        return () => {};
    }

    let state = getAppState();
    let isPlaying = false;
    let scheduledPlayBeat = null;
    let scheduledPauseBeat = null;
    let activeSongIndex = 0;
    let lastBeat = null;
    let lastProcessedVersion = "";
    let beatTimer = 0;
    let queuedSongId = "";
    let songOrder = [];
    const titleDraftBySongId = {};
    const trackTitleDraftBySongTrack = {};
    const songStateMap = readJsonStorage(SONG_STATE_STORAGE_KEY, {});
    const savedOrder = readJsonStorage(SONG_ORDER_STORAGE_KEY, { ids: [] });
    let lastThemeActionSongId = "";
    let lastThemeActionSignature = "";

    const ensureSongState = (songId) => {
        const existing = songStateMap[songId];
        const normalized = normalizeSongSettings(existing || {});
        if (existing && Number.isFinite(Number(existing.__activeBar))) {
            normalized.__activeBar = clampInt(existing.__activeBar, 1, normalized.phrasesPerRow, 1);
        }
        const songFromState = (state.dj.songs || []).find((item) => item.id === songId);
        if (Array.isArray(songFromState?.themeColors) && songFromState.themeColors.length === 5) {
            normalized.themeColors = songFromState.themeColors.map((item) => String(item || "").trim());
        }
        songStateMap[songId] = normalized;
        return normalized;
    };

    const persistSongState = () => {
        persistJsonStorage(SONG_STATE_STORAGE_KEY, songStateMap);
        persistJsonStorage(SONG_ORDER_STORAGE_KEY, { ids: songOrder });
    };

    const getSongs = () => {
        const songs = Array.isArray(state.dj.songs) ? state.dj.songs : [];
        if (songOrder.length === 0) {
            songOrder = savedOrder.ids.filter((id) => songs.some((song) => song.id === id));
        }
        for (const song of songs) {
            if (!songOrder.includes(song.id)) {
                songOrder.push(song.id);
            }
        }
        songOrder = songOrder.slice(0, SONG_COUNT);
        return songOrder
            .map((id) => songs.find((song) => song.id === id))
            .filter(Boolean);
    };

    const buildGridForSong = (songId, rowsPerSong, barsPerSection) => {
        const gridEl = songListEl.querySelector(`[data-role="artist-launcher-grid"][data-song-id="${songId}"]`);
        if (!gridEl) {
            return;
        }
        gridEl.innerHTML = Array.from({ length: rowsPerSong }, (_, row) => (
            Array.from({ length: TRACK_COUNT }, (_, track) => buildLauncherCell({
                songId,
                row,
                track,
                barsPerSection,
            })).join("")
        )).join("");
    };

    const renderSongList = () => {
        const songs = getSongs();
        const activeSongId = songs[Math.max(0, Math.min(songs.length - 1, activeSongIndex))]?.id || "";
        songListEl.innerHTML = songs.map((song, index) => buildSongBlockHtml(song, index, ensureSongState(song.id), {
            queuedSongId,
            activeSongId,
            isPlaying,
            titleDraftBySongId,
            trackTitleDraftBySongTrack,
        })).join("");
        for (const song of songs) {
            const songState = ensureSongState(song.id);
            buildGridForSong(song.id, songState.rowsPerSong, songState.phrasesPerRow);
        }
        renderPads();
    };

    const setSongUploadMessage = (songId, message = "", isError = false) => {
        const el = songListEl.querySelector(`[data-role="artist-song-upload-message"][data-song-id="${songId}"]`);
        if (!el) {
            return;
        }
        if (!message) {
            el.hidden = true;
            el.textContent = "";
            el.classList.remove("upload-error");
            return;
        }
        el.hidden = false;
        el.textContent = message;
        el.classList.toggle("upload-error", Boolean(isError));
    };

    const updatePlaybackStateFromBeat = () => {
        const beatNow = getAbsoluteBeatNow(state.pulse);
        if (!Number.isFinite(beatNow)) {
            return false;
        }
        let changed = false;
        if (scheduledPlayBeat !== null && beatNow >= scheduledPlayBeat) {
            if (!isPlaying) {
                isPlaying = true;
                changed = true;
            }
            scheduledPlayBeat = null;
        }
        if (scheduledPauseBeat !== null && beatNow >= scheduledPauseBeat) {
            if (isPlaying) {
                isPlaying = false;
                changed = true;
            }
            scheduledPauseBeat = null;
        }
        return changed;
    };

    const applyPerformActionPlaybackState = (action) => {
        if (!action || typeof action !== "object") {
            return false;
        }
        const beatNow = getAbsoluteBeatNow(state.pulse);
        const actionBeat = Number.isFinite(action.absoluteBeat) ? Math.trunc(Number(action.absoluteBeat)) : null;
        let changed = false;

        if (action.action === "play") {
            const playSongId = String(action.songId || "");
            if (playSongId) {
                const playSongState = ensureSongState(playSongId);
                playSongState.__activeBar = 1;
                persistSongState();
            }
            scheduledPauseBeat = null;
            if (actionBeat !== null) {
                scheduledPlayBeat = actionBeat;
                if (Number.isFinite(beatNow) && beatNow >= actionBeat) {
                    if (!isPlaying) {
                        isPlaying = true;
                        changed = true;
                    }
                    scheduledPlayBeat = null;
                } else if (isPlaying) {
                    isPlaying = false;
                    changed = true;
                }
            } else if (!isPlaying) {
                isPlaying = true;
                changed = true;
            }
        }

        if (action.action === "pause") {
            scheduledPlayBeat = null;
            if (actionBeat !== null) {
                scheduledPauseBeat = actionBeat;
                if (Number.isFinite(beatNow) && beatNow >= actionBeat) {
                    if (isPlaying) {
                        isPlaying = false;
                        changed = true;
                    }
                    scheduledPauseBeat = null;
                } else if (!isPlaying) {
                    isPlaying = true;
                    changed = true;
                }
            } else if (isPlaying) {
                isPlaying = false;
                changed = true;
            }
        }

        return changed;
    };

    const getActiveSong = () => {
        const songs = getSongs();
        if (songs.length === 0) {
            return null;
        }
        const idx = Math.max(0, Math.min(songs.length - 1, activeSongIndex));
        activeSongIndex = idx;
        return songs[idx];
    };

    const resetSongPlaybackToStart = (songId) => {
        const songState = ensureSongState(songId);
        songState.__activeBar = 1;
        songState.playingRows = Array.from({ length: TRACK_COUNT }, () => 0);
        songState.queuedRows = Array.from({ length: TRACK_COUNT }, () => null);
        persistSongState();
    };

    const sendThemeForSong = (song, { force = false } = {}) => {
        if (!song) {
            return;
        }
        const songState = ensureSongState(song.id);
        const signature = `${song.id}|${songState.themeColors.join("|")}`;
        if (!force && signature === lastThemeActionSignature) {
            return;
        }
        updateSong(song.id, { themeColors: songState.themeColors });
        sendDjPerformAction({
            action: "theme",
            songId: song.id,
            barsPerRow: songState.phrasesPerRow,
            themeColors: songState.themeColors,
            atDownbeat: false,
        });
        lastThemeActionSongId = song.id;
        lastThemeActionSignature = signature;
    };

    const sendPlayForSong = async (song) => {
        const songState = ensureSongState(song.id);
        songState.__activeBar = 1;
        persistSongState();
        sendDjPerformAction({
            action: "play",
            songId: song.id,
            selectedRows: songState.playingRows,
            barsPerRow: songState.phrasesPerRow,
            atDownbeat: true,
        });
    };

    const getNextDownbeatBeat = () => {
        const beatNow = getAbsoluteBeatNow(state.pulse);
        const beatsPerBar = Math.max(1, Math.trunc(Number(state.pulse.numBarBeats) || 4));
        const beatInBarZero = ((beatNow % beatsPerBar) + beatsPerBar) % beatsPerBar;
        const beatsToNextDownbeat = beatInBarZero === 0 ? beatsPerBar : (beatsPerBar - beatInBarZero);
        return beatNow + beatsToNextDownbeat;
    };

    const renderPads = () => {
        const songs = getSongs();
        const activeSong = getActiveSong();
        const absoluteBeatNow = getAbsoluteBeatNow(state.pulse);
        for (const song of songs) {
            const songState = ensureSongState(song.id);
            const rowsPerSong = songState.rowsPerSong;
            const fallbackBar = clampInt(songState.__activeBar || 1, 1, songState.phrasesPerRow, 1) - 1;
            const beatSyncedBar = Number.isFinite(absoluteBeatNow)
                ? ((absoluteBeatNow % songState.phrasesPerRow) + songState.phrasesPerRow) % songState.phrasesPerRow
                : fallbackBar;
            const activeBar = isPlaying && activeSong?.id === song.id ? beatSyncedBar : fallbackBar;
            const pads = songListEl.querySelectorAll(`[data-role="artist-launcher-grid"][data-song-id="${song.id}"] [data-role="artist-launcher-pad"]`);
            for (const pad of pads) {
                const row = clampInt(pad.dataset.row, 0, 64, 0);
                const track = clampInt(pad.dataset.launcherTrack, 0, TRACK_COUNT - 1, 0);
                const isPlayingPad = songState.playingRows[track] === row;
                const isQueuedPad = songState.queuedRows[track] === row;
                pad.classList.toggle("playing", isPlaying && activeSong?.id === song.id && isPlayingPad);
                pad.classList.toggle("armed", isQueuedPad || (!isPlaying && isPlayingPad));
                const bars = pad.querySelectorAll(".padBar");
                for (let i = 0; i < bars.length; i += 1) {
                    const on = isPlaying && activeSong?.id === song.id && isPlayingPad && i === activeBar;
                    bars[i].classList.toggle("on", on);
                }
                pad.hidden = row >= rowsPerSong;
            }
        }
        playPauseButton.classList.toggle("is-playing", isPlaying);
        playPauseButton.classList.toggle("is-pending", !isPlaying && scheduledPlayBeat !== null);
        playPauseButton.setAttribute("aria-pressed", isPlaying ? "true" : "false");
        playPauseButton.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
    };

    const processBeat = async () => {
        const playbackChanged = updatePlaybackStateFromBeat();
        if (playbackChanged) {
            renderSongList();
            renderPads();
        }
        if (!isPlaying) {
            return;
        }
        const activeSong = getActiveSong();
        if (!activeSong) {
            return;
        }
        const songState = ensureSongState(activeSong.id);
        const beatNow = getAbsoluteBeatNow(state.pulse);
        if (!Number.isFinite(beatNow)) {
            return;
        }
        if (lastBeat === null) {
            lastBeat = beatNow;
            renderPads();
            return;
        }
        if (beatNow === lastBeat) {
            return;
        }
        renderPads();
        for (let beat = lastBeat + 1; beat <= beatNow; beat += 1) {
            const beatInBar = ((beat % songState.beatsPerPhrase) + songState.beatsPerPhrase) % songState.beatsPerPhrase;
            const isDownbeat = beatInBar === 0;
            if (!isDownbeat) {
                continue;
            }
            const barsPerSection = Math.max(1, songState.phrasesPerRow);
            const currentBar = clampInt(songState.__activeBar || 1, 1, barsPerSection, 1);
            const nextBar = currentBar >= barsPerSection ? 1 : currentBar + 1;
            songState.__activeBar = nextBar;
            const sectionBoundary = nextBar === 1;
            if (!sectionBoundary) {
                renderPads();
                continue;
            }

            if (queuedSongId && queuedSongId !== activeSong.id) {
                const queuedIndex = songOrder.indexOf(queuedSongId);
                if (queuedIndex !== -1) {
                    activeSongIndex = queuedIndex;
                    const nextQueuedSong = getActiveSong();
                    queuedSongId = "";
                    if (nextQueuedSong) {
                        sendThemeForSong(nextQueuedSong);
                        await sendPlayForSong(nextQueuedSong);
                    }
                    renderSongList();
                    renderPads();
                    return;
                }
                queuedSongId = "";
            }

            const allAtEnd = songState.playingRows.every((row) => row === (songState.rowsPerSong - 1));
            const hadQueued = songState.queuedRows.some((row) => row !== null);
            if (allAtEnd && !hadQueued) {
                if (activeSongIndex >= SONG_COUNT - 1) {
                    sendDjPerformAction({ action: "pause", atDownbeat: true });
                    renderSongList();
                    renderPads();
                    return;
                }
                activeSongIndex += 1;
                const nextSong = getActiveSong();
                if (nextSong) {
                    sendThemeForSong(nextSong);
                    await sendPlayForSong(nextSong);
                }
                renderSongList();
                renderPads();
                return;
            }

            for (let track = 0; track < TRACK_COUNT; track += 1) {
                if (songState.queuedRows[track] === null) {
                    songState.queuedRows[track] = (songState.playingRows[track] + 1) % songState.rowsPerSong;
                }
            }
            for (let track = 0; track < TRACK_COUNT; track += 1) {
                const queued = songState.queuedRows[track];
                if (queued === null) {
                    continue;
                }
                songState.playingRows[track] = queued;
                songState.queuedRows[track] = null;
                sendDjPerformAction({
                    action: "jump",
                    songId: activeSong.id,
                    trackIndex: track,
                    rowIndex: queued,
                    barsPerRow: songState.phrasesPerRow,
                    atDownbeat: true,
                });
            }
            persistSongState();
            renderPads();
        }
        lastBeat = beatNow;
    };

    const ensureThreeSongs = async () => {
        await ensureDjLibraryLoaded();
        let attempts = 0;
        while ((state.dj.songs?.length || 0) < SONG_COUNT && attempts < 6) {
            attempts += 1;
            await addSong();
            await ensureDjLibraryLoaded();
            state = getAppState();
        }
    };

    const onSongListInput = (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) {
            return;
        }
        const songId = String(target.dataset.songId || "");
        if (!songId) {
            return;
        }
        const songState = ensureSongState(songId);
        if (target.dataset.role === "artist-track-name") {
            const trackIndex = clampInt(target.dataset.trackIndex, 0, TRACK_COUNT - 1, 0);
            trackTitleDraftBySongTrack[`${songId}:${trackIndex}`] = target.value;
            return;
        }
        if (target.dataset.role === "artist-song-title") {
            titleDraftBySongId[songId] = target.value;
            return;
        }
        if (target.dataset.role === "artist-song-bpm") {
            songState.bpm = clampInt(target.value, 60, 220, songState.bpm);
        }
        if (target.dataset.role === "artist-beats-per-phrase") {
            songState.beatsPerPhrase = clampInt(target.value, 1, 16, songState.beatsPerPhrase);
        }
        if (target.dataset.role === "artist-phrases-per-row") {
            songState.phrasesPerRow = clampInt(target.value, 1, 16, songState.phrasesPerRow);
            buildGridForSong(songId, songState.rowsPerSong, songState.phrasesPerRow);
        }
        if (target.dataset.role === "artist-rows-per-song") {
            songState.rowsPerSong = clampInt(target.value, 1, 16, songState.rowsPerSong);
            songState.playingRows = songState.playingRows.map((row) => Math.min(row, songState.rowsPerSong - 1));
            songState.queuedRows = songState.queuedRows.map((row) => (row === null ? null : Math.min(row, songState.rowsPerSong - 1)));
            buildGridForSong(songId, songState.rowsPerSong, songState.phrasesPerRow);
        }
        persistSongState();
        renderPads();
    };

    const onSongListClick = async (event) => {
        const button = event.target.closest("button[data-role]");
        if (!button) {
            return;
        }
        const role = String(button.dataset.role || "");
        const songId = String(button.dataset.songId || "");
        if (role === "artist-song-up" || role === "artist-song-down") {
            const index = songOrder.indexOf(songId);
            if (index === -1) {
                return;
            }
            const delta = role === "artist-song-up" ? -1 : 1;
            const nextIndex = Math.max(0, Math.min(songOrder.length - 1, index + delta));
            if (nextIndex === index) {
                return;
            }
            const [item] = songOrder.splice(index, 1);
            songOrder.splice(nextIndex, 0, item);
            persistSongState();
            renderSongList();
            return;
        }
        if (role === "artist-song-queue") {
            if (!isPlaying) {
                const queuedIndex = songOrder.indexOf(songId);
                if (queuedIndex !== -1) {
                    activeSongIndex = queuedIndex;
                }
                queuedSongId = "";
                const currentSong = getActiveSong();
                if (currentSong) {
                    sendThemeForSong(currentSong);
                }
                renderSongList();
                renderPads();
                return;
            }
            queuedSongId = queuedSongId === songId ? "" : songId;
            renderSongList();
            return;
        }
        if (role === "artist-theme-swatch") {
            const swatchIndex = clampInt(button.dataset.swatchIndex, 0, 4, 0);
            const input = songListEl.querySelector(`input[data-role="artist-theme-color-input"][data-song-id="${songId}"][data-swatch-index="${swatchIndex}"]`);
            if (input instanceof HTMLInputElement) {
                input.click();
            }
            return;
        }
        if (role === "artist-track-upload") {
            const trackIndex = clampInt(button.dataset.trackIndex, 0, TRACK_COUNT - 1, 0);
            const input = songListEl.querySelector(`input[data-role="artist-track-file"][data-song-id="${songId}"][data-track-index="${trackIndex}"]`);
            if (input instanceof HTMLInputElement) {
                input.click();
            }
            return;
        }
        if (role === "artist-launcher-pad") {
            const pad = button;
            const trackIndex = clampInt(pad.dataset.launcherTrack, 0, TRACK_COUNT - 1, 0);
            const rowIndex = clampInt(pad.dataset.row, 0, 15, 0);
            const thisSong = getSongs().find((song) => song.id === songId);
            if (!thisSong) {
                return;
            }
            const songState = ensureSongState(songId);
            if (!isPlaying) {
                songState.playingRows[trackIndex] = Math.min(rowIndex, songState.rowsPerSong - 1);
                songState.queuedRows[trackIndex] = null;
            } else {
                if (songState.playingRows[trackIndex] === rowIndex) {
                    songState.queuedRows[trackIndex] = null;
                } else {
                    songState.queuedRows[trackIndex] = Math.min(rowIndex, songState.rowsPerSong - 1);
                }
            }
            persistSongState();
            renderPads();
        }
    };

    const onSongListChange = async (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement)) {
            return;
        }
        if (input.dataset.role === "artist-song-title") {
            const songId = String(input.dataset.songId || "");
            if (!songId) {
                return;
            }
            const nextTitle = String(input.value || "");
            updateSong(songId, { title: nextTitle });
            delete titleDraftBySongId[songId];
            return;
        }
        if (input.dataset.role === "artist-track-name") {
            const songId = String(input.dataset.songId || "");
            if (!songId) {
                return;
            }
            const trackIndex = clampInt(input.dataset.trackIndex, 0, TRACK_COUNT - 1, 0);
            updateTrack(songId, trackIndex, { title: input.value });
            delete trackTitleDraftBySongTrack[`${songId}:${trackIndex}`];
            return;
        }
        if (input.dataset.role === "artist-theme-color-input") {
            const songId = String(input.dataset.songId || "");
            if (!songId) {
                return;
            }
            const swatchIndex = clampInt(input.dataset.swatchIndex, 0, 4, 0);
            const songState = ensureSongState(songId);
            songState.themeColors[swatchIndex] = String(input.value || DEFAULT_THEME_COLORS[swatchIndex]);
            persistSongState();
            const activeSong = getActiveSong();
            if (activeSong?.id === songId) {
                sendThemeForSong(activeSong, { force: true });
            } else {
                updateSong(songId, { themeColors: songState.themeColors });
            }
            renderSongList();
            renderPads();
            return;
        }
        if (input.dataset.role !== "artist-track-file") {
            return;
        }
        const file = input.files && input.files[0];
        if (!file) {
            return;
        }
        const songId = String(input.dataset.songId || "");
        const trackIndex = clampInt(input.dataset.trackIndex, 0, TRACK_COUNT - 1, 0);
        setSongUploadMessage(songId, "Uploading...");
        const result = await uploadTrackFile({ songId, trackIndex, file });
        setSongUploadMessage(songId, result.ok ? "Upload saved." : (result.error || "Upload failed"), !result.ok);
    };

    const onSongListDragOver = (event) => {
        const col = event.target.closest('[data-role="artist-track-col"]');
        if (!col) {
            return;
        }
        event.preventDefault();
        col.classList.add("is-drag-over");
    };

    const onSongListDragLeave = (event) => {
        const col = event.target.closest('[data-role="artist-track-col"]');
        if (!col) {
            return;
        }
        col.classList.remove("is-drag-over");
    };

    const onSongListDrop = async (event) => {
        const col = event.target.closest('[data-role="artist-track-col"]');
        if (!col) {
            return;
        }
        event.preventDefault();
        col.classList.remove("is-drag-over");
        const file = event.dataTransfer?.files?.[0];
        if (!file) {
            return;
        }
        const songId = String(col.dataset.songId || "");
        const trackIndex = clampInt(col.dataset.trackIndex, 0, TRACK_COUNT - 1, 0);
        setSongUploadMessage(songId, "Uploading...");
        const result = await uploadTrackFile({ songId, trackIndex, file });
        setSongUploadMessage(songId, result.ok ? "Upload saved." : (result.error || "Upload failed"), !result.ok);
    };

    const onSongListFocusOut = (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement)) {
            return;
        }
        if (input.dataset.role === "artist-song-title") {
            const songId = String(input.dataset.songId || "");
            if (!songId) {
                return;
            }
            const nextTitle = String(input.value || "");
            updateSong(songId, { title: nextTitle });
            delete titleDraftBySongId[songId];
            return;
        }
        if (input.dataset.role === "artist-track-name") {
            const songId = String(input.dataset.songId || "");
            if (!songId) {
                return;
            }
            const trackIndex = clampInt(input.dataset.trackIndex, 0, TRACK_COUNT - 1, 0);
            updateTrack(songId, trackIndex, { title: input.value });
            delete trackTitleDraftBySongTrack[`${songId}:${trackIndex}`];
        }
    };

    const onPlayPause = async () => {
        const activeSong = getActiveSong();
        if (!activeSong) {
            return;
        }
        updatePlaybackStateFromBeat();
        const playbackActiveOrQueued = isPlaying || scheduledPlayBeat !== null;
        if (playbackActiveOrQueued) {
            scheduledPauseBeat = getNextDownbeatBeat();
            sendDjPerformAction({ action: "pause", atDownbeat: true });
            return;
        }
        sendThemeForSong(activeSong);
        scheduledPlayBeat = getNextDownbeatBeat();
        lastBeat = null;
        await sendPlayForSong(activeSong);
    };

    const onStop = () => {
        const activeSong = getActiveSong();
        if (!activeSong) {
            return;
        }
        resetSongPlaybackToStart(activeSong.id);
        queuedSongId = "";
        scheduledPlayBeat = null;
        scheduledPauseBeat = null;
        isPlaying = false;
        lastBeat = null;
        sendDjPerformAction({ action: "pause", atDownbeat: false });
        renderSongList();
        renderPads();
    };

    const unsubscribe = subscribeAppState((nextState) => {
        state = nextState;
        if (!state.auth.authenticated || !isArtistRole(state.auth.user?.role || "")) {
            return;
        }
        updatePlaybackStateFromBeat();
        const nextAction = state.performance?.lastAction || null;
        if (nextAction && nextAction.songId) {
            const nextSongIdx = songOrder.indexOf(nextAction.songId);
            if (nextSongIdx !== -1 && nextSongIdx !== activeSongIndex) {
                activeSongIndex = nextSongIdx;
            }
        }
        if (nextAction?.action === "theme" && nextAction?.songId) {
            const nextThemeColors = Array.isArray(nextAction.themeColors)
                ? nextAction.themeColors.map((item) => String(item || "").trim())
                : [];
            lastThemeActionSongId = String(nextAction.songId || "");
            lastThemeActionSignature = `${lastThemeActionSongId}|${nextThemeColors.join("|")}`;
        }
        if (nextAction) {
            applyPerformActionPlaybackState(nextAction);
        }
        const songSignature = (state.dj.songs || [])
            .map((song) => `${song.id}:${song.title || ""}:${(song.themeColors || []).join("|")}:${(song.tracks || []).map((track) => `${track.title}|${track.fileName}|${track.uploadedAt}`).join(",")}`)
            .join(";");
        const version = `${state.dj.songs.length}|${state.performance.updatedAt}|${state.pulse.lastDownBeatTime}|${state.pulse.connectionStatus}|${songSignature}`;
        if (version !== lastProcessedVersion) {
            lastProcessedVersion = version;
            renderSongList();
        }
    });

    const onPlayPauseClick = () => {
        void onPlayPause();
    };
    const onStopClick = () => {
        onStop();
    };
    const onSongListClickBound = (event) => {
        void onSongListClick(event);
    };
    const onSongListChangeBound = (event) => {
        void onSongListChange(event);
    };
    const onSongListDragOverBound = (event) => {
        onSongListDragOver(event);
    };
    const onSongListDragLeaveBound = (event) => {
        onSongListDragLeave(event);
    };
    const onSongListDropBound = (event) => {
        void onSongListDrop(event);
    };
    const onSongListFocusOutBound = (event) => {
        onSongListFocusOut(event);
    };
    playPauseButton.addEventListener("click", onPlayPauseClick);
    stopButton.addEventListener("click", onStopClick);
    songListEl.addEventListener("input", onSongListInput);
    songListEl.addEventListener("click", onSongListClickBound);
    songListEl.addEventListener("change", onSongListChangeBound);
    songListEl.addEventListener("dragover", onSongListDragOverBound);
    songListEl.addEventListener("dragleave", onSongListDragLeaveBound);
    songListEl.addEventListener("drop", onSongListDropBound);
    songListEl.addEventListener("focusout", onSongListFocusOutBound);

    ensurePulseTransportConnected();
    void loadPerformanceState();
    void ensureThreeSongs().then(() => {
        state = getAppState();
        renderSongList();
    });
    beatTimer = window.setInterval(() => {
        void processBeat();
    }, 120);

    return () => {
        unsubscribe();
        if (beatTimer) {
            window.clearInterval(beatTimer);
        }
        playPauseButton.removeEventListener("click", onPlayPauseClick);
        stopButton.removeEventListener("click", onStopClick);
        songListEl.removeEventListener("input", onSongListInput);
        songListEl.removeEventListener("click", onSongListClickBound);
        songListEl.removeEventListener("change", onSongListChangeBound);
        songListEl.removeEventListener("dragover", onSongListDragOverBound);
        songListEl.removeEventListener("dragleave", onSongListDragLeaveBound);
        songListEl.removeEventListener("drop", onSongListDropBound);
        songListEl.removeEventListener("focusout", onSongListFocusOutBound);
    };
};
