/**
 * Window helpers shared by every ApplicationV2 in this module.
 *
 * Foundry keys an application's DOM element and its entry in
 * `foundry.applications.instances` by the id computed in the constructor from
 * `options.id`. Overriding the `id` getter afterwards changes neither, so a window that
 * must be one-per-document has to receive its id through the constructor options.
 */

/**
 * Make a value safe to use inside a DOM id.
 * @param {*} value A document id or uuid.
 * @returns {string}
 */
export function domSafe(value) {
  return String(value ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "-");
}

/**
 * Add a control to an Application V2 window header.
 *
 * Application V1 sheets are served by their `get…HeaderButtons` hooks instead, which is
 * why this returns early for them: V1 rebuilds its header only on the first render, and
 * a V2-style button pushed into it looks and behaves out of place.
 *
 * @param {object} app The rendered application.
 * @param {HTMLElement} html Its root element.
 * @param {object} control
 * @param {string} control.cssClass Marker class, also used to avoid duplicates.
 * @param {string} control.icon Font Awesome classes.
 * @param {string} control.tooltip Localisation key for the tooltip and accessible name.
 * @param {() => void} control.onClick Click handler.
 * @returns {void}
 */
export function injectHeaderControl(app, html, { cssClass, icon, tooltip, onClick }) {
  if (!(app instanceof foundry.applications.api.ApplicationV2)) return;
  const header = app.window?.header ?? html?.closest?.(".application")?.querySelector(".window-header");
  if (!header || header.querySelector(`.${cssClass}`)) return;

  const label = game.i18n.localize(tooltip);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `header-control icon ${icon} ${cssClass}`;
  button.dataset.tooltip = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  const close = header.querySelector("[data-action='close']");
  header.insertBefore(button, close ?? null);
}

/**
 * Focus a window that is already open under this id, or build and render a new one.
 *
 * Two instances sharing an id fight over one DOM element: the second replaces the first
 * one's markup while the first keeps its own state, and a second render started while
 * the first is still rendering is dropped by core without a word. Reusing the open
 * window avoids both.
 *
 * @param {string} id The application id.
 * @param {() => object} create Builds the application when none is open.
 * @returns {object} The open application.
 */
export function openOrFocus(id, create) {
  const { RENDERING, RENDERED } = foundry.applications.api.ApplicationV2.RENDER_STATES;
  const existing = foundry.applications.instances.get(id);
  if (existing?.state === RENDERED) {
    // A forced render maximizes the window and brings it to the front.
    existing.render({ force: true });
    return existing;
  }
  // Still on its first render: it will appear on its own, and a second instance would
  // only be dropped by core.
  if (existing?.state === RENDERING) return existing;
  const app = create();
  app.render({ force: true });
  return app;
}
