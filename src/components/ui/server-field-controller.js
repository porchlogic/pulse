/* Reusable controller for server-backed form fields with local draft + explicit apply commit. */

export const mountServerFieldController = ({
    inputEl,
    applyButton,
    readServerValue = () => "",
    formatServerValue = (value) => String(value ?? ""),
    parseDraftValue = (rawValue) => ({ ok: true, value: rawValue }),
    canEdit = () => true,
    commitValue = async () => {},
    onValidationError = () => {},
    onCommitError = () => {},
} = {}) => {
    if (!inputEl || !applyButton) {
        return {
            sync: () => {},
            destroy: () => {},
        };
    }

    let applying = false;
    let hasDraftValue = false;

    const sync = () => {
        const isEditing = document.activeElement === inputEl;
        if (!isEditing && !hasDraftValue) {
            inputEl.value = formatServerValue(readServerValue());
        }
        const editable = Boolean(canEdit());
        inputEl.disabled = !editable || applying;
        applyButton.disabled = !editable || applying;
    };

    const onInput = () => {
        hasDraftValue = true;
    };

    const apply = async () => {
        if (!canEdit() || applying) {
            return;
        }
        const parsed = parseDraftValue(inputEl.value);
        if (!parsed || parsed.ok !== true) {
            onValidationError(parsed);
            return;
        }

        applying = true;
        sync();
        try {
            await commitValue(parsed.value);
            hasDraftValue = false;
        } catch (error) {
            onCommitError(error);
        } finally {
            applying = false;
            sync();
        }
    };

    const onApplyClick = (event) => {
        event.preventDefault();
        void apply();
    };

    const onKeyDown = (event) => {
        if (event.key !== "Enter") {
            return;
        }
        event.preventDefault();
        void apply();
    };

    inputEl.addEventListener("input", onInput);
    inputEl.addEventListener("keydown", onKeyDown);
    applyButton.addEventListener("click", onApplyClick);
    sync();

    return {
        sync,
        destroy: () => {
            inputEl.removeEventListener("input", onInput);
            inputEl.removeEventListener("keydown", onKeyDown);
            applyButton.removeEventListener("click", onApplyClick);
        },
    };
};
