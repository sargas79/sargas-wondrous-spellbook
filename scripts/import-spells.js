/**
 * Character sheet import.
 *
 * The read-side mirror of `slot-manager.js`: where that sends one spell from a book
 * into an actor's slots, this collects the spells an actor already has and turns them
 * back into the stored records a spellbook holds.
 *
 * An owned spell is a copy, not a reference, so every row is matched back to the
 * compendium original before it is stored — by source id, then slug, then name. That
 * matters because a stored record's uuid is what "Send to Slot" later resolves: a book
 * holding `Actor.x.Item.y` uuids would break the moment that character is deleted.
 * Spells that match nothing are still importable, but they are marked unlinked so the
 * user knows the row is tied to that one sheet.
 */

import { MODULE_ID } from "./constants.js";
import { ANIMATION_FLAG } from "./animation-config.js";
import {
  MAX_RANK,
  getRankBadge,
  getRarityLabel,
  getSpellRank,
  getSpellRarity,
  getSpellSlug,
  getSpellTraditions,
  isCantrip,
  isFocusSpell,
  isRitual,
  loadAllSpells
} from "./spell-query.js";
import {
  canEditSpellbook,
  createSpellbook,
  getStoredSpells,
  getUserSpellbooks,
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
 * @returns {Promise<{ byUuid: Map<string, object>, bySlug: Map<string, object>, byName: Map<string, object> }>}
 */
async function buildMatchIndex() {
  const { spells } = await loadAllSpells();

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
 * Actors the current user could import a spellbook from.
 *
 * Ownership is required because the import reads the sheet's items; actors with no
 * spells at all are dropped so the picker never offers an empty sheet.
 *
 * @returns {object[]} Actor documents, sorted by name.
 */
export function listImportableActors() {
  return game.actors
    .filter((actor) => actor.isOwner && (actor.itemTypes?.spell?.length ?? 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Collect an actor's spells, grouped by the spellcasting entry that holds them.
 *
 * Rituals are dropped here for the same reason the compendium query drops them: a
 * spellbook exists to feed spell slots, and a ritual can never occupy one. The count
 * comes back on the result so the UI can say so rather than silently losing rows.
 *
 * @param {object} actor The actor to read.
 * @returns {Promise<{ groups: object[], total: number, unlinked: number, rituals: number }>}
 */
export async function collectActorSpells(actor) {
  if (!actor) return { groups: [], total: 0, unlinked: 0, rituals: 0 };

  const index = await buildMatchIndex();
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

    if (isRitual(item)) {
      rituals++;
      return null;
    }

    const match = matchCompendiumSpell(item, index);
    const rank = match ? match.rank : getBaseRank(item);
    const traditions = match ? match.traditions : getSpellTraditions(item);
    const rarity = match ? match.rarity : getSpellRarity(item);
    // Kept through the import so a configured animation survives the round trip out to
    // a book and back into another sheet.
    const animation = item.getFlag?.(MODULE_ID, ANIMATION_FLAG) ?? "";

    if (!match) unlinked++;
    total++;

    return {
      itemId: item.id,
      name: match?.name ?? item.name,
      img: match?.img ?? item.img,
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
      linked: !!match,
      // What actually gets written into the book. An unmatched spell keeps its owned
      // uuid, which resolves for as long as this actor holds the item.
      record: toStoredSpell({
        ...(match ?? {
          uuid: item.uuid,
          id: item.id,
          packId: "",
          name: item.name,
          img: item.img,
          rank,
          traditions,
          rarity
        }),
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

  // Spells with no entry - or with a stale entry id - would otherwise be invisible.
  const loose = actor.itemTypes.spell.map(toRow).filter(Boolean);
  if (loose.length) {
    loose.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    groups.push({
      id: "",
      name: game.i18n.localize("BWS.Import.LooseSpells"),
      kind: "",
      tradition: "",
      spells: loose
    });
  }

  return { groups, total, unlinked, rituals };
}

/**
 * Spellbooks the current user may import into.
 * @returns {object[]} JournalEntry documents, sorted by name.
 */
export function listImportTargets() {
  return getUserSpellbooks().filter((journal) => canEditSpellbook(journal));
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
 * @param {object[]} params.spells Stored spell records to write.
 * @param {string} [params.name] Name for a new spellbook. Ignored when merging.
 * @param {object} [params.journal] An existing spellbook to merge into.
 * @returns {Promise<{ journal: object, added: number, skipped: number }|null>}
 *   Null when the write failed; the underlying helper has already reported why.
 */
export async function importIntoSpellbook({ spells, name, journal = null }) {
  const incoming = [];
  const seen = new Set();
  // One compendium spell can sit in two entries on the same sheet; the book holds it once.
  for (const spell of spells) {
    if (seen.has(spell.uuid)) continue;
    seen.add(spell.uuid);
    incoming.push(spell);
  }

  if (!journal) {
    const created = await createSpellbook({ name, spells: incoming });
    return created ? { journal: created, added: incoming.length, skipped: 0 } : null;
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
