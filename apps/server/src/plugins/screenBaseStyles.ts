/**
 * The base stylesheet, served to every screen at `./_t3/base.css` and linked first in every
 * page, so plain HTML looks like T3 Code. It sits in a cascade layer, so the screen's own
 * styles always win.
 *
 * It uses only the `--t3-*` tokens the runtime sets on the frame root
 * (`apps/web/src/components/plugins/pluginScreenTheme.ts` lists them), never fixed colors,
 * so it follows the user's theme and text size live. No transitions or animations.
 */
export const SCREEN_BASE_STYLESHEET_SOURCE = `/* A cascade layer, so any unlayered screen style wins whatever its specificity. */
@layer t3-base {
  :root {
    font-size: var(--t3-font-size);
    font-family: var(--t3-font-sans);
    line-height: 1.5;
    background: var(--t3-color-canvas);
    color: var(--t3-color-text);
    accent-color: var(--t3-color-accent);
    scrollbar-color: var(--t3-color-border) transparent;
    -webkit-text-size-adjust: 100%;
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    font-size: 0.875rem;
  }

  h1, h2, h3, h4 {
    margin: 0 0 0.5em;
    font-weight: 600;
    line-height: 1.25;
  }

  h1 { font-size: 1.25rem; }
  h2 { font-size: 1.125rem; }
  h3 { font-size: 1rem; }
  h4 { font-size: 0.875rem; }

  p {
    margin: 0 0 0.75em;
  }

  small {
    color: var(--t3-color-text-muted);
  }

  a {
    color: var(--t3-color-accent);
    text-decoration: none;
    text-underline-offset: 2px;
  }

  a:hover {
    text-decoration: underline;
  }

  hr {
    border: 0;
    border-top: 1px solid var(--t3-color-border);
    margin: 1rem 0;
  }

  :focus-visible {
    outline: 2px solid var(--t3-color-focus);
    outline-offset: 1px;
  }

  button,
  input,
  select,
  textarea {
    font: inherit;
    color: inherit;
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    min-height: 2rem;
    padding: 0 0.75rem;
    border: 1px solid var(--t3-color-border);
    border-radius: var(--t3-radius-md);
    background: var(--t3-color-secondary);
    color: var(--t3-color-secondary-foreground);
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
  }

  button:hover {
    background: var(--t3-color-muted);
  }

  button:disabled,
  input:disabled,
  select:disabled,
  textarea:disabled {
    opacity: 0.64;
    cursor: not-allowed;
  }

  input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"]),
  select,
  textarea {
    min-height: 2rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--t3-color-input);
    border-radius: var(--t3-radius-md);
    background: var(--t3-color-surface);
  }

  textarea {
    resize: vertical;
  }

  ::placeholder {
    color: var(--t3-color-text-muted);
    opacity: 1;
  }

  code,
  kbd,
  samp,
  pre {
    font-family: var(--t3-font-mono);
    font-size: var(--t3-font-size-code);
  }

  code,
  kbd {
    padding: 0.1em 0.3em;
    border-radius: var(--t3-radius-sm);
    background: var(--t3-color-code-background);
    color: var(--t3-color-code-foreground);
  }

  pre {
    margin: 0 0 0.75em;
    padding: 0.75rem;
    overflow: auto;
    border: 1px solid var(--t3-color-border);
    border-radius: var(--t3-radius-lg);
    background: var(--t3-color-code-background);
    color: var(--t3-color-code-foreground);
  }

  pre code {
    padding: 0;
    background: none;
  }

  table {
    border-collapse: collapse;
  }

  th,
  td {
    padding: 0.375rem 0.5rem;
    border-bottom: 1px solid var(--t3-color-border);
    text-align: left;
  }

  /* Engines without scrollbar-color (Safari) use these; others ignore them. */
  ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }

  ::-webkit-scrollbar-track {
    background: transparent;
  }

  ::-webkit-scrollbar-thumb {
    background: var(--t3-color-border);
    border-radius: 3px;
  }
}
`;
