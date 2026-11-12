// Deadlines: dates you must not miss. (The list and drawer follow in the next commits.)
import { h } from '../ui.js';

export async function render() {
    return h('div', { class: 'view deadlines' }, h('p', { class: 'lede', text: 'Dates you must not miss.' }));
}
