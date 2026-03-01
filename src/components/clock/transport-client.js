/* Reusable Pulse transport client: websocket + basic clock sync + timing ingestion */

import { debugLog, debugWarn } from "../util/debug.js";

const DEFAULT_TICK_LENGTH = 20833;
const DEFAULT_NUM_BAR_BEATS = 4;
const INITIAL_SYNC_DELAYS_MS = [0, 120, 260, 450, 700];
const PING_TIMEOUT_MS = 4000;
const MAX_SYNC_SAMPLES = 60;

const getNow = () => performance.now();

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
    let clockOffset = 0;
    let syncTimers = [];
    const pendingPings = new Map();
    const syncSamples = [];

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

    const clearSyncTimers = () => {
        for (const timerId of syncTimers) {
            window.clearTimeout(timerId);
        }
        syncTimers = [];
    };

    const chooseClockOffsetEstimate = () => {
        if (syncSamples.length === 0) {
            return null;
        }

        const ordered = [...syncSamples].sort((left, right) => left.roundTripTime - right.roundTripTime);
        const used = ordered.slice(0, Math.max(1, Math.ceil(ordered.length / 2)));
        let weightedOffset = 0;
        let totalWeight = 0;

        for (const sample of used) {
            const weight = 1 / Math.max(0.5, sample.roundTripTime);
            weightedOffset += sample.clockOffset * weight;
            totalWeight += weight;
        }

        if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
            return null;
        }

        return weightedOffset / totalWeight;
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

        const sentAt = getNow();
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

    const scheduleInitialClockSync = () => {
        clearSyncTimers();
        syncTimers = INITIAL_SYNC_DELAYS_MS.map((delayMs) => (
            window.setTimeout(() => {
                requestClockSync();
            }, delayMs)
        ));
    };

    const handleServerTime = (message) => {
        const receivedAt = getNow();
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

        const roundTripTime = Math.max(0, (t4 - t1) - (t3 - t2));
        const sampleOffset = ((t2 - t1) + (t3 - t4)) / 2;
        if (!Number.isFinite(roundTripTime) || !Number.isFinite(sampleOffset)) {
            debugWarn("sync", "discarding non-finite RTT/offset", { roundTripTime, sampleOffset });
            return;
        }

        syncSamples.push({
            roundTripTime,
            clockOffset: sampleOffset,
        });
        if (syncSamples.length > MAX_SYNC_SAMPLES) {
            syncSamples.shift();
        }

        const estimate = chooseClockOffsetEstimate();
        if (!Number.isFinite(estimate)) {
            return;
        }

        clockOffset = estimate;
        debugLog("sync", "clock offset updated", {
            roundTripTime,
            sampleOffset,
            estimate,
            sampleCount: syncSamples.length,
        });
        onClockOffsetChange(clockOffset);
        onSyncSample({
            roundTripTime,
            clockOffset: sampleOffset,
            sampleCount: syncSamples.length,
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

        if (message.type === "performance_state" || message.type === "dj_perform_action") {
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
            scheduleInitialClockSync();
        });

        ws.addEventListener("message", handleSocketMessage);

        ws.addEventListener("close", () => {
            clearSyncTimers();
            clearPendingPings();
            ws = null;
            reportConnection("disconnected");
        });

        ws.addEventListener("error", (error) => {
            reportConnection("error", { error: "WebSocket error" });
            debugWarn("ws", "socket error event", error);
        });
    };

    const disconnect = () => {
        clearSyncTimers();
        clearPendingPings();
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
        getClockOffset: () => clockOffset,
        getTickLengthMs: (rawTickLength = DEFAULT_TICK_LENGTH) => parseTickLengthMs(rawTickLength),
    };
};
