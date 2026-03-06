/* Shared speaker latency calibration utility for Pulse audio clients. */

import { getSharedAudioEngine } from "./audio-engine.js";

const CALIBRATION_CHIRP_FREQ_HZ = 1850;
const SPEAKER_LATENCY_BASE_STORAGE_KEY = "pulse_speaker_latency_base_seconds";
const SPEAKER_LATENCY_TRIM_STORAGE_KEY = "pulse_speaker_latency_trim_seconds";
const MAX_AUTO_LATENCY_MS = 350;
const MIN_VALID_TRIAL_MS = 12;
const MAX_VALID_TRIAL_MS = 900;
const MAX_TRIM_SECONDS = 0.3;
const MIN_DETECTION_AFTER_SEND_MS = 24;
const REQUIRED_TONE_HIT_FRAMES = 2;

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
    const activeDuration = 0.09;
    const startTime = now + 0.004;
    const endTime = startTime + activeDuration;

    oscillator.type = "sine";
    oscillator.frequency.value = CALIBRATION_CHIRP_FREQ_HZ;
    gain.gain.value = 0.0001;

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    gain.gain.setValueAtTime(0.0001, startTime - 0.004);
    gain.gain.exponentialRampToValueAtTime(0.65, startTime + 0.01);
    gain.gain.setValueAtTime(0.65, endTime - 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, endTime + 0.012);

    oscillator.start(startTime);
    oscillator.stop(endTime + 0.02);
    return startTime;
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

    const toneScore = goertzelPower(samples, sampleRate, CALIBRATION_CHIRP_FREQ_HZ);

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
    let toneHitFrames = 0;

    const result = await new Promise((resolve) => {
        const sendTimer = window.setTimeout(() => {
            const perfNow = performance.now();
            const ctxNow = audioContext.currentTime;
            const scheduledStart = playCalibrationTone(audioContext);
            toneSentAt = perfNow + Math.max(0, (scheduledStart - ctxNow) * 1000);
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
            const toneThreshold = Math.max(0.0000004, toneMean * 3.5, toneMean + 8 * toneStd);

            if (toneSentAt > 0 && performance.now() - toneSentAt > MIN_DETECTION_AFTER_SEND_MS) {
                const toneDetected = toneScore > toneThreshold && rms > Math.max(0.0015, rmsMean * 1.1);
                if (toneDetected) {
                    toneHitFrames += 1;
                } else {
                    toneHitFrames = 0;
                }
                if (toneHitFrames >= REQUIRED_TONE_HIT_FRAMES) {
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
    const trialCount = Number.isInteger(options.trialCount) ? options.trialCount : 1;
    const trialGapMs = Number.isFinite(options.trialGapMs) ? options.trialGapMs : 200;
    const audioEngine = options.audioEngine || getSharedAudioEngine();
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

        isRunning = true;
        setStatus("Calibrating speaker latency...");
        log("Starting speaker latency calibration.");

        let stream = null;
        let audioContext = null;

        try {
            const unlocked = await audioEngine.unlock();
            if (!unlocked) {
                setStatus("Calibration unavailable: audio blocked");
                log("Latency calibration failed: shared audio context could not be resumed.");
                return null;
            }
            audioContext = audioEngine.getContext();
            if (!audioContext) {
                setStatus("Calibration unavailable: no shared audio context");
                log("Latency calibration failed: shared audio context missing.");
                return null;
            }

            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
                video: false,
            });
            const micSource = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 1024;
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

            let pickedMs = validTrials[0];
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
            isRunning = false;
        }
    };

    return {
        calibrate,
    };
};
