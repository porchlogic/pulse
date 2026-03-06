/* Reusable Pulse transport client: websocket + basic clock sync + timing ingestion */

import { debugLog, debugWarn } from "../util/debug.js";
import { createSyncClockEstimator, getClientNow } from "./sync-clock.js";

const DEFAULT_TICK_LENGTH = 20833;
const DEFAULT_NUM_BAR_BEATS = 4;
const INITIAL_SYNC_DELAYS_MS = [0, 120, 260, 450, 700];
const CONTINUOUS_SYNC_INTERVAL_MS = 2500;
const PING_TIMEOUT_MS = 4000;

const parseTickLengthMs = (rawTickLength) => {
    if (!Number.isFinite(rawTickLength) || rawTickLength <= 0) {
        return DEFAULT_TICK_LENGTH / 1000;
    }
    return rawTickLength > 1000 ? rawTickLength / 1000 : rawTickLength;
};

const normalizeTimingPayload = (message) => {
    const timing = {};

    if (Number.isFinite(message?.lastDownBeatTime)) {
        timing.lastDownBeatTime = Number(message.lastDownBeatTime);
    }
    if (Number.isFinite(message?.tickLength) && Number(message.tickLength) > 0) {
        timing.tickLength = Number(message.tickLength);
    }
    if (Number.isFinite(message?.numBarBeats)) {
        timing.numBarBeats = Math.max(1, Math.trunc(Number(message.numBarBeats)));
    }
    return timing;
};

export const createPulseTransportClient = ({
    url,
    onConnectionChange = () => {},
    onTimingChange = () => {},
    onClockOffsetChange = () => {},
    onSyncSample = () => {},
    onRealtimeEvent = () => {},
} = {}) => {
    let ws = null;
    let nextPingId = 1;
    const syncEstimator = createSyncClockEstimator();
    let initialSyncTimers = [];
    let continuousSyncTimerId = 0;
    const pendingPings = new Map();

    const reportConnection = (status, details = {}) => {
        debugLog("ws", `connection ${status}`, details);
        onConnectionChange({
            status,
            url,
            ...details,
        });
    };

    const clearPendingPings = () => {
        for (const pending of pendingPings.values()) {
            window.clearTimeout(pending.timeoutId);
        }
        pendingPings.clear();
    };

    const clearInitialSyncTimers = () => {
        for (const timerId of initialSyncTimers) {
            window.clearTimeout(timerId);
        }
        initialSyncTimers = [];
    };

    const clearContinuousSyncTimer = () => {
        if (!continuousSyncTimerId) {
            return;
        }
        window.clearInterval(continuousSyncTimerId);
        continuousSyncTimerId = 0;
    };

    const resetSyncEstimator = ({ resetOffset = false } = {}) => {
        clearPendingPings();
        clearInitialSyncTimers();
        clearContinuousSyncTimer();
        syncEstimator.reset({ resetOffset });
        if (resetOffset) {
            onClockOffsetChange(0);
        }
    };

    const sendJson = (payload) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            debugWarn("ws", "send skipped because socket is not open", payload);
            return;
        }
        debugLog("ws", "send", payload);
        ws.send(JSON.stringify(payload));
    };

    const requestClockSync = () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return;
        }

        const sentAt = getClientNow();
        const requestId = String(nextPingId);
        nextPingId += 1;

        const timeoutId = window.setTimeout(() => {
            pendingPings.delete(requestId);
        }, PING_TIMEOUT_MS);

        pendingPings.set(requestId, { sentAt, timeoutId });
        sendJson({
            type: "get_time",
            requestId,
            clientSendTime: sentAt,
        });
    };

    const startSyncLoop = () => {
        clearInitialSyncTimers();
        initialSyncTimers = INITIAL_SYNC_DELAYS_MS.map((delayMs) => (
            window.setTimeout(() => {
                requestClockSync();
            }, delayMs)
        ));
        clearContinuousSyncTimer();
        continuousSyncTimerId = window.setInterval(() => {
            requestClockSync();
        }, CONTINUOUS_SYNC_INTERVAL_MS);
    };

    const handleServerTime = (message) => {
        const receivedAt = getClientNow();
        const requestId = typeof message.requestId === "string" || typeof message.requestId === "number"
            ? String(message.requestId)
            : null;
        const pending = requestId ? pendingPings.get(requestId) : null;
        if (!pending) {
            debugWarn("sync", "received server_time without pending request", message);
            return;
        }

        window.clearTimeout(pending.timeoutId);
        pendingPings.delete(requestId);

        const t1 = Number.isFinite(message.clientSendTime) ? Number(message.clientSendTime) : pending.sentAt;
        const t2 = Number(message.serverReceiveTime);
        const t3 = Number(message.serverSendTime);
        const t4 = receivedAt;
        if (!Number.isFinite(t1) || !Number.isFinite(t2) || !Number.isFinite(t3) || !Number.isFinite(t4)) {
            debugWarn("sync", "discarding invalid sync sample", { t1, t2, t3, t4 });
            return;
        }

        const sample = syncEstimator.addSample({ t1, t2, t3, t4 });
        if (!sample) {
            debugWarn("sync", "discarding non-finite RTT/offset");
            return;
        }
        onClockOffsetChange(sample.appliedOffset);
        debugLog("sync", "clock offset updated", {
            roundTripTime: sample.roundTripTime,
            sampleOffset: sample.sampleOffset,
            estimateOffset: sample.estimateOffset,
            appliedOffset: sample.appliedOffset,
            sampleCount: sample.sampleCount,
        });
        onSyncSample({
            roundTripTime: sample.roundTripTime,
            clockOffset: sample.sampleOffset,
            estimateClockOffset: sample.estimateOffset,
            appliedClockOffset: sample.appliedOffset,
            sampleCount: sample.sampleCount,
        });
    };

    const handlePulse = (message) => {
        const timing = normalizeTimingPayload(message);
        if (Object.keys(timing).length === 0) {
            return;
        }
        onTimingChange(timing);
    };

    const handleSocketMessage = (event) => {
        if (typeof event.data !== "string") {
            return;
        }

        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }

        if (!message || typeof message !== "object") {
            return;
        }

        if (message.type && message.type !== "pulse" && message.type !== "server_time") {
            debugLog("ws", `recv ${message.type}`, message);
        }

        if (message.type === "server_time") {
            handleServerTime(message);
            return;
        }

        if (message.type === "pulse") {
            handlePulse(message);
            return;
        }

        if (message.type === "performance_state" || message.type === "dj_perform_action" || message.type === "troupe_track_counts") {
            onRealtimeEvent(message);
        }
    };

    const ensureConnected = () => {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        reportConnection("connecting");
        ws = new WebSocket(url);

        ws.addEventListener("open", () => {
            reportConnection("connected");
            startSyncLoop();
        });

        ws.addEventListener("message", handleSocketMessage);

        ws.addEventListener("close", () => {
            resetSyncEstimator();
            ws = null;
            reportConnection("disconnected");
        });

        ws.addEventListener("error", (error) => {
            reportConnection("error", { error: "WebSocket error" });
            debugWarn("ws", "socket error event", error);
        });
    };

    const disconnect = () => {
        resetSyncEstimator();
        if (ws) {
            const current = ws;
            ws = null;
            current.close();
        }
        reportConnection("disconnected");
    };

    return {
        ensureConnected,
        disconnect,
        sendRealtime: (payload) => {
            sendJson(payload);
        },
        getClockOffset: () => syncEstimator.getOffset(),
        getTickLengthMs: (rawTickLength = DEFAULT_TICK_LENGTH) => parseTickLengthMs(rawTickLength),
    };
};
