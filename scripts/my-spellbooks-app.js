/**
 * The "My Spellbooks" browser.
 *
 * Lists every book the module knows about, filtered by ownership: a GM sees every book,
 * a player sees only the ones they own. Edit and delete controls are disabled per-row
 * for anyone who lacks OWNER on that specific entry.
 *
 * Rows are sorted into one alphabetical list across two axes that are deliberately kept
 * apart. `kind` is where a book is *stored* - a journal, or a rolled loot item - and is
 * what every action handler dispatches on. `bookKind` is what a journal *holds*, and
 * decides which window its edit control opens: the creator for spells and rituals, the
 * crafter's reader for formulas.
 */

import { BOOK_KINDS, MODULE_ID, template } from "./constants.js";
import {
  deleteSpellbook,
  getBookKind,
  getFolderName,
  getUserSpellbooks,
  summariseSpellbook
} from "./persistence.js";
import { SpellbookApp } from "./spellbook-app.js";
import { LootGeneratorApp } from "./loot-generator-app.js";
import { getUserLootBooks, isLootSpellbook, summariseLootBook } from "./loot-generator.js";
import { openLootBook } from "./loot-book-app.js";
import { openImport } from "./import-app.js";
import { listImportableActors } from "./import-spells.js";
import { openFormulaBook } from "./formula-book-app.js";
import { openOrFocus } from "./app-utils.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class MySpellbooksApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * Open the browser, focusing it when it is already open.
   * @returns {MySpellbooksApp}
   */
  static open() {
    return openOrFocus(MySpellbooksApp.DEFAULT_OPTIONS.id, () => new MySpellbooksApp());
  }

  /** @inheritdoc */
  static DEFAULT_OPTIONS = {
    id: "bws-my-spellbooks",
    classes: ["bws", "bws-browser"],
    tag: "div",
    window: {
      title: "BWS.Browser.Title",
      icon: "fa-solid fa-book-bookmark",
      resizable: true
    },
    position: { width: 460, height: 520 },
    actions: {
      create: MySpellbooksApp.#onCreate,
      importSheet: MySpellbooksApp.#onImportSheet,
      rollLoot: MySpellbooksApp.#onRollLoot,
      open: MySpellbooksApp.#onOpen,
      edit: MySpellbooksApp.#onEdit,
      remove: MySpellbooksApp.#onRemove
    }
  };

  /** @inheritdoc */
  static PARTS = {
    body: { template: template("my-spellbooks.hbs"), scrollable: [".bws-book-list"] }
  };

  /** @inheritdoc */
  async _prepareContext(options) {
    // Journals and rolled loot items are two storage shapes for the same idea, so both
    // are listed here; `kind` is what every action handler dispatches on.
    const journals = getUserSpellbooks().map((journal) => ({
      ...summariseSpellbook(journal),
      kind: "journal",
      openHint: game.i18n.localize("BWS.Browser.Open"),
      editHint: game.i18n.localize("BWS.Browser.Edit"),
      deleteHint: game.i18n.localize("BWS.Browser.Delete")
    }));
    const loot = getUserLootBooks().map((item) => ({
      ...summariseLootBook(item),
      kind: "loot",
      openHint: game.i18n.localize("BWS.Loot.OpenBook"),
      editHint: game.i18n.localize("BWS.Browser.OpenItem"),
      deleteHint: game.i18n.localize("BWS.Browser.DeleteLoot")
    }));
    // One alphabetical list rather than two blocks: the loot tag on a row is what tells
    // the two kinds apart, so grouping by kind would only cost the reader the ordering.
    const books = [...journals, ...loot].sort((a, b) => a.name.localeCompare(b.name));

    return {
      ...(await super._prepareContext(options)),
      books,
      hasBooks: books.length > 0,
      // Rolling loot writes a world Item, which only a GM may do.
      isGM: game.user.isGM,
      folderLine: game.i18n.format("BWS.Browser.FolderLine", { folder: getFolderName() }),
      scopeLine: game.user.isGM
        ? game.i18n.format("BWS.Browser.GMSeesAll", { count: books.length })
        : game.i18n.format("BWS.Browser.OwnedCount", { count: books.length })
    };
  }

  /** Open a blank creator window. */
  static async #onCreate() {
    SpellbookApp.open();
  }

  /**
   * Build a book out of what a character already has.
   *
   * Opens on the first kind this user has anything to import of, so a table whose only
   * owned character is a crafter lands on Formulas instead of an empty spell list.
   */
  static async #onImportSheet() {
    const kind =
      Object.values(BOOK_KINDS).find((key) => listImportableActors({ kind: key }).length) ??
      BOOK_KINDS.SPELLS;
    openImport({ kind });
  }

  /** Open the random loot spellbook generator. */
  static async #onRollLoot() {
    LootGeneratorApp.open();
  }

  /** Open the underlying journal entry, or a loot book's reader. */
  static async #onOpen(event, target) {
    if (target.dataset.kind === "loot") {
      // Guarded rather than passed straight in: a row left over from a book deleted
      // elsewhere would otherwise be reported as "not a loot book".
      const item = game.items.get(target.dataset.id);
      if (item) openLootBook(item);
      return;
    }
    const journal = game.journal.get(target.dataset.id);
    journal?.sheet?.render(true);
  }

  /**
   * Open a book with the window that suits it.
   *
   * Two independent questions decide that. Where the book is stored: a loot book is a
   * physical item the creator cannot edit, so its own sheet is opened instead. And what
   * a journal holds: a formula book holds items rather than spells, so the spell creator
   * would render it as nonsense, and its reader is where formulas are taught to a
   * crafter instead.
   */
  static async #onEdit(event, target) {
    if (target.dataset.kind === "loot") {
      game.items.get(target.dataset.id)?.sheet?.render(true);
      return;
    }
    const journal = game.journal.get(target.dataset.id);
    if (!journal) return;

    if (getBookKind(journal) === BOOK_KINDS.FORMULAS) openFormulaBook(journal);
    else SpellbookApp.open({ journal });
  }

  /** Delete a spellbook, or a loot book item, after confirmation. */
  static async #onRemove(event, target) {
    const isLoot = target.dataset.kind === "loot";
    const doc = isLoot ? game.items.get(target.dataset.id) : game.journal.get(target.dataset.id);
    if (!doc) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("BWS.Browser.DeleteTitle"), icon: "fa-solid fa-trash" },
      classes: ["bws-dialog"],
      content: `<p>${game.i18n.format(
        isLoot ? "BWS.Browser.DeleteLootConfirm" : "BWS.Browser.DeleteConfirm",
        { name: foundry.utils.escapeHTML(doc.name) }
      )}</p>`,
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return;

    if (isLoot) {
      try {
        await doc.delete();
        ui.notifications.info(game.i18n.format("BWS.Notify.Deleted", { name: doc.name }));
      } catch (err) {
        console.error("Blizzard's Wondrous Spellbook | Failed to delete the loot spellbook", err);
        ui.notifications.error(game.i18n.localize("BWS.Error.DeleteFailed"));
      }
    } else await deleteSpellbook(doc);

    await this.render();
  }
}

/**
 * Keep any open browser window in step with journal changes made elsewhere.
 *
 * Registered once from `main.js`; each handler is a no-op unless the browser is open.
 */
export function registerBrowserRefreshHooks() {
  const refresh = () => {
    for (const app of foundry.applications.instances.values()) {
      if (app instanceof MySpellbooksApp) app.render();
    }
  };

  Hooks.on("createJournalEntry", refresh);
  Hooks.on("updateJournalEntry", refresh);
  Hooks.on("deleteJournalEntry", refresh);
  // Loot books are Items, so the list has to follow item changes too. Compendium and
  // actor-owned items are skipped: neither is ever listed here.
  const refreshItem = (item) => {
    if (item?.pack || item?.parent) return;
    if (isLootSpellbook(item)) refresh();
  };
  Hooks.on("createItem", refreshItem);
  Hooks.on("updateItem", refreshItem);
  Hooks.on("deleteItem", refreshItem);
  Hooks.on(`${MODULE_ID}.spellbookSaved`, refresh);
}
