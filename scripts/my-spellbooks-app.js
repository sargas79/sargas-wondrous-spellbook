/**
 * The "My Spellbooks" browser.
 *
 * Lists every book in the module's folder - spellbooks, ritual books and formula books -
 * filtered by ownership: a GM sees every book, a player sees only the ones they own.
 * Edit and delete controls are disabled per-row for anyone who lacks OWNER on that
 * specific entry.
 *
 * A row's edit control opens whatever that kind of book is edited with: the creator for
 * spells and rituals, the crafter's reader for formulas.
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
import { openImport } from "./import-app.js";
import { listImportableActors } from "./import-spells.js";
import { openFormulaBook } from "./formula-book-app.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class MySpellbooksApp extends HandlebarsApplicationMixin(ApplicationV2) {
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
    const books = getUserSpellbooks().map(summariseSpellbook);

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
    new SpellbookApp().render(true);
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
    new LootGeneratorApp().render(true);
  }

  /** Open the underlying journal entry. */
  static async #onOpen(event, target) {
    const journal = game.journal.get(target.dataset.id);
    journal?.sheet?.render(true);
  }

  /**
   * Open a book with the window that suits its kind.
   *
   * A formula book holds items rather than spells, so the spell creator would render it
   * as nonsense; its reader is where formulas are taught to a crafter instead.
   */
  static async #onEdit(event, target) {
    const journal = game.journal.get(target.dataset.id);
    if (!journal) return;

    if (getBookKind(journal) === BOOK_KINDS.FORMULAS) openFormulaBook(journal);
    else new SpellbookApp({ journal }).render(true);
  }

  /** Delete a spellbook after confirmation. */
  static async #onRemove(event, target) {
    const journal = game.journal.get(target.dataset.id);
    if (!journal) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("BWS.Browser.DeleteTitle"), icon: "fa-solid fa-trash" },
      classes: ["bws-dialog"],
      content: `<p>${game.i18n.format("BWS.Browser.DeleteConfirm", {
        name: foundry.utils.escapeHTML(journal.name)
      })}</p>`,
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return;

    await deleteSpellbook(journal);
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
  Hooks.on(`${MODULE_ID}.spellbookSaved`, refresh);
}
