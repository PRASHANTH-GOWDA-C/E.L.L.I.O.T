// JSX-like templates without a build step: html`<${Box}>…<//>`.
import { createElement } from 'react';
import htm from 'htm';

export const html = htm.bind(createElement);
