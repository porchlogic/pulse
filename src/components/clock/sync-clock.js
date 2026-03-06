/* Shared sync-clock helpers: monotonic now + NTP-style offset estimator. */

const MIN_WEIGHT_RTT_MS = 0.5;
const DEFAULT_MAX_SAMPLES = 60;
const OFFSET_SLEW_ALPHA = 0.35;
const OFFSET_SLEW_MAX_STEP_MS = 8;
const HARD_RESET_THRESHOLD_MS = 120;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const getClientNow = () => performance.now();

export const getEstimatedServerNow = (pulseState = {}) => (
    getClientNow() + Number(pulseState.clockOffset || 0)
);

const chooseOffsetEstimate = (samples) => {
    if (!Array.isArray(samples) || samples.length === 0) {
        return null;
    }
    const ordered = [...samples].sort((left, right) => left.roundTripTime - right.roundTripTime);
    const used = ordered.slice(0, Math.max(1, Math.ceil(ordered.length / 2)));
    let weightedOffset = 0;
    let totalWeight = 0;
    for (const sample of used) {
        const weight = 1 / Math.max(MIN_WEIGHT_RTT_MS, Number(sample.roundTripTime) || 0);
        weightedOffset += Number(sample.clockOffset || 0) * weight;
        totalWeight += weight;
    }
    if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
        return null;
    }
    return weightedOffset / totalWeight;
};

export const createSyncClockEstimator = ({
    maxSamples = DEFAULT_MAX_SAMPLES,
} = {}) => {
    let clockOffset = 0;
    const samples = [];

    const reset = ({ resetOffset = false } = {}) => {
        samples.length = 0;
        if (resetOffset) {
            clockOffset = 0;
        }
    };

    const addSample = ({ t1, t2, t3, t4 } = {}) => {
        if (!Number.isFinite(t1) || !Number.isFinite(t2) || !Number.isFinite(t3) || !Number.isFinite(t4)) {
            return null;
        }
        const roundTripTime = Math.max(0, (t4 - t1) - (t3 - t2));
        const sampleOffset = ((t2 - t1) + (t3 - t4)) / 2;
        if (!Number.isFinite(roundTripTime) || !Number.isFinite(sampleOffset)) {
            return null;
        }

        samples.push({
            roundTripTime,
            clockOffset: sampleOffset,
        });
        if (samples.length > Math.max(1, Math.trunc(Number(maxSamples) || DEFAULT_MAX_SAMPLES))) {
            samples.shift();
        }

        const estimate = chooseOffsetEstimate(samples);
        if (!Number.isFinite(estimate)) {
            return null;
        }

        const delta = estimate - clockOffset;
        const shouldHardReset = samples.length <= 2 || Math.abs(delta) >= HARD_RESET_THRESHOLD_MS;
        if (shouldHardReset) {
            clockOffset = estimate;
        } else {
            const step = clamp(delta * OFFSET_SLEW_ALPHA, -OFFSET_SLEW_MAX_STEP_MS, OFFSET_SLEW_MAX_STEP_MS);
            clockOffset += step;
        }

        return {
            roundTripTime,
            sampleOffset,
            estimateOffset: estimate,
            appliedOffset: clockOffset,
            sampleCount: samples.length,
        };
    };

    return {
        addSample,
        getOffset: () => clockOffset,
        getServerNow: () => getClientNow() + clockOffset,
        reset,
    };
};

