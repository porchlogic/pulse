/* Shared beat display renderer with simple pulse animation classes. */

import { getAbsoluteBeatNow, getBeatInBar } from "./beat-time.js";

export const mountBeatDisplay = ({
    beatEl,
    getPulseState,
} = {}) => {
    if (!beatEl || typeof getPulseState !== "function") {
        return () => {};
    }

    let rafId = 0;
    let lastAbsoluteBeat = null;

    const render = () => {
        const pulseState = getPulseState();
        const beatInBar = getBeatInBar(pulseState);
        const absoluteBeat = getAbsoluteBeatNow(pulseState);
        beatEl.textContent = String(beatInBar);

        if (absoluteBeat !== lastAbsoluteBeat) {
            beatEl.classList.remove("ui-beat-display--pulse");
            void beatEl.offsetWidth;
            beatEl.classList.add("ui-beat-display--pulse");
            beatEl.classList.toggle("ui-beat-display--downbeat", beatInBar === 1);
            lastAbsoluteBeat = absoluteBeat;
        }

        rafId = window.requestAnimationFrame(render);
    };

    render();

    return () => {
        if (rafId) {
            window.cancelAnimationFrame(rafId);
        }
    };
};
