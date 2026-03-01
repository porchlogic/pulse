/* Shared beat timing math from synchronized pulse clock */

export const getTickLengthMs = (rawTickLength) => {
    if (!Number.isFinite(rawTickLength) || rawTickLength <= 0) {
        return 20.833;
    }
    return rawTickLength > 1000 ? rawTickLength / 1000 : rawTickLength;
};

export const getBeatWindowMs = (rawTickLength) => getTickLengthMs(rawTickLength) * 24;

export const getAbsoluteBeatNow = (pulseState) => {
    const nowTime = performance.now() + Number(pulseState.clockOffset || 0);
    const beatWindowMs = getBeatWindowMs(pulseState.tickLength);
    if (!Number.isFinite(beatWindowMs) || beatWindowMs <= 0 || !Number.isFinite(pulseState.lastDownBeatTime)) {
        return 0;
    }
    return Math.floor((nowTime - pulseState.lastDownBeatTime) / beatWindowMs);
};

export const getBeatInBar = (pulseState) => {
    const absoluteBeat = getAbsoluteBeatNow(pulseState);
    const numBarBeats = Math.max(1, Math.trunc(Number(pulseState.numBarBeats) || 4));
    return ((absoluteBeat % numBarBeats) + numBarBeats) % numBarBeats + 1;
};

export const getMsUntilNextDownbeat = (pulseState) => {
    const numBarBeats = Math.max(1, Math.trunc(Number(pulseState.numBarBeats) || 4));
    const beatWindowMs = getBeatWindowMs(pulseState.tickLength);
    const absoluteBeat = getAbsoluteBeatNow(pulseState);
    const beatsToNextDownbeat = numBarBeats - ((((absoluteBeat % numBarBeats) + numBarBeats) % numBarBeats));
    return Math.max(0, beatsToNextDownbeat * beatWindowMs);
};
