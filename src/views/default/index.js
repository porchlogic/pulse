/* Unified default entry behavior: scan to join temporary troupe session or log in by username/password. */

import { loginMember, loginTroupeSim } from "../../state.js";
import { createQrScanner, extractSessionToken } from "../../components/util/qr.js";

export const mount = ({ mountNode, navigate }) => {
    const form = mountNode.querySelector("[data-role=\"member-login-form\"]");
    const usernameInput = mountNode.querySelector("#member-username");
    const passwordInput = mountNode.querySelector("#member-password");
    const errorEl = mountNode.querySelector("[data-role=\"member-login-error\"]");
    const submitButton = mountNode.querySelector("[data-role=\"member-login-submit\"]");
    const startButton = mountNode.querySelector("[data-role=\"qr-start\"]");
    const stopButton = mountNode.querySelector("[data-role=\"qr-stop\"]");
    const manualJoinButton = mountNode.querySelector("[data-role=\"manual-join\"]");
    const codeInput = mountNode.querySelector("[data-role=\"join-code-input\"]");
    const statusEl = mountNode.querySelector("[data-role=\"qr-status\"]");
    const videoEl = mountNode.querySelector("[data-role=\"qr-video\"]");

    if (
        !form
        || !usernameInput
        || !passwordInput
        || !errorEl
        || !submitButton
        || !startButton
        || !stopButton
        || !manualJoinButton
        || !codeInput
        || !statusEl
        || !videoEl
    ) {
        return () => {};
    }

    const setStatus = (text) => {
        statusEl.textContent = text;
    };

    const applySessionTokenToUrl = (token) => {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set("session", token);
        nextUrl.hash = "default";
        window.history.replaceState({}, "", nextUrl);
    };

    const joinWithToken = async (token) => {
        if (!token) {
            setStatus("Missing session token.");
            return;
        }
        applySessionTokenToUrl(token);
        setStatus("Joining performance...");
        const result = await loginTroupeSim(token);
        if (!result.ok) {
            setStatus(result.error || "Join failed.");
            return;
        }
        navigate("app");
    };

    const scanner = createQrScanner({
        videoEl,
        onStatus: setStatus,
        onToken: (token) => {
            void joinWithToken(token);
        },
    });

    const onSubmit = async (event) => {
        event.preventDefault();
        errorEl.hidden = true;
        submitButton.disabled = true;
        const result = await loginMember({
            username: usernameInput.value,
            password: passwordInput.value,
        });
        submitButton.disabled = false;
        if (result.ok) {
            navigate("app");
            return;
        }
        errorEl.textContent = result.error || "Login failed";
        errorEl.hidden = false;
    };

    const onStartScan = async () => {
        try {
            await scanner.start();
        } catch (error) {
            setStatus(error.message || "Unable to start scanner.");
        }
    };

    const onStopScan = () => {
        scanner.stop();
        setStatus("Scanner stopped.");
    };

    const onManualJoin = async () => {
        const token = extractSessionToken(codeInput.value);
        await joinWithToken(token);
    };

    const existingToken = extractSessionToken(new URLSearchParams(window.location.search).get("session") || "");
    if (existingToken) {
        codeInput.value = existingToken;
        setStatus("Session token detected in URL.");
    }

    form.addEventListener("submit", onSubmit);
    startButton.addEventListener("click", onStartScan);
    stopButton.addEventListener("click", onStopScan);
    manualJoinButton.addEventListener("click", onManualJoin);

    return () => {
        scanner.stop();
        form.removeEventListener("submit", onSubmit);
        startButton.removeEventListener("click", onStartScan);
        stopButton.removeEventListener("click", onStopScan);
        manualJoinButton.removeEventListener("click", onManualJoin);
    };
};
