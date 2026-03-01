/* Shared API fetch helper for pulse frontend modules */

const getDefaultApiBaseUrl = () => {
    if (typeof window !== "undefined" && typeof window.PULSE_API_BASE_URL === "string" && window.PULSE_API_BASE_URL.trim()) {
        return window.PULSE_API_BASE_URL.trim().replace(/\/$/, "");
    }
    if (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
        return "http://127.0.0.1:3001";
    }
    return "https://api.porchlogic.com";
};

export const createApiClient = ({ baseUrl = getDefaultApiBaseUrl() } = {}) => {
    const request = async (path, options = {}) => {
        const headers = {
            ...(options.headers || {}),
        };
        if (!("Content-Type" in headers) && options.body !== undefined) {
            headers["Content-Type"] = "application/json";
        }

        const response = await fetch(`${baseUrl}${path}`, {
            method: options.method || "GET",
            headers,
            credentials: "include",
            body: options.rawBody !== undefined
                ? options.rawBody
                : options.body !== undefined
                    ? JSON.stringify(options.body)
                    : undefined,
        });

        let payload = null;
        try {
            payload = await response.json();
        } catch {
            payload = null;
        }

        if (!response.ok) {
            const message = payload && typeof payload.error === "string"
                ? payload.error
                : `Request failed (${response.status})`;
            throw new Error(message);
        }

        return payload;
    };

    return {
        baseUrl,
        request,
    };
};
