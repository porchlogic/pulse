/* Standalone Bluetooth-friendly drum pulse test page (no shared component dependencies). */

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));

export const mount = ({ mountNode } = {}) => {
    const root = mountNode?.querySelector(".bt-drum-test");
    if (!root) {
        return () => {};
    }

    const startButton = root.querySelector("[data-role=\"bt-start\"]");
    const stopButton = root.querySelector("[data-role=\"bt-stop\"]");
    const bpmInput = root.querySelector("[data-role=\"bt-bpm\"]");
    const bpmValue = root.querySelector("[data-role=\"bt-bpm-value\"]");
    const levelInput = root.querySelector("[data-role=\"bt-level\"]");
    const levelValue = root.querySelector("[data-role=\"bt-level-value\"]");
    const offsetInput = root.querySelector("[data-role=\"bt-offset\"]");
    const offsetValue = root.querySelector("[data-role=\"bt-offset-value\"]");
    const beatEl = root.querySelector("[data-role=\"bt-beat\"]");
    const contextEl = root.querySelector("[data-role=\"bt-context\"]");
    const logEl = root.querySelector("[data-role=\"bt-log\"]");
    if (!startButton || !stopButton || !bpmInput || !bpmValue || !levelInput || !levelValue || !offsetInput || !offsetValue || !beatEl || !contextEl || !logEl) {
        return () => {};
    }

    root.style.cssText = [
        "display: grid",
        "gap: 0.9rem",
        "max-width: 42rem",
        "margin: 0 auto",
        "padding: 1rem",
        "border: 1px solid #2d3238",
        "border-radius: 0.8rem",
        "background: #121416",
        "color: #f2f2f2",
        "font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    ].join(";");
    const controls = root.querySelector(".bt-controls");
    if (controls) {
        controls.style.cssText = "display:flex;gap:0.65rem;";
    }
    for (const button of root.querySelectorAll("button")) {
        button.style.cssText = [
            "padding:0.55rem 0.9rem",
            "border-radius:0.45rem",
            "border:1px solid #47505a",
            "background:#1e252d",
            "color:#f4f4f4",
            "font-weight:600",
            "cursor:pointer",
        ].join(";");
    }
    const grid = root.querySelector(".bt-grid");
    if (grid) {
        grid.style.cssText = "display:grid;gap:0.6rem;";
    }
    for (const label of root.querySelectorAll("label")) {
        label.style.cssText = "display:grid;gap:0.35rem;font-size:0.92rem;";
    }
    for (const input of root.querySelectorAll("input[type=\"range\"]")) {
        input.style.cssText = "width:100%;";
    }
    const status = root.querySelector(".bt-status");
    if (status) {
        status.style.cssText = "display:grid;gap:0.25rem;font-size:0.92rem;";
    }
    const note = root.querySelector(".bt-note");
    if (note) {
        note.style.cssText = "opacity:0.85;margin:0;";
    }

    let audioContext = null;
    let masterGain = null;
    let limiter = null;
    let running = false;
    let schedulerId = 0;
    let nextBeatTimeSec = 0;
    let beatCount = 0;
    let didInit = false;

    const SCHEDULER_INTERVAL_MS = 45;
    const LOOKAHEAD_SEC = 0.24;
    const MIN_SCHEDULE_AHEAD_SEC = 0.02;

    const setLog = (text) => {
        logEl.textContent = String(text || "");
    };

    const updateReadouts = () => {
        bpmValue.textContent = String(Math.trunc(Number(bpmInput.value)));
        levelValue.textContent = Number(levelInput.value).toFixed(2);
        offsetValue.textContent = String(Math.trunc(Number(offsetInput.value)));
        contextEl.textContent = audioContext ? audioContext.state : "idle";
        startButton.disabled = running;
        stopButton.disabled = !running;
    };

    const secondsPerBeat = () => 60 / clamp(bpmInput.value, 60, 170);
    const offsetSec = () => clamp(offsetInput.value, -120, 220) / 1000;

    const ensureAudio = async () => {
        if (!audioContext) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) {
                throw new Error("AudioContext unavailable");
            }
            audioContext = new Ctx({
                latencyHint: "playback",
                sampleRate: 48000,
            });

            masterGain = audioContext.createGain();
            limiter = audioContext.createDynamicsCompressor();
            limiter.threshold.value = -10;
            limiter.knee.value = 8;
            limiter.ratio.value = 7;
            limiter.attack.value = 0.003;
            limiter.release.value = 0.08;

            masterGain.gain.value = 0.0001;
            masterGain.connect(limiter);
            limiter.connect(audioContext.destination);
            didInit = true;
        }
        if (audioContext.state !== "running") {
            await audioContext.resume();
        }
        updateReadouts();
    };

    const scheduleHit = (rawWhenSec, isDownbeat) => {
        const audioNow = audioContext.currentTime;
        const whenSec = Math.max(rawWhenSec + offsetSec(), audioNow + MIN_SCHEDULE_AHEAD_SEC);

        const body = audioContext.createOscillator();
        const knock = audioContext.createOscillator();
        const tone = audioContext.createBiquadFilter();
        const hitGain = audioContext.createGain();
        const hp = audioContext.createBiquadFilter();

        body.type = "triangle";
        body.frequency.setValueAtTime(isDownbeat ? 760 : 690, whenSec);

        knock.type = "sine";
        knock.frequency.setValueAtTime(isDownbeat ? 2020 : 1750, whenSec);

        tone.type = "bandpass";
        tone.frequency.setValueAtTime(isDownbeat ? 1180 : 1010, whenSec);
        tone.Q.setValueAtTime(isDownbeat ? 3.4 : 2.8, whenSec);

        hp.type = "highpass";
        hp.frequency.value = 65;
        hp.Q.value = 0.7;

        const peak = clamp(levelInput.value, 0.05, 0.9) * (isDownbeat ? 0.88 : 0.7);
        const attackSec = 0.005;
        const bodyDecaySec = isDownbeat ? 0.14 : 0.12;
        const releaseSec = 0.03;
        const endSec = whenSec + bodyDecaySec + releaseSec;

        hitGain.gain.cancelScheduledValues(whenSec - 0.01);
        hitGain.gain.setValueAtTime(0.0001, whenSec - 0.002);
        hitGain.gain.linearRampToValueAtTime(peak, whenSec + attackSec);
        hitGain.gain.exponentialRampToValueAtTime(0.001, endSec);

        knock.connect(tone);
        body.connect(tone);
        tone.connect(hp);
        hp.connect(hitGain);
        hitGain.connect(masterGain);

        body.start(whenSec);
        knock.start(whenSec);
        body.stop(endSec + 0.01);
        knock.stop(endSec + 0.01);
    };

    const tick = () => {
        if (!running || !audioContext) {
            return;
        }

        const audioNow = audioContext.currentTime;
        while (nextBeatTimeSec <= audioNow + LOOKAHEAD_SEC) {
            const isDownbeat = beatCount % 4 === 0;
            scheduleHit(nextBeatTimeSec, isDownbeat);
            beatCount += 1;
            beatEl.textContent = String((beatCount % 4) || 4);
            nextBeatTimeSec += secondsPerBeat();
        }
    };

    const stopScheduler = () => {
        if (schedulerId) {
            window.clearInterval(schedulerId);
            schedulerId = 0;
        }
    };

    const start = async () => {
        try {
            await ensureAudio();
            running = true;
            beatCount = 0;
            nextBeatTimeSec = audioContext.currentTime + 0.08;
            masterGain.gain.cancelScheduledValues(audioContext.currentTime);
            masterGain.gain.setValueAtTime(Math.max(0.0001, masterGain.gain.value), audioContext.currentTime);
            masterGain.gain.linearRampToValueAtTime(1, audioContext.currentTime + 0.03);
            stopScheduler();
            tick();
            schedulerId = window.setInterval(tick, SCHEDULER_INTERVAL_MS);
            setLog("Running. If you hear artifacts, try +20 to +80ms offset.");
        } catch (error) {
            setLog(error?.message || "Unable to start audio.");
            running = false;
        }
        updateReadouts();
    };

    const stop = () => {
        if (!audioContext) {
            running = false;
            updateReadouts();
            return;
        }
        const now = audioContext.currentTime;
        running = false;
        stopScheduler();
        masterGain.gain.cancelScheduledValues(now);
        masterGain.gain.setValueAtTime(Math.max(0.0001, masterGain.gain.value), now);
        masterGain.gain.linearRampToValueAtTime(0.0001, now + 0.03);
        beatEl.textContent = "-";
        setLog("Stopped.");
        updateReadouts();
    };

    const onStart = () => {
        void start();
    };
    const onStop = () => {
        stop();
    };
    const onInput = () => {
        updateReadouts();
        if (running && audioContext) {
            setLog("Updated settings.");
        }
    };

    startButton.addEventListener("click", onStart);
    stopButton.addEventListener("click", onStop);
    bpmInput.addEventListener("input", onInput);
    levelInput.addEventListener("input", onInput);
    offsetInput.addEventListener("input", onInput);
    updateReadouts();
    setLog("Tap Start, then connect Bluetooth speaker and listen for stability.");

    return () => {
        stop();
        startButton.removeEventListener("click", onStart);
        stopButton.removeEventListener("click", onStop);
        bpmInput.removeEventListener("input", onInput);
        levelInput.removeEventListener("input", onInput);
        offsetInput.removeEventListener("input", onInput);
        if (audioContext && didInit) {
            void audioContext.close();
        }
        audioContext = null;
        masterGain = null;
        limiter = null;
    };
};
