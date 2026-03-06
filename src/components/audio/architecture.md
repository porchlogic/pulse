# Audio Architecture Overview (High-Level)

This document describes the expected architecture and performance characteristics of a simple synchronized web audio system (for example: metronome pulse + track playback across clients).

It intentionally focuses on general design expectations, not project-specific implementation details.

## Goals

1. Keep timing predictable for users.
2. Make playback behavior deterministic across clients.
3. Degrade gracefully on constrained devices and networks.
4. Provide clear observability for debugging timing and audio issues.

## Core Model

A minimal synchronized audio system has four logical layers:

1. Transport and Shared Time
- Establish a shared reference clock (server-authoritative or equivalent).
- Continuously estimate local clock offset and jitter.
- Broadcast timing state (tempo, beat anchor, meter, etc.) to clients.

2. Event Timeline
- Represent playback actions as timestamped events in shared musical time.
- Quantize actions to grid boundaries (beat/downbeat/bar) when needed.
- Ensure events are idempotent and ordered by stable event IDs.

3. Audio Scheduler
- Convert shared-time events into local AudioContext schedule times.
- Use lookahead scheduling and never rely on `setTimeout`/`requestAnimationFrame` for sample-accurate starts.
- Keep a safety margin so events are not scheduled "too late."

4. Rendering and UI
- UI reflects playback state but does not drive audio timing.
- Visual indicators can update at frame rate; audio must remain independent.
- Display user-facing status for connection, sync health, and audio readiness.

## Timing Expectations

For simple systems, expected behavior should include:

1. Stable Tempo Perception
- Tempo changes should be explicit and coherent (applied at known boundaries).
- Users should not hear frequent micro-jitter while tempo is constant.

2. Predictable Event Execution
- "Play/Pause/Jump" actions should execute at intended grid points.
- Late events should use deterministic fallback behavior (defer, clamp, or drop based on policy).

3. Drift Management
- Local clock estimates should be smoothed to reduce jitter-driven corrections.
- Re-anchoring should be controlled to avoid audible discontinuities.

## Latency Model

A simple latency model should separate concerns:

1. Network/Clock Sync Latency
- Affects alignment to shared timeline.
- Solved with offset estimation and scheduling lookahead.

2. Output (Speaker/Bluetooth) Latency
- Affects perceived alignment with visual beat or other devices in the room.
- Compensated with a user-adjustable output offset.

3. Input (Mic) Latency for Calibration
- Can be noisy on mobile and should be treated as advisory.
- Calibration should provide confidence/quality indicators and allow manual trim.

## Performance Targets (Practical)

Reasonable expectations for lightweight browser-based systems:

1. Scheduling loop frequency: ~20-50ms interval with lookahead window.
2. Event start safety margin: avoid "schedule in the past" conditions.
3. UI updates: smooth enough for beat feedback without affecting audio thread work.
4. CPU overhead: low enough to run on mid-range phones/tablets without audio dropouts.

## Audio Quality Expectations

1. No clicks/pops under nominal load.
2. Consistent gain staging (no clipping at summing points).
3. Envelope shaping for transients (avoid discontinuities at start/stop).
4. Device-aware behavior (Bluetooth outputs may need larger safety margins).

## Failure and Fallback Behavior

The system should fail transparently and safely:

1. If sync is unavailable
- Keep local audio functional where possible.
- Mark degraded mode clearly in UI.

2. If autoplay policies block audio
- Require explicit user gesture to unlock context.
- Preserve intended state and retry on next gesture.

3. If assets are missing/unloaded
- Defer dependent events with bounded retry policy.
- Avoid silent permanent failure without status reporting.

## Observability and Diagnostics

Minimum useful telemetry:

1. Clock sync: RTT, offset estimate, sample count.
2. Scheduler: queued/deferred/executed event counts.
3. Audio readiness: context state, buffer loaded/unloaded states.
4. Quality warnings: late schedules, dropped events, decode/load failures.

Logs should be scoped, sampled when noisy, and actionable.

## Control Patterns (Server-Backed UI)

Any control that commits server state (tempo, mode, track action policy, etc.) should use:

1. Local draft value while editing.
2. Explicit commit action (Apply/Enter).
3. No overwrite of draft from live state updates.
4. In-flight disable + clear success/failure feedback.

This pattern prevents common race conditions between user input and realtime state refreshes.

## Testing Strategy

Simple systems still need coverage across layers:

1. Unit tests
- Time conversion, quantization, schedule-time math, clamping behavior.

2. Integration tests
- Event ordering, playback state transitions, reconnect/resync scenarios.

3. Device testing
- iOS Safari/iPadOS, Android Chrome, desktop Chrome/Safari.
- Wired output, built-in speakers, and Bluetooth output paths.

4. Soak testing
- Long-run stability under continuous playback and periodic tempo changes.

## Non-Goals

For a basic system, avoid unnecessary complexity:

1. Sample-accurate distributed phase locking across arbitrary internet links.
2. Heavy DSP pipelines when simple synthesis/playback is sufficient.
3. Overly dynamic correction algorithms that trade stability for theoretical precision.

## Summary

A good simple synchronized audio architecture is:

1. Shared-clock driven.
2. Event-scheduled (not UI-timed).
3. Conservative with timing safety on real devices.
4. Observable and debuggable.
5. Designed for graceful degradation.

If these principles are followed, users should perceive stable rhythm, predictable controls, and reliable behavior across typical browser/device conditions.
