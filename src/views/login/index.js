/* Login route entry */

import { loginDj } from "../../state.js";

export const mount = ({ mountNode, navigate }) => {
    const form = mountNode.querySelector("[data-role=\"dj-login-form\"]");
    const emailInput = mountNode.querySelector("#dj-email");
    const passwordInput = mountNode.querySelector("#dj-password");
    const errorEl = mountNode.querySelector("[data-role=\"login-error\"]");
    const submitButton = mountNode.querySelector("[data-role=\"login-submit\"]");

    if (!form || !emailInput || !passwordInput || !errorEl || !submitButton) {
        return () => {};
    }

    const onSubmit = async (event) => {
        event.preventDefault();
        errorEl.hidden = true;
        submitButton.disabled = true;

        const result = await loginDj({
            email: emailInput.value,
            password: passwordInput.value,
        });

        submitButton.disabled = false;
        if (result.ok) {
            navigate("dj");
            return;
        }

        errorEl.textContent = result.error || "Login failed";
        errorEl.hidden = false;
    };

    form.addEventListener("submit", onSubmit);
    return () => {
        form.removeEventListener("submit", onSubmit);
    };
};
