/* Director route entry for choosing live DJ and controlling performance tempo/session. */

import {
    ensurePulseTransportConnected,
    directorEndPerformance,
    directorSetLiveDj,
    directorSetTempo,
    directorStartPerformance,
    getAppState,
    loadDirectorState,
    loginDirector,
    logout,
    subscribeAppState,
} from "../../state.js";
import { createQrImageUrl } from "../../components/util/qr.js";
import { mountBeatDisplay } from "../../components/clock/beat-display.js";
import { mountTempoControl } from "../../components/ui/tempo-control.js";

const makeJoinUrl = (token) => {
    if (!token) {
        return "not started";
    }
    return `${window.location.origin}${window.location.pathname}?session=${token}#join`;
};

export const mount = ({ mountNode }) => {
    const loginForm = mountNode.querySelector("[data-role=\"director-login-form\"]");
    const passwordInput = mountNode.querySelector("#director-password");
    const errorEl = mountNode.querySelector("[data-role=\"director-error\"]");
    const controls = mountNode.querySelector("[data-role=\"director-controls\"]");
    const connectionStatusEl = mountNode.querySelector("[data-role=\"director-connection-status\"]");
    const beatEl = mountNode.querySelector("[data-role=\"director-current-beat\"]");
    const joinUrlEl = mountNode.querySelector("[data-role=\"director-join-url\"]");
    const joinQrEl = mountNode.querySelector("[data-role=\"director-join-qr\"]");
    const startButton = mountNode.querySelector("[data-role=\"director-start\"]");
    const endButton = mountNode.querySelector("[data-role=\"director-end\"]");
    const logoutButton = mountNode.querySelector("[data-role=\"director-logout\"]");
    const liveDjSelect = mountNode.querySelector("[data-role=\"director-live-dj\"]");
    const bpmInput = mountNode.querySelector("[data-role=\"director-bpm\"]");
    const applyBpmButton = mountNode.querySelector("[data-role=\"director-set-bpm\"]");

    if (!loginForm || !passwordInput || !errorEl || !controls || !joinUrlEl || !joinQrEl || !startButton || !endButton || !logoutButton || !liveDjSelect || !bpmInput || !applyBpmButton || !connectionStatusEl || !beatEl) {
        return () => {};
    }

    let state = getAppState();
    let pollTimer = 0;
    let cleanupBeatDisplay = () => {};
    let directorStateLoadInFlight = false;
    let lastDirectorAuthKey = "";
    let cleanupTempoControl = () => {};

    const isDirectorAuthenticated = () => Boolean(state.auth.authenticated && state.auth.user?.role === "director");

    const ensureDirectorStateLoaded = async () => {
        if (!isDirectorAuthenticated() || directorStateLoadInFlight) {
            return;
        }
        directorStateLoadInFlight = true;
        try {
            await loadDirectorState();
        } finally {
            directorStateLoadInFlight = false;
        }
    };

    const render = () => {
        const isDirector = state.auth.authenticated && state.auth.user?.role === "director";
        loginForm.hidden = isDirector;
        controls.hidden = !isDirector;
        if (!isDirector) {
            return;
        }

        const isConnected = state.pulse.connectionStatus === "connected";
        connectionStatusEl.classList.toggle("ui-status--connected", isConnected);
        connectionStatusEl.classList.toggle("ui-status--not-connected", !isConnected);
        connectionStatusEl.textContent = state.pulse.connectionStatus;

        const joinUrl = makeJoinUrl(state.performance.sessionToken);
        joinUrlEl.textContent = joinUrl;
        const qrUrl = state.performance.sessionToken ? createQrImageUrl(joinUrl, { size: 320 }) : "";
        if (qrUrl) {
            joinQrEl.src = qrUrl;
            joinQrEl.hidden = false;
        } else {
            joinQrEl.hidden = true;
            joinQrEl.removeAttribute("src");
        }
        const djOptions = state.director.djs.length > 0 ? state.director.djs : [{ id: "dj_user_01", email: "dj@porchlogic.com" }];
        liveDjSelect.innerHTML = djOptions.map((dj) => (
            `<option value="${dj.id}" ${state.performance.liveDjUserId === dj.id ? "selected" : ""}>${dj.email}</option>`
        )).join("");
        tempoControl.sync();
    };

    const onSubmit = async (event) => {
        event.preventDefault();
        const result = await loginDirector(passwordInput.value);
        if (!result.ok) {
            errorEl.textContent = result.error || "Login failed";
            errorEl.hidden = false;
            return;
        }
        errorEl.hidden = true;
        await ensureDirectorStateLoaded();
    };

    const onStart = async () => {
        const selectedDjUserId = String(liveDjSelect.value || "").trim();
        if (selectedDjUserId) {
            await directorSetLiveDj(selectedDjUserId);
        }
        await directorStartPerformance();
    };

    const onEnd = async () => {
        await directorEndPerformance();
    };

    const onLiveDjChange = async () => {
        await directorSetLiveDj(liveDjSelect.value);
    };

    const onLogout = async () => {
        await logout();
    };

    const tempoControl = mountTempoControl({
        inputEl: bpmInput,
        applyButton: applyBpmButton,
        getCurrentBpm: () => Number(state.performance.bpm || 120),
        canEdit: () => isDirectorAuthenticated(),
        onApply: async (bpm) => {
            await directorSetTempo(bpm);
        },
    });
    cleanupTempoControl = tempoControl.destroy;

    const unsubscribe = subscribeAppState((next) => {
        state = next;
        const authKey = `${state.auth.authenticated ? "1" : "0"}:${state.auth.user?.role || ""}:${state.auth.user?.id || ""}`;
        if (authKey !== lastDirectorAuthKey) {
            lastDirectorAuthKey = authKey;
            if (isDirectorAuthenticated()) {
                void ensureDirectorStateLoaded();
            }
        }
        render();
    });

    loginForm.addEventListener("submit", onSubmit);
    startButton.addEventListener("click", onStart);
    endButton.addEventListener("click", onEnd);
    liveDjSelect.addEventListener("change", onLiveDjChange);
    logoutButton.addEventListener("click", onLogout);

    pollTimer = window.setInterval(() => {
        void ensureDirectorStateLoaded();
    }, 2000);
    ensurePulseTransportConnected();
    cleanupBeatDisplay = mountBeatDisplay({
        beatEl,
        getPulseState: () => state.pulse,
    });
    render();

    return () => {
        cleanupBeatDisplay();
        unsubscribe();
        loginForm.removeEventListener("submit", onSubmit);
        startButton.removeEventListener("click", onStart);
        endButton.removeEventListener("click", onEnd);
        liveDjSelect.removeEventListener("change", onLiveDjChange);
        logoutButton.removeEventListener("click", onLogout);
        cleanupTempoControl();
        if (pollTimer) {
            window.clearInterval(pollTimer);
        }
    };
};
