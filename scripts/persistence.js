/**
 * Spellbook persistence.
 *
 * A book is a JournalEntry inside a dedicated folder. The authoritative record list
 * lives in `flags[MODULE_ID].spells`; the journal page is a human-readable rendering of
 * that flag, regenerated on every save.
 *
 * Three kinds of book share this machinery, distinguished by `flags[MODULE_ID].kind`:
 * spellbooks, ritual books and formula books. Only the page renderer and the stored
 * record shape differ; folders, ownership, listing and deletion are identical, and a
 * book saved before kinds existed reads as a spellbook.
 *
 * Ownership is written explicitly on create: default NONE, OWNER for the creator,
 * and OWNER for every GM, so a spellbook is always reachable by any GM regardless
 * of who authored it.
 */

import {
  BOOK_KINDS,
  BOOK_KIND_FLAG,
  DEFAULT_FOLDER_NAME,
  MODULE_ID,
  SETTINGS,
  SPELLS_FLAG
} from "./constants.js";
import { getRankBadge, getRankLabel } from "./spell-query.js";

const { DOCUMENT_OWNERSHIP_LEVELS: OWNERSHIP } = CONST;

/**
 * Configured name of the spellbook folder.
 * @returns {string}
 */
export function getFolderName() {
  const configured = game.settings.get(MODULE_ID, SETTINGS.FOLDER_NAME);
  return configured?.trim() || DEFAULT_FOLDER_NAME;
}

/**
 * Find the spellbook folder, creating it if it does not exist.
 *
 * Only a GM can create a Folder, so players fall back to whatever folder already
 * exists; if none does yet, they get null and the caller reports the failure.
 *
 * @returns {Promise<object|null>} The Folder document, or null on failure.
 */
export async function getOrCreateSpellbooksFolder() {
  const name = getFolderName();
  try {
    const existing = game.folders.find((f) => f.type === "JournalEntry" && f.name === name);
    if (existing) return existing;
    if (!game.user.isGM) return null;

    return await Folder.create({ name, type: "JournalEntry", color: "#6d5ce7", sorting: "a" });
  } catch (err) {
    console.error("Blizzard's Wondrous Spellbook | Failed to resolve the spellbook folder", err);
    ui.notifications.error(game.i18n.localize("BWS.Error.FolderFailed"));
    return null;
  }
}

/**
 * Build the ownership map for a new spellbook: nobody by default, OWNER for the
 * creating user, OWNER for every GM.
 *
 * @param {string} [creatorId] User id of the creator. Defaults to the current user.
 * @returns {Record<string, number>} A Foundry ownership object.
 */
export function buildOwnership(creatorId = game.user.id) {
  const ownership = { default: OWNERSHIP.NONE };
  ownership[creatorId] = OWNERSHIP.OWNER;
  for (const gm of game.users.filter((u) => u.isGM)) ownership[gm.id] = OWNERSHIP.OWNER;
  return ownership;
}

/**
 * Escape a value for the journal page.
 *
 * Names and traits come from world and pack content, which may contain markup. This
 * HTML is persisted into a JournalEntry page and rendered later, so everything
 * interpolated into it is escaped first.
 *
 * @param {*} value
 * @returns {string}
 */
function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

/**
 * Build the `@UUID` link for one stored record.
 *
 * The enricher delimits its label with braces, so those are stripped from the name
 * before escaping or a stray brace truncates the link.
 *
 * @param {object} record A stored record with `uuid` and `name`.
 * @returns {string}
 */
function uuidLink(record) {
  return `@UUID[${esc(record.uuid)}]{${esc(String(record.name ?? "").replace(/[{}]/g, ""))}}`;
}

/**
 * Group stored records into sorted sections.
 * @param {object[]} records Stored records.
 * @param {(record: object) => number} keyOf Section key for a record.
 * @returns {[number, object[]][]} Sections in ascending key order, each name-sorted.
 */
function groupRecords(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, list]) => [key, list.sort((a, b) => a.name.localeCompare(b.name))]);
}

/**
 * Render the stored spell list as journal page HTML.
 * @param {object[]} spells Stored spell records.
 * @returns {string} HTML table grouped by rank.
 */
export function renderSpellsPage(spells) {
  if (!spells.length) return `<p><em>${game.i18n.localize("BWS.Creator.SelectedEmpty")}</em></p>`;

  const byRank = new Map();
  for (const spell of spells) {
    if (!byRank.has(spell.rank)) byRank.set(spell.rank, []);
    byRank.get(spell.rank).push(spell);
  }

  const sections = [...byRank.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rank, list]) => {
      const rows = list
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((spell) => {
          // Spell names and traits come from world and pack content, which may contain
          // markup. This HTML is persisted into a JournalEntry page and rendered later,
          // so everything interpolated here is escaped first.
          const traditions = foundry.utils.escapeHTML((spell.traditions ?? []).join(", "));
          const uuid = foundry.utils.escapeHTML(spell.uuid ?? "");
          // The enricher delimits its label with braces, so strip those from the name
          // before escaping or a stray brace truncates the link.
          const label = foundry.utils.escapeHTML(String(spell.name ?? "").replace(/[{}]/g, ""));
          return `<tr><td>@UUID[${uuid}]{${label}}</td><td>${traditions}</td></tr>`;
        })
        .join("");
      return `<h2>${getRankLabel(rank)}</h2>
<table><thead><tr><th>${game.i18n.localize("BWS.Journal.TableSpell")}</th><th>${game.i18n.localize(
        "BWS.Journal.TableTraditions"
      )}</th></tr></thead><tbody>${rows}</tbody></table>`;
    });

  return sections.join("\n");
}

/**
 * Render a stored ritual list as journal page HTML.
 *
 * The columns are the three things a table actually needs before agreeing to a ritual:
 * how long it takes, what it costs, and how many secondary casters it wants. Anything a
 * ritual leaves blank renders as an em dash rather than an empty cell.
 *
 * @param {object[]} rituals Stored ritual records.
 * @returns {string} HTML tables grouped by rank.
 */
export function renderRitualsPage(rituals) {
  if (!rituals.length) return `<p><em>${game.i18n.localize("BWS.Ritual.SelectedEmpty")}</em></p>`;

  const head = [
    game.i18n.localize("BWS.Journal.TableRitual"),
    game.i18n.localize("BWS.Journal.TableCastTime"),
    game.i18n.localize("BWS.Journal.TableCost"),
    game.i18n.localize("BWS.Journal.TableSecondary")
  ]
    .map((label) => `<th>${label}</th>`)
    .join("");

  return groupRecords(rituals, (ritual) => ritual.rank)
    .map(([rank, list]) => {
      const rows = list
        .map((ritual) => {
          const detail = ritual.ritual ?? {};
          const casters = Number(detail.secondaryCasters) || 0;
          const cells = [
            uuidLink(ritual),
            esc(detail.castTime) || "&mdash;",
            esc(detail.cost) || "&mdash;",
            casters ? String(casters) : "&mdash;"
          ];
          return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
        })
        .join("");
      return `<h2>${getRankLabel(rank)}</h2>
<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join("\n");
}

/**
 * Render a stored formula list as journal page HTML.
 * @param {object[]} formulas Stored formula records.
 * @returns {string} HTML tables grouped by item level.
 */
export function renderFormulasPage(formulas) {
  if (!formulas.length) return `<p><em>${game.i18n.localize("BWS.Formula.SelectedEmpty")}</em></p>`;

  const head = [
    game.i18n.localize("BWS.Journal.TableItem"),
    game.i18n.localize("BWS.Journal.TablePrice"),
    game.i18n.localize("BWS.Journal.TableRarity")
  ]
    .map((label) => `<th>${label}</th>`)
    .join("");

  return groupRecords(formulas, (formula) => formula.level ?? 0)
    .map(([level, list]) => {
      const rows = list
        .map((formula) => {
          const cells = [
            uuidLink(formula),
            esc(formula.price) || "&mdash;",
            esc(formula.rarity ?? "common")
          ];
          return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
        })
        .join("");
      return `<h2>${game.i18n.format("BWS.Formula.LevelHeading", { level })}</h2>
<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join("\n");
}

/**
 * Render a book's contents for its journal page, according to its kind.
 * @param {object[]} records Stored records.
 * @param {string} [kind] One of {@link BOOK_KINDS}.
 * @returns {string} Page HTML.
 */
export function renderBookPage(records, kind = BOOK_KINDS.SPELLS) {
  if (kind === BOOK_KINDS.RITUALS) return renderRitualsPage(records);
  if (kind === BOOK_KINDS.FORMULAS) return renderFormulasPage(records);
  return renderSpellsPage(records);
}

/**
 * Strip a spell record down to what is worth persisting.
 * @param {object} spell A normalised spell record.
 * @returns {object} Storable record.
 */
export function toStoredSpell(spell) {
  return {
    uuid: spell.uuid,
    id: spell.id,
    packId: spell.packId,
    name: spell.name,
    img: spell.img,
    rank: spell.rank,
    traditions: spell.traditions ?? [],
    // Kept so the reader can show a page's rarity without re-reading the compendiums.
    // Books written before this existed simply have no rarity pill.
    ...(spell.rarity ? { rarity: spell.rarity } : {}),
    // Cast time, cost and secondary casters, on rituals only. The ritual book's page is
    // rendered from this, so it stays readable without re-reading the compendiums.
    ...(spell.ritual ? { ritual: spell.ritual } : {}),
    // Preserved verbatim if it was ever set, even while JB2A is disabled.
    ...(spell.jb2aAnimation ? { jb2aAnimation: spell.jb2aAnimation } : {})
  };
}

/**
 * Strip a formula record down to what is worth persisting.
 *
 * A formula is a pointer to a physical item, so the record keeps enough of that item to
 * render a readable page - level, price, rarity - without loading every compendium the
 * book draws on.
 *
 * @param {object} formula A normalised formula record.
 * @returns {object} Storable record.
 */
export function toStoredFormula(formula) {
  return {
    uuid: formula.uuid,
    id: formula.id,
    packId: formula.packId,
    name: formula.name,
    img: formula.img,
    level: formula.level ?? 0,
    price: formula.price ?? "",
    itemType: formula.itemType ?? "",
    ...(formula.rarity ? { rarity: formula.rarity } : {})
  };
}

/**
 * Reduce a record to its storable form according to a book's kind.
 * @param {object} record A normalised record.
 * @param {string} [kind] One of {@link BOOK_KINDS}.
 * @returns {object} Storable record.
 */
export function toStoredRecord(record, kind = BOOK_KINDS.SPELLS) {
  return kind === BOOK_KINDS.FORMULAS ? toStoredFormula(record) : toStoredSpell(record);
}

/**
 * Which kind of book this is.
 *
 * A missing flag means a spellbook: that is every book written before ritual and
 * formula books existed.
 *
 * @param {object} journal A JournalEntry.
 * @returns {string} One of {@link BOOK_KINDS}.
 */
export function getBookKind(journal) {
  const kind = journal?.getFlag?.(MODULE_ID, BOOK_KIND_FLAG);
  return Object.values(BOOK_KINDS).includes(kind) ? kind : BOOK_KINDS.SPELLS;
}

/**
 * Localised name for a book kind, as shown on buttons and row badges.
 * @param {string} kind One of {@link BOOK_KINDS}.
 * @returns {string}
 */
export function getBookKindLabel(kind) {
  const key = Object.values(BOOK_KINDS).includes(kind) ? kind : BOOK_KINDS.SPELLS;
  return game.i18n.localize(`BWS.Kind.${key}`);
}

/**
 * Font Awesome icon class for a book kind.
 * @param {string} kind One of {@link BOOK_KINDS}.
 * @returns {string}
 */
export function getBookKindIcon(kind) {
  if (kind === BOOK_KINDS.RITUALS) return "fa-solid fa-hat-wizard";
  if (kind === BOOK_KINDS.FORMULAS) return "fa-solid fa-hammer";
  return "fa-solid fa-wand-sparkles";
}

/**
 * Create a new book journal entry.
 *
 * @param {object} params
 * @param {string} params.name Book name.
 * @param {object[]} params.spells Normalised records to store. Spell records for a
 *   spellbook or ritual book, formula records for a formula book.
 * @param {string} [params.kind] One of {@link BOOK_KINDS}. Defaults to a spellbook.
 * @returns {Promise<object|null>} The created JournalEntry, or null on failure.
 */
export async function createSpellbook({ name, spells, kind = BOOK_KINDS.SPELLS }) {
  try {
    const folder = await getOrCreateSpellbooksFolder();
    const stored = spells.map((record) => toStoredRecord(record, kind));

    return await JournalEntry.create({
      name,
      folder: folder?.id ?? null,
      ownership: buildOwnership(),
      flags: {
        [MODULE_ID]: { [SPELLS_FLAG]: stored, [BOOK_KIND_FLAG]: kind, createdBy: game.user.id }
      },
      pages: [
        {
          name: game.i18n.localize(`BWS.Journal.PageTitle.${kind}`),
          type: "text",
          text: {
            format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML,
            content: renderBookPage(stored, kind)
          }
        }
      ]
    });
  } catch (err) {
    console.error("Blizzard's Wondrous Spellbook | Failed to create the spellbook", err);
    ui.notifications.error(game.i18n.localize("BWS.Error.SaveFailed"));
    return null;
  }
}

/**
 * Update an existing book in place, preserving its ownership map.
 *
 * The kind is read off the book rather than passed in: a book never changes what it is,
 * and a caller that thought otherwise would rewrite the page in the wrong shape.
 *
 * @param {object} journal The JournalEntry to update.
 * @param {object} params
 * @param {string} params.name New book name.
 * @param {object[]} params.spells Normalised records to store.
 * @returns {Promise<object|null>} The updated JournalEntry, or null on failure.
 */
export async function updateSpellbook(journal, { name, spells }) {
  if (!canEditSpellbook(journal)) {
    ui.notifications.warn(game.i18n.localize("BWS.Notify.NoPermission"));
    return null;
  }

  try {
    const kind = getBookKind(journal);
    const stored = spells.map((record) => toStoredRecord(record, kind));
    await journal.update({
      name,
      [`flags.${MODULE_ID}.${SPELLS_FLAG}`]: stored,
      // Stamped on update too, so a book written before kinds existed gains one the
      // first time it is saved.
      [`flags.${MODULE_ID}.${BOOK_KIND_FLAG}`]: kind
    });

    // Keep the readable page in step with the flag data.
    const page = journal.pages.contents[0];
    const content = renderBookPage(stored, kind);
    if (page) await page.update({ "text.content": content });
    else {
      await journal.createEmbeddedDocuments("JournalEntryPage", [
        {
          name: game.i18n.localize(`BWS.Journal.PageTitle.${kind}`),
          type: "text",
          text: { format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML, content }
        }
      ]);
    }
    return journal;
  } catch (err) {
    console.error("Blizzard's Wondrous Spellbook | Failed to update the spellbook", err);
    ui.notifications.error(game.i18n.localize("BWS.Error.SaveFailed"));
    return null;
  }
}

/**
 * Delete a spellbook.
 * @param {object} journal The JournalEntry to delete.
 * @returns {Promise<boolean>} True when the entry was deleted.
 */
export async function deleteSpellbook(journal) {
  if (!canEditSpellbook(journal)) {
    ui.notifications.warn(game.i18n.localize("BWS.Notify.NoPermission"));
    return false;
  }
  try {
    const name = journal.name;
    await journal.delete();
    ui.notifications.info(game.i18n.format("BWS.Notify.Deleted", { name }));
    return true;
  } catch (err) {
    console.error("Blizzard's Wondrous Spellbook | Failed to delete the spellbook", err);
    ui.notifications.error(game.i18n.localize("BWS.Error.DeleteFailed"));
    return false;
  }
}

/**
 * Read the spell records stored on a spellbook.
 * @param {object} journal A JournalEntry.
 * @returns {object[]} Stored spell records, or an empty array.
 */
export function getStoredSpells(journal) {
  const spells = journal?.getFlag?.(MODULE_ID, SPELLS_FLAG);
  return Array.isArray(spells) ? spells : [];
}

/**
 * Is this JournalEntry one of our spellbooks?
 * @param {object} journal A JournalEntry.
 * @returns {boolean}
 */
export function isSpellbook(journal) {
  return Array.isArray(journal?.getFlag?.(MODULE_ID, SPELLS_FLAG));
}

/**
 * May the current user edit this spellbook? GMs always may.
 * @param {object} journal A JournalEntry.
 * @returns {boolean}
 */
export function canEditSpellbook(journal) {
  if (game.user.isGM) return true;
  return !!journal?.testUserPermission(game.user, "OWNER");
}

/**
 * List the spellbooks the current user may see.
 *
 * GMs get every spellbook in the folder. Players get only the ones they own, tested
 * through `testUserPermission` rather than by comparing the creator id, so ownership
 * granted after the fact is respected.
 *
 * @param {object} [options]
 * @param {string|null} [options.kind=null] Keep only books of this kind. Null lists
 *   every kind, which is what the browser wants.
 * @returns {object[]} JournalEntry documents, sorted by name.
 */
export function getUserSpellbooks({ kind = null } = {}) {
  const folderName = getFolderName();
  const folder = game.folders.find((f) => f.type === "JournalEntry" && f.name === folderName);

  return game.journal
    .filter((entry) => {
      if (!isSpellbook(entry)) return false;
      if (folder && entry.folder?.id !== folder.id) return false;
      if (kind && getBookKind(entry) !== kind) return false;
      if (game.user.isGM) return true;
      return entry.testUserPermission(game.user, "OWNER");
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Summarise a spellbook for the browser list.
 * @param {object} journal A JournalEntry.
 * @returns {object} View model with counts and permission flags.
 */
export function summariseSpellbook(journal) {
  const records = getStoredSpells(journal);
  const kind = getBookKind(journal);
  const isFormulas = kind === BOOK_KINDS.FORMULAS;

  // Formula records have an item level rather than a spell rank, and a level badge per
  // level would be a row of twenty; the count carries that book instead.
  const ranks = isFormulas
    ? []
    : [...new Set(records.map((record) => record.rank))].sort((a, b) => a - b);

  const countKey = {
    [BOOK_KINDS.FORMULAS]: "BWS.Browser.FormulaSummary",
    [BOOK_KINDS.RITUALS]: "BWS.Browser.RitualSummary"
  }[kind] ?? "BWS.Browser.SpellSummary";
  return {
    id: journal.id,
    uuid: journal.uuid,
    name: journal.name,
    // `bookKind`, not `kind`: the browser lists journals alongside rolled loot items and
    // uses `kind` for which document collection a row lives in. What a book *holds* is a
    // separate question from where it is stored, and the two must not share a name.
    bookKind: kind,
    kindLabel: getBookKindLabel(kind),
    kindIcon: getBookKindIcon(kind),
    // Formula books have no in-module editor to open; the journal page is their view.
    isFormulas,
    count: records.length,
    countLabel:
      records.length === 1
        ? game.i18n.localize(`${countKey}One`)
        : game.i18n.format(countKey, { count: records.length }),
    ranks: ranks.map((r) => ({ rank: r, badge: getRankBadge(r) })),
    canEdit: canEditSpellbook(journal)
  };
}
