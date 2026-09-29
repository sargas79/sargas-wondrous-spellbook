/**
 * The Spellbook Creator window.
 *
 * Built on ApplicationV2 + HandlebarsApplicationMixin. The window is split into three
 * parts so typing in the search box only re-renders the results list: the search input
 * itself lives in `header`, which is left untouched, so focus and caret position
 * survive without any manual restoration.
 *
 * A spellbook is storage only. Ticking a spell adds it to the book; the row's
 * "send to slot" arrow is a separate, immediate write to an actor and does not
 * require the book to be saved first.
 *
 * The same window builds ritual books: the kind switch points the query at the ritual
 * pool instead, and a book records which of the two it holds. The two never mix, so
 * switching kinds clears whatever was ticked.
 */

import { BOOK_KINDS, MODULE_ID, template } from "./constants.js";
import { TRADITIONS, RANKS, querySpells, getRankBadge, getRankLabel } from "./spell-query.js";
import {
  canCreateSpellbook,
  canEditSpellbook,
  createSpellbook,
  getBookKind,
  getStoredSpells,
  updateSpellbook
} from "./persistence.js";
import { openSendToSlotDialog } from "./slot-manager.js";
import { domSafe, openOrFocus } from "./app-utils.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SpellbookApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {object} [options]
   * @param {object} [options.journal] An existing spellbook JournalEntry to edit.
   */
  constructor(options = {}) {
    // One window per book being edited, so reopening a book focuses its window; a new,
    // unsaved book gets a fresh id each time and several can be drafted side by side.
    super({
      ...options,
      ...(options.journal ? { id: SpellbookApp.idFor(options.journal) } : {})
    });

    /** @type {object|null} The spellbook being edited, if any. */
    this.journal = options.journal ?? null;

    /** @type {string|null} Kind of the book being edited, if any. */
    const journalKind = this.journal ? getBookKind(this.journal) : null;

    /**
     * A formula book holds items, not spells, so this window cannot edit one. The
     * browser routes those to the crafter's reader instead; this guard only catches a
     * caller reaching past it through the API.
     * @type {boolean}
     */
    this.unsupportedBook = journalKind === BOOK_KINDS.FORMULAS;
    if (this.unsupportedBook) ui.notifications.warn(game.i18n.localize("BWS.Creator.NotEditable"));

    /**
     * Which pool this book draws from: spells, or rituals. An existing book's kind wins
     * over anything passed in - a book cannot change what it holds.
     * @type {string}
     */
    this.kind =
      journalKind === BOOK_KINDS.RITUALS || (!this.journal && options.kind === BOOK_KINDS.RITUALS)
        ? BOOK_KINDS.RITUALS
        : BOOK_KINDS.SPELLS;

    /** @type {boolean} True when the kind switch must not be offered. */
    this.kindLocked = !!this.journal;

    /** @type {string} */
    this.spellbookName = this.journal?.name ?? "";
    /** @type {string} */
    this.tradition = "all";
    /** @type {boolean} */
    this.includeFocus = false;
    /** @type {string} */
    this.search = "";

    /**
     * Ranks to show, 0 for cantrips. Empty means every rank, which is why this is a
     * Set rather than a flag per rank: "no filter" and "nothing selected" are the
     * same state, so clearing it needs no special case.
     * @type {Set<number>}
     */
    this.ranks = new Set();

    /** @type {number|null} Last rank chip clicked, so shift-click can span a range. */
    this._lastRank = null;

    /**
     * Selected spells, keyed by uuid. Seeded from the journal when editing so
     * previously stored records (including any animation flag) round-trip intact.
     * @type {Map<string, object>}
     */
    this.selected = new Map();
    for (const spell of getStoredSpells(this.journal)) this.selected.set(spell.uuid, spell);

    /** @type {boolean} True when the user may not write to this spellbook. */
    this.readOnly = this.unsupportedBook || (!!this.journal && !canEditSpellbook(this.journal));

    /** @type {boolean} True when this user may build a book but has no right to save a new one. */
    this.cannotCreate = !this.journal && !canCreateSpellbook();

    this._debouncedSearch = foundry.utils.debounce(() => {
      this.render({ parts: ["body", "footer"] });
    }, 200);
  }

  /**
   * Window id for the creator editing a given book.
   * @param {object} journal A spellbook JournalEntry.
   * @returns {string}
   */
  static idFor(journal) {
    return `bws-spellbook-creator-${domSafe(journal.id)}`;
  }

  /**
   * Open the creator, focusing the existing window when that book is already open.
   * @param {object} [options] Constructor options.
   * @returns {SpellbookApp}
   */
  static open(options = {}) {
    if (!options.journal) {
      const app = new SpellbookApp(options);
      app.render({ force: true });
      return app;
    }
    return openOrFocus(SpellbookApp.idFor(options.journal), () => new SpellbookApp(options));
  }

  /** @inheritdoc */
  static DEFAULT_OPTIONS = {
    id: "bws-spellbook-creator-{id}",
    classes: ["bws", "bws-creator"],
    tag: "div",
    window: {
      title: "BWS.Creator.Title.spells",
      icon: "fa-solid fa-book-open",
      resizable: true
    },
    position: { width: 900, height: 640 },
    actions: {
      setKind: SpellbookApp.#onSetKind,
      setTradition: SpellbookApp.#onSetTradition,
      setRank: SpellbookApp.#onSetRank,
      sendToSlot: SpellbookApp.#onSendToSlot,
      removeSelected: SpellbookApp.#onRemoveSelected,
      save: SpellbookApp.#onSave,
      cancel: SpellbookApp.#onCancel
    }
  };

  /** @inheritdoc */
  static PARTS = {
    header: { template: template("creator-header.hbs") },
    body: { template: template("creator-body.hbs"), scrollable: [".bws-spell-list", ".bws-selected-list"] },
    footer: { template: template("creator-footer.hbs") }
  };

  /** @inheritdoc */
  get title() {
    const base = game.i18n.localize(`BWS.Creator.Title.${this.kind}`);
    return this.journal ? `${base}: ${this.journal.name}` : base;
  }

  /** @inheritdoc */
  async _prepareContext(options) {
    const query = await querySpells({
      tradition: this.tradition,
      includeFocus: this.includeFocus,
      search: this.search,
      ranks: [...this.ranks],
      kind: this.kind
    });

    // Mark rows that are already in the book so the checkbox renders ticked.
    // `querySpells` hands back references into the shared compendium cache, so the
    // `selected` flag goes onto a shallow clone: mutating the cached record would
    // leak this window's selection into every other Spellbook Creator window.
    const groups = query.groups.map((group) => ({
      ...group,
      spells: group.spells.map((spell) => ({ ...spell, selected: this.selected.has(spell.uuid) }))
    }));

    const selected = [...this.selected.values()]
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
      .map((spell) => ({ ...spell, rankBadge: getRankBadge(spell.rank) }));

    const isRituals = this.kind === BOOK_KINDS.RITUALS;

    return {
      ...(await super._prepareContext(options)),
      kind: this.kind,
      isRituals,
      kindLocked: this.kindLocked,
      kinds: [BOOK_KINDS.SPELLS, BOOK_KINDS.RITUALS].map((key) => ({
        key,
        label: game.i18n.localize(`BWS.Kind.${key}`),
        active: key === this.kind
      })),
      nameLabel: game.i18n.localize(`BWS.Creator.NameLabel.${this.kind}`),
      saveLabel: game.i18n.localize(`BWS.Creator.Save.${this.kind}`),
      emptyNote: game.i18n.localize(
        isRituals ? "BWS.Ritual.SelectedEmpty" : "BWS.Creator.SelectedEmpty"
      ),
      spellbookName: this.spellbookName,
      tradition: this.tradition,
      traditions: [
        { key: "all", label: game.i18n.localize("BWS.Tradition.All"), active: this.tradition === "all" },
        ...TRADITIONS.map((key) => ({
          key,
          label: game.i18n.localize(`BWS.Tradition.${key.charAt(0).toUpperCase()}${key.slice(1)}`),
          active: this.tradition === key
        }))
      ],
      rankOptions: [
        {
          key: "all",
          // `aria` is kept separate from `title`: an accessible name should name the
          // control, so it starts with the visible label and leaves the shift-click
          // gesture to the tooltip rather than reading it out on every focus.
          label: game.i18n.localize("BWS.Creator.RankAll"),
          title: game.i18n.localize("BWS.Creator.RankAllHint"),
          aria: game.i18n.localize("BWS.Creator.RankAllAria"),
          active: this.ranks.size === 0
        },
        // Badges are short by design, so the chips stay compact; the full rank name
        // carries the meaning for tooltips and screen readers.
        ...RANKS.map((rank) => ({
          key: String(rank),
          label: getRankBadge(rank),
          title: getRankLabel(rank),
          aria: getRankLabel(rank),
          active: this.ranks.has(rank)
        }))
      ],
      includeFocus: this.includeFocus,
      search: this.search,
      groups,
      hasResults: groups.length > 0,
      selected,
      selectedCount: selected.length,
      selectedCountLabel:
        selected.length === 1
          ? game.i18n.localize("BWS.Creator.SelectedCountOne")
          : game.i18n.format("BWS.Creator.SelectedCount", { count: selected.length }),
      readOnly: this.readOnly,
      cannotCreate: this.cannotCreate,
      canSave: !this.readOnly && !this.cannotCreate && selected.length > 0 && !!this.spellbookName.trim(),
      statusLine: game.i18n.format("BWS.Creator.StatusLine", {
        packs: query.packCount,
        indexed: query.indexed,
        shown: query.shown
      })
    };
  }

  /** @inheritdoc */
  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;

    // Every listener below is guarded by a marker attribute: parts re-render
    // independently, so a node that survived the last render must not be bound twice.
    const bind = (selector, event, handler) => {
      const node = root.querySelector(selector);
      if (!node || node.dataset.bwsBound === event) return;
      node.dataset.bwsBound = event;
      node.addEventListener(event, handler);
    };

    bind("[name='spellbookName']", "input", (event) => {
      this.spellbookName = event.currentTarget.value;
      // Only the save button's disabled state depends on the name.
      const save = root.querySelector("[data-action='save']");
      if (save) save.disabled = this.readOnly || this.cannotCreate || !this.spellbookName.trim() || !this.selected.size;
    });

    bind("[name='search']", "input", (event) => {
      this.search = event.currentTarget.value;
      this._debouncedSearch();
    });

    bind("[name='includeFocus']", "change", (event) => {
      this.includeFocus = event.currentTarget.checked;
      this.render({ parts: ["body", "footer"] });
    });

    // Row checkboxes live inside `body`, which is replaced wholesale on each render,
    // so a single delegated listener on the freshly rendered list is enough.
    const list = root.querySelector(".bws-spell-list");
    if (list && list.dataset.bwsBound !== "change") {
      list.dataset.bwsBound = "change";
      list.addEventListener("change", (event) => {
        const checkbox = event.target.closest("input[type='checkbox'][data-uuid]");
        if (checkbox) this.#toggleSpell(checkbox.dataset.uuid, checkbox.checked);
      });
    }
  }

  /**
   * Add or remove a spell from the book.
   * @param {string} uuid Spell uuid.
   * @param {boolean} selected Whether the spell should be in the book.
   */
  #toggleSpell(uuid, selected) {
    if (this.readOnly) return;

    if (!selected) {
      this.selected.delete(uuid);
    } else {
      // Pull the normalised record straight out of the rendered context.
      const record = this.#findRenderedSpell(uuid);
      if (record) this.selected.set(uuid, record);
    }
    this.render({ parts: ["body"] });
  }

  /**
   * Look up a spell record from the most recent query result.
   * @param {string} uuid Spell uuid.
   * @returns {object|null}
   */
  #findRenderedSpell(uuid) {
    for (const group of this._lastQueryGroups ?? []) {
      const found = group.spells.find((s) => s.uuid === uuid);
      if (found) return found;
    }
    return null;
  }

  /** @inheritdoc */
  async _preparePartContext(partId, context, options) {
    const partContext = await super._preparePartContext(partId, context, options);
    // Cache the groups so checkbox toggles can resolve a uuid without re-querying.
    if (partId === "body") this._lastQueryGroups = context.groups;
    return partContext;
  }

  /**
   * Switch between building a spellbook and building a ritual book.
   *
   * The selection is dropped rather than carried across: a book holds one kind, and
   * silently keeping spells ticked while the list shows rituals would save a book that
   * does not match what is on screen.
   */
  static async #onSetKind(event, target) {
    const kind = target.dataset.kind === BOOK_KINDS.RITUALS ? BOOK_KINDS.RITUALS : BOOK_KINDS.SPELLS;
    if (this.kindLocked || kind === this.kind) return;

    if (this.selected.size) {
      ui.notifications.info(game.i18n.localize("BWS.Creator.KindSwitchCleared"));
      this.selected.clear();
    }
    this.kind = kind;
    await this.render({ parts: ["header", "body", "footer"] });
  }

  /** Switch the tradition filter. */
  static async #onSetTradition(event, target) {
    this.tradition = target.dataset.tradition ?? "all";
    await this.render({ parts: ["header", "body", "footer"] });
  }

  /**
   * Toggle a rank chip. `all` clears the set; shift-click spans from the last chip
   * clicked, which is the natural gesture for "ranks 1 through 4".
   */
  static async #onSetRank(event, target) {
    const key = target.dataset.rank ?? "all";

    if (key === "all") {
      this.ranks.clear();
      this._lastRank = null;
    } else {
      const rank = Number(key);
      if (!Number.isInteger(rank)) return;

      if (event.shiftKey && this._lastRank !== null) {
        const [from, to] = [this._lastRank, rank].sort((a, b) => a - b);
        for (let r = from; r <= to; r++) this.ranks.add(r);
      } else if (this.ranks.has(rank)) {
        this.ranks.delete(rank);
      } else {
        this.ranks.add(rank);
      }
      this._lastRank = rank;
    }

    // Header for the pressed states, body for the results, footer for the status line.
    await this.render({ parts: ["header", "body", "footer"] });
  }

  /** Send a compendium spell straight to an actor's slot. */
  static async #onSendToSlot(event, target) {
    const uuid = target.dataset.uuid;
    if (uuid) await openSendToSlotDialog({ uuid });
  }

  /** Drop a spell from the selection panel. */
  static async #onRemoveSelected(event, target) {
    if (this.readOnly) return;
    this.selected.delete(target.dataset.uuid);
    await this.render({ parts: ["body"] });
  }

  /** Persist the spellbook and close. */
  static async #onSave() {
    if (this.readOnly) {
      ui.notifications.warn(game.i18n.localize("BWS.Notify.NoPermission"));
      return;
    }

    const name = this.spellbookName.trim();
    if (!name) {
      ui.notifications.warn(game.i18n.localize("BWS.Notify.NoName"));
      return;
    }
    if (!this.selected.size) {
      ui.notifications.warn(game.i18n.localize("BWS.Notify.NoSpells"));
      return;
    }

    const spells = [...this.selected.values()];
    const result = this.journal
      ? await updateSpellbook(this.journal, { name, spells })
      : await createSpellbook({ name, spells, kind: this.kind });

    if (!result) return;

    ui.notifications.info(
      game.i18n.format(this.journal ? "BWS.Notify.Updated" : "BWS.Notify.Saved", { name })
    );
    Hooks.callAll(`${MODULE_ID}.spellbookSaved`, result);
    await this.close();
  }

  /** Close without saving. */
  static async #onCancel() {
    await this.close();
  }
}
