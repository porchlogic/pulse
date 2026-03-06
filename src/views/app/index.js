/* Single unified app route: role-gated sections in one interface. */

import {
    createTroupeAccount,
    directorCreateAccount,
    directorEndPerformance,
    directorListAccounts,
    directorSetLiveDj,
    directorSetTempo,
    directorStartPerformance,
    directorUpdateAccount,
    djChangeCredentials,
    ensurePulseTransportConnected,
    getAppState,
    loadDirectorState,
    loadPerformanceState,
    loginDj,
    loginTroupeSim,
    logout,
    setNoiseFloorEnabled,
    setSpeakerLatencyCompensationSeconds,
    subscribeAppState,
} from "../../state.js";
import { mount as mountTroupe } from "../troupe/index.js";
import { mountArtistLaunchers } from "./artist.js";
import { createQrImageUrl, createQrScanner, extractSessionToken } from "../../components/util/qr.js";
import {
    createDrumPulseSynth,
    persistDrumPulseEnabled,
    readStoredDrumPulseEnabled,
} from "../../components/audio/drum-pulse-synth.js";

const MAX_SPEAKER_OFFSET_MS = 250;
const DEFAULT_THEME_COLORS = ["#0b0d12", "#151a22", "#7df0c8", "#f2f6ff", "#8f9db6"];

const isArtistRole = (role) => role === "artist" || role === "dj";

const toJoinUrl = (token) => {
    if (!token) {
        return "not started";
    }
    return `${window.location.origin}${window.location.pathname}?session=${token}`;
};

const clampNumber = (value, min, max, fallback) => {
    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
};

const setTextMessage = (el, message) => {
    if (!el) return;
    if (!message) {
        el.hidden = true;
        el.textContent = "";
        return;
    }
    el.hidden = false;
    el.textContent = message;
};

const normalizeThemeColors = (value) => {
    const list = Array.isArray(value) ? value : [];
    const normalized = list
        .slice(0, 5)
        .map((item) => String(item || "").trim())
        .filter((item) => /^#[0-9a-fA-F]{6}$/.test(item));
    if (normalized.length === 5) {
        return normalized;
    }
    return [...DEFAULT_THEME_COLORS];
};

export const mount = ({ mountNode, navigate }) => {
    const appShell = mountNode.querySelector('[data-role="app-shell"]');
    const authWrap = mountNode.querySelector('[data-role="app-auth-wrap"]');

    const loginForm = mountNode.querySelector('[data-role="app-login-form"]');
    const loginUsername = mountNode.querySelector("#app-login-username");
    const loginPassword = mountNode.querySelector("#app-login-password");
    const loginSubmit = mountNode.querySelector('[data-role="app-login-submit"]');
    const joinTokenInput = mountNode.querySelector('[data-role="app-join-token"]');
    const joinSubmit = mountNode.querySelector('[data-role="app-join-submit"]');
    const authErrorEl = mountNode.querySelector('[data-role="app-auth-error"]');
    const authQrVideo = mountNode.querySelector('[data-role="app-qr-video"]');
    const authQrStatus = mountNode.querySelector('[data-role="app-qr-status"]');
    const authQrStart = mountNode.querySelector('[data-role="app-qr-start"]');
    const authQrStop = mountNode.querySelector('[data-role="app-qr-stop"]');

    const logoutButton = mountNode.querySelector('[data-role="app-logout"]');
    const playPauseButton = mountNode.querySelector("#artist-play-toggle");
    const stopButton = mountNode.querySelector("#artist-stop-toggle");
    const connectionStatusEl = mountNode.querySelector('[data-role="connection-status"]');
    const currentArtistEl = mountNode.querySelector('[data-role="current-artist"]');
    const artistLiveIndicator = mountNode.querySelector('[data-role="artist-live-indicator"]');
    const trackLabelEls = mountNode.querySelectorAll('[data-role="app-track-label"]');

    const speakerOffsetSlider = mountNode.querySelector('[data-role="global-speaker-offset"]');
    const metronomeToggle = mountNode.querySelector('[data-role="global-metronome-toggle"]');
    const noiseFloorToggle = mountNode.querySelector('[data-role="global-noise-floor-toggle"]');

    const artistWrap = mountNode.querySelector('[data-role="app-artist-wrap"]');
    const artistRoot = mountNode.querySelector('[data-role="app-artist-root"]');

    const tempTroupeWrap = mountNode.querySelector('[data-role="app-temp-troupe-create-wrap"]');
    const tempTroupeForm = mountNode.querySelector('[data-role="temp-troupe-create-form"]');
    const tempTroupeSubmit = mountNode.querySelector('[data-role="temp-troupe-create-submit"]');
    const tempTroupeMessage = mountNode.querySelector('[data-role="temp-troupe-create-message"]');
    const tempTroupeUsername = mountNode.querySelector("#temp-troupe-username");
    const tempTroupePassword = mountNode.querySelector("#temp-troupe-password");
    const tempTroupeEmail = mountNode.querySelector("#temp-troupe-email");

    const memberWrap = mountNode.querySelector('[data-role="app-member-edit-wrap"]');
    const memberForm = mountNode.querySelector('[data-role="member-edit-form"]');
    const memberSubmit = mountNode.querySelector('[data-role="member-edit-submit"]');
    const memberMessage = mountNode.querySelector('[data-role="member-edit-message"]');
    const memberCurrentPassword = mountNode.querySelector("#member-current-password");
    const memberNewUsername = mountNode.querySelector("#member-new-username");
    const memberNewPassword = mountNode.querySelector("#member-new-password");

    const directorPerformanceWrap = mountNode.querySelector('[data-role="app-director-performance-wrap"]');
    const directorLiveDj = mountNode.querySelector('[data-role="director-live-dj"]');
    const directorBpm = mountNode.querySelector('[data-role="director-bpm"]');
    const directorPerformanceToggle = mountNode.querySelector('[data-role="director-performance-toggle"]');
    const directorJoinQr = mountNode.querySelector('[data-role="director-join-qr"]');
    const directorJoinUrl = mountNode.querySelector('[data-role="director-join-url"]');

    const directorAccountsWrap = mountNode.querySelector('[data-role="app-director-accounts-wrap"]');
    const directorAccountCreateForm = mountNode.querySelector('[data-role="director-account-create-form"]');
    const directorAccountCreateSubmit = mountNode.querySelector('[data-role="director-account-create-submit"]');
    const directorAccountMessage = mountNode.querySelector('[data-role="director-account-message"]');
    const directorAccountUsername = mountNode.querySelector("#director-account-username");
    const directorAccountPassword = mountNode.querySelector("#director-account-password");
    const directorAccountDisplayName = mountNode.querySelector("#director-account-display-name");

    const directorAccountEditForm = mountNode.querySelector('[data-role="director-account-edit-form"]');
    const directorAccountSelect = mountNode.querySelector('[data-role="director-account-select"]');
    const directorAccountEditUsername = mountNode.querySelector('[data-role="director-account-edit-username"]');
    const directorAccountEditPassword = mountNode.querySelector('[data-role="director-account-edit-password"]');
    const directorAccountEditEmail = mountNode.querySelector('[data-role="director-account-edit-email"]');

    if (
        !appShell
        || !authWrap
        || !loginForm
        || !loginUsername
        || !loginPassword
        || !loginSubmit
        || !joinTokenInput
        || !joinSubmit
        || !authErrorEl
        || !authQrVideo
        || !authQrStatus
        || !authQrStart
        || !authQrStop
        || !logoutButton
        || !playPauseButton
        || !stopButton
        || !connectionStatusEl
        || !currentArtistEl
        || !artistLiveIndicator
        || !trackLabelEls.length
        || !speakerOffsetSlider
        || !metronomeToggle
        || !noiseFloorToggle
        || !artistWrap
        || !artistRoot
        || !tempTroupeWrap
        || !tempTroupeForm
        || !tempTroupeSubmit
        || !tempTroupeMessage
        || !tempTroupeUsername
        || !tempTroupePassword
        || !tempTroupeEmail
        || !memberWrap
        || !memberForm
        || !memberSubmit
        || !memberMessage
        || !memberCurrentPassword
        || !memberNewUsername
        || !memberNewPassword
        || !directorPerformanceWrap
        || !directorLiveDj
        || !directorBpm
        || !directorPerformanceToggle
        || !directorJoinQr
        || !directorJoinUrl
        || !directorAccountsWrap
        || !directorAccountCreateForm
        || !directorAccountCreateSubmit
        || !directorAccountMessage
        || !directorAccountUsername
        || !directorAccountPassword
        || !directorAccountDisplayName
        || !directorAccountEditForm
        || !directorAccountSelect
        || !directorAccountEditUsername
        || !directorAccountEditPassword
        || !directorAccountEditEmail
    ) {
        return () => {};
    }

    let state = getAppState();
    let authBusy = false;
    let cleanupTroupe = () => {};
    let cleanupArtist = () => {};
    let roleMountKey = "";
    let directorPollTimer = 0;
    let artistIsLive = false;

    const setAuthQrStatus = (message) => {
        authQrStatus.textContent = message || "";
    };

    const onScannerToken = async (token) => {
        const value = String(token || "").trim();
        if (!value) {
            return;
        }
        joinTokenInput.value = value;
        setAuthQrStatus("Joining performance...");
        const result = await loginTroupeSim(value);
        if (!result.ok) {
            setAuthQrStatus(result.error || "Join failed");
            return;
        }
        setAuthQrStatus("Joined performance.");
    };

    const qrScanner = createQrScanner({
        videoEl: authQrVideo,
        onStatus: setAuthQrStatus,
        onToken: (token) => {
            void onScannerToken(token);
        },
    });

    const drumPulseSynth = createDrumPulseSynth({
        getPulseState: () => state.pulse,
        getLatencySeconds: () => Number(state.pulse.speakerLatencyCompensationSeconds) || 0,
        getNoiseFloorEnabled: () => state.pulse.noiseFloorEnabled !== false,
    });

    const setAuthBusy = (busy) => {
        authBusy = Boolean(busy);
        loginSubmit.disabled = authBusy;
        joinSubmit.disabled = authBusy;
    };

    const renderConnection = () => {
        const connected = state.pulse.connectionStatus === "connected";
        connectionStatusEl.textContent = state.pulse.connectionStatus;
        connectionStatusEl.classList.toggle("ui-status--connected", connected);
        connectionStatusEl.classList.toggle("ui-status--not-connected", !connected);

        const liveDjId = String(state.performance.liveDjUserId || "");
        const liveDj = state.director.djs.find((dj) => dj.id === liveDjId);
        currentArtistEl.textContent = liveDj?.displayName || liveDj?.username || liveDj?.id || "-";

        const role = String(state.auth.user?.role || "");
        const isLiveArtist = isArtistRole(role) && Boolean(state.performance.active) && state.auth.user?.id === liveDjId;
        artistIsLive = isLiveArtist;
        appShell.classList.toggle("app-shell--artist-live", isLiveArtist);
        artistLiveIndicator.hidden = !isLiveArtist;
        playPauseButton.hidden = !isArtistRole(role);
        playPauseButton.disabled = !isLiveArtist;
        stopButton.hidden = !isArtistRole(role);
        stopButton.disabled = !isLiveArtist;
    };

    const renderSettings = () => {
        const effective = Number(state.pulse.speakerLatencyCompensationSeconds) || 0;
        const offsetMs = Math.max(0, Math.min(MAX_SPEAKER_OFFSET_MS, Math.round(effective * 1000)));
        const sliderValue = MAX_SPEAKER_OFFSET_MS - offsetMs;
        speakerOffsetSlider.value = String(sliderValue);
        noiseFloorToggle.checked = state.pulse.noiseFloorEnabled !== false;
        metronomeToggle.checked = drumPulseSynth.isRunning();
    };

    const renderTrackLabels = () => {
        const fallbackLabels = Array.from({ length: 8 }, (_, idx) => `Track ${idx + 1}`);
        const lastActionSongId = String(state.performance?.lastAction?.songId || "");
        const activeSongId = String(state.dj?.activeSongId || "");
        const songs = Array.isArray(state.dj?.songs) ? state.dj.songs : [];
        const currentSong = songs.find((song) => song.id === lastActionSongId)
            || songs.find((song) => song.id === activeSongId)
            || songs[0]
            || null;
        const labels = currentSong
            ? fallbackLabels.map((fallback, idx) => String(currentSong?.tracks?.[idx]?.title || "").trim() || fallback)
            : fallbackLabels;
        for (const labelEl of trackLabelEls) {
            const trackNumber = Math.max(1, Math.min(8, Number(labelEl.getAttribute("data-track-label") || "1")));
            labelEl.textContent = labels[trackNumber - 1] || `Track ${trackNumber}`;
        }
    };

    const applyThemeColors = () => {
        const [bg, surface, accent, text, muted] = normalizeThemeColors(state.performance.themeColors);
        const root = document.documentElement;
        root.style.setProperty("--theme-bg", bg);
        root.style.setProperty("--theme-surface", surface);
        root.style.setProperty("--theme-accent", accent);
        root.style.setProperty("--theme-text", text);
        root.style.setProperty("--theme-muted", muted);
    };

    const renderDirectorControls = () => {
        const djs = Array.isArray(state.director.djs) ? state.director.djs : [];
        const currentSelection = String(state.performance.liveDjUserId || "");
        directorLiveDj.innerHTML = [`<option value="">select live artist</option>`, ...djs.map((dj) => {
            const label = dj.displayName ? `${dj.displayName} (${dj.username})` : dj.username;
            const selected = currentSelection === dj.id ? " selected" : "";
            return `<option value="${dj.id}"${selected}>${label}</option>`;
        })].join("");

        directorBpm.value = String(Number(state.performance.bpm || 120));

        const isRunning = Boolean(state.performance.active);
        directorPerformanceToggle.dataset.running = isRunning ? "true" : "false";
        directorPerformanceToggle.textContent = isRunning ? "End Performance" : "Start Performance";

        const joinUrl = toJoinUrl(state.performance.sessionToken || "");
        directorJoinUrl.textContent = joinUrl;
        const qrUrl = state.performance.sessionToken ? createQrImageUrl(joinUrl, { size: 320 }) : "";
        if (qrUrl) {
            directorJoinQr.src = qrUrl;
            directorJoinQr.hidden = false;
        } else {
            directorJoinQr.hidden = true;
            directorJoinQr.removeAttribute("src");
        }

        const accounts = Array.isArray(state.director.accounts) ? state.director.accounts : [];
        const selectedUserId = String(directorAccountSelect.value || "");
        directorAccountSelect.innerHTML = [`<option value="">select username</option>`, ...accounts.map((account) => {
            const selected = selectedUserId === account.id ? " selected" : "";
            return `<option value="${account.id}"${selected}>${account.username}</option>`;
        })].join("");
    };

    const syncRoleModules = () => {
        if (!state.auth.authenticated) {
            roleMountKey = "";
            cleanupTroupe();
            cleanupArtist();
            cleanupTroupe = () => {};
            cleanupArtist = () => {};
            if (directorPollTimer) {
                window.clearInterval(directorPollTimer);
                directorPollTimer = 0;
            }
            return;
        }

        const role = String(state.auth.user?.role || "");
        const key = `${role}|${state.auth.user?.id || ""}`;
        if (key === roleMountKey) {
            return;
        }
        roleMountKey = key;

        cleanupTroupe();
        cleanupArtist();
        cleanupTroupe = mountTroupe({ mountNode, navigate: navigate || (() => {}) });
        cleanupArtist = isArtistRole(role)
            ? mountArtistLaunchers({ mountNode: artistRoot, navigate: navigate || (() => {}) })
            : () => {};

        if (directorPollTimer) {
            window.clearInterval(directorPollTimer);
            directorPollTimer = 0;
        }
        if (role === "director") {
            void loadDirectorState();
            void directorListAccounts();
            directorPollTimer = window.setInterval(() => {
                void loadDirectorState();
                void directorListAccounts();
            }, 2000);
        }
    };

    const renderVisibility = () => {
        const authenticated = state.auth.authenticated === true;
        appShell.hidden = !authenticated;
        authWrap.hidden = authenticated;
        if (authenticated) {
            qrScanner.stop();
        }

        if (!authenticated) {
            return;
        }

        const role = String(state.auth.user?.role || "");
        artistWrap.hidden = !isArtistRole(role);
        directorPerformanceWrap.hidden = role !== "director";
        directorAccountsWrap.hidden = role !== "director";
        memberWrap.hidden = !(role === "member" || isArtistRole(role));
        tempTroupeWrap.hidden = !(role === "troupe" && state.auth.user?.id === "troupe_user_01");
    };

    const render = () => {
        applyThemeColors();
        renderVisibility();
        renderConnection();
        renderSettings();
        renderTrackLabels();
        if (state.auth.user?.role === "director") {
            renderDirectorControls();
        }
    };

    const onLogin = async (event) => {
        event.preventDefault();
        if (authBusy) return;
        setAuthBusy(true);
        setTextMessage(authErrorEl, "");
        const result = await loginDj({
            username: loginUsername.value,
            password: loginPassword.value,
        });
        setAuthBusy(false);
        if (!result.ok) {
            setTextMessage(authErrorEl, result.error || "Login failed");
            return;
        }
        loginPassword.value = "";
    };

    const onJoin = async () => {
        if (authBusy) return;
        setAuthBusy(true);
        setTextMessage(authErrorEl, "");
        const token = extractSessionToken(joinTokenInput.value) || joinTokenInput.value;
        const result = await loginTroupeSim(token);
        setAuthBusy(false);
        if (!result.ok) {
            setTextMessage(authErrorEl, result.error || "Join failed");
            setAuthQrStatus(result.error || "Join failed");
            return;
        }
        setAuthQrStatus("Joined performance.");
    };

    const onLogout = async () => {
        qrScanner.stop();
        await logout();
    };

    const onSpeakerOffsetInput = () => {
        if (!state.auth.authenticated) return;
        const sliderValue = clampNumber(speakerOffsetSlider.value, 0, MAX_SPEAKER_OFFSET_MS, MAX_SPEAKER_OFFSET_MS);
        const offsetMs = MAX_SPEAKER_OFFSET_MS - sliderValue;
        setSpeakerLatencyCompensationSeconds(offsetMs / 1000);
    };

    const onNoiseFloorInput = () => {
        if (!state.auth.authenticated) return;
        const enabled = Boolean(noiseFloorToggle.checked);
        setNoiseFloorEnabled(enabled);
        drumPulseSynth.setNoiseFloorEnabled(enabled);
    };

    const onMetronomeInput = async () => {
        if (!state.auth.authenticated) return;
        if (metronomeToggle.checked) {
            const started = await drumPulseSynth.start().catch(() => false);
            persistDrumPulseEnabled(Boolean(started));
            if (!started) {
                metronomeToggle.checked = false;
            }
            return;
        }
        drumPulseSynth.stop();
        persistDrumPulseEnabled(false);
    };

    const onQrStart = async () => {
        try {
            await qrScanner.start();
        } catch (error) {
            setAuthQrStatus(error?.message || "Unable to start scanner.");
        }
    };

    const onQrStop = () => {
        qrScanner.stop();
        setAuthQrStatus("Scanner stopped.");
    };

    const onTempTroupeCreate = async (event) => {
        event.preventDefault();
        tempTroupeSubmit.disabled = true;
        setTextMessage(tempTroupeMessage, "");
        const result = await createTroupeAccount({
            username: tempTroupeUsername.value,
            password: tempTroupePassword.value,
            email: tempTroupeEmail.value,
        });
        tempTroupeSubmit.disabled = false;
        if (!result.ok) {
            setTextMessage(tempTroupeMessage, result.error || "Unable to create troupe account");
            return;
        }
        tempTroupePassword.value = "";
        setTextMessage(tempTroupeMessage, "Troupe account created");
    };

    const onMemberEdit = async (event) => {
        event.preventDefault();
        memberSubmit.disabled = true;
        setTextMessage(memberMessage, "");
        const result = await djChangeCredentials({
            currentPassword: memberCurrentPassword.value,
            newUsername: memberNewUsername.value,
            newPassword: memberNewPassword.value,
        });
        memberSubmit.disabled = false;
        if (!result.ok) {
            setTextMessage(memberMessage, result.error || "Failed to update credentials");
            return;
        }
        memberCurrentPassword.value = "";
        memberNewPassword.value = "";
        setTextMessage(memberMessage, "Credentials updated");
    };

    const onDirectorPerformanceToggle = async () => {
        const isRunning = directorPerformanceToggle.dataset.running === "true";
        if (!isRunning) {
            const selectedDjUserId = String(directorLiveDj.value || "").trim();
            if (selectedDjUserId) {
                await directorSetLiveDj(selectedDjUserId);
            }
            const bpm = clampNumber(directorBpm.value, 60, 220, 120);
            await directorSetTempo(bpm);
            await directorStartPerformance();
            return;
        }
        if (window.confirm("End performance now?")) {
            await directorEndPerformance();
        }
    };

    const onDirectorLiveDjChange = async () => {
        const selected = String(directorLiveDj.value || "").trim();
        if (!selected) return;
        await directorSetLiveDj(selected);
    };

    const onDirectorBpmChange = async () => {
        const bpm = clampNumber(directorBpm.value, 60, 220, 120);
        await directorSetTempo(bpm);
    };

    const onDirectorCreateAccount = async (event) => {
        event.preventDefault();
        directorAccountCreateSubmit.disabled = true;
        setTextMessage(directorAccountMessage, "");
        const result = await directorCreateAccount({
            username: directorAccountUsername.value,
            password: directorAccountPassword.value,
            email: directorAccountDisplayName.value,
        });
        directorAccountCreateSubmit.disabled = false;
        if (!result.ok) {
            setTextMessage(directorAccountMessage, result.error || "Failed to create account");
            return;
        }
        directorAccountUsername.value = "";
        directorAccountPassword.value = "";
        directorAccountDisplayName.value = "";
        setTextMessage(directorAccountMessage, "Account created");
        await directorListAccounts();
    };

    const onDirectorEditAccount = async (event) => {
        event.preventDefault();
        const userId = String(directorAccountSelect.value || "").trim();
        if (!userId) {
            setTextMessage(directorAccountMessage, "Select an account first");
            return;
        }
        const payload = {};
        if (directorAccountEditUsername.value.trim()) payload.username = directorAccountEditUsername.value.trim();
        if (directorAccountEditPassword.value) payload.password = directorAccountEditPassword.value;
        if (directorAccountEditEmail.value.trim()) payload.email = directorAccountEditEmail.value.trim();
        if (Object.keys(payload).length === 0) {
            setTextMessage(directorAccountMessage, "No changes to save");
            return;
        }
        const result = await directorUpdateAccount(userId, payload);
        if (!result.ok) {
            setTextMessage(directorAccountMessage, result.error || "Failed to save account");
            return;
        }
        directorAccountEditPassword.value = "";
        setTextMessage(directorAccountMessage, "Account updated");
        await directorListAccounts();
    };

    const unsubscribe = subscribeAppState((nextState) => {
        state = nextState;
        drumPulseSynth.setNoiseFloorEnabled(state.pulse.noiseFloorEnabled !== false);
        render();
        syncRoleModules();
    });

    loginForm.addEventListener("submit", onLogin);
    joinSubmit.addEventListener("click", onJoin);
    logoutButton.addEventListener("click", onLogout);
    authQrStart.addEventListener("click", onQrStart);
    authQrStop.addEventListener("click", onQrStop);

    speakerOffsetSlider.addEventListener("input", onSpeakerOffsetInput);
    noiseFloorToggle.addEventListener("input", onNoiseFloorInput);
    metronomeToggle.addEventListener("input", onMetronomeInput);

    tempTroupeForm.addEventListener("submit", onTempTroupeCreate);
    memberForm.addEventListener("submit", onMemberEdit);

    directorPerformanceToggle.addEventListener("click", onDirectorPerformanceToggle);
    directorLiveDj.addEventListener("change", onDirectorLiveDjChange);
    directorBpm.addEventListener("change", onDirectorBpmChange);
    directorAccountCreateForm.addEventListener("submit", onDirectorCreateAccount);
    directorAccountEditForm.addEventListener("submit", onDirectorEditAccount);

    ensurePulseTransportConnected();
    void loadPerformanceState();

    if (readStoredDrumPulseEnabled()) {
        // Respect stored preference, but do not auto-start audio without a user toggle.
        metronomeToggle.checked = false;
    }
    if (!artistIsLive) {
        playPauseButton.disabled = true;
        stopButton.disabled = true;
    }
    setAuthQrStatus("Camera scanner idle.");

    render();
    syncRoleModules();

    return () => {
        unsubscribe();
        cleanupTroupe();
        cleanupArtist();
        drumPulseSynth.destroy();
        if (directorPollTimer) {
            window.clearInterval(directorPollTimer);
        }

        loginForm.removeEventListener("submit", onLogin);
        joinSubmit.removeEventListener("click", onJoin);
        logoutButton.removeEventListener("click", onLogout);
        authQrStart.removeEventListener("click", onQrStart);
        authQrStop.removeEventListener("click", onQrStop);
        qrScanner.stop();

        speakerOffsetSlider.removeEventListener("input", onSpeakerOffsetInput);
        noiseFloorToggle.removeEventListener("input", onNoiseFloorInput);
        metronomeToggle.removeEventListener("input", onMetronomeInput);

        tempTroupeForm.removeEventListener("submit", onTempTroupeCreate);
        memberForm.removeEventListener("submit", onMemberEdit);

        directorPerformanceToggle.removeEventListener("click", onDirectorPerformanceToggle);
        directorLiveDj.removeEventListener("change", onDirectorLiveDjChange);
        directorBpm.removeEventListener("change", onDirectorBpmChange);
        directorAccountCreateForm.removeEventListener("submit", onDirectorCreateAccount);
        directorAccountEditForm.removeEventListener("submit", onDirectorEditAccount);
    };
};
