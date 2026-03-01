/* Shared speaker latency calibration utility for Pulse audio clients. */

const CALIBRATION_TONE_FREQS = [1320, 1760, 2200];
const SPEAKER_LATENCY_BASE_STORAGE_KEY = "pulse_speaker_latency_base_seconds";
const SPEAKER_LATENCY_TRIM_STORAGE_KEY = "pulse_speaker_latency_trim_seconds";
const MAX_AUTO_LATENCY_MS = 350;
const MIN_VALID_TRIAL_MS = 12;
const MAX_VALID_TRIAL_MS = 900;
const MAX_TRIM_SECONDS = 0.3;

const sleep = (ms) => new Promise((resolve) => {
    window.setTimeout(resolve, ms);
});

export const clampSpeakerLatencySeconds = (value) => {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(2, Number(value)));
};

export const clampSpeakerLatencyTrimSeconds = (value) => {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(-MAX_TRIM_SECONDS, Math.min(MAX_TRIM_SECONDS, Number(value)));
};

export const readStoredSpeakerLatencyBaseSeconds = () => {
    if (typeof window === "undefined" || !window.localStorage) {
        return 0;
    }
    const raw = window.localStorage.getItem(SPEAKER_LATENCY_BASE_STORAGE_KEY);
    const parsed = Number.parseFloat(raw || "");
    return clampSpeakerLatencySeconds(parsed);
};

export const readStoredSpeakerLatencyTrimSeconds = () => {
    if (typeof window === "undefined" || !window.localStorage) {
        return 0;
    }
    const raw = window.localStorage.getItem(SPEAKER_LATENCY_TRIM_STORAGE_KEY);
    const parsed = Number.parseFloat(raw || "");
    return clampSpeakerLatencyTrimSeconds(parsed);
};

export const computeSpeakerLatencyCompensationSeconds = (baseSeconds, trimSeconds) => {
    return clampSpeakerLatencySeconds(
        clampSpeakerLatencySeconds(baseSeconds) + clampSpeakerLatencyTrimSeconds(trimSeconds),
    );
};

export const persistSpeakerLatencyBaseSeconds = (seconds) => {
    if (typeof window === "undefined" || !window.localStorage) {
        return;
    }
    const clamped = clampSpeakerLatencySeconds(seconds);
    window.localStorage.setItem(SPEAKER_LATENCY_BASE_STORAGE_KEY, clamped.toFixed(3));
};

export const persistSpeakerLatencyTrimSeconds = (seconds) => {
    if (typeof window === "undefined" || !window.localStorage) {
        return;
    }
    const clamped = clampSpeakerLatencyTrimSeconds(seconds);
    window.localStorage.setItem(SPEAKER_LATENCY_TRIM_STORAGE_KEY, clamped.toFixed(3));
};

const playCalibrationTone = (audioContext) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const now = audioContext.currentTime;
    const segmentDuration = 0.055;
    const segmentGap = 0.012;
    const activeDuration =
        CALIBRATION_TONE_FREQS.length * segmentDuration + (CALIBRATION_TONE_FREQS.length - 1) * segmentGap;
    const startTime = now + 0.004;
    const endTime = startTime + activeDuration;

    oscillator.type = "sine";
    oscillator.frequency.value = CALIBRATION_TONE_FREQS[0];
    gain.gain.value = 0.0001;

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    gain.gain.setValueAtTime(0.0001, startTime - 0.004);
    gain.gain.exponentialRampToValueAtTime(0.5, startTime + 0.008);
    gain.gain.setValueAtTime(0.5, endTime - 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, endTime + 0.012);

    let cursor = startTime;
    for (const freq of CALIBRATION_TONE_FREQS) {
        oscillator.frequency.setValueAtTime(freq, cursor);
        cursor += segmentDuration + segmentGap;
    }

    oscillator.start(startTime);
    oscillator.stop(endTime + 0.02);
};

const meanAndStd = (values) => {
    if (values.length === 0) {
        return { mean: 0, std: 0 };
    }
    let sum = 0;
    for (const value of values) {
        sum += value;
    }
    const mean = sum / values.length;
    let varianceSum = 0;
    for (const value of values) {
        const diff = value - mean;
        varianceSum += diff * diff;
    }
    const std = Math.sqrt(varianceSum / values.length);
    return { mean, std };
};

const goertzelPower = (samples, sampleRate, frequencyHz) => {
    const n = samples.length;
    if (n === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
        return 0;
    }

    const k = Math.round((n * frequencyHz) / sampleRate);
    if (k <= 0 || k >= n / 2) {
        return 0;
    }

    const omega = (2 * Math.PI * k) / n;
    const coeff = 2 * Math.cos(omega);
    let q0 = 0;
    let q1 = 0;
    let q2 = 0;

    for (let i = 0; i < n; i += 1) {
        q0 = coeff * q1 - q2 + samples[i];
        q2 = q1;
        q1 = q0;
    }

    const power = q1 * q1 + q2 * q2 - coeff * q1 * q2;
    return power / (n * n);
};

const getSignalMetrics = (samples, sampleRate) => {
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i += 1) {
        const value = samples[i];
        sumSquares += value * value;
    }
    const rms = Math.sqrt(sumSquares / samples.length);

    let tonePowerSum = 0;
    for (const freq of CALIBRATION_TONE_FREQS) {
        tonePowerSum += goertzelPower(samples, sampleRate, freq);
    }
    const toneScore = tonePowerSum / CALIBRATION_TONE_FREQS.length;

    return { rms, toneScore };
};

const runSingleLatencyTrial = async (audioContext, analyser) => {
    const samples = new Float32Array(analyser.fftSize);
    const trialStart = performance.now();
    const preListenMs = 300;
    const timeoutMs = 2000;
    const baselineRmsValues = [];
    const baselineToneValues = [];
    let toneSentAt = 0;
    let rafId = 0;
    let peakToneScore = 0;

    const result = await new Promise((resolve) => {
        const sendTimer = window.setTimeout(() => {
            toneSentAt = performance.now();
            playCalibrationTone(audioContext);
        }, preListenMs);

        const finish = (value) => {
            window.clearTimeout(sendTimer);
            if (rafId) {
                window.cancelAnimationFrame(rafId);
            }
            resolve(value);
        };

        const loop = () => {
            analyser.getFloatTimeDomainData(samples);
            const { rms, toneScore } = getSignalMetrics(samples, audioContext.sampleRate);
            const elapsed = performance.now() - trialStart;
            if (toneScore > peakToneScore) {
                peakToneScore = toneScore;
            }

            if (elapsed < preListenMs - 20) {
                baselineRmsValues.push(rms);
                baselineToneValues.push(toneScore);
            }

            const { mean: rmsMean, std: rmsStd } = meanAndStd(baselineRmsValues);
            const { mean: toneMean, std: toneStd } = meanAndStd(baselineToneValues);
            const rmsThreshold = Math.max(0.003, rmsMean * 2.2, rmsMean + 6 * rmsStd);
            const toneThreshold = Math.max(0.0000004, toneMean * 3.5, toneMean + 8 * toneStd);

            if (toneSentAt > 0 && performance.now() - toneSentAt > 18) {
                const toneDetected = toneScore > toneThreshold && rms > Math.max(0.0015, rmsMean * 1.1);
                const loudDetected = rms > rmsThreshold * 1.8;
                if (toneDetected || loudDetected) {
                    finish({
                        latencyMs: performance.now() - toneSentAt,
                        peakToneScore,
                    });
                    return;
                }
            }

            if (elapsed > timeoutMs) {
                finish({
                    latencyMs: null,
                    peakToneScore,
                });
                return;
            }

            rafId = window.requestAnimationFrame(loop);
        };

        loop();
    });

    return result;
};

export const createSpeakerLatencyCalibrator = (options = {}) => {
    const log = typeof options.log === "function" ? options.log : () => {};
    const setStatus = typeof options.setStatus === "function" ? options.setStatus : () => {};
    const trialCount = Number.isInteger(options.trialCount) ? options.trialCount : 5;
    const trialGapMs = Number.isFinite(options.trialGapMs) ? options.trialGapMs : 200;
    let isRunning = false;

    const calibrate = async () => {
        if (isRunning) {
            log("Latency calibration already in progress.");
            return null;
        }

        if (
            typeof navigator === "undefined" ||
            !navigator.mediaDevices ||
            !navigator.mediaDevices.getUserMedia
        ) {
            setStatus("Calibration unavailable: no microphone API");
            log("Latency calibration failed: getUserMedia unsupported.");
            return null;
        }

        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) {
            setStatus("Calibration unavailable: no Web Audio API");
            log("Latency calibration failed: no AudioContext.");
            return null;
        }

        isRunning = true;
        setStatus("Calibrating speaker latency...");
        log("Starting speaker latency calibration.");

        let stream = null;
        let audioContext = null;

        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
                video: false,
            });

            audioContext = new AudioContextCtor();
            const micSource = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0;
            micSource.connect(analyser);

            const trials = [];
            for (let i = 0; i < trialCount; i += 1) {
                const trial = await runSingleLatencyTrial(audioContext, analyser);
                const ms = trial ? trial.latencyMs : null;
                if (typeof ms === "number" && Number.isFinite(ms)) {
                    trials.push(ms);
                    log(`Calibration trial ${i + 1}: ${ms.toFixed(1)}ms`);
                } else {
                    const peakText =
                        trial && Number.isFinite(trial.peakToneScore)
                            ? ` (peak tone ${(trial.peakToneScore * 1e6).toFixed(2)})`
                            : "";
                    log(`Calibration trial ${i + 1}: no detection${peakText}`);
                }
                await sleep(trialGapMs);
            }

            if (trials.length === 0) {
                setStatus("Calibration failed: no audible detection");
                log("Latency calibration failed: no valid trials.");
                return null;
            }

            const validTrials = trials
                .filter((ms) => ms >= MIN_VALID_TRIAL_MS && ms <= MAX_VALID_TRIAL_MS)
                .sort((a, b) => a - b);
            if (validTrials.length === 0) {
                setStatus("Calibration failed: unstable detection");
                log("Latency calibration failed: trials out of valid range.");
                return null;
            }

            const lowClusterCount = Math.max(1, Math.ceil(validTrials.length * 0.35));
            const lowCluster = validTrials.slice(0, lowClusterCount);
            let pickedMs = lowCluster[Math.floor(lowCluster.length / 2)];

            const p20Index = Math.floor((validTrials.length - 1) * 0.2);
            const p80Index = Math.floor((validTrials.length - 1) * 0.8);
            const p20 = validTrials[p20Index];
            const p80 = validTrials[p80Index];
            const { std } = meanAndStd(validTrials);
            const spread = p80 - p20;
            const isUnstable = spread > 120 || std > 55;

            const contextLatencyMs = (
                (Number(audioContext.baseLatency) || 0) +
                (Number(audioContext.outputLatency) || 0)
            ) * 1000;

            if (isUnstable) {
                const fallbackCapMs = Number.isFinite(contextLatencyMs) && contextLatencyMs > 0
                    ? Math.max(45, contextLatencyMs + 45)
                    : 160;
                const previous = pickedMs;
                pickedMs = Math.min(pickedMs, fallbackCapMs);
                log(
                    `Calibration trials unstable (spread ${spread.toFixed(1)}ms, std ${std.toFixed(1)}ms). ` +
                    `Capping ${previous.toFixed(1)}ms to ${pickedMs.toFixed(1)}ms.`,
                );
            }

            pickedMs = Math.max(0, Math.min(MAX_AUTO_LATENCY_MS, pickedMs));
            const seconds = clampSpeakerLatencySeconds(pickedMs / 1000);

            setStatus(`Latency calibrated: ${pickedMs.toFixed(1)}ms`);
            log(`Latency calibration complete. Picked ${pickedMs.toFixed(1)}ms (${validTrials.length}/${trials.length} valid trials).`);
            return { seconds, pickedMs, trials: validTrials };
        } catch (error) {
            setStatus("Calibration failed");
            log(`Latency calibration error: ${error.message}`);
            return null;
        } finally {
            if (stream) {
                stream.getTracks().forEach((track) => track.stop());
            }
            if (audioContext) {
                await audioContext.close();
            }
            isRunning = false;
        }
    };

    return {
        calibrate,
    };
};
