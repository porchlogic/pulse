/* Screen/view switching for the Pulse experience */

import { canAccessRoute, getFallbackRouteForAuth, initializeAuth } from "./state.js";

const VALID_ROUTES = new Set(["default", "login", "join", "troupe", "dj", "perform", "director"]);
const ROUTE_TEMPLATES = {
    default: new URL("./views/default/index.html", import.meta.url),
    login: new URL("./views/login/index.html", import.meta.url),
    join: new URL("./views/troupe/join.html", import.meta.url),
    troupe: new URL("./views/troupe/index.html", import.meta.url),
    dj: new URL("./views/dj/index.html", import.meta.url),
    perform: new URL("./views/dj/perform.html", import.meta.url),
    director: new URL("./views/admin/director.html", import.meta.url),
};
const ROUTE_MODULES = {
    default: new URL("./views/default/index.js", import.meta.url),
    login: new URL("./views/login/index.js", import.meta.url),
    join: new URL("./views/troupe/join.js", import.meta.url),
    troupe: new URL("./views/troupe/index.js", import.meta.url),
    dj: new URL("./views/dj/index.js", import.meta.url),
    perform: new URL("./views/dj/perform.js", import.meta.url),
    director: new URL("./views/admin/director.js", import.meta.url),
};

const templateCache = new Map();
const moduleCache = new Map();
let renderVersion = 0;
let activeCleanup = null;

const normalizeRoute = (route) => {
    const next = String(route || "").trim().toLowerCase();
    return VALID_ROUTES.has(next) ? next : "default";
};

const getRouteFromHash = () => normalizeRoute(window.location.hash.slice(1));

const loadTemplate = async (route) => {
    if (templateCache.has(route)) {
        return templateCache.get(route);
    }

    const response = await fetch(ROUTE_TEMPLATES[route]);
    if (!response.ok) {
        throw new Error(`Failed to load route template: ${route}`);
    }

    const html = await response.text();
    templateCache.set(route, html);
    return html;
};

const isPublicRoute = (route) => route === "default" || route === "login" || route === "join";

const loadRouteModule = async (route) => {
    if (!ROUTE_MODULES[route]) {
        return null;
    }
    if (moduleCache.has(route)) {
        return moduleCache.get(route);
    }

    const module = await import(ROUTE_MODULES[route]);
    moduleCache.set(route, module);
    return module;
};

const cleanupActiveRoute = () => {
    if (typeof activeCleanup === "function") {
        activeCleanup();
    }
    activeCleanup = null;
};

const renderRoute = async (route) => {
    const requestedScreen = normalizeRoute(route);
    if (!isPublicRoute(requestedScreen)) {
        await initializeAuth();
    }
    const screen = canAccessRoute(requestedScreen)
        ? requestedScreen
        : getFallbackRouteForAuth(requestedScreen);
    if (screen !== requestedScreen) {
        navigate(screen);
        return;
    }
    const mount = document.getElementById("app-view");
    if (!mount) {
        return;
    }

    const currentVersion = ++renderVersion;

    try {
        const [template, routeModule] = await Promise.all([
            loadTemplate(screen),
            loadRouteModule(screen),
        ]);
        if (currentVersion !== renderVersion) {
            return;
        }

        cleanupActiveRoute();
        mount.innerHTML = template;

        if (routeModule && typeof routeModule.mount === "function") {
            const cleanup = routeModule.mount({
                route: screen,
                mountNode: mount,
                navigate,
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

const navigate = (route) => {
    const next = normalizeRoute(route);
    window.location.hash = next;
};

export const initRouter = () => {
    document.addEventListener("click", (event) => {
        const button = event.target.closest("[data-nav]");
        if (!button) {
            return;
        }

        event.preventDefault();
        navigate(button.dataset.nav);
    });

    window.addEventListener("hashchange", () => {
        void renderRoute(getRouteFromHash());
    });

    void renderRoute(getRouteFromHash());
};
