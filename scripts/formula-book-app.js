/**
 * The formula book reader.
 *
 * What a crafter's blueprints are for: open the book, pick a crafter, and copy formulas
 * into their sheet. It is the formula counterpart of the loot book's learn flow, and it
 * routes every write through `addFormulaToActor` so this module still has exactly one
 * place that touches an actor's formula list.
 *
 * Formulas a crafter already knows are shown as known rather than hidden, so the book
 * reads as a checklist of what that character still has to learn.
 */

import { BOOK_KINDS, template } from "./constants.js";
import { actorKnowsFormula, addFormulaToActor, listCrafters } from "./formula-query.js";
import { getRarityLabel } from "./spell-query.js";
import { canEditSpellbook, getBookKind, getStoredSpells } from "./persistence.js";
import { resolveTargetActor } from "./slot-manager.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class FormulaBookApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {object} options
   * @param {object} options.journal The formula book JournalEntry to read.
   */
  constructor(options = {}) {
    super(options);

    /** @type {object} */
    this.journal = options.journal;

    /** @type {object|null} The crafter being taught. */
    this.actor = options.actor ?? FormulaBookApp.#resolveDefaultCrafter();
  }

  /**
   * Who is reading the book: the selected token or assigned character when either is a
   * crafter this user owns, otherwise the first owned actor.
   * @returns {object|null}
   */
  static #resolveDefaultCrafter() {
    return resolveTargetActor()?.actor ?? listCrafters()[0] ?? null;
  }

  /** @inheritdoc */
  static DEFAULT_OPTIONS = {
    classes: ["bws", "bws-formula-book"],
    tag: "div",
    window: {
      title: "BWS.Formula.ReaderTitle",
      icon: "fa-solid fa-hammer",
      resizable: true
    },
    position: { width: 540, height: 600 },
    actions: {
      teach: FormulaBookApp.#onTeach,
      teachAll: FormulaBookApp.#onTeachAll
    }
  };

  /** @inheritdoc */
  static PARTS = {
    body: { template: template("formula-book.hbs"), scrollable: [".bws-formula-list"] }
  };

  /**
   * Windows are keyed per book so two can be open side by side.
   * @inheritdoc
   */
  get id() {
    return `bws-formula-book-${this.journal?.id ?? "unknown"}`;
  }

  /** @inheritdoc */
  get title() {
    return this.journal?.name ?? game.i18n.localize("BWS.Formula.ReaderTitle");
  }

  /** @inheritdoc */
  async _prepareContext(options) {
    // Copied before sorting: `getStoredSpells` hands back the array stored on the
    // document, and sorting it in place would reorder the book's own flag data.
    const records = [...getStoredSpells(this.journal)].sort(
      (a, b) => (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name)
    );

    const groups = [];
    let unknown = 0;
    for (const record of records) {
      const known = !!this.actor && actorKnowsFormula(this.actor, record.uuid);
      if (!known) unknown++;

      let group = groups.at(-1);
      const level = record.level ?? 0;
      if (!group || group.level !== level) {
        group = { level, label: game.i18n.format("BWS.Formula.LevelHeading", { level }), rows: [] };
        groups.push(group);
      }
      group.rows.push({
        ...record,
        rarity: record.rarity ?? "common",
        rarityLabel: getRarityLabel(record.rarity ?? "common"),
        known,
        disabled: !this.actor || known
      });
    }

    return {
      ...(await super._prepareContext(options)),
      groups,
      hasFormulas: groups.length > 0,
      crafters: listCrafters().map((actor) => ({
        id: actor.id,
        name: actor.name,
        selected: actor.id === this.actor?.id
      })),
      hasCrafter: !!this.actor,
      unknownCount: unknown,
      canTeachAll: !!this.actor && unknown > 0,
      countLine:
        records.length === 1
          ? game.i18n.localize("BWS.Browser.FormulaSummaryOne")
          : game.i18n.format("BWS.Browser.FormulaSummary", { count: records.length }),
      targetLine: this.actor
        ? game.i18n.format("BWS.Formula.TargetLine", { actor: this.actor.name })
        : game.i18n.localize("BWS.Formula.NoTarget"),
      canEdit: canEditSpellbook(this.journal)
    };
  }

  /** @inheritdoc */
  _onRender(context, options) {
    super._onRender(context, options);

    this.element.querySelector("[name='crafter']")?.addEventListener("change", async (event) => {
      const actor = game.actors.get(event.currentTarget.value);
      if (!actor) return;
      this.actor = actor;
      await this.render();
    });
  }

  /** Copy one formula into the chosen crafter's sheet. */
  static async #onTeach(event, target) {
    const uuid = target.dataset.uuid;
    if (!uuid || !this.actor) return;

    const added = await addFormulaToActor(this.actor, uuid);
    if (!added) return;

    ui.notifications.info(
      game.i18n.format("BWS.Formula.Taught", {
        formula: target.dataset.name ?? uuid,
        actor: this.actor.name
      })
    );
    await this.render();
  }

  /** Copy every formula the crafter does not already know. */
  static async #onTeachAll() {
    if (!this.actor) return;

    const missing = getStoredSpells(this.journal).filter(
      (record) => !actorKnowsFormula(this.actor, record.uuid)
    );
    if (!missing.length) {
      ui.notifications.info(
        game.i18n.format("BWS.Formula.NothingToTeach", { actor: this.actor.name })
      );
      return;
    }

    let added = 0;
    // One at a time rather than one bulk update: `addFormulaToActor` re-reads the actor
    // each pass, so a formula added by someone else mid-loop is not overwritten.
    for (const record of missing) {
      if (await addFormulaToActor(this.actor, record.uuid)) added++;
    }

    ui.notifications.info(
      game.i18n.format("BWS.Formula.TaughtAll", { count: added, actor: this.actor.name })
    );
    await this.render();
  }
}

/**
 * Open the reader for a formula book, refusing anything else.
 * @param {object} journal A JournalEntry.
 * @returns {FormulaBookApp|null}
 */
export function openFormulaBook(journal) {
  if (getBookKind(journal) !== BOOK_KINDS.FORMULAS) {
    ui.notifications.warn(game.i18n.localize("BWS.Formula.NotAFormulaBook"));
    return null;
  }
  const app = new FormulaBookApp({ journal });
  app.render(true);
  return app;
}
