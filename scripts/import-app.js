/**
 * The "Import from Character Sheet" window.
 *
 * Reads what a character already has and stores it as a book: their spells, their
 * rituals, or their crafting formulas. Nothing is written to the actor - this window
 * only ever reads a sheet and writes a JournalEntry.
 *
 * One list, three kinds. The kind switch changes which pool the sheet is read against,
 * which books may be merged into, and the labels; everything below that is shared, so a
 * ritual book is selected and written exactly the way a spellbook is.
 *
 * Ticking rows updates the summary line and the Import button in place rather than
 * re-rendering, so the list never scrolls back to the top mid-selection.
 */

import { BOOK_KINDS, MODULE_ID, template } from "./constants.js";
import {
  collectFromActor,
  importIntoSpellbook,
  listImportTargets,
  listImportableActors
} from "./import-spells.js";
import { resolveTargetActor } from "./slot-manager.js";
import { injectHeaderControl } from "./app-utils.js";
import { canCreateSpellbook } from "./persistence.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Order of the kind switch, left to right. */
const KIND_ORDER = Object.freeze([BOOK_KINDS.SPELLS, BOOK_KINDS.RITUALS, BOOK_KINDS.FORMULAS]);

export class ImportApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {object} [options]
   * @param {object} [options.actor] Actor to import from. Resolved from the current
   *   selection when omitted.
   * @param {string} [options.kind] Which kind of book to start on.
   */
  constructor(options = {}) {
    super(options);

    /** @type {string} One of {@link BOOK_KINDS}. */
    this.kind = KIND_ORDER.includes(options.kind) ? options.kind : BOOK_KINDS.SPELLS;

    /**
     * The actor being read. An explicit actor always wins; a selection-resolved one is
     * only taken when it actually has content of this kind, so opening the window off a
     * spell-less assigned character still lands on a sheet worth importing.
     * @type {object|null}
     */
    this.actor = options.actor ?? ImportApp.#resolveDefaultActor(this.kind);

    /** @type {{ groups: object[], total: number, unlinked: number, rituals: number, missing: number }|null} */
    this.data = null;

    /** @type {Set<string>} Row keys ticked for import. */
    this.selection = new Set();

    /** @type {string} Name used when the destination is a new book. */
    this.bookName = "";

    /** @type {string} Id of the book to merge into, or "" for a new one. */
    this.targetId = "";

    /** @type {boolean} True while the sheet is being read. */
    this.loading = false;
  }

  /**
   * The sheet to open on when the caller named none.
   * @param {string} kind Which kind of content the sheet must have.
   * @returns {object|null}
   */
  static #resolveDefaultActor(kind) {
    const importable = listImportableActors({ kind });
    const resolved = resolveTargetActor()?.actor ?? null;
    if (resolved && importable.some((actor) => actor.id === resolved.id)) return resolved;
    return importable[0] ?? null;
  }

  /** @inheritdoc */
  static DEFAULT_OPTIONS = {
    id: "bws-import-{id}",
    classes: ["bws", "bws-import"],
    tag: "div",
    window: {
      title: "BWS.Import.Title.spells",
      icon: "fa-solid fa-file-import",
      resizable: true
    },
    position: { width: 580, height: 640 },
    actions: {
      setKind: ImportApp.#onSetKind,
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
    const base = game.i18n.localize(`BWS.Import.Title.${this.kind}`);
    return this.actor ? `${base}: ${this.actor.name}` : base;
  }

  /** @inheritdoc */
  async _prepareContext(options) {
    if (this.actor && !this.data && !this.loading) await this.#read();

    const groups = (this.data?.groups ?? []).map((group) => ({
      ...group,
      selectedCount: group.rows.filter((row) => this.selection.has(row.itemId)).length,
      rows: group.rows.map((row) => ({ ...row, selected: this.selection.has(row.itemId) }))
    }));

    const targets = listImportTargets(this.kind);
    const journal = this.targetId ? game.journal.get(this.targetId) : null;

    // An actor handed in from a sheet button may hold nothing of this kind, and would
    // then be missing from the picker its own window is showing.
    const actors = listImportableActors({ kind: this.kind });
    if (this.actor && !actors.some((actor) => actor.id === this.actor.id)) actors.unshift(this.actor);

    return {
      ...(await super._prepareContext(options)),
      kind: this.kind,
      isFormulas: this.kind === BOOK_KINDS.FORMULAS,
      kinds: KIND_ORDER.map((key) => ({
        key,
        label: game.i18n.localize(`BWS.Kind.${key}`),
        active: key === this.kind
      })),
      hasActor: !!this.actor,
      actors: actors.map((actor) => ({
        id: actor.id,
        name: actor.name,
        selected: actor.id === this.actor?.id
      })),
      targets: [
        {
          id: "",
          name: game.i18n.localize(`BWS.Import.TargetNew.${this.kind}`),
          selected: !this.targetId
        },
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
      hasRows: groups.length > 0,
      selectedCount: this.selection.size,
      summaryLine: this.#summaryLine(),
      noteLine: this.#noteLine(),
      emptyTitle: game.i18n.localize(`BWS.Import.Empty.${this.kind}`),
      emptyHint: game.i18n.localize(`BWS.Import.EmptyHint.${this.kind}`),
      noActorsLine: game.i18n.localize(`BWS.Import.NoActors.${this.kind}`),
      canImport: this.selection.size > 0 && (!!journal || (!!this.bookName.trim() && canCreateSpellbook())),
      importLabel: journal
        ? game.i18n.localize("BWS.Import.SubmitMerge")
        : game.i18n.localize(`BWS.Import.Submit.${this.kind}`)
    };
  }

  /**
   * Read the current actor's sheet and tick everything by default.
   * @returns {Promise<void>}
   */
  async #read() {
    this.loading = true;
    try {
      this.data = await collectFromActor(this.actor, this.kind);
      this.selection = new Set(
        this.data.groups.flatMap((group) => group.rows.map((row) => row.itemId))
      );
      if (!this.bookName.trim() && this.actor) {
        this.bookName = game.i18n.format(`BWS.Import.DefaultName.${this.kind}`, {
          actor: this.actor.name
        });
      }
    } catch (err) {
      console.error("Blizzard's Wondrous Spellbook | Failed to read the character sheet", err);
      ui.notifications.error(game.i18n.localize("BWS.Error.ImportFailed"));
      this.data = { groups: [], total: 0, unlinked: 0, rituals: 0, missing: 0 };
    } finally {
      this.loading = false;
    }
  }

  /**
   * "12 of 18 spells selected", in the words of the current kind.
   * @returns {string}
   */
  #summaryLine() {
    return game.i18n.format(`BWS.Import.Summary.${this.kind}`, {
      selected: this.selection.size,
      total: this.data?.total ?? 0
    });
  }

  /**
   * What the import will quietly do differently: rows with nothing behind them in a
   * compendium, and rituals a spellbook cannot hold at all.
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
    if (this.data?.missing) {
      parts.push(game.i18n.format("BWS.Import.MissingNote", { count: this.data.missing }));
    }
    // Merging into a book the user owns is still open to them; only a new book is not.
    if (!this.targetId && !canCreateSpellbook()) {
      parts.push(game.i18n.localize("BWS.Error.NoJournalCreate"));
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
      this.#resetSheetState();
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
      else if (box.dataset.itemId) this.#toggleRow(box.dataset.itemId, box.checked);
    });

    // The group boxes render blank: their state is derived from the rows below them,
    // which is exactly what the summary pass computes.
    this.#refreshSummary();
  }

  /**
   * Drop everything read from the previous sheet or kind.
   * @returns {void}
   */
  #resetSheetState() {
    this.data = null;
    this.bookName = "";
    this.targetId = "";
  }

  /**
   * Tick or clear one row.
   * @param {string} rowId Row key.
   * @param {boolean} selected
   * @returns {void}
   */
  #toggleRow(rowId, selected) {
    if (selected) this.selection.add(rowId);
    else this.selection.delete(rowId);
    this.#refreshSummary();
  }

  /**
   * Tick or clear every row in one group.
   * @param {string} groupId Group id: a spellcasting entry, or an item level.
   * @param {boolean} selected
   * @returns {void}
   */
  #toggleGroup(groupId, selected) {
    const group = this.data?.groups.find((g) => g.id === groupId);
    if (!group) return;

    for (const row of group.rows) {
      if (selected) this.selection.add(row.itemId);
      else this.selection.delete(row.itemId);
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
      const selected = group.rows.filter((row) => this.selection.has(row.itemId)).length;
      const box = root.querySelector(`input[data-group='${group.id}']`);
      if (box) {
        box.checked = selected === group.rows.length;
        // Neither ticked nor clear: some of the group is in, some is not.
        box.indeterminate = selected > 0 && selected < group.rows.length;
      }
      const count = root.querySelector(`[data-group-count='${group.id}']`);
      if (count) {
        count.textContent = game.i18n.format("BWS.Import.GroupCount", {
          selected,
          total: group.rows.length
        });
      }
    }

    const button = root.querySelector("[data-action='import']");
    if (button) {
      const named = !!this.targetId || (!!this.bookName.trim() && canCreateSpellbook());
      button.disabled = !this.selection.size || !named;
    }
  }

  /** Switch between spells, rituals and formulas. */
  static async #onSetKind(event, target) {
    const kind = target.dataset.kind;
    if (!KIND_ORDER.includes(kind) || kind === this.kind) return;

    this.kind = kind;
    this.#resetSheetState();
    this.selection.clear();
    // The sheet in view may hold nothing of the new kind; fall back the same way the
    // window does when it is opened cold, and keep the current actor if nothing better
    // exists so the picker still names who is being read.
    if (!this.actor || !listImportableActors({ kind }).some((a) => a.id === this.actor.id)) {
      this.actor = ImportApp.#resolveDefaultActor(kind) ?? this.actor;
    }
    await this.render();
  }

  /** Tick every row on the sheet. */
  static async #onSelectAll() {
    for (const group of this.data?.groups ?? []) {
      for (const row of group.rows) this.selection.add(row.itemId);
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

  /** Write the ticked rows into a new or existing book. */
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
      .flatMap((group) => group.rows)
      .filter((row) => this.selection.has(row.itemId))
      .map((row) => row.record);

    const result = await importIntoSpellbook({ spells, name, journal, kind: this.kind });
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
 * @param {string} [options.kind] Which kind of book to start on.
 * @returns {ImportApp|null}
 */
export function openImport({ actor, kind = BOOK_KINDS.SPELLS } = {}) {
  const target = actor ?? resolveTargetActor()?.actor ?? null;
  if (target && !target.isOwner) {
    ui.notifications.warn(game.i18n.format("BWS.Slot.NotOwner", { actor: target.name }));
    return null;
  }
  if (!target && !listImportableActors({ kind }).length) {
    ui.notifications.warn(game.i18n.localize(`BWS.Import.NoActors.${kind}`));
    return null;
  }

  const app = new ImportApp({ actor: target ?? undefined, kind });
  app.render({ force: true });
  return app;
}

/**
 * The kind a sheet's import should open on: whatever the character actually has.
 *
 * Read at click time rather than when the sheet first rendered, so a character who
 * gained spells since opening their sheet lands on them.
 *
 * @param {object} actor The character.
 * @returns {string} One of {@link BOOK_KINDS}.
 */
function pickImportKind(actor) {
  const spells = actor.itemTypes?.spell ?? [];
  if (spells.some((spell) => !spell.isRitual)) return BOOK_KINDS.SPELLS;
  if (spells.length) return BOOK_KINDS.RITUALS;
  if ((actor.system?.crafting?.formulas?.length ?? 0) > 0) return BOOK_KINDS.FORMULAS;
  return BOOK_KINDS.SPELLS;
}

/** Shared description of the sheet's import control. */
const IMPORT_CONTROL = Object.freeze({
  cssClass: "bws-import-spells",
  icon: "fa-solid fa-book-medical",
  label: "BWS.Import.SheetButtonLabel",
  tooltip: "BWS.Import.SheetButton"
});

/**
 * Add the import control to an Application V1 character sheet's header buttons.
 *
 * Registered on `getCharacterSheetPF2eHeaderButtons`, the hook V1 fires while it builds
 * the header, so the button is a native header control rather than markup pushed into
 * a header that is rebuilt on its own schedule. Shown on every sheet its viewer owns;
 * the importer explains when there is nothing to take.
 *
 * @param {object} app The CharacterSheetPF2e being rendered.
 * @param {object[]} buttons The header buttons being assembled.
 * @returns {void}
 */
export function addImportHeaderButton(app, buttons) {
  const actor = app?.actor;
  if (!actor?.isOwner || buttons.some((b) => b.class === IMPORT_CONTROL.cssClass)) return;
  buttons.unshift({
    label: IMPORT_CONTROL.label,
    class: IMPORT_CONTROL.cssClass,
    icon: IMPORT_CONTROL.icon,
    tooltip: IMPORT_CONTROL.tooltip,
    onclick: () => openImport({ actor, kind: pickImportKind(actor) })
  });
}

/**
 * Add the import control to an Application V2 character sheet's header.
 *
 * Only for a PF2e release that has moved the sheet to V2, which has no header-button
 * hook of the V1 kind. A V1 sheet is handled by {@link addImportHeaderButton}.
 *
 * @param {object} app The rendered character sheet.
 * @param {HTMLElement} html The sheet's root element.
 * @returns {void}
 */
export function injectImportButton(app, html) {
  const actor = app?.actor;
  if (!actor?.isOwner) return;
  injectHeaderControl(app, html, {
    ...IMPORT_CONTROL,
    onClick: () => openImport({ actor, kind: pickImportKind(actor) })
  });
}
