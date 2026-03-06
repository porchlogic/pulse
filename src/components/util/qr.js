/* Reusable QR helpers for generating codes and scanning session tokens. */

const QR_API_BASE = "https://api.qrserver.com/v1/create-qr-code/";
const JSQR_SCRIPT_SRC = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";

export const createQrImageUrl = (text, { size = 256 } = {}) => {
    const safeText = String(text || "").trim();
    if (!safeText) {
        return "";
    }
    const clampedSize = Math.max(96, Math.min(1024, Math.trunc(size)));
    const query = new URLSearchParams({
        size: `${clampedSize}x${clampedSize}`,
        data: safeText,
    });
    return `${QR_API_BASE}?${query.toString()}`;
};

export const extractSessionToken = (value) => {
    const raw = String(value || "").trim();
    if (!raw) {
        return "";
    }

    try {
        const parsed = new URL(raw);
        const token = parsed.searchParams.get("session");
        if (token && token.trim()) {
            return token.trim();
        }
    } catch {
        // Treat as non-URL fallback token.
    }

    const match = raw.match(/[a-f0-9]{8,32}/i);
    return match ? match[0] : "";
};

export const createQrScanner = ({ videoEl, onToken = () => {}, onStatus = () => {} } = {}) => {
    let stream = null;
    let detector = null;
    let jsQrDecode = null;
    let frameCanvas = null;
    let frameContext = null;
    let animationFrameId = 0;
    let active = false;

    const ensureJsQrDecoder = async () => {
        if (typeof window === "undefined") {
            return null;
        }
        if (typeof window.jsQR === "function") {
            return window.jsQR;
        }
        await new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = JSQR_SCRIPT_SRC;
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error("Failed to load QR decoder"));
            document.head.appendChild(script);
        });
        return typeof window.jsQR === "function" ? window.jsQR : null;
    };

    const ensureFrameCanvas = () => {
        if (!frameCanvas) {
            frameCanvas = document.createElement("canvas");
            frameContext = frameCanvas.getContext("2d", { willReadFrequently: true });
        }
        return Boolean(frameCanvas && frameContext);
    };

    const stop = () => {
        active = false;
        if (animationFrameId) {
            window.cancelAnimationFrame(animationFrameId);
            animationFrameId = 0;
        }
        if (stream) {
            for (const track of stream.getTracks()) {
                track.stop();
            }
            stream = null;
        }
        if (videoEl) {
            videoEl.srcObject = null;
        }
        frameCanvas = null;
        frameContext = null;
    };

    const detectFrame = async () => {
        if (!active || !videoEl) {
            return;
        }
        try {
            if (detector) {
                const results = await detector.detect(videoEl);
                for (const result of results) {
                    const token = extractSessionToken(result.rawValue || "");
                    if (token) {
                        onToken(token);
                        onStatus("QR scanned.");
                        stop();
                        return;
                    }
                }
            } else if (jsQrDecode && ensureFrameCanvas()) {
                const width = Math.max(2, Math.trunc(videoEl.videoWidth || 0));
                const height = Math.max(2, Math.trunc(videoEl.videoHeight || 0));
                if (width > 1 && height > 1) {
                    frameCanvas.width = width;
                    frameCanvas.height = height;
                    frameContext.drawImage(videoEl, 0, 0, width, height);
                    const imageData = frameContext.getImageData(0, 0, width, height);
                    const decoded = jsQrDecode(imageData.data, width, height, { inversionAttempts: "dontInvert" });
                    const token = extractSessionToken(decoded?.data || "");
                    if (token) {
                        onToken(token);
                        onStatus("QR scanned.");
                        stop();
                        return;
                    }
                }
            }
        } catch {
            // Keep scanning on transient detector/decoder errors.
        }
        animationFrameId = window.requestAnimationFrame(() => {
            void detectFrame();
        });
    };

    const start = async () => {
        if (!videoEl) {
            onStatus("Scanner unavailable: missing video element.");
            return false;
        }
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
            onStatus("Camera access unavailable in this browser. Paste code manually.");
            return false;
        }
        if (active) {
            return true;
        }

        if ("BarcodeDetector" in window) {
            const formats = await window.BarcodeDetector.getSupportedFormats();
            if (formats.includes("qr_code")) {
                detector = new window.BarcodeDetector({ formats: ["qr_code"] });
            }
        }

        if (!detector) {
            jsQrDecode = await ensureJsQrDecoder();
            if (!jsQrDecode) {
                onStatus("QR scanning unavailable. Paste code manually.");
                return false;
            }
            onStatus("Using fallback scanner...");
        }

        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: "environment" },
            },
            audio: false,
        });
        videoEl.srcObject = stream;
        await videoEl.play();
        active = true;
        onStatus("Scanning for QR code...");
        void detectFrame();
        return true;
    };

    return {
        start,
        stop,
    };
};
