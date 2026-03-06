/* DJ perform module: beat-quantized playback with shared clock scheduling. */

import {
    djSetBarsPerRow,
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
import { getEstimatedServerNow } from "../../components/clock/sync-clock.js";
import { createMultiTrackBufferPlayer } from "../../components/audio/multi-track-buffer-player.js";
import { createPerformEventScheduler } from "../../components/audio/perform-event-scheduler.js";
import { debugLog, debugWarn } from "../../components/util/debug.js";
import { createApiClient } from "../../components/util/api-client.js";
import { mountTempoControl } from "../../components/ui/tempo-control.js";
import { mountBarsPerRowControl } from "../../components/ui/bars-per-row-control.js";

const TRACK_COUNT = 8;
const ROW_COUNT = 8;
const apiClient = createApiClient();
const isArtistRole = (role) => role === "artist" || role === "dj";
const clampBarsPerRow = (value) => {
    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed)) {
        return 4;
    }
    return Math.max(1, Math.min(16, parsed));
};

const resolveBarsPerRow = (performanceState, action = null) => (
    clampBarsPerRow(action?.barsPerRow || performanceState?.barsPerRow || 4)
);
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

const getSegmentStartSeconds = (rowIndex, pulseState, barsPerRow) => {
    const beatWindowMs = getBeatWindowMs(pulseState.tickLength);
    const barDurationSeconds = (beatWindowMs * Math.max(1, Number(pulseState.numBarBeats) || 4)) / 1000;
    return Math.max(0, rowIndex * barsPerRow * barDurationSeconds);
};

const getBarDurationSeconds = (pulseState) => {
    const beatWindowMs = getBeatWindowMs(pulseState.tickLength);
    return (beatWindowMs * Math.max(1, Number(pulseState.numBarBeats) || 4)) / 1000;
};

const getSegmentDurationSeconds = (pulseState, barsPerRow) => getBarDurationSeconds(pulseState) * barsPerRow;

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
    const barsPerRowInput = mountNode.querySelector("[data-role=\"perform-bars-per-row\"]");
    const applyBarsPerRowButton = mountNode.querySelector("[data-role=\"perform-set-bars-per-row\"]");

    if (!statusEl || !beatEl || !songSelectEl || !playToggleButton || !gridEl || !labelsEl || !modeEl || !bpmInput || !applyBpmButton || !barsPerRowInput || !applyBarsPerRowButton) {
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
    let cleanupBarsPerRowControl = () => {};
    let lastLatencyCompensationSec = Number(latestState.pulse.speakerLatencyCompensationSeconds) || 0;
    const selectedRows = Array.from({ length: TRACK_COUNT }, () => 0);
    const armedRows = Array.from({ length: TRACK_COUNT }, () => null);
    const activeRows = Array.from({ length: TRACK_COUNT }, () => null);
    const trackPlaybackStartWhenSec = Array.from({ length: TRACK_COUNT }, () => NaN);
    const trackPlaybackStartOffsetSec = Array.from({ length: TRACK_COUNT }, () => NaN);
    const trackPlaybackAnchorBeat = Array.from({ length: TRACK_COUNT }, () => NaN);
    const trackPlaybackAnchorRow = Array.from({ length: TRACK_COUNT }, () => 0);
    let scheduledPauseAudioSec = NaN;
    const loggedBufferWaitEvents = new Set();
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
            const barsPerRow = getBarsPerRow(event);
            if (event.action === "pause") {
                bufferPlayer.schedulePause(whenSec);
                scheduledPauseAudioSec = Number(whenSec);
                return true;
            }
            if (event.action === "play") {
                const rows = Array.isArray(event.selectedRows) ? event.selectedRows : [];
                const offsets = Array.from({ length: TRACK_COUNT }, (_, index) => {
                    const row = Math.max(0, Math.trunc(Number(rows[index] || 0)));
                    return row * barsPerRow * barDurationSec;
                });
                debugLog("dj-audio", "scheduling play event", {
                    eventId: event.eventId,
                    whenSec: Number(whenSec).toFixed(3),
                });
                const started = bufferPlayer.schedulePlay(whenSec, offsets);
                if (started) {
                    setAllTrackPlaybackStarts(whenSec, offsets);
                    setAllTrackPlaybackAnchors(rows, event.absoluteBeat);
                    scheduledPauseAudioSec = NaN;
                }
                return started;
            }
            if (event.action === "jump") {
                const trackIndex = Math.max(0, Math.trunc(Number(event.trackIndex || 0)));
                const row = Math.max(0, Math.trunc(Number(event.rowIndex || 0)));
                const offset = row * barsPerRow * barDurationSec + elapsedSec;
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
                const started = bufferPlayer.scheduleJump(trackIndex, whenSec, offset);
                if (started) {
                    setTrackPlaybackStart(trackIndex, whenSec, offset);
                    setTrackPlaybackAnchor(trackIndex, row, event.absoluteBeat);
                    scheduledPauseAudioSec = NaN;
                }
                return started;
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
    const getBarsPerRow = (action = null) => resolveBarsPerRow(latestState.performance, action);

    const tempoControl = mountTempoControl({
        inputEl: bpmInput,
        applyButton: applyBpmButton,
        getCurrentBpm: () => Number(latestState.performance.bpm || 120),
        isServerValueReady: () => Boolean(latestState.performance.updatedAt),
        canEdit: () => (latestState.auth.authenticated === true && isArtistRole(latestState.auth.user?.role || "")),
        onApply: async (bpm) => {
            await djSetTempo(bpm);
        },
    });
    cleanupTempoControl = tempoControl.destroy;

    const barsPerRowControl = mountBarsPerRowControl({
        inputEl: barsPerRowInput,
        applyButton: applyBarsPerRowButton,
        getCurrentBarsPerRow: () => getBarsPerRow(),
        isServerValueReady: () => Boolean(latestState.performance.updatedAt),
        canEdit: () => (latestState.auth.authenticated === true && isArtistRole(latestState.auth.user?.role || "")),
        onApply: async (barsPerRow) => {
            await djSetBarsPerRow(barsPerRow);
        },
    });
    cleanupBarsPerRowControl = barsPerRowControl.destroy;

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

    const setTrackPlaybackStart = (trackIndex, whenSec, offsetSec) => {
        trackPlaybackStartWhenSec[trackIndex] = Number(whenSec);
        trackPlaybackStartOffsetSec[trackIndex] = Math.max(0, Number(offsetSec) || 0);
    };

    const setTrackPlaybackAnchor = (trackIndex, rowIndex, absoluteBeat) => {
        const normalizedTrack = Math.max(0, Math.min(TRACK_COUNT - 1, Math.trunc(Number(trackIndex) || 0)));
        const normalizedRow = ((Math.trunc(Number(rowIndex) || 0) % ROW_COUNT) + ROW_COUNT) % ROW_COUNT;
        const normalizedBeat = Math.trunc(Number(absoluteBeat));
        if (!Number.isFinite(normalizedBeat)) {
            return;
        }
        trackPlaybackAnchorBeat[normalizedTrack] = normalizedBeat;
        trackPlaybackAnchorRow[normalizedTrack] = normalizedRow;
    };

    const setAllTrackPlaybackAnchors = (rows, absoluteBeat) => {
        for (let trackIndex = 0; trackIndex < TRACK_COUNT; trackIndex += 1) {
            const row = Math.max(0, Math.trunc(Number(rows[trackIndex] || 0)));
            setTrackPlaybackAnchor(trackIndex, row, absoluteBeat);
        }
    };

    const setAllTrackPlaybackStarts = (whenSec, offsetsByTrack) => {
        for (let trackIndex = 0; trackIndex < TRACK_COUNT; trackIndex += 1) {
            setTrackPlaybackStart(trackIndex, whenSec, Number(offsetsByTrack[trackIndex] || 0));
        }
    };

    const clearAllTrackPlaybackStarts = () => {
        for (let trackIndex = 0; trackIndex < TRACK_COUNT; trackIndex += 1) {
            trackPlaybackStartWhenSec[trackIndex] = NaN;
            trackPlaybackStartOffsetSec[trackIndex] = NaN;
            trackPlaybackAnchorBeat[trackIndex] = NaN;
            trackPlaybackAnchorRow[trackIndex] = 0;
            activeRows[trackIndex] = null;
        }
    };

    const syncActiveRowsFromPlayback = () => {
        const audioNow = Number(bufferPlayer.getAudioCurrentTime());

        if (Number.isFinite(audioNow) && Number.isFinite(scheduledPauseAudioSec) && audioNow >= scheduledPauseAudioSec) {
            scheduledPauseAudioSec = NaN;
            clearAllTrackPlaybackStarts();
        }

        const segmentDurationSec = getSegmentDurationSeconds(latestState.pulse, getBarsPerRow());
        if (!Number.isFinite(segmentDurationSec) || segmentDurationSec <= 0) {
            return;
        }

        for (let trackIndex = 0; trackIndex < TRACK_COUNT; trackIndex += 1) {
            const startWhenSec = trackPlaybackStartWhenSec[trackIndex];
            const startOffsetSec = trackPlaybackStartOffsetSec[trackIndex];
            if (!Number.isFinite(startWhenSec) || !Number.isFinite(startOffsetSec) || !Number.isFinite(audioNow) || audioNow < startWhenSec) {
                if (isPlaying && Number.isFinite(trackPlaybackAnchorBeat[trackIndex])) {
                    const segmentBeatLength = Math.max(1, Math.trunc((Number(latestState.pulse.numBarBeats) || 4) * getBarsPerRow()));
                    const nowBeat = getAbsoluteBeatNow(latestState.pulse);
                    const anchorBeat = trackPlaybackAnchorBeat[trackIndex];
                    if (nowBeat >= anchorBeat) {
                        const deltaSegments = Math.floor((nowBeat - anchorBeat) / segmentBeatLength);
                        const row = (trackPlaybackAnchorRow[trackIndex] + deltaSegments) % ROW_COUNT;
                        activeRows[trackIndex] = ((row % ROW_COUNT) + ROW_COUNT) % ROW_COUNT;
                    } else {
                        activeRows[trackIndex] = null;
                    }
                } else {
                    activeRows[trackIndex] = null;
                }
                continue;
            }
            const elapsedSec = Math.max(0, audioNow - startWhenSec);
            const currentOffsetSec = Math.max(0, startOffsetSec + elapsedSec);
            const segmentIndex = Math.trunc(currentOffsetSec / segmentDurationSec);
            activeRows[trackIndex] = ((segmentIndex % ROW_COUNT) + ROW_COUNT) % ROW_COUNT;
        }
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
        setAllTrackPlaybackAnchors(selectedRows, getAbsoluteBeatNow(latestState.pulse));
        const offsets = Array.from({ length: TRACK_COUNT }, (_, trackIndex) => (
            getSegmentStartSeconds(selectedRows[trackIndex], latestState.pulse, getBarsPerRow())
        ));
        bufferPlayer.schedulePlay(whenSec, offsets);
        setAllTrackPlaybackStarts(whenSec, offsets);
        scheduledPauseAudioSec = NaN;
        for (let trackIndex = 0; trackIndex < TRACK_COUNT; trackIndex += 1) {
            armedRows[trackIndex] = null;
        }
        syncActiveRowsFromPlayback();
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
                    barsPerRow: getBarsPerRow(),
                    absoluteBeat: getNextDownbeatAbsoluteBeat(latestState.pulse),
                    atDownbeat: true,
                });
                setAllTrackPlaybackAnchors(selectedRows, getNextDownbeatAbsoluteBeat(latestState.pulse));
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
                barsPerRow: getBarsPerRow(),
                absoluteBeat: getNextDownbeatAbsoluteBeat(latestState.pulse),
                atDownbeat: true,
            });
            debugLog("dj-audio", "sent pause action", {
                absoluteBeat: getNextDownbeatAbsoluteBeat(latestState.pulse),
            });
        } else {
            bufferPlayer.schedulePause(Number(bufferPlayer.getAudioCurrentTime()) + 0.01);
            clearAllTrackPlaybackStarts();
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
            const nowTime = getEstimatedServerNow(latestState.pulse);
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
        syncActiveRowsFromPlayback();
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
        barsPerRowControl.sync();
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
        updateSelectedCellClasses();

        if (isPlaying) {
            if (isLiveDj()) {
                void bufferPlayer.unlock();
                sendDjPerformAction({
                    action: "jump",
                    songId: getActiveSong()?.id || "",
                    trackIndex: track,
                    rowIndex: row,
                    barsPerRow: getBarsPerRow(),
                    absoluteBeat: getNextDownbeatAbsoluteBeat(latestState.pulse),
                    atDownbeat: true,
                });
                setTrackPlaybackAnchor(track, row, getNextDownbeatAbsoluteBeat(latestState.pulse));
                debugLog("dj-audio", "sent jump action", {
                    trackIndex: track,
                    rowIndex: row,
                    absoluteBeat: getNextDownbeatAbsoluteBeat(latestState.pulse),
                });
                return;
            }
            scheduleAtNextDownbeat(() => {
                const whenSec = Number(bufferPlayer.getAudioCurrentTime()) + 0.02;
                const offsetSec = getSegmentStartSeconds(row, latestState.pulse, getBarsPerRow());
                bufferPlayer.scheduleJump(track, whenSec, offsetSec);
                setTrackPlaybackStart(track, whenSec, offsetSec);
                setTrackPlaybackAnchor(track, row, getAbsoluteBeatNow(latestState.pulse));
                scheduledPauseAudioSec = NaN;
                armedRows[track] = null;
                syncActiveRowsFromPlayback();
                updateSelectedCellClasses();
            });
        }
    };

    let lastLiveActionId = -1;
    const unsubscribe = subscribeAppState((nextState) => {
        const nextLatencyCompensationSec = Number(nextState.pulse.speakerLatencyCompensationSeconds) || 0;
        const latencyDeltaSec = nextLatencyCompensationSec - lastLatencyCompensationSec;
        lastLatencyCompensationSec = nextLatencyCompensationSec;
        latestState = nextState;
        renderConnection();
        renderSongSelect();
        renderTrackLabels();
        syncTrackSources();
        renderMode();
        bufferPlayer.setNoiseFloorEnabled(latestState.pulse.noiseFloorEnabled !== false);
        if (Math.abs(latencyDeltaSec) >= 0.001 && isPlaying) {
            const retimed = bufferPlayer.retimeActiveTracksByDelta(latencyDeltaSec, {
                whenSec: Number(bufferPlayer.getAudioCurrentTime()) + 0.015,
                fadeSec: 0.02,
            });
            if (retimed > 0) {
                for (let trackIndex = 0; trackIndex < TRACK_COUNT; trackIndex += 1) {
                    if (Number.isFinite(trackPlaybackStartOffsetSec[trackIndex])) {
                        trackPlaybackStartOffsetSec[trackIndex] = Math.max(0, trackPlaybackStartOffsetSec[trackIndex] + latencyDeltaSec);
                    }
                }
                debugLog("dj-audio", "retimed active tracks for latency change", {
                    latencyDeltaSec: Number(latencyDeltaSec).toFixed(4),
                    retimed,
                });
            }
        }
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
                }
                setAllTrackPlaybackAnchors(selectedRows, liveAction.absoluteBeat);
                isPlaying = true;
                playToggleButton.textContent = "Pause";
                updateSelectedCellClasses();
            } else if (liveAction.action === "jump") {
                const track = Math.max(0, Math.trunc(Number(liveAction.trackIndex || 0)));
                const row = Math.max(0, Math.trunc(Number(liveAction.rowIndex || 0)));
                selectedRows[track] = row;
                armedRows[track] = null;
                setTrackPlaybackAnchor(track, row, liveAction.absoluteBeat);
                updateSelectedCellClasses();
            } else if (liveAction.action === "pause") {
                isPlaying = false;
                playToggleButton.textContent = "Play";
                clearAllTrackPlaybackStarts();
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
        clearAllTrackPlaybackStarts();
        cleanupTempoControl();
        cleanupBarsPerRowControl();
        window.cancelAnimationFrame(rafId);
        unsubscribe();
        songSelectEl.removeEventListener("change", onSongChange);
        playToggleButton.removeEventListener("click", handlePlayPause);
        gridEl.removeEventListener("click", onGridClick);
    };
};
