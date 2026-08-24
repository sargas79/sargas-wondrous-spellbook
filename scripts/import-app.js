/**
 * The "Import from Character Sheet" window.
 *
 * Reads the spells a character already has and stores them as a spellbook, either as a
 * new book or merged into one that exists. Nothing is written to the actor: this window
 * only ever reads a sheet and writes a JournalEntry.
 *
 * Ticking rows updates the summary line and the Import button in place rather than
 * re-rendering, so the list never scrolls back to the top mid-selection.
 */

import { MODULE_ID, template } from "./constants.js";
import {
  collectActorSpells,
  importIntoSpellbook,
  listImportTargets,
  listImportableActors
} from "./import-spells.js";
import { resolveTargetActor } from "./slot-manager.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ImportApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {object} [options]
   * @param {object} [options.actor] Actor to import from. Resolved from the current
   *   selection when omitted.
   */
  constructor(options = {}) {
    super(options);

    /**
     * The actor being read. An explicit actor always wins; a selection-resolved one is
     * only taken when it actually has spells, so opening the window off a spell-less
     * assigned character still lands on a sheet worth importing.
     * @type {object|null}
     */
    this.actor = options.actor ?? ImportApp.#resolveDefaultActor();

    /** @type {{ groups: object[], total: number, unlinked: number, rituals: number }|null} */
    this.data = null;

    /** @type {Set<string>} Ids of the owned spell items ticked for import. */
    this.selection = new Set();

    /** @type {string} Name used when the destination is a new spellbook. */
    this.bookName = "";

    /** @type {string} Id of the spellbook to merge into, or "" for a new one. */
    this.targetId = "";

    /** @type {boolean} True while the sheet is being read. */
    this.loading = false;
  }

  /**
   * The sheet to open on when the caller named none.
   * @returns {object|null}
   */
  static #resolveDefaultActor() {
    const importable = listImportableActors();
    const resolved = resolveTargetActor()?.actor ?? null;
    if (resolved && importable.some((actor) => actor.id === resolved.id)) return resolved;
    return importable[0] ?? null;
  }

  /** @inheritdoc */
  static DEFAULT_OPTIONS = {
    id: "bws-import",
    classes: ["bws", "bws-import"],
    tag: "div",
    window: {
      title: "BWS.Import.Title",
      icon: "fa-solid fa-file-import",
      resizable: true
    },
    position: { width: 560, height: 620 },
    actions: {
      selectAll: ImportApp.#onSelectAll,
      selectNone: ImportApp.#onSelectNone,
      import: ImportApp.#onImport,
      cancel: ImportApp.#onCancel
    }
  };

  /** @inheritdoc */
  static PARTS = {
    body: { template: template("import.hbs"), scrollable: [".bws-import-list"] }
  };

  /** @inheritdoc */
  get title() {
    const base = game.i18n.localize("BWS.Import.Title");
    return this.actor ? `${base}: ${this.actor.name}` : base;
  }

  /** @inheritdoc */
  async _prepareContext(options) {
    if (this.actor && !this.data && !this.loading) await this.#read();

    const groups = (this.data?.groups ?? []).map((group) => ({
      ...group,
      selectedCount: group.spells.filter((spell) => this.selection.has(spell.itemId)).length,
      spells: group.spells.map((spell) => ({
        ...spell,
        selected: this.selection.has(spell.itemId)
      }))
    }));

    const targets = listImportTargets();
    const journal = this.targetId ? game.journal.get(this.targetId) : null;

    // An actor handed in from a sheet button may hold no spells at all, and would then
    // be missing from the picker its own window is showing.
    const actors = listImportableActors();
    if (this.actor && !actors.some((actor) => actor.id === this.actor.id)) actors.unshift(this.actor);

    return {
      ...(await super._prepareContext(options)),
      hasActor: !!this.actor,
      actors: actors.map((actor) => ({
        id: actor.id,
        name: actor.name,
        selected: actor.id === this.actor?.id
      })),
      targets: [
        { id: "", name: game.i18n.localize("BWS.Import.TargetNew"), selected: !this.targetId },
        ...targets.map((entry) => ({
          id: entry.id,
          name: entry.name,
          selected: entry.id === this.targetId
        }))
      ],
      bookName: journal ? journal.name : this.bookName,
      // A book that already exists keeps its own name; only a new one is named here.
      nameDisabled: !!journal,
      groups,
      hasSpells: groups.length > 0,
      selectedCount: this.selection.size,
      summaryLine: this.#summaryLine(),
      noteLine: this.#noteLine(),
      canImport: this.selection.size > 0 && (!!journal || !!this.bookName.trim()),
      importLabel: journal
        ? game.i18n.localize("BWS.Import.SubmitMerge")
        : game.i18n.localize("BWS.Import.Submit")
    };
  }

  /**
   * Read the current actor's spells and tick everything by default.
   * @returns {Promise<void>}
   */
  async #read() {
    this.loading = true;
    try {
      this.data = await collectActorSpells(this.actor);
      this.selection = new Set(
        this.data.groups.flatMap((group) => group.spells.map((spell) => spell.itemId))
      );
      if (!this.bookName.trim() && this.actor) {
        this.bookName = game.i18n.format("BWS.Import.DefaultName", { actor: this.actor.name });
      }
    } catch (err) {
      console.error("Blizzard's Wondrous Spellbook | Failed to read the character sheet", err);
      ui.notifications.error(game.i18n.localize("BWS.Error.ImportFailed"));
      this.data = { groups: [], total: 0, unlinked: 0, rituals: 0 };
    } finally {
      this.loading = false;
    }
  }

  /**
   * "12 of 18 spells selected".
   * @returns {string}
   */
  #summaryLine() {
    return game.i18n.format("BWS.Import.Summary", {
      selected: this.selection.size,
      total: this.data?.total ?? 0
    });
  }

  /**
   * What the import will quietly do differently: spells with no compendium behind them,
   * and rituals that a spellbook cannot hold at all.
   * @returns {string}
   */
  #noteLine() {
    const parts = [];
    if (this.data?.unlinked) {
      parts.push(game.i18n.format("BWS.Import.UnlinkedNote", { count: this.data.unlinked }));
    }
    if (this.data?.rituals) {
      parts.push(game.i18n.format("BWS.Import.RitualNote", { count: this.data.rituals }));
    }
    return parts.join(" ");
  }

  /** @inheritdoc */
  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;

    root.querySelector("[name='actor']")?.addEventListener("change", async (event) => {
      const actor = game.actors.get(event.currentTarget.value);
      if (!actor) return;
      this.actor = actor;
      // The name follows the actor unless it has been typed over.
      this.data = null;
      this.bookName = "";
      await this.render();
    });

    root.querySelector("[name='target']")?.addEventListener("change", async (event) => {
      this.targetId = event.currentTarget.value;
      await this.render();
    });

    // Typing must not re-render, or the field would lose focus on every keystroke.
    root.querySelector("[name='bookName']")?.addEventListener("input", (event) => {
      this.bookName = event.currentTarget.value;
      this.#refreshSummary();
    });

    const list = root.querySelector(".bws-import-list");
    list?.addEventListener("change", (event) => {
      const box = event.target.closest("input[type='checkbox']");
      if (!box) return;

      if (box.dataset.group !== undefined) this.#toggleGroup(box.dataset.group, box.checked);
      else if (box.dataset.itemId) this.#toggleSpell(box.dataset.itemId, box.checked);
    });

    // The group boxes render blank: their state is derived from the rows below them,
    // which is exactly what the summary pass computes.
    this.#refreshSummary();
  }

  /**
   * Tick or clear one spell.
   * @param {string} itemId Owned spell item id.
   * @param {boolean} selected
   * @returns {void}
   */
  #toggleSpell(itemId, selected) {
    if (selected) this.selection.add(itemId);
    else this.selection.delete(itemId);
    this.#refreshSummary();
  }

  /**
   * Tick or clear every spell in one entry.
   * @param {string} groupId Spellcasting entry id, or "" for the loose group.
   * @param {boolean} selected
   * @returns {void}
   */
  #toggleGroup(groupId, selected) {
    const group = this.data?.groups.find((g) => g.id === groupId);
    if (!group) return;

    for (const spell of group.spells) {
      if (selected) this.selection.add(spell.itemId);
      else this.selection.delete(spell.itemId);
    }

    for (const box of this.element.querySelectorAll(`[data-item-id][data-group-id='${groupId}']`)) {
      box.checked = selected;
    }
    this.#refreshSummary();
  }

  /**
   * Update the summary line, the group headers and the Import button in place.
   *
   * Selection is the one piece of state the whole window reacts to, and re-rendering
   * for it would throw away the list's scroll position on every tick.
   *
   * @returns {void}
   */
  #refreshSummary() {
    const root = this.element;

    const summary = root.querySelector(".bws-import-summary");
    if (summary) summary.textContent = this.#summaryLine();

    for (const group of this.data?.groups ?? []) {
      const selected = group.spells.filter((spell) => this.selection.has(spell.itemId)).length;
      const box = root.querySelector(`input[data-group='${group.id}']`);
      if (box) {
        box.checked = selected === group.spells.length;
        // Neither ticked nor clear: some of the entry is in, some is not.
        box.indeterminate = selected > 0 && selected < group.spells.length;
      }
      const count = root.querySelector(`[data-group-count='${group.id}']`);
      if (count) {
        count.textContent = game.i18n.format("BWS.Import.GroupCount", {
          selected,
          total: group.spells.length
        });
      }
    }

    const button = root.querySelector("[data-action='import']");
    if (button) {
      const named = !!this.targetId || !!this.bookName.trim();
      button.disabled = !this.selection.size || !named;
    }
  }

  /** Tick every spell on the sheet. */
  static async #onSelectAll() {
    for (const group of this.data?.groups ?? []) {
      for (const spell of group.spells) this.selection.add(spell.itemId);
    }
    for (const box of this.element.querySelectorAll("[data-item-id]")) box.checked = true;
    this.#refreshSummary();
  }

  /** Clear the whole selection. */
  static async #onSelectNone() {
    this.selection.clear();
    for (const box of this.element.querySelectorAll("[data-item-id]")) box.checked = false;
    this.#refreshSummary();
  }

  /** Write the ticked spells into a new or existing spellbook. */
  static async #onImport() {
    if (!this.selection.size) {
      ui.notifications.warn(game.i18n.localize("BWS.Import.NothingSelected"));
      return;
    }

    const journal = this.targetId ? game.journal.get(this.targetId) : null;
    const name = this.bookName.trim();
    if (!journal && !name) {
      ui.notifications.warn(game.i18n.localize("BWS.Notify.NoName"));
      return;
    }

    const spells = (this.data?.groups ?? [])
      .flatMap((group) => group.spells)
      .filter((spell) => this.selection.has(spell.itemId))
      .map((spell) => spell.record);

    const result = await importIntoSpellbook({ spells, name, journal });
    if (!result) return;

    if (!result.added) {
      ui.notifications.info(
        game.i18n.format("BWS.Import.NothingNew", { name: result.journal.name })
      );
      return;
    }

    ui.notifications.info(
      journal
        ? game.i18n.format("BWS.Import.Merged", {
            count: result.added,
            name: result.journal.name,
            skipped: result.skipped
          })
        : game.i18n.format("BWS.Import.Created", {
            count: result.added,
            name: result.journal.name
          })
    );

    Hooks.callAll(`${MODULE_ID}.spellbookSaved`, result.journal);
    await this.close();
  }

  /** Close without importing. */
  static async #onCancel() {
    await this.close();
  }
}

/**
 * Open the importer for an actor, or for the current selection when none is given.
 * @param {object} [options]
 * @param {object} [options.actor] Actor to read.
 * @returns {ImportApp|null}
 */
export function openImport({ actor } = {}) {
  const target = actor ?? resolveTargetActor()?.actor ?? null;
  if (target && !target.isOwner) {
    ui.notifications.warn(game.i18n.format("BWS.Slot.NotOwner", { actor: target.name }));
    return null;
  }
  if (!target && !listImportableActors().length) {
    ui.notifications.warn(game.i18n.localize("BWS.Import.NoActors"));
    return null;
  }

  const app = new ImportApp({ actor: target ?? undefined });
  app.render(true);
  return app;
}

/**
 * Add an "Import spells into a spellbook" button to a character sheet's header.
 *
 * Injected on render rather than registered as a sheet header control, because the PF2e
 * character sheet is not this module's to subclass - the same approach the loot book
 * reader takes on the item sheet.
 *
 * @param {object} app The rendered CharacterSheetPF2e application.
 * @param {HTMLElement|object} html The sheet's root element, or a jQuery wrapper.
 * @returns {void}
 */
export function injectImportButton(app, html) {
  const actor = app?.actor;
  if (!actor?.isOwner) return;
  // Nothing to import from a sheet with no spells; the button appears once one is added.
  if (!(actor.itemTypes?.spell?.length > 0)) return;

  const root = html instanceof HTMLElement ? html : html?.[0];
  const frame = root?.closest?.(".application, .app") ?? root;
  const header = frame?.querySelector?.(".window-header");
  if (!header || header.querySelector(".bws-import-spells")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "header-control icon fa-solid fa-book-medical bws-import-spells";
  button.dataset.tooltip = game.i18n.localize("BWS.Import.SheetButton");
  button.setAttribute("aria-label", game.i18n.localize("BWS.Import.SheetButton"));
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openImport({ actor });
  });

  const close = header.querySelector("[data-action='close'], .close");
  header.insertBefore(button, close ?? null);
}
