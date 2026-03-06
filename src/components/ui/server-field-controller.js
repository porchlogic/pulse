/* Reusable controller for server-backed form fields with local draft + explicit apply commit. */

export const mountServerFieldController = ({
    inputEl,
    applyButton,
    readServerValue = () => "",
    isServerValueReady = () => true,
    formatPendingValue = () => "",
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

    const syncDirtyClasses = () => {
        inputEl.classList.toggle("ui-input--dirty", hasDraftValue);
        applyButton.classList.toggle("ui-button--dirty", hasDraftValue);
    };

    const sync = () => {
        const ready = Boolean(isServerValueReady());
        const isEditing = document.activeElement === inputEl;
        if (!isEditing && !hasDraftValue) {
            inputEl.value = ready
                ? formatServerValue(readServerValue())
                : formatPendingValue();
        }
        const editable = ready && Boolean(canEdit());
        inputEl.disabled = !editable || applying;
        applyButton.disabled = !editable || applying || !hasDraftValue;
        syncDirtyClasses();
    };

    const onInput = () => {
        hasDraftValue = true;
        sync();
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
    inputEl.addEventListener("change", onInput);
    inputEl.addEventListener("keydown", onKeyDown);
    applyButton.addEventListener("click", onApplyClick);
    sync();

    return {
        sync,
        destroy: () => {
            inputEl.removeEventListener("input", onInput);
            inputEl.removeEventListener("change", onInput);
            inputEl.removeEventListener("keydown", onKeyDown);
            applyButton.removeEventListener("click", onApplyClick);
            inputEl.classList.remove("ui-input--dirty");
            applyButton.classList.remove("ui-button--dirty");
        },
    };
};
