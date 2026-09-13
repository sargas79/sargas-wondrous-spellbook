/**
 * Character sheet import.
 *
 * The read-side mirror of `slot-manager.js`: where that sends one spell from a book
 * into an actor's slots, this collects the spells an actor already has and turns them
 * back into the stored records a spellbook holds.
 *
 * The same pass serves ritual books: a ritual is an ordinary spell item on the sheet,
 * bound to a ritual spellcasting entry, so only the pool it is matched against changes.
 *
 * An owned spell is a copy, not a reference, so every row is matched back to the
 * compendium original before it is stored — by source id, then slug, then name. That
 * matters because a stored record's uuid is what "Send to Slot" later resolves: a book
 * holding `Actor.x.Item.y` uuids would break the moment that character is deleted.
 * Spells that match nothing are still importable, but they are marked unlinked so the
 * user knows the row is tied to that one sheet.
 */

import { BOOK_KINDS, MODULE_ID } from "./constants.js";
import { ANIMATION_FLAG } from "./animation-config.js";
import {
  MAX_RANK,
  getRankBadge,
  getRarityLabel,
  getRitualDetails,
  getSpellRank,
  getSpellRarity,
  getSpellSlug,
  getSpellTraditions,
  isCantrip,
  isFocusSpell,
  isRitual,
  loadAllRituals,
  loadAllSpells
} from "./spell-query.js";
import { collectActorFormulas, getActorFormulaUuids } from "./formula-query.js";
import {
  canEditSpellbook,
  createSpellbook,
  getBookKind,
  getStoredSpells,
  getUserSpellbooks,
  toStoredFormula,
  toStoredSpell,
  updateSpellbook
} from "./persistence.js";

/**
 * Read the compendium a sheet spell was copied from.
 *
 * Foundry moved the source id from `flags.core.sourceId` to `_stats.compendiumSource`
 * during v12, so both are read. A world item id (`Item.abc`) is deliberately rejected:
 * only a compendium uuid is stable enough to store in a book.
 *
 * @param {object} item An owned Item document.
 * @returns {string} A `Compendium.…` uuid, or an empty string.
 */
export function getCompendiumSource(item) {
  const raw =
    item?._stats?.compendiumSource ??
    item?._source?._stats?.compendiumSource ??
    item?.flags?.core?.sourceId ??
    item?.sourceId ??
    "";
  const uuid = String(raw);
  return uuid.startsWith("Compendium.") ? uuid : "";
}

/**
 * Read an owned spell's own rank, ignoring the slot it happens to sit in.
 *
 * A prepared spell can be slotted above its rank, and some PF2e builds fold that
 * heightening into the item's `rank` getter. A book stores the spell, not one casting
 * of it, so the source level wins and the getter is only a fallback.
 *
 * @param {object} item An owned spell Item.
 * @returns {number} Rank 0-10, where 0 means cantrip.
 */
function getBaseRank(item) {
  if (isCantrip(item)) return 0;
  const raw = item?.system?.level?.value;
  const rank = Number(raw);
  if (Number.isFinite(rank)) return Math.clamp(rank, 0, MAX_RANK);
  return getSpellRank(item);
}

/**
 * Build the lookup tables used to match a sheet spell to its compendium original.
 *
 * The two pools are kept apart on purpose: a ritual must never resolve to a same-named
 * slot spell, or a ritual book would quietly store something that is not a ritual.
 *
 * @param {string} kind `spells` or `rituals`.
 * @returns {Promise<{ byUuid: Map<string, object>, bySlug: Map<string, object>, byName: Map<string, object> }>}
 */
async function buildMatchIndex(kind) {
  const spells =
    kind === BOOK_KINDS.RITUALS ? (await loadAllRituals()).rituals : (await loadAllSpells()).spells;

  const byUuid = new Map();
  const bySlug = new Map();
  const byName = new Map();
  for (const spell of spells) {
    byUuid.set(spell.uuid, spell);
    // First pack wins for slug and name: several compendiums can reprint one spell, and
    // any of those copies resolves to the same content.
    if (spell.slug && !bySlug.has(spell.slug)) bySlug.set(spell.slug, spell);
    const name = spell.name.toLowerCase();
    if (!byName.has(name)) byName.set(name, spell);
  }

  return { byUuid, bySlug, byName };
}

/**
 * Find the compendium record behind an owned spell.
 *
 * @param {object} item An owned spell Item.
 * @param {object} index The tables from {@link buildMatchIndex}.
 * @returns {object|null} A normalised compendium record, or null when nothing matches.
 */
function matchCompendiumSpell(item, index) {
  const sourceId = getCompendiumSource(item);
  // A source id can outlive the pack it points at, so a hit still has to be in the
  // index; if the pack is gone, the slug and name passes below can still rescue it.
  if (sourceId && index.byUuid.has(sourceId)) return index.byUuid.get(sourceId);

  const slug = getSpellSlug(item);
  if (slug && index.bySlug.has(slug)) return index.bySlug.get(slug);

  return index.byName.get(String(item?.name ?? "").toLowerCase()) ?? null;
}

/**
 * Human-readable kind of a spellcasting entry.
 *
 * A local copy of `slot-manager.js`'s version rather than a shared export: that one
 * describes where a spell is going, this one describes where it came from, and the two
 * lists are free to drift apart as PF2e adds entry kinds.
 *
 * @param {object} entry A SpellcastingEntryPF2e.
 * @returns {string} Localised label such as "prepared" or "spontaneous".
 */
function describeEntryKind(entry) {
  if (entry.isPrepared) return game.i18n.localize("BWS.Slot.EntryPrepared");
  if (entry.isSpontaneous) return game.i18n.localize("BWS.Slot.EntrySpontaneous");
  if (entry.isInnate) return game.i18n.localize("BWS.Slot.EntryInnate");
  if (entry.isFocusPool) return game.i18n.localize("BWS.Slot.EntryFocus");
  if (entry.isRitual) return game.i18n.localize("BWS.Slot.EntryRitual");
  return "";
}

/**
 * Every spell item bound to one spellcasting entry.
 *
 * PF2e's `entry.spells` collection is preferred because it knows about the entry's own
 * bookkeeping; the `system.location` scan is the fallback for entry kinds that expose
 * no collection at all.
 *
 * @param {object} entry A SpellcastingEntryPF2e.
 * @param {object} actor The owning actor.
 * @returns {object[]} Owned spell Items.
 */
function getEntrySpells(entry, actor) {
  const collection = entry?.spells;
  const contents = collection?.contents ?? (collection ? [...collection] : null);
  if (Array.isArray(contents) && contents.length) return contents;
  return actor.itemTypes.spell.filter((spell) => spell.system?.location?.value === entry.id);
}

/**
 * One-line summary of a ritual's cast time, cost and secondary casters.
 *
 * Built for the exporter's rows, where there is no space for a table but a GM still
 * wants to see what a ritual is going to cost before ticking it.
 *
 * @param {object} ritual The detail object from `getRitualDetails`.
 * @returns {string}
 */
function describeRitual(ritual) {
  const parts = [];
  if (ritual.castTime) parts.push(ritual.castTime);
  if (ritual.cost) parts.push(ritual.cost);
  if (ritual.secondaryCasters) {
    parts.push(
      game.i18n.format("BWS.Ritual.SecondaryCasters", { count: ritual.secondaryCasters })
    );
  }
  return parts.join(" \u00b7 ");
}

/**
 * Actors the current user could import a book from.
 *
 * Ownership is required because the import reads the sheet; actors with nothing of the
 * requested kind are dropped so the picker never offers an empty sheet. Rituals share
 * the spell test rather than getting their own: a sheet's rituals are spell items, and
 * testing them properly would mean walking every spell on every actor to build a
 * dropdown.
 *
 * @param {object} [options]
 * @param {string} [options.kind] One of the book kinds.
 * @returns {object[]} Actor documents, sorted by name.
 */
export function listImportableActors({ kind = BOOK_KINDS.SPELLS } = {}) {
  const hasContent =
    kind === BOOK_KINDS.FORMULAS
      ? (actor) => getActorFormulaUuids(actor).length > 0
      : (actor) => (actor.itemTypes?.spell?.length ?? 0) > 0;

  return game.actors
    .filter((actor) => actor.isOwner && actor.type !== "loot" && hasContent(actor))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Collect whatever a book of the given kind takes from a character sheet.
 *
 * The one entry point the exporter uses, so its selection list is the same shape for all
 * three kinds: every group holds `rows`, and every row carries the `record` that would
 * be written into the book.
 *
 * @param {object} actor The actor to read.
 * @param {string} [kind] One of the book kinds.
 * @returns {Promise<{ groups: object[], total: number, unlinked: number, rituals: number, missing: number }>}
 */
export async function collectFromActor(actor, kind = BOOK_KINDS.SPELLS) {
  if (kind === BOOK_KINDS.FORMULAS) {
    const { groups, total, missing } = await collectActorFormulas(actor);
    return {
      total,
      missing,
      // A formula matches its compendium item by uuid or not at all, so neither of the
      // spell importer's two caveats can arise here.
      unlinked: 0,
      rituals: 0,
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        kind: "",
        rows: group.formulas.map((formula) => ({
          // A formula is a uuid on the sheet rather than an item, so the uuid is also
          // the row key - which makes duplicates impossible by construction.
          itemId: formula.uuid,
          isFormula: true,
          linked: true,
          name: formula.name,
          img: formula.img,
          rankBadge: game.i18n.format("BWS.Formula.LevelShort", { level: formula.level }),
          price: formula.price,
          rarity: formula.rarity,
          rarityLabel: getRarityLabel(formula.rarity),
          itemTypeLabel: formula.itemTypeLabel,
          record: toStoredFormula(formula)
        }))
      }))
    };
  }

  const data = await collectActorSpells(actor, { kind });
  return {
    ...data,
    missing: 0,
    groups: data.groups.map((group) => ({ ...group, rows: group.spells }))
  };
}

/**
 * Collect an actor's spells, grouped by the spellcasting entry that holds them.
 *
 * In `spells` mode rituals are dropped, for the same reason the compendium query drops
 * them: a spellbook exists to feed spell slots, and a ritual can never occupy one. The
 * count comes back on the result so the UI can say so rather than silently losing rows.
 * In `rituals` mode the filter is exactly inverted and nothing else changes.
 *
 * @param {object} actor The actor to read.
 * @param {object} [options]
 * @param {string} [options.kind] `spells` or `rituals`.
 * @returns {Promise<{ groups: object[], total: number, unlinked: number, rituals: number }>}
 */
export async function collectActorSpells(actor, { kind = BOOK_KINDS.SPELLS } = {}) {
  if (!actor) return { groups: [], total: 0, unlinked: 0, rituals: 0 };

  const wantRituals = kind === BOOK_KINDS.RITUALS;
  const index = await buildMatchIndex(kind);
  const entries = actor.itemTypes.spellcastingEntry ?? [];
  const seen = new Set();
  const groups = [];
  let total = 0;
  let unlinked = 0;
  let rituals = 0;

  /**
   * Turn one owned spell into a row, or null when it does not belong in a book.
   * @param {object} item An owned spell Item.
   * @returns {object|null}
   */
  const toRow = (item) => {
    if (item.type !== "spell") return null;
    // A spell can be reachable through both the entry collection and the location scan.
    if (seen.has(item.id)) return null;
    seen.add(item.id);

    const itemIsRitual = isRitual(item);
    if (itemIsRitual !== wantRituals) {
      // Only worth reporting the other way round: a spellbook silently losing the
      // sheet's rituals is the surprising case, a ritual book ignoring spells is not.
      if (itemIsRitual) rituals++;
      return null;
    }

    const match = matchCompendiumSpell(item, index);
    const rank = match ? match.rank : getBaseRank(item);
    // Cast time, cost and secondary casters, so a ritual book's page reads without
    // reopening the compendium it came from.
    const ritual = wantRituals ? match?.ritual ?? getRitualDetails(item) : null;
    const traditions = match ? match.traditions : getSpellTraditions(item);
    const rarity = match ? match.rarity : getSpellRarity(item);
    // Kept through the import so a configured animation survives the round trip out to
    // a book and back into another sheet.
    const animation = item.getFlag?.(MODULE_ID, ANIMATION_FLAG) ?? "";

    if (!match) unlinked++;
    total++;

    return {
      itemId: item.id,
      // The sheet's own name and icon, not the compendium's: players rename spells, and
      // a book that silently put the printed name back would lose that. The match still
      // supplies the uuid, so the link resolves exactly as before.
      name: item.name,
      img: item.img,
      // Shown alongside a renamed row so it is clear what the link points at.
      ...(match && match.name !== item.name ? { sourceName: match.name } : {}),
      rank,
      rankBadge: getRankBadge(rank),
      traditions,
      traditionTags: traditions.map((key) => ({
        key,
        label: game.i18n.localize(`BWS.Tradition.${key.charAt(0).toUpperCase()}${key.slice(1)}`)
      })),
      rarity,
      rarityLabel: getRarityLabel(rarity),
      isCantrip: rank === 0,
      isFocus: match ? match.isFocus : isFocusSpell(item),
      ...(ritual ? { ritual, detailLine: describeRitual(ritual) } : {}),
      linked: !!match,
      // What actually gets written into the book. An unmatched spell keeps its owned
      // uuid, which resolves for as long as this actor holds the item.
      record: toStoredSpell({
        ...(match ?? {
          uuid: item.uuid,
          id: item.id,
          packId: "",
          rank,
          traditions,
          rarity
        }),
        name: item.name,
        img: item.img,
        ...(ritual ? { ritual } : {}),
        ...(animation ? { jb2aAnimation: animation } : {})
      })
    };
  };

  for (const entry of entries) {
    const spells = getEntrySpells(entry, actor).map(toRow).filter(Boolean);
    if (!spells.length) continue;

    spells.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    groups.push({
      id: entry.id,
      name: entry.name,
      kind: describeEntryKind(entry),
      tradition: entry.tradition ?? "",
      spells
    });
  }

  // Spells with no entry - or with a stale entry id - would otherwise be invisible. In
  // rituals mode this is the normal case rather than a leftover: PF2e casts rituals
  // through a virtual entry that is not an item, so a sheet's rituals are never reached
  // by the entry pass above and all land here.
  const loose = actor.itemTypes.spell.map(toRow).filter(Boolean);
  if (loose.length) {
    loose.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    groups.push({
      id: "",
      name: game.i18n.localize(wantRituals ? "BWS.Import.LooseRituals" : "BWS.Import.LooseSpells"),
      kind: "",
      tradition: "",
      spells: loose
    });
  }

  return { groups, total, unlinked, rituals };
}

/**
 * Books the current user may import into.
 *
 * Filtered to one kind: merging spells into a formula book would write records the
 * book's page renderer cannot read.
 *
 * @param {string} [kind] One of the book kinds.
 * @returns {object[]} JournalEntry documents, sorted by name.
 */
export function listImportTargets(kind = BOOK_KINDS.SPELLS) {
  return getUserSpellbooks({ kind }).filter((journal) => canEditSpellbook(journal));
}

/**
 * Write imported spells into a new or existing spellbook.
 *
 * Merging keeps the book's existing order and appends what is new, so importing the
 * same sheet twice is a no-op rather than a pile of duplicates. Records already in the
 * book are left untouched: a stored spell may carry an animation path the sheet copy
 * does not know about.
 *
 * @param {object} params
 * @param {object[]} params.spells Stored records to write.
 * @param {string} [params.name] Name for a new book. Ignored when merging.
 * @param {object} [params.journal] An existing book to merge into.
 * @param {string} [params.kind] Kind of book to create. Ignored when merging, where the
 *   target book's own kind decides.
 * @returns {Promise<{ journal: object, added: number, skipped: number }|null>}
 *   Null when the write failed; the underlying helper has already reported why.
 */
export async function importIntoSpellbook({
  spells,
  name,
  journal = null,
  kind = BOOK_KINDS.SPELLS
}) {
  const incoming = [];
  const seen = new Set();
  // One compendium spell can sit in two entries on the same sheet; the book holds it once.
  for (const spell of spells) {
    if (seen.has(spell.uuid)) continue;
    seen.add(spell.uuid);
    incoming.push(spell);
  }

  if (!journal) {
    const created = await createSpellbook({ name, spells: incoming, kind });
    return created ? { journal: created, added: incoming.length, skipped: 0 } : null;
  }

  // Refuse a mismatch outright rather than writing records the book cannot render. The
  // exporter only ever offers same-kind targets, so this catches API misuse.
  if (getBookKind(journal) !== kind) {
    ui.notifications.warn(game.i18n.localize("BWS.Import.KindMismatch"));
    return null;
  }

  const existing = getStoredSpells(journal);
  const known = new Set(existing.map((spell) => spell.uuid));
  const additions = incoming.filter((spell) => !known.has(spell.uuid));

  if (!additions.length) return { journal, added: 0, skipped: incoming.length };

  const updated = await updateSpellbook(journal, {
    name: journal.name,
    spells: [...existing, ...additions]
  });
  return updated
    ? { journal: updated, added: additions.length, skipped: incoming.length - additions.length }
    : null;
}
