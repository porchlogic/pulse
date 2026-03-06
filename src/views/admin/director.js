/* Director route entry for choosing live DJ and controlling performance tempo/session. */

import {
    ensurePulseTransportConnected,
    directorCreateAccount,
    directorDeleteAccount,
    directorEndPerformance,
    directorListAccounts,
    directorSetLiveDj,
    directorSetTempo,
    directorStartPerformance,
    directorUpdateAccount,
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

const escapeHtml = (value) => String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatDate = (iso) => {
    if (!iso) {
        return "-";
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return "-";
    }
    return date.toLocaleString();
};

const buildAccountRow = (account) => `
    <article class="ui-section" data-role="director-account-row" data-account-id="${escapeHtml(account.id)}" style="margin-top: 0.75rem;">
        <div class="ui-row-between" style="gap: 0.5rem; flex-wrap: wrap;">
            <div class="ui-field" style="margin: 0; min-width: 12rem; flex: 1;">
                <label class="ui-label">username</label>
                <input class="ui-input" data-role="director-account-username" type="text" value="${escapeHtml(account.username)}">
            </div>
            <div class="ui-field" style="margin: 0; min-width: 12rem; flex: 1;">
                <label class="ui-label">email</label>
                <input class="ui-input" data-role="director-account-email" type="email" value="${escapeHtml(account.email || "")}">
            </div>
            <div class="ui-field" style="margin: 0; min-width: 12rem; flex: 1;">
                <label class="ui-label">reset password</label>
                <input class="ui-input" data-role="director-account-password" type="password" placeholder="leave blank to keep">
            </div>
        </div>
        <div class="ui-row-between" style="gap: 0.5rem; flex-wrap: wrap; margin-top: 0.5rem;">
            <p class="ui-label" style="margin: 0;">status: ${account.isActive ? "active" : "inactive"} | created: ${escapeHtml(formatDate(account.createdAt))} | last login: ${escapeHtml(formatDate(account.lastLoginAt))}</p>
            <div class="ui-row-between" style="gap: 0.5rem;">
                <button type="button" class="ui-button ui-button--small" data-role="director-account-save">Save</button>
                <button type="button" class="ui-button ui-button--small" data-role="director-account-toggle">${account.isActive ? "Deactivate" : "Reactivate"}</button>
                <button type="button" class="ui-button ui-button--small" data-role="director-account-delete">Delete</button>
            </div>
        </div>
    </article>
`;

export const mount = ({ mountNode }) => {
    const loginForm = mountNode.querySelector("[data-role=\"director-login-form\"]");
    const passwordInput = mountNode.querySelector("#director-password");
    const errorEl = mountNode.querySelector("[data-role=\"director-error\"]");
    const controls = mountNode.querySelector("[data-role=\"director-controls\"]");
    const accountControls = mountNode.querySelector("[data-role=\"director-account-controls\"]");
    const accountCreateForm = mountNode.querySelector("[data-role=\"director-account-create-form\"]");
    const accountCreateUsername = mountNode.querySelector("#director-account-username");
    const accountCreatePassword = mountNode.querySelector("#director-account-password");
    const accountCreateDisplayName = mountNode.querySelector("#director-account-display-name");
    const accountCreateSubmit = mountNode.querySelector("[data-role=\"director-account-create-submit\"]");
    const accountMessageEl = mountNode.querySelector("[data-role=\"director-account-message\"]");
    const accountListEl = mountNode.querySelector("[data-role=\"director-account-list\"]");
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

    if (
        !loginForm
        || !passwordInput
        || !errorEl
        || !controls
        || !accountControls
        || !accountCreateForm
        || !accountCreateUsername
        || !accountCreatePassword
        || !accountCreateDisplayName
        || !accountCreateSubmit
        || !accountMessageEl
        || !accountListEl
        || !joinUrlEl
        || !joinQrEl
        || !startButton
        || !endButton
        || !logoutButton
        || !liveDjSelect
        || !bpmInput
        || !applyBpmButton
        || !connectionStatusEl
        || !beatEl
    ) {
        return () => {};
    }

    let state = getAppState();
    let pollTimer = 0;
    let cleanupBeatDisplay = () => {};
    let directorStateLoadInFlight = false;
    let lastDirectorAuthKey = "";
    let cleanupTempoControl = () => {};

    const isDirectorAuthenticated = () => Boolean(state.auth.authenticated && state.auth.user?.role === "director");

    const setAccountMessage = (text) => {
        if (!text) {
            accountMessageEl.hidden = true;
            return;
        }
        accountMessageEl.hidden = false;
        accountMessageEl.textContent = text;
    };

    const ensureDirectorStateLoaded = async () => {
        if (!isDirectorAuthenticated() || directorStateLoadInFlight) {
            return;
        }
        directorStateLoadInFlight = true;
        try {
            await loadDirectorState();
            await directorListAccounts();
        } finally {
            directorStateLoadInFlight = false;
        }
    };

    const renderAccounts = () => {
        const accounts = Array.isArray(state.director.accounts) ? state.director.accounts : [];
        if (accounts.length === 0) {
            accountListEl.innerHTML = "<p class=\"ui-label\">No artist accounts yet.</p>";
            return;
        }
        accountListEl.innerHTML = accounts.map((account) => buildAccountRow(account)).join("");
    };

    const render = () => {
        const isDirector = state.auth.authenticated && state.auth.user?.role === "director";
        loginForm.hidden = isDirector;
        controls.hidden = !isDirector;
        accountControls.hidden = !isDirector;
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
        const djOptions = state.director.djs.length > 0 ? state.director.djs : [];
        liveDjSelect.innerHTML = djOptions.map((dj) => {
            const label = dj.displayName ? `${dj.displayName} (${dj.username})` : dj.username;
            return `<option value="${dj.id}" ${state.performance.liveDjUserId === dj.id ? "selected" : ""}>${label}</option>`;
        }).join("");
        tempoControl.sync();

        if (state.director.error) {
            setAccountMessage(state.director.error);
        }
        renderAccounts();
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

    const onAccountCreate = async (event) => {
        event.preventDefault();
        accountCreateSubmit.disabled = true;
        setAccountMessage("");
        const result = await directorCreateAccount({
            username: accountCreateUsername.value,
            password: accountCreatePassword.value,
            email: accountCreateDisplayName.value,
        });
        accountCreateSubmit.disabled = false;
        if (!result.ok) {
            setAccountMessage(result.error || "Failed to create account");
            return;
        }
        accountCreateUsername.value = "";
        accountCreatePassword.value = "";
        accountCreateDisplayName.value = "";
        setAccountMessage("Artist account created");
        await ensureDirectorStateLoaded();
    };

    const onAccountListClick = async (event) => {
        const actionButton = event.target.closest("button[data-role]");
        if (!actionButton) {
            return;
        }
        const row = actionButton.closest("[data-role=\"director-account-row\"]");
        if (!row) {
            return;
        }
        const userId = String(row.dataset.accountId || "");
        if (!userId) {
            return;
        }

        const usernameInput = row.querySelector("[data-role=\"director-account-username\"]");
        const displayNameInput = row.querySelector("[data-role=\"director-account-email\"]");
        const passwordField = row.querySelector("[data-role=\"director-account-password\"]");
        const account = state.director.accounts.find((item) => item.id === userId);
        if (!(usernameInput instanceof HTMLInputElement) || !(displayNameInput instanceof HTMLInputElement) || !(passwordField instanceof HTMLInputElement) || !account) {
            return;
        }

        setAccountMessage("");
        actionButton.disabled = true;

        if (actionButton.dataset.role === "director-account-save") {
            const payload = {};
            if (usernameInput.value.trim() !== account.username) {
                payload.username = usernameInput.value.trim();
            }
            if (displayNameInput.value.trim() !== (account.email || "")) {
                payload.email = displayNameInput.value.trim();
            }
            if (passwordField.value) {
                payload.password = passwordField.value;
            }
            if (Object.keys(payload).length === 0) {
                actionButton.disabled = false;
                setAccountMessage("No changes to save");
                return;
            }
            const result = await directorUpdateAccount(userId, payload);
            actionButton.disabled = false;
            if (!result.ok) {
                setAccountMessage(result.error || "Failed to update account");
                return;
            }
            passwordField.value = "";
            setAccountMessage("Account updated");
            await ensureDirectorStateLoaded();
            return;
        }

        if (actionButton.dataset.role === "director-account-toggle") {
            const result = await directorUpdateAccount(userId, { isActive: !account.isActive });
            actionButton.disabled = false;
            if (!result.ok) {
                setAccountMessage(result.error || "Failed to update account status");
                return;
            }
            setAccountMessage(account.isActive ? "Account deactivated" : "Account reactivated");
            await ensureDirectorStateLoaded();
            return;
        }

        if (actionButton.dataset.role === "director-account-delete") {
            const result = await directorDeleteAccount(userId);
            actionButton.disabled = false;
            if (!result.ok) {
                setAccountMessage(result.error || "Failed to delete account");
                return;
            }
            setAccountMessage("Account deleted (deactivated)");
            await ensureDirectorStateLoaded();
            return;
        }

        actionButton.disabled = false;
    };

    const tempoControl = mountTempoControl({
        inputEl: bpmInput,
        applyButton: applyBpmButton,
        getCurrentBpm: () => Number(state.performance.bpm || 120),
        isServerValueReady: () => Boolean(state.performance.updatedAt),
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
    accountCreateForm.addEventListener("submit", onAccountCreate);
    accountListEl.addEventListener("click", onAccountListClick);

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
        accountCreateForm.removeEventListener("submit", onAccountCreate);
        accountListEl.removeEventListener("click", onAccountListClick);
        cleanupTempoControl();
        if (pollTimer) {
            window.clearInterval(pollTimer);
        }
    };
};
