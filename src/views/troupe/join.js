/* Join route entry: simulate troupe QR login for now */

import { loginTroupeSim } from "../../state.js";
import { createQrScanner, extractSessionToken } from "../../components/util/qr.js";

export const mount = ({ mountNode, navigate }) => {
    const simulateButton = mountNode.querySelector("[data-role=\"simulate-qr-join\"]");
    const startButton = mountNode.querySelector("[data-role=\"qr-start\"]");
    const stopButton = mountNode.querySelector("[data-role=\"qr-stop\"]");
    const manualJoinButton = mountNode.querySelector("[data-role=\"manual-join\"]");
    const codeInput = mountNode.querySelector("[data-role=\"join-code-input\"]");
    const statusEl = mountNode.querySelector("[data-role=\"qr-status\"]");
    const videoEl = mountNode.querySelector("[data-role=\"qr-video\"]");

    if (!simulateButton || !startButton || !stopButton || !manualJoinButton || !codeInput || !statusEl || !videoEl) {
        return () => {};
    }

    const setStatus = (text) => {
        statusEl.textContent = text;
    };

    const applySessionTokenToUrl = (token) => {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set("session", token);
        nextUrl.hash = "join";
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
        if (result.ok) {
            navigate("troupe");
            return;
        }
        setStatus(result.error || "Join failed.");
    };

    const scanner = createQrScanner({
        videoEl,
        onStatus: setStatus,
        onToken: (token) => {
            void joinWithToken(token);
        },
    });

    const onSimulateClick = async () => {
        const token = extractSessionToken(new URLSearchParams(window.location.search).get("session") || "");
        await joinWithToken(token);
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

    simulateButton.addEventListener("click", onSimulateClick);
    startButton.addEventListener("click", onStartScan);
    stopButton.addEventListener("click", onStopScan);
    manualJoinButton.addEventListener("click", onManualJoin);

    return () => {
        scanner.stop();
        simulateButton.removeEventListener("click", onSimulateClick);
        startButton.removeEventListener("click", onStartScan);
        stopButton.removeEventListener("click", onStopScan);
        manualJoinButton.removeEventListener("click", onManualJoin);
    };
};
