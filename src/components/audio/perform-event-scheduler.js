/* Beat-grid event scheduler for performance playback actions. */

import { getAbsoluteBeatNow, getBeatWindowMs } from "../clock/beat-time.js";
import { debugLog } from "../util/debug.js";

const SCHEDULER_INTERVAL_MS = 25;
const SCHEDULER_LOOKAHEAD_MS = 140;
const SCHEDULER_GUARD_MS = 35;

const compareEvents = (left, right) => {
    if (left.absoluteBeat !== right.absoluteBeat) {
        return left.absoluteBeat - right.absoluteBeat;
    }
    return left.eventId - right.eventId;
};

export const createPerformEventScheduler = ({
    getPulseState = () => ({}),
    getLatencySeconds = () => 0,
    getAudioCurrentTime = () => NaN,
    onScheduleEvent = () => true,
} = {}) => {
    let timerId = 0;
    let nextEventCursor = 0;
    const events = [];
    const seenEventIds = new Set();
    const deferredEventIds = new Set();
    let running = false;

    const enqueue = (event) => {
        const eventId = Number.isFinite(event?.eventId) ? Math.trunc(Number(event.eventId)) : NaN;
        const absoluteBeat = Number.isFinite(event?.absoluteBeat) ? Math.trunc(Number(event.absoluteBeat)) : NaN;
        if (!Number.isFinite(eventId) || !Number.isFinite(absoluteBeat)) {
            return false;
        }
        if (seenEventIds.has(eventId)) {
            return false;
        }
        seenEventIds.add(eventId);
        events.push({
            ...event,
            eventId,
            absoluteBeat,
        });
        events.sort(compareEvents);
        debugLog("perform-scheduler", "event queued", {
            eventId,
            action: event.action,
            absoluteBeat,
        });
        return true;
    };

    const tick = () => {
        if (!running) {
            return;
        }
        const pulseState = getPulseState();
        const beatWindowMs = getBeatWindowMs(pulseState.tickLength);
        if (!Number.isFinite(beatWindowMs) || beatWindowMs <= 0 || !Number.isFinite(pulseState.lastDownBeatTime)) {
            return;
        }

        const serverNow = performance.now() + Number(pulseState.clockOffset || 0);
        const currentAbsoluteBeat = getAbsoluteBeatNow(pulseState);
        const latencyMs = Math.max(0, Math.min(2000, Number(getLatencySeconds()) * 1000 || 0));
        const horizonServerMs = serverNow + SCHEDULER_LOOKAHEAD_MS + latencyMs + SCHEDULER_GUARD_MS;
        const audioNow = Number(getAudioCurrentTime());
        if (!Number.isFinite(audioNow)) {
            return;
        }

        while (nextEventCursor < events.length) {
            const event = events[nextEventCursor];
            const beatServerTime = Number(pulseState.lastDownBeatTime) + Number(event.absoluteBeat) * beatWindowMs;
            if (beatServerTime > horizonServerMs) {
                break;
            }
            const whenSec = audioNow + (beatServerTime - serverNow) / 1000 - latencyMs / 1000;
            const handled = onScheduleEvent({
                event,
                whenSec,
                beatServerTime,
                serverNow,
                audioNow,
                currentAbsoluteBeat,
            });
            if (handled === false) {
                if (!deferredEventIds.has(event.eventId)) {
                    deferredEventIds.add(event.eventId);
                    debugLog("perform-scheduler", "event deferred", {
                        eventId: event.eventId,
                        action: event.action,
                        absoluteBeat: event.absoluteBeat,
                    });
                }
                break;
            }
            deferredEventIds.delete(event.eventId);
            nextEventCursor += 1;
        }

        if (nextEventCursor > 0 && nextEventCursor >= events.length) {
            events.length = 0;
            nextEventCursor = 0;
        }
    };

    const start = () => {
        if (running) {
            return;
        }
        running = true;
        tick();
        timerId = window.setInterval(tick, SCHEDULER_INTERVAL_MS);
    };

    const stop = () => {
        running = false;
        if (timerId) {
            window.clearInterval(timerId);
            timerId = 0;
        }
    };

    const clear = () => {
        events.length = 0;
        nextEventCursor = 0;
        seenEventIds.clear();
        deferredEventIds.clear();
    };

    const destroy = () => {
        stop();
        clear();
    };

    return {
        clear,
        destroy,
        enqueue,
        start,
        stop,
    };
};
