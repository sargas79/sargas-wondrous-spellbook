/**
 * Shared identifiers.
 *
 * Kept in their own module so every other file can import them without pulling in
 * `main.js` and creating an import cycle.
 */

/** Module id, used for flags, settings, template paths and socket names. */
export const MODULE_ID = "sargas-wondrous-spellbook";

/** Root path for this module's assets inside the Foundry data directory. */
export const MODULE_PATH = `modules/${MODULE_ID}`;

/** Default name of the Journal Entry folder that stores every spellbook. */
export const DEFAULT_FOLDER_NAME = "Sargas Spellbooks";

/** Default name of the Item folder that stores generated loot spellbooks. */
export const DEFAULT_LOOT_FOLDER_NAME = "Spellbook Loot";

/**
 * Flag key on a JournalEntry holding the array of stored records.
 *
 * Every book kind stores its contents here, whatever those contents are: spells and
 * rituals share the spell record shape, a formula book holds formula records. What a
 * given array means is decided by {@link BOOK_KIND_FLAG}, so one reader helper serves
 * all three kinds and books written before kinds existed still read as spellbooks.
 */
export const SPELLS_FLAG = "spells";

/** Flag key on a JournalEntry naming which kind of book it is. */
export const BOOK_KIND_FLAG = "kind";

/**
 * The kinds of book this module writes.
 *
 * `spells` is the default for anything that predates the flag, which is exactly what a
 * book without one is.
 */
export const BOOK_KINDS = Object.freeze({
  SPELLS: "spells",
  RITUALS: "rituals",
  FORMULAS: "formulas"
});

/**
 * Flag key on a physical Item holding the loot metadata (seed, level, learned map).
 * The spell list itself lives under {@link SPELLS_FLAG}, so every reader helper in
 * `persistence.js` works on a loot book exactly as it does on a spellbook journal.
 */
export const LOOT_FLAG = "loot";

/** Settings keys. */
export const SETTINGS = Object.freeze({
  SHEET_INTEGRATION: "enableSheetIntegration",
  SIDEBAR_BUTTON: "showSidebarButton",
  FOLDER_NAME: "folderName",
  LOOT_FOLDER_NAME: "lootFolderName",
  LOOT_PROFILE: "lootDefaultProfile",
  LOOT_MAX_RARITY: "lootMaxRarity",
  LOOT_SOURCES: "lootSources",
  TRACK_LEARNED: "trackLearned",
  CONSUME_ON_LEARN: "consumeOnLearn"
});

/**
 * Build a path to one of this module's Handlebars templates.
 * @param {string} name File name inside `templates/`.
 * @returns {string} Full template path.
 */
export const template = (name) => `${MODULE_PATH}/templates/${name}`;
