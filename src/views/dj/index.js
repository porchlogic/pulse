/* DJ library route entry */

import {
    addSong,
    deleteTrackFile,
    ensureDjLibraryLoaded,
    ensurePulseTransportConnected,
    getAppState,
    djSetTempo,
    loadPerformanceState,
    logout,
    subscribeAppState,
    uploadTrackFile,
    updateSong,
    updateTrack,
} from "../../state.js";
import { mountBeatDisplay } from "../../components/clock/beat-display.js";
import { mountTempoControl } from "../../components/ui/tempo-control.js";

const TRACK_COUNT = 8;

const buildTrackSlotHtml = (songId, track) => `
    <div class="ui-track-slot">
        <div class="ui-dropzone" data-role="track-dropzone" data-song-id="${songId}" data-track-index="${track.index}">
            ${track.fileName || "Drop audio file or click Select"}
        </div>
        <div class="ui-row-between">
            <button type="button" class="ui-button ui-button--small" data-role="track-select" data-song-id="${songId}" data-track-index="${track.index}">Select</button>
            <button type="button" class="ui-button ui-button--small" data-role="track-delete" data-song-id="${songId}" data-track-index="${track.index}">Delete</button>
        </div>
        <input class="ui-input" style="display:none" type="file" accept=".wav,.wave,.mp3,audio/wav,audio/mpeg"
            data-role="track-file" data-song-id="${songId}" data-track-index="${track.index}">
        <input class="ui-input ui-input--plain ui-track-title" type="text" placeholder="Track ${track.index + 1} title"
            value="${track.title}" data-role="track-title" data-song-id="${songId}" data-track-index="${track.index}">
    </div>
`;

const buildSongHtml = (song) => `
    <article class="ui-song ui-stack" data-song-id="${song.id}">
        <div class="ui-song-header">
            <input class="ui-input ui-input--plain ui-song-title" type="text" value="${song.title}" data-role="song-title" data-song-id="${song.id}">
            <div class="ui-song-permissions">
                <button type="button" class="ui-button ui-button--small ${song.mode === "performance" ? "ui-button--active" : ""}"
                    data-role="song-mode" data-mode="performance" data-song-id="${song.id}">performance</button>
                <button type="button" class="ui-button ui-button--small ${song.mode === "radio" ? "ui-button--active" : ""}"
                    data-role="song-mode" data-mode="radio" data-song-id="${song.id}">radio</button>
            </div>
        </div>
        <div class="ui-song-tracks">
            ${song.tracks.slice(0, TRACK_COUNT).map((track) => buildTrackSlotHtml(song.id, track)).join("")}
        </div>
    </article>
`;

export const mount = ({ mountNode, navigate }) => {
    const statusEl = mountNode.querySelector(".ui-status");
    const beatEl = mountNode.querySelector(".ui-beat-display");
    const songListEl = mountNode.querySelector("[data-role=\"song-list\"]");
    const addSongButton = mountNode.querySelector("[data-role=\"add-song\"]");
    const identityEl = mountNode.querySelector("[data-role=\"dj-identity\"]");
    const logoutButton = mountNode.querySelector("[data-role=\"dj-logout\"]");
    const performButton = mountNode.querySelector("[data-nav=\"perform\"]");
    const bpmInput = mountNode.querySelector("[data-role=\"dj-bpm\"]");
    const applyBpmButton = mountNode.querySelector("[data-role=\"dj-set-bpm\"]");

    if (!statusEl || !beatEl || !songListEl || !addSongButton || !identityEl || !logoutButton || !performButton || !bpmInput || !applyBpmButton) {
        return () => {};
    }

    let cleanupBeatDisplay = () => {};
    let performancePollTimer = 0;
    let latestState = getAppState();
    let lastSongsRef = latestState.dj.songs;
    let cleanupTempoControl = () => {};

    const renderConnection = () => {
        const { connectionStatus } = latestState.pulse;
        const isConnected = connectionStatus === "connected";
        statusEl.classList.toggle("ui-status--connected", isConnected);
        statusEl.classList.toggle("ui-status--not-connected", !isConnected);
        statusEl.textContent = connectionStatus;
    };

    const renderSongs = () => {
        const activeElement = document.activeElement;
        const activeRole = activeElement instanceof HTMLInputElement ? activeElement.dataset.role : "";
        const activeSongId = activeElement instanceof HTMLInputElement ? activeElement.dataset.songId : "";
        const activeTrackIndex = activeElement instanceof HTMLInputElement ? activeElement.dataset.trackIndex : "";

        songListEl.innerHTML = latestState.dj.songs.map((song) => buildSongHtml(song)).join("");

        if (activeRole === "song-title" || activeRole === "track-title") {
            const selector = activeRole === "song-title"
                ? `input[data-role="song-title"][data-song-id="${activeSongId}"]`
                : `input[data-role="track-title"][data-song-id="${activeSongId}"][data-track-index="${activeTrackIndex}"]`;
            const nextInput = songListEl.querySelector(selector);
            if (nextInput instanceof HTMLInputElement) {
                nextInput.focus();
                nextInput.select();
            }
        }
    };

    const renderIdentity = () => {
        const email = latestState.auth.user?.email || "unknown";
        identityEl.textContent = `logged in as: ${email}`;
        const isLive = latestState.performance.active && latestState.performance.liveDjUserId === latestState.auth.user?.id;
        performButton.textContent = isLive ? "perform" : "practice";
        tempoControl.sync();
    };

    const applyTrackFile = async (songId, trackIndex, file) => {
        if (!file) {
            return;
        }
        await uploadTrackFile({ songId, trackIndex, file });
    };

    const onSongListChange = (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) {
            return;
        }
        if (target.dataset.role === "song-title") {
            updateSong(target.dataset.songId, { title: target.value || "Untitled Song" });
            return;
        }
        if (target.dataset.role === "track-title") {
            updateTrack(target.dataset.songId, Number(target.dataset.trackIndex), {
                title: target.value || "",
            });
            return;
        }
        if (target.dataset.role === "track-file") {
            const file = target.files && target.files[0];
            void applyTrackFile(target.dataset.songId, Number(target.dataset.trackIndex), file);
        }
    };

    const onSongListClick = (event) => {
        const selectButton = event.target.closest("button[data-role=\"track-select\"]");
        if (selectButton) {
            const fileInput = songListEl.querySelector(
                `input[data-role="track-file"][data-song-id="${selectButton.dataset.songId}"][data-track-index="${selectButton.dataset.trackIndex}"]`,
            );
            if (fileInput instanceof HTMLInputElement) {
                fileInput.click();
            }
            return;
        }

        const deleteButton = event.target.closest("button[data-role=\"track-delete\"]");
        if (deleteButton) {
            void deleteTrackFile({
                songId: deleteButton.dataset.songId,
                trackIndex: Number(deleteButton.dataset.trackIndex),
            });
            return;
        }

        const button = event.target.closest("button[data-role=\"song-mode\"]");
        if (!button) {
            return;
        }
        updateSong(button.dataset.songId, { mode: button.dataset.mode || "performance" });
    };

    const onSongListFocusIn = (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) {
            return;
        }
        if (target.dataset.role === "song-title" || target.dataset.role === "track-title") {
            target.select();
        }
    };

    const onSongListMouseDown = (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) {
            return;
        }
        if (target.dataset.role !== "song-title" && target.dataset.role !== "track-title") {
            return;
        }
        event.preventDefault();
        target.focus();
        target.select();
    };

    const onSongListDragOver = (event) => {
        const dropzone = event.target.closest("[data-role=\"track-dropzone\"]");
        if (!dropzone) {
            return;
        }
        event.preventDefault();
    };

    const onSongListDrop = (event) => {
        const dropzone = event.target.closest("[data-role=\"track-dropzone\"]");
        if (!dropzone) {
            return;
        }
        event.preventDefault();
        const files = event.dataTransfer?.files;
        const file = files && files[0];
        void applyTrackFile(dropzone.dataset.songId, Number(dropzone.dataset.trackIndex), file);
    };

    const onAddSong = () => {
        addSong();
    };

    const onLogout = async () => {
        await logout();
        navigate("login");
    };

    const tempoControl = mountTempoControl({
        inputEl: bpmInput,
        applyButton: applyBpmButton,
        getCurrentBpm: () => Number(latestState.performance.bpm || 120),
        canEdit: () => (latestState.auth.authenticated === true && latestState.auth.user?.role === "dj"),
        onApply: async (bpm) => {
            await djSetTempo(bpm);
        },
    });
    cleanupTempoControl = tempoControl.destroy;

    const unsubscribe = subscribeAppState((nextState) => {
        latestState = nextState;
        renderConnection();
        renderIdentity();
        if (nextState.dj.songs !== lastSongsRef) {
            lastSongsRef = nextState.dj.songs;
            renderSongs();
        }
    });

    songListEl.addEventListener("change", onSongListChange);
    songListEl.addEventListener("click", onSongListClick);
    songListEl.addEventListener("focusin", onSongListFocusIn);
    songListEl.addEventListener("mousedown", onSongListMouseDown);
    songListEl.addEventListener("dragover", onSongListDragOver);
    songListEl.addEventListener("drop", onSongListDrop);
    addSongButton.addEventListener("click", onAddSong);
    logoutButton.addEventListener("click", onLogout);

    ensurePulseTransportConnected();
    void loadPerformanceState();
    performancePollTimer = window.setInterval(() => {
        void loadPerformanceState();
    }, 2000);
    void ensureDjLibraryLoaded();
    renderConnection();
    renderIdentity();
    renderSongs();
    cleanupBeatDisplay = mountBeatDisplay({
        beatEl,
        getPulseState: () => latestState.pulse,
    });

    return () => {
        cleanupBeatDisplay();
        if (performancePollTimer) {
            window.clearInterval(performancePollTimer);
        }
        cleanupTempoControl();
        unsubscribe();
        songListEl.removeEventListener("change", onSongListChange);
        songListEl.removeEventListener("click", onSongListClick);
        songListEl.removeEventListener("focusin", onSongListFocusIn);
        songListEl.removeEventListener("mousedown", onSongListMouseDown);
        songListEl.removeEventListener("dragover", onSongListDragOver);
        songListEl.removeEventListener("drop", onSongListDrop);
        addSongButton.removeEventListener("click", onAddSong);
        logoutButton.removeEventListener("click", onLogout);
    };
};
