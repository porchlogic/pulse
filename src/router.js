/* Single-shell app router: always mount unified app view at root. */

import { initializeAuth } from "./state.js";

const APP_TEMPLATE_URL = new URL("./views/app/index.html", import.meta.url);
const APP_MODULE_URL = new URL("./views/app/index.js", import.meta.url);
const VERSION_URL = new URL("../version.json", import.meta.url);

let renderVersion = 0;
let activeCleanup = null;
let cachedTemplate = "";
let cachedModule = null;
let cacheBustTokenPromise = null;

const getCacheBustToken = async () => {
    if (cacheBustTokenPromise) {
        return cacheBustTokenPromise;
    }
    cacheBustTokenPromise = (async () => {
        try {
            const response = await fetch(VERSION_URL, { cache: "no-store" });
            if (!response.ok) {
                throw new Error("version unavailable");
            }
            const payload = await response.json();
            const version = String(payload?.version || "").trim();
            return version || String(Date.now());
        } catch {
            return String(Date.now());
        }
    })();
    return cacheBustTokenPromise;
};

const loadTemplate = async (route) => {
    if (cachedTemplate) {
        return cachedTemplate;
    }

    const cacheBustToken = await getCacheBustToken();
    const templateUrl = new URL(APP_TEMPLATE_URL);
    templateUrl.searchParams.set("v", cacheBustToken);
    const response = await fetch(templateUrl, { cache: "no-store" });
    if (!response.ok) {
        throw new Error("Failed to load app template");
    }

    const html = await response.text();
    cachedTemplate = html;
    return html;
};

const loadRouteModule = async (route) => {
    if (cachedModule) {
        return cachedModule;
    }
    const cacheBustToken = await getCacheBustToken();
    const moduleUrl = new URL(APP_MODULE_URL);
    moduleUrl.searchParams.set("v", cacheBustToken);
    const module = await import(moduleUrl.href);
    cachedModule = module;
    return module;
};

const cleanupActiveRoute = () => {
    if (typeof activeCleanup === "function") {
        activeCleanup();
    }
    activeCleanup = null;
};

const renderRoute = async () => {
    await initializeAuth();
    const mount = document.getElementById("app-view");
    if (!mount) {
        return;
    }

    const currentVersion = ++renderVersion;

    try {
        const [template, routeModule] = await Promise.all([
            loadTemplate("app"),
            loadRouteModule("app"),
        ]);
        if (currentVersion !== renderVersion) {
            return;
        }

        cleanupActiveRoute();
        mount.innerHTML = template;

        if (routeModule && typeof routeModule.mount === "function") {
            const cleanup = routeModule.mount({
                route: "app",
                mountNode: mount,
                navigate: () => {},
            });
            if (typeof cleanup === "function") {
                activeCleanup = cleanup;
            }
        }
    } catch (error) {
        cleanupActiveRoute();
        mount.innerHTML = "<section class=\"ui-section\"><p>Unable to load screen.</p></section>";
        console.error(error);
    }
};

export const initRouter = () => {
    if (window.location.hash) {
        history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
    }
    void renderRoute();
};
