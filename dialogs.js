/**
 * Small in-app dialogs (text entry and choices). They are built with DOM APIs and safe text only,
 * so names and phrases are never interpreted as markup.
 */
const COLORS = [['lime', 'Lime'], ['purple', 'Violet'], ['blue', 'Blue'], ['orange', 'Orange'], ['pink', 'Pink']];

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function shell(id, eyebrow, title) {
    document.getElementById(id)?.remove();
    const dialog = element('dialog', 'app-dialog'); dialog.id = id;
    const head = element('div', 'dialog-title');
    const heading = element('div');
    if (eyebrow) heading.append(element('div', 'eyebrow', eyebrow));
    heading.append(element('h2', '', title));
    const close = element('button', 'icon-button', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close');
    head.append(heading, close);
    dialog.append(head);
    document.body.append(dialog);
    return { dialog, close };
}

/** Asks for a name (and optionally a pad color). Resolves null on cancel. */
export function askText({ id = 'textDialog', eyebrow = '', title, label = 'Name', value = '', confirm = 'Save', maxLength = 80, colors = false, color = 'lime', help = '' }) {
    return new Promise(resolve => {
        const { dialog, close } = shell(id, eyebrow, title);
        const form = element('form');
        const labelNode = element('label', '', label); labelNode.htmlFor = `${id}Input`;
        const input = element('input'); input.id = `${id}Input`; input.maxLength = maxLength; input.value = value; input.required = true; input.autocomplete = 'off';
        form.append(labelNode, input);
        if (help) form.append(element('p', 'field-help', help));
        let swatches = null;
        if (colors) {
            form.append(element('span', 'swatch-label', 'Pad color'));
            swatches = element('div', 'swatches');
            for (const [value, name] of COLORS) {
                const option = element('label', `swatch ${value}`);
                const radio = element('input'); radio.type = 'radio'; radio.name = `${id}Color`; radio.value = value; radio.checked = value === color;
                option.append(radio, element('span'), element('em', '', name));
                swatches.append(option);
            }
            form.append(swatches);
        }
        const error = element('p', 'form-error'); error.hidden = true; error.setAttribute('role', 'alert');
        const actions = element('div', 'dialog-actions');
        const cancel = element('button', 'text-button', 'Cancel'); cancel.type = 'button';
        const ok = element('button', 'primary', confirm); ok.type = 'submit';
        actions.append(element('span'), element('div', 'action-group'));
        actions.lastChild.append(cancel, ok);
        form.append(error, actions);
        dialog.append(form);
        let result = null;
        form.onsubmit = event => {
            event.preventDefault();
            const text = input.value.trim();
            if (!text) { error.textContent = 'Enter a name.'; error.hidden = false; return; }
            result = { text, color: swatches?.querySelector('input:checked')?.value || color };
            dialog.close();
        };
        cancel.onclick = () => dialog.close();
        close.onclick = () => dialog.close();
        dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
        dialog.showModal();
        input.select();
    });
}

/** Chooses one option from a list, optionally creating a new one by name. Resolves { value } | { newName } | null. */
export function askPick({ id = 'pickDialog', eyebrow = '', title, label = 'Choose', options, allowNew = false, newLabel = 'New…', confirm = 'Choose' }) {
    return new Promise(resolve => {
        const { dialog, close } = shell(id, eyebrow, title);
        const form = element('form');
        const labelNode = element('label', '', label); labelNode.htmlFor = `${id}Select`;
        const select = element('select'); select.id = `${id}Select`;
        for (const option of options) select.add(new Option(option.label, option.value));
        if (allowNew) select.add(new Option(newLabel, '__new'));
        const nameLabel = element('label', '', 'Name'); nameLabel.htmlFor = `${id}Name`;
        const name = element('input'); name.id = `${id}Name`; name.maxLength = 60; name.autocomplete = 'off';
        const toggleName = () => { const show = select.value === '__new'; nameLabel.hidden = name.hidden = !show; if (show) name.focus(); };
        select.onchange = toggleName;
        const error = element('p', 'form-error'); error.hidden = true;
        const actions = element('div', 'dialog-actions');
        const cancel = element('button', 'text-button', 'Cancel'); cancel.type = 'button';
        const ok = element('button', 'primary', confirm); ok.type = 'submit';
        actions.append(element('span'), element('div', 'action-group')); actions.lastChild.append(cancel, ok);
        form.append(labelNode, select, nameLabel, name, error, actions);
        dialog.append(form);
        let result = null;
        form.onsubmit = event => {
            event.preventDefault();
            if (select.value === '__new') {
                if (!name.value.trim()) { error.textContent = 'Enter a name.'; error.hidden = false; return; }
                result = { newName: name.value.trim() };
            } else if (select.value) result = { value: select.value };
            dialog.close();
        };
        cancel.onclick = () => dialog.close();
        close.onclick = () => dialog.close();
        dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
        dialog.showModal();
        toggleName();
    });
}

/** Offers a set of choices. Resolves with the chosen id, or null when dismissed. */
export function askChoice({ id = 'choiceDialog', eyebrow = '', title, message = '', choices }) {
    return new Promise(resolve => {
        const { dialog, close } = shell(id, eyebrow, title);
        if (message) dialog.append(element('p', 'dialog-message', message));
        const actions = element('div', 'dialog-actions choice-actions');
        let result = null;
        for (const choice of choices) {
            const button = element('button', choice.primary ? 'primary' : choice.danger ? 'danger' : 'secondary', choice.label);
            button.type = 'button'; button.dataset.choice = choice.id;
            button.onclick = () => { result = choice.id; dialog.close(); };
            actions.append(button);
        }
        dialog.append(actions);
        close.onclick = () => dialog.close();
        dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
        dialog.showModal();
        actions.querySelector('.primary')?.focus();
    });
}
