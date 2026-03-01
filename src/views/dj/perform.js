/* DJ perform module: beat-quantized playback with shared clock scheduling. */

import {
    djSetTempo,
    ensureDjLibraryLoaded,
    ensurePulseTransportConnected,
    loadPerformanceState,
    getAppState,
    sendDjPerformAction,
    setActiveSong,
    subscribeAppState,
} from "../../state.js";
import { getAbsoluteBeatNow, getBeatInBar, getBeatWindowMs, getMsUntilNextDownbeat } from "../../components/clock/beat-time.js";
import { createMultiTrackBufferPlayer } from "../../components/audio/multi-track-buffer-player.js";
import { createPerformEventScheduler } from "../../components/audio/perform-event-scheduler.js";
import { debugLog, debugWarn } from "../../components/util/debug.js";
import { createApiClient } from "../../components/util/api-client.js";
import { mountTempoControl } from "../../components/ui/tempo-control.js";

const TRACK_COUNT = 8;
const ROW_COUNT = 8;
const BARS_PER_STEP = 4;
const apiClient = createApiClient();
const getNextDownbeatAbsoluteBeat = (pulseState) => {
    const beatsPerBar = Math.max(1, Math.trunc(Number(pulseState.numBarBeats) || 4));
    const nowBeat = getAbsoluteBeatNow(pulseState);
    const beatInBarZero = ((nowBeat % beatsPerBar) + beatsPerBar) % beatsPerBar;
    const beatsToNextDownbeat = beatInBarZero === 0 ? beatsPerBar : (beatsPerBar - beatInBarZero);
    return nowBeat + beatsToNextDownbeat;
};

const buildGridHtml = () => {
    const cells = [];
    for (let row = 0; row < ROW_COUNT; row += 1) {
        for (let track = 0; track < TRACK_COUNT; track += 1) {
            cells.push(
                `<button type="button" class="ui-perform-cell" data-role="perform-cell" data-row="${row}" data-track="${track}"></button>`,
            );
        }
    }
    return cells.join("");
};

const getSegmentStartSeconds = (rowIndex, pulseState) => {
    const beatWindowMs = getBeatWindowMs(pulseState.tickLength);
    const barDurationSeconds = (beatWindowMs * Math.max(1, Number(pulseState.numBarBeats) || 4)) / 1000;
    return Math.max(0, rowIndex * BARS_PER_STEP * barDurationSeconds);
};

export const mount = ({ mountNode }) => {
    const statusEl = mountNode.querySelector(".ui-status");
    const beatEl = mountNode.querySelector(".ui-beat-display");
    const songSelectEl = mountNode.querySelector("[data-role=\"perform-song-select\"]");
    const playToggleButton = mountNode.querySelector("[data-role=\"perform-play-toggle\"]");
    const gridEl = mountNode.querySelector("[data-role=\"perform-grid\"]");
    const labelsEl = mountNode.querySelector("[data-role=\"perform-track-labels\"]");
    const modeEl = mountNode.querySelector("[data-role=\"perform-mode\"]");
    const bpmInput = mountNode.querySelector("[data-role=\"perform-bpm\"]");
    const applyBpmButton = mountNode.querySelector("[data-role=\"perform-set-bpm\"]");

    if (!statusEl || !beatEl || !songSelectEl || !playToggleButton || !gridEl || !labelsEl || !modeEl || !bpmInput || !applyBpmButton) {
        return () => {};
    }

    let latestState = getAppState();
    let rafId = 0;
    let isPlaying = false;
    let firstPlayPending = true;
    let queuedTimerId = 0;
    let performancePollTimer = 0;
    let blinkFrame = false;
    let lastAbsoluteBeat = null;
    let practiceAnchorMs = performance.now();
    let cleanupTempoControl = () => {};
    const selectedRows = Array.from({ length: TRACK_COUNT }, () => 0);
    const armedRows = Array.from({ length: TRACK_COUNT }, () => null);
    const activeRows = Array.from({ length: TRACK_COUNT }, () => null);
    const activeUntilBeat = Array.from({ length: TRACK_COUNT }, () => -1);
    const loggedBufferWaitEvents = new Set();
    const bufferPlayer = createMultiTrackBufferPlayer({ trackCount: TRACK_COUNT });
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
                const rows = Array.isArray(event.selectedRows) ? event.selectedRows : [];
                const offsets = Array.from({ length: TRACK_COUNT }, (_, index) => {
                    const row = Math.max(0, Math.trunc(Number(rows[index] || 0)));
                    return row * BARS_PER_STEP * barDurationSec + elapsedSec;
                });
                debugLog("dj-audio", "scheduling play event", {
                    eventId: event.eventId,
                    whenSec: Number(whenSec).toFixed(3),
                });
                return bufferPlayer.schedulePlay(whenSec, offsets);
            }
            if (event.action === "jump") {
                const trackIndex = Math.max(0, Math.trunc(Number(event.trackIndex || 0)));
                const row = Math.max(0, Math.trunc(Number(event.rowIndex || 0)));
                const offset = row * BARS_PER_STEP * barDurationSec + elapsedSec;
                if (!bufferPlayer.hasTrackBuffer(trackIndex)) {
                    if (!loggedBufferWaitEvents.has(event.eventId)) {
                        loggedBufferWaitEvents.add(event.eventId);
                        debugWarn("dj-audio", "waiting for track buffer before jump event", {
                            eventId: event.eventId,
                            trackIndex,
                            absoluteBeat: event.absoluteBeat,
                        });
                    }
                    return true;
                }
                debugLog("dj-audio", "scheduling jump event", {
                    eventId: event.eventId,
                    trackIndex,
                    whenSec: Number(whenSec).toFixed(3),
                    offsetSec: Number(offset).toFixed(3),
                });
                return bufferPlayer.scheduleJump(trackIndex, whenSec, offset);
            }
            return true;
        },
    });

    gridEl.innerHTML = buildGridHtml();

    const updateSelectedCellClasses = () => {
        const cells = gridEl.querySelectorAll("[data-role=\"perform-cell\"]");
        for (const cell of cells) {
            const row = Number(cell.dataset.row);
            const track = Number(cell.dataset.track);
            const isArmed = armedRows[track] === row;
            const isActive = activeRows[track] === row;
            cell.classList.toggle("ui-button--active", isActive);
            cell.classList.toggle("ui-perform-cell--armed", isArmed);
            cell.classList.toggle("ui-perform-cell--armed-blink", isArmed && blinkFrame);
        }
    };

    const isLiveDj = () => {
        const userId = latestState.auth.user?.id || "";
        return latestState.performance.active && latestState.performance.liveDjUserId === userId;
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

    const getPracticeDelayMs = () => {
        const bpm = Math.max(60, Math.min(220, Number(latestState.performance.bpm || 120)));
        const barMs = (60000 / bpm) * 4;
        const elapsed = performance.now() - practiceAnchorMs;
        const remainder = ((elapsed % barMs) + barMs) % barMs;
        return Math.max(0, barMs - remainder);
    };

    const getActiveSong = () => {
        const { activeSongId, songs } = latestState.dj;
        return songs.find((song) => song.id === activeSongId) || songs[0] || null;
    };

    const syncTrackSources = () => {
        const song = getActiveSong();
        if (!song) {
            return;
        }

        for (let trackIndex = 0; trackIndex < TRACK_COUNT; trackIndex += 1) {
            const track = song.tracks[trackIndex];
            const hasUploadedTrack = Boolean(track?.sourceUrl);
            const sourceUrl = hasUploadedTrack
                ? `${apiClient.baseUrl}/pulse/songs/${encodeURIComponent(song.id)}/tracks/${trackIndex}/content`
                : "";
            void bufferPlayer.setTrackSource(trackIndex, sourceUrl);
        }
    };

    const playAllFromSelectedRowsPractice = async () => {
        await bufferPlayer.unlock();
        const whenSec = Number(bufferPlayer.getAudioCurrentTime()) + 0.02;
        const offsets = Array.from({ length: TRACK_COUNT }, (_, trackIndex) => (
            getSegmentStartSeconds(selectedRows[trackIndex], latestState.pulse)
        ));
        bufferPlayer.schedulePlay(whenSec, offsets);
        const downbeat = getAbsoluteBeatNow(latestState.pulse);
        for (let trackIndex = 0; trackIndex < TRACK_COUNT; trackIndex += 1) {
            armedRows[trackIndex] = null;
            activeRows[trackIndex] = selectedRows[trackIndex];
            activeUntilBeat[trackIndex] = downbeat + (4 * Math.max(1, Number(latestState.pulse.numBarBeats) || 4));
        }
        updateSelectedCellClasses();
        isPlaying = true;
        playToggleButton.textContent = "Pause";
    };

    const scheduleAtNextDownbeat = (callback) => {
        if (queuedTimerId) {
            window.clearTimeout(queuedTimerId);
            queuedTimerId = 0;
        }
        const delayMs = isLiveDj() ? getMsUntilNextDownbeat(latestState.pulse) : getPracticeDelayMs();
        queuedTimerId = window.setTimeout(() => {
            queuedTimerId = 0;
            callback();
        }, delayMs);
    };

    const handlePlayPause = () => {
        const live = isLiveDj();
        if (!isPlaying) {
            if (firstPlayPending) {
                for (let i = 0; i < TRACK_COUNT; i += 1) {
                    selectedRows[i] = 0;
                }
                firstPlayPending = false;
            }
            updateSelectedCellClasses();
            playToggleButton.textContent = "Queued...";
            if (live) {
                void bufferPlayer.unlock();
                isPlaying = true;
                sendDjPerformAction({
                    action: "play",
                    songId: getActiveSong()?.id || "",
                    selectedRows,
                    absoluteBeat: getNextDownbeatAbsoluteBeat(latestState.pulse),
                    atDownbeat: true,
                });
                debugLog("dj-audio", "sent play action", {
                    absoluteBeat: getNextDownbeatAbsoluteBeat(latestState.pulse),
                });
                playToggleButton.textContent = "Pause";
            } else {
                scheduleAtNextDownbeat(() => {
                    void playAllFromSelectedRowsPractice();
                });
            }
            return;
        }

        if (queuedTimerId) {
            window.clearTimeout(queuedTimerId);
            queuedTimerId = 0;
        }
        isPlaying = false;
        playToggleButton.textContent = "Play";
        if (live) {
            sendDjPerformAction({
                action: "pause",
                songId: getActiveSong()?.id || "",
                absoluteBeat: getNextDownbeatAbsoluteBeat(latestState.pulse),
                atDownbeat: true,
            });
            debugLog("dj-audio", "sent pause action", {
                absoluteBeat: getNextDownbeatAbsoluteBeat(latestState.pulse),
            });
        } else {
            bufferPlayer.schedulePause(Number(bufferPlayer.getAudioCurrentTime()) + 0.01);
        }
    };

    const renderConnection = () => {
        const { connectionStatus } = latestState.pulse;
        const isConnected = connectionStatus === "connected";
        statusEl.classList.toggle("ui-status--connected", isConnected);
        statusEl.classList.toggle("ui-status--not-connected", !isConnected);
        statusEl.textContent = connectionStatus;
    };

    const renderBeat = () => {
        if (isLiveDj()) {
            const nowTime = performance.now() + Number(latestState.pulse.clockOffset || 0);
            const beatWindowMs = getBeatWindowMs(latestState.pulse.tickLength);
            const eighthWindow = Math.max(1, beatWindowMs / 2);
            blinkFrame = Math.floor(nowTime / eighthWindow) % 2 === 0;
        } else {
            const bpm = Math.max(60, Math.min(220, Number(latestState.performance.bpm || 120)));
            const eighthWindow = (60000 / bpm) / 2;
            blinkFrame = Math.floor((performance.now() - practiceAnchorMs) / Math.max(1, eighthWindow)) % 2 === 0;
        }
        const nowBeat = getAbsoluteBeatNow(latestState.pulse);
        if (nowBeat !== lastAbsoluteBeat) {
            const beatInBar = getBeatInBar(latestState.pulse);
            beatEl.classList.remove("ui-beat-display--pulse");
            void beatEl.offsetWidth;
            beatEl.classList.add("ui-beat-display--pulse");
            beatEl.classList.toggle("ui-beat-display--downbeat", beatInBar === 1);
            lastAbsoluteBeat = nowBeat;
        }
        for (let trackIndex = 0; trackIndex < TRACK_COUNT; trackIndex += 1) {
            if (activeUntilBeat[trackIndex] >= 0 && nowBeat > activeUntilBeat[trackIndex]) {
                activeRows[trackIndex] = null;
                activeUntilBeat[trackIndex] = -1;
            }
        }
        updateSelectedCellClasses();
        beatEl.textContent = String(getBeatInBar(latestState.pulse));
        rafId = window.requestAnimationFrame(renderBeat);
    };

    const renderMode = () => {
        if (isLiveDj()) {
            modeEl.textContent = "LIVE";
            mountNode.classList.add("ui-live-performer");
            playToggleButton.textContent = isPlaying ? "Pause" : "Play";
        } else {
            modeEl.textContent = "practice";
            mountNode.classList.remove("ui-live-performer");
            playToggleButton.textContent = isPlaying ? "Pause" : "Play";
            if (!isPlaying) {
                practiceAnchorMs = performance.now();
            }
        }
        tempoControl.sync();
    };

    const renderSongSelect = () => {
        const { songs, activeSongId } = latestState.dj;
        songSelectEl.innerHTML = songs.map((song) => (
            `<option value="${song.id}" ${song.id === activeSongId ? "selected" : ""}>${song.title}</option>`
        )).join("");
    };

    const renderTrackLabels = () => {
        const song = getActiveSong();
        labelsEl.innerHTML = Array.from({ length: TRACK_COUNT }, (_, index) => {
            const label = song?.tracks[index]?.title || `Track ${index + 1}`;
            return `<span class="ui-label">${label}</span>`;
        }).join("");
    };

    const onSongChange = () => {
        setActiveSong(songSelectEl.value);
    };

    const onGridClick = (event) => {
        const button = event.target.closest("[data-role=\"perform-cell\"]");
        if (!button) {
            return;
        }
        const row = Number(button.dataset.row);
        const track = Number(button.dataset.track);
        selectedRows[track] = row;
        armedRows[track] = row;
        activeRows[track] = null;
        activeUntilBeat[track] = -1;
        updateSelectedCellClasses();

        if (isPlaying) {
            if (isLiveDj()) {
                void bufferPlayer.unlock();
                sendDjPerformAction({
                    action: "jump",
                    songId: getActiveSong()?.id || "",
                    trackIndex: track,
                    rowIndex: row,
                    absoluteBeat: getNextDownbeatAbsoluteBeat(latestState.pulse),
                    atDownbeat: true,
                });
                debugLog("dj-audio", "sent jump action", {
                    trackIndex: track,
                    rowIndex: row,
                    absoluteBeat: getNextDownbeatAbsoluteBeat(latestState.pulse),
                });
                return;
            }
            scheduleAtNextDownbeat(() => {
                const whenSec = Number(bufferPlayer.getAudioCurrentTime()) + 0.02;
                bufferPlayer.scheduleJump(track, whenSec, getSegmentStartSeconds(row, latestState.pulse));
                const downbeat = getAbsoluteBeatNow(latestState.pulse);
                armedRows[track] = null;
                activeRows[track] = row;
                activeUntilBeat[track] = downbeat + (4 * Math.max(1, Number(latestState.pulse.numBarBeats) || 4));
                updateSelectedCellClasses();
            });
        }
    };

    let lastLiveActionId = -1;
    const unsubscribe = subscribeAppState((nextState) => {
        latestState = nextState;
        renderConnection();
        renderSongSelect();
        renderTrackLabels();
        syncTrackSources();
        renderMode();
        const liveAction = nextState.performance.lastAction;
        if (isLiveDj() && liveAction && Number.isFinite(liveAction.eventId) && liveAction.eventId !== lastLiveActionId) {
            lastLiveActionId = liveAction.eventId;
            eventScheduler.enqueue(liveAction);
            debugLog("dj-audio", "received live perform action", {
                eventId: liveAction.eventId,
                action: liveAction.action,
                absoluteBeat: liveAction.absoluteBeat,
            });
            if (liveAction.action === "play") {
                const rows = Array.isArray(liveAction.selectedRows) ? liveAction.selectedRows : [];
                for (let trackIndex = 0; trackIndex < TRACK_COUNT; trackIndex += 1) {
                    selectedRows[trackIndex] = Math.max(0, Math.trunc(Number(rows[trackIndex] || 0)));
                    armedRows[trackIndex] = null;
                    activeRows[trackIndex] = selectedRows[trackIndex];
                    activeUntilBeat[trackIndex] = getAbsoluteBeatNow(latestState.pulse) + (4 * Math.max(1, Number(latestState.pulse.numBarBeats) || 4));
                }
                isPlaying = true;
                playToggleButton.textContent = "Pause";
                updateSelectedCellClasses();
            } else if (liveAction.action === "jump") {
                const track = Math.max(0, Math.trunc(Number(liveAction.trackIndex || 0)));
                const row = Math.max(0, Math.trunc(Number(liveAction.rowIndex || 0)));
                selectedRows[track] = row;
                armedRows[track] = null;
                activeRows[track] = row;
                activeUntilBeat[track] = getAbsoluteBeatNow(latestState.pulse) + (4 * Math.max(1, Number(latestState.pulse.numBarBeats) || 4));
                updateSelectedCellClasses();
            } else if (liveAction.action === "pause") {
                isPlaying = false;
                playToggleButton.textContent = "Play";
            }
        }
    });

    songSelectEl.addEventListener("change", onSongChange);
    playToggleButton.addEventListener("click", handlePlayPause);
    gridEl.addEventListener("click", onGridClick);
    eventScheduler.start();

    ensurePulseTransportConnected();
    void ensureDjLibraryLoaded();
    void loadPerformanceState();
    performancePollTimer = window.setInterval(() => {
        void loadPerformanceState();
    }, 2000);
    renderConnection();
    renderSongSelect();
    renderTrackLabels();
    syncTrackSources();
    updateSelectedCellClasses();
    renderMode();
    renderBeat();

    return () => {
        if (queuedTimerId) {
            window.clearTimeout(queuedTimerId);
        }
        if (performancePollTimer) {
            window.clearInterval(performancePollTimer);
        }
        eventScheduler.destroy();
        bufferPlayer.destroy();
        cleanupTempoControl();
        window.cancelAnimationFrame(rafId);
        unsubscribe();
        songSelectEl.removeEventListener("change", onSongChange);
        playToggleButton.removeEventListener("click", handlePlayPause);
        gridEl.removeEventListener("click", onGridClick);
    };
};
