/**
 * Spell query engine.
 *
 * Reads every `spell` Item out of the world's Item compendium packs, normalises the
 * bits of the PF2e data model this module cares about, and groups the result by rank
 * so a Handlebars template can render it directly.
 *
 * PF2e renamed spell "level" to "rank" in its UI, but the stored source data still
 * lives at `system.level.value`. `SpellPF2e` exposes a `rank` getter on top of it.
 * Every accessor below reads the getter first and falls back to raw source paths, so
 * the module keeps working across PF2e data-model shuffles.
 */

import { BOOK_KINDS } from "./constants.js";

/** @type {readonly string[]} The four PF2e magical traditions. */
export const TRADITIONS = Object.freeze(["arcane", "divine", "occult", "primal"]);

/** Highest spell rank in PF2e. */
export const MAX_RANK = 10;

/**
 * @type {readonly number[]} Every selectable rank, cantrips (0) first.
 * Shared by the query filter and the creator's rank chips so both agree on the range.
 */
export const RANKS = Object.freeze(Array.from({ length: MAX_RANK + 1 }, (_, i) => i));

/**
 * @type {readonly string[]} PF2e rarity slugs, ascending. Index order is meaningful:
 * the loot generator keeps every spell at or below a chosen ceiling.
 */
export const RARITIES = Object.freeze(["common", "uncommon", "rare", "unique"]);

/**
 * Cached compendium read. Building this is expensive (it loads every spell document
 * in every pack), so it is done once and reused for all subsequent filtering.
 *
 * Rituals are kept in their own list rather than mixed into `spells`. Everything that
 * fills a spell slot reads `spells` and must never see a ritual; the ritual book side
 * of the module reads `rituals` and wants nothing else. One pass over the packs feeds
 * both.
 *
 * @type {{ spells: object[], rituals: object[], packCount: number } | null}
 */
let _cache = null;

/** In-flight load, so concurrent callers share one pass over the packs. */
let _loading = null;

/**
 * Compendium index fields read by {@link normaliseSpell}. Whole sub-objects are named
 * rather than single leaves so every fallback path in the accessors below still finds
 * its data on an index entry.
 */
const INDEX_FIELDS = Object.freeze([
  "system.level",
  "system.traits",
  "system.category",
  "system.ritual",
  "system.time",
  "system.cost",
  "system.publication",
  "system.source",
  "system.slug"
]);

/** Clear the cached compendium read. Call when packs change. */
export function invalidateSpellCache() {
  _cache = null;
  _loading = null;
}

/**
 * Read a spell's rank (formerly "level").
 * @param {object} spell A SpellPF2e document or raw spell source.
 * @returns {number} Rank 0-10, where 0 means cantrip.
 */
export function getSpellRank(spell) {
  const raw = spell?.rank ?? spell?.system?.level?.value ?? spell?.system?.rank;
  const rank = Number(raw);
  return Number.isFinite(rank) ? Math.clamp(rank, 0, MAX_RANK) : 1;
}

/**
 * Read a spell's traits array.
 * @param {object} spell A SpellPF2e document or raw spell source.
 * @returns {string[]} Lower-cased trait slugs.
 */
export function getSpellTraits(spell) {
  const traits = spell?.system?.traits?.value;
  if (!Array.isArray(traits)) return [];
  return traits.map((t) => String(t).toLowerCase());
}

/**
 * Read a spell's magical traditions.
 * @param {object} spell A SpellPF2e document or raw spell source.
 * @returns {string[]} Any of arcane/divine/occult/primal present on the spell.
 */
export function getSpellTraditions(spell) {
  // PF2e 6+ keeps traditions in their own bucket; older data folded them into traits.
  const explicit = spell?.system?.traits?.traditions;
  const source = Array.isArray(explicit) ? explicit : getSpellTraits(spell);
  return source.map((t) => String(t).toLowerCase()).filter((t) => TRADITIONS.includes(t));
}

/**
 * Read a spell's rarity.
 * @param {object} spell A SpellPF2e document or raw spell source.
 * @returns {string} One of common/uncommon/rare/unique.
 */
export function getSpellRarity(spell) {
  const raw = spell?.system?.traits?.rarity ?? spell?.rarity;
  const rarity = typeof raw === "string" ? raw.toLowerCase() : "";
  return RARITIES.includes(rarity) ? rarity : "common";
}

/**
 * Slugify a free-text source title into a stable key.
 *
 * Letters and digits are kept in any script: a Latin-only pattern would collapse a
 * Japanese or Cyrillic publication title to an empty string, and every such source
 * would then share one key in the picker. Diacritics are folded so "Sombras del
 * Espejo" and "Sombrás del Espejo" do not split into two entries.
 *
 * @param {string} value
 * @returns {string} Lower-cased, dash-separated key.
 */
function slugify(value) {
  return String(value)
    .normalize("NFKD")
    // Combining marks left behind by the decomposition above.
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Stable picker key for a source title.
 *
 * A title made entirely of punctuation still slugifies to nothing, so those fall back
 * to a hash of the title rather than a shared literal: two such sources must not
 * collapse into one row of the picker.
 *
 * @param {string} label A source title.
 * @returns {string}
 */
function sourceKey(label) {
  const slug = slugify(label);
  if (slug) return slug;

  const title = String(label).trim();
  if (!title) return "unknown";

  let hash = 2166136261;
  for (let i = 0; i < title.length; i++) {
    hash ^= title.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `source-${(hash >>> 0).toString(36)}`;
}

/**
 * Read the book a spell was published in.
 *
 * PF2e moved this from `system.source.value` to `system.publication.title`; both are
 * read so the label survives either data model. Third-party and homebrew packs often
 * leave it empty, so callers pass the compendium's own label as the fallback.
 *
 * @param {object} spell A SpellPF2e document or raw spell source.
 * @param {string} [fallback=""] Used when the spell carries no publication title.
 * @returns {string} A human-readable source title.
 */
export function getSpellSource(spell, fallback = "") {
  const raw = spell?.system?.publication?.title ?? spell?.system?.source?.value ?? "";
  const title = String(raw).trim();
  return title || fallback;
}

/**
 * Read a spell's slug.
 *
 * PF2e stamps a slug on every compendium spell, and copies it onto the owned item when
 * a spell is added to an actor, so it is the most reliable way to recognise a sheet
 * spell that has lost its compendium link. Falls back to an empty string rather than
 * deriving one from the name: the caller already falls back to a name match.
 *
 * @param {object} spell A SpellPF2e document or raw spell source.
 * @returns {string} Lower-cased slug, or an empty string.
 */
export function getSpellSlug(spell) {
  const raw = spell?.system?.slug ?? spell?.slug ?? "";
  return typeof raw === "string" ? raw.toLowerCase() : "";
}

/**
 * Read the ritual-specific fields off a ritual spell.
 *
 * PF2e keeps these under `system.ritual`, with the cast time and cost living on the
 * ordinary spell fields. Every one of them is optional in practice - third-party
 * rituals often fill in only some - so each falls back to an empty value rather than
 * to a guess.
 *
 * @param {object} spell A SpellPF2e document or raw spell source.
 * @returns {{ castTime: string, cost: string, primaryCheck: string, secondaryCasters: number, secondaryChecks: string }}
 */
export function getRitualDetails(spell) {
  const ritual = spell?.system?.ritual ?? {};
  const casters = Number(ritual?.secondary?.casters);
  return {
    castTime: String(spell?.system?.time?.value ?? "").trim(),
    cost: String(spell?.system?.cost?.value ?? "").trim(),
    primaryCheck: String(ritual?.primary?.check ?? "").trim(),
    secondaryCasters: Number.isFinite(casters) ? casters : 0,
    secondaryChecks: String(ritual?.secondary?.checks ?? "").trim()
  };
}

/**
 * Read a spell's category slug (`spell`, `focus`, `ritual`, ...).
 * @param {object} spell A SpellPF2e document or raw spell source.
 * @returns {string} Lower-cased category slug, or an empty string.
 */
export function getSpellCategory(spell) {
  const raw = spell?.system?.category?.value ?? spell?.system?.category;
  return typeof raw === "string" ? raw.toLowerCase() : "";
}

/**
 * Is this a focus spell?
 * @param {object} spell A SpellPF2e document or raw spell source.
 * @returns {boolean}
 */
export function isFocusSpell(spell) {
  if (typeof spell?.isFocusSpell === "boolean") return spell.isFocusSpell;
  if (getSpellCategory(spell) === "focus" || getSpellTraits(spell).includes("focus")) return true;
  // PF2e's own rule: a cantrip that belongs to no tradition is a focus cantrip, such as
  // a bard's compositions. Raw data and index entries have no getter to say so.
  const traditions = spell?.system?.traits?.traditions;
  return Array.isArray(traditions) && traditions.length === 0 && isCantrip(spell);
}

/**
 * Is this a ritual? Rituals cannot occupy spell slots, so they are always excluded.
 * @param {object} spell A SpellPF2e document or raw spell source.
 * @returns {boolean}
 */
export function isRitual(spell) {
  if (typeof spell?.isRitual === "boolean") return spell.isRitual;
  return getSpellCategory(spell) === "ritual" || !!spell?.system?.ritual;
}

/**
 * Is this a cantrip? Cantrips report rank 0 in this module's grouping.
 * @param {object} spell A SpellPF2e document or raw spell source.
 * @returns {boolean}
 */
export function isCantrip(spell) {
  if (typeof spell?.isCantrip === "boolean") return spell.isCantrip;
  return getSpellTraits(spell).includes("cantrip");
}

/**
 * Describe a spell's action cost for the compact row glyph.
 * @param {object} spell A SpellPF2e document or raw spell source.
 * @returns {{ glyph: string, label: string, isNumeric: boolean }}
 */
export function getActionCost(spell) {
  const raw = String(spell?.system?.time?.value ?? "").trim();
  if (!raw) return { glyph: "", label: "", isNumeric: false };

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 3) {
    return { glyph: String(numeric), label: `${numeric} action${numeric > 1 ? "s" : ""}`, isNumeric: true };
  }
  if (/^reaction$/i.test(raw)) return { glyph: "R", label: "Reaction", isNumeric: false };
  if (/^free$/i.test(raw)) return { glyph: "F", label: "Free action", isNumeric: false };
  return { glyph: raw, label: raw, isNumeric: false };
}

/**
 * Localised heading for a rank group.
 * @param {number} rank Spell rank, 0 for cantrips.
 * @returns {string}
 */
export function getRankLabel(rank) {
  if (rank === 0) return game.i18n.localize("SWS.Rank.Cantrips");
  return game.i18n.format("SWS.Rank.Rank", { rank });
}

/**
 * Short rank badge used in the selected-spells panel (`C`, `R1`, `R3`, ...).
 * @param {number} rank Spell rank, 0 for cantrips.
 * @returns {string}
 */
export function getRankBadge(rank) {
  if (rank === 0) return game.i18n.localize("SWS.Rank.CantripShort");
  return game.i18n.format("SWS.Rank.RankShort", { rank });
}

/**
 * Localised rarity name, shared by the rarity pills and the ceiling dropdown.
 * @param {string} rarity One of common/uncommon/rare/unique.
 * @returns {string}
 */
export function getRarityLabel(rarity) {
  const key = RARITIES.includes(rarity) ? rarity : "common";
  return game.i18n.localize(`SWS.Loot.Rarity.${key}`);
}

/**
 * Reduce a spell document to the flat shape the templates and journal flags use.
 * @param {object} spell A SpellPF2e document or compendium index entry.
 * @param {object} pack The compendium collection the spell came from.
 * @returns {object} Normalised spell record.
 */
function normaliseSpell(spell, pack) {
  const ritual = isRitual(spell);
  const rank = isCantrip(spell) ? 0 : getSpellRank(spell);
  const traditions = getSpellTraditions(spell);
  const rarity = getSpellRarity(spell);
  const packLabel = pack?.metadata?.label ?? pack?.title ?? pack?.collection ?? "";
  const sourceLabel = getSpellSource(spell, packLabel);
  return {
    uuid: spell.uuid,
    // Compendium index entries carry `_id`; documents expose `id`.
    id: spell.id ?? spell._id,
    packId: pack?.collection ?? "",
    packLabel,
    // Which book the spell was printed in, so the loot generator can be pointed at
    // just the sources a table actually owns.
    sourceKey: sourceKey(sourceLabel),
    sourceLabel,
    // Carried so an actor's spell can be matched back to its compendium original even
    // when the item has lost its source id.
    slug: getSpellSlug(spell),
    name: spell.name,
    img: spell.img,
    rank,
    baseRank: rank,
    rankBadge: getRankBadge(rank),
    traditions,
    // Pre-localised for the row pills: Handlebars has no `capitalize` helper.
    traditionTags: traditions.map((key) => ({
      key,
      label: game.i18n.localize(`SWS.Tradition.${key.charAt(0).toUpperCase()}${key.slice(1)}`)
    })),
    traits: getSpellTraits(spell),
    category: getSpellCategory(spell),
    rarity,
    // Pre-localised for the row pill, like `traditionTags` above.
    rarityLabel: getRarityLabel(rarity),
    isFocus: isFocusSpell(spell),
    isRitual: ritual,
    // Only rituals carry this, so a spell record stays exactly the shape it was.
    ...(ritual ? { ritual: getRitualDetails(spell) } : {}),
    isCantrip: rank === 0,
    action: getActionCost(spell),
    // Pre-lowered once so filtering does not re-allocate per keystroke.
    searchKey: `${spell.name} ${getSpellTraits(spell).join(" ")}`.toLowerCase()
  };
}

/**
 * Load and cache every spell in every Item compendium pack.
 *
 * Rituals are split off into their own list here, which is why callers that fill spell
 * slots can use the returned `spells` without filtering: it never contains one.
 *
 * @param {object} [options]
 * @param {boolean} [options.force=false] Bypass the cache and re-read the packs.
 * @returns {Promise<{ spells: object[], rituals: object[], packCount: number }>}
 */
async function loadCompendiumSpells({ force = false } = {}) {
  if (force) invalidateSpellCache();
  if (_cache) return _cache;
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      const packs = game.packs.filter((p) => p.documentName === "Item");

      const results = await Promise.all(
        packs.map(async (pack) => {
          try {
            // The index, not the documents: building every spell document in every
            // pack took several seconds on first open. The index carries only the
            // fields named here, which is everything `normaliseSpell` reads; a spell's
            // full document is fetched by uuid only when it is sent to an actor.
            const index = await pack.getIndex({ fields: INDEX_FIELDS });
            return index
              .filter((entry) => entry.type === "spell")
              .map((entry) => normaliseSpell(entry, pack));
          } catch (err) {
            // One unreadable pack must not sink the whole query.
            console.warn(`Sargas Wondrous Spellbook | Skipped pack ${pack.collection}`, err);
            return [];
          }
        })
      );

      const seen = new Set();
      const spells = [];
      const rituals = [];
      for (const spell of results.flat()) {
        if (seen.has(spell.uuid)) continue;
        seen.add(spell.uuid);
        // Rituals never occupy a slot, so they are held apart from everything that
        // fills one. The flag is read off the normalised record, which carries no
        // `system` object.
        (spell.isRitual ? rituals : spells).push(spell);
      }

      const byRankThenName = (a, b) => a.rank - b.rank || a.name.localeCompare(b.name);
      spells.sort(byRankThenName);
      rituals.sort(byRankThenName);
      _cache = { spells, rituals, packCount: packs.length };
      return _cache;
    } catch (err) {
      console.error("Sargas Wondrous Spellbook | Spell query failed", err);
      ui.notifications.error(game.i18n.localize("SWS.Error.QueryFailed"));
      _cache = { spells: [], rituals: [], packCount: 0 };
      return _cache;
    } finally {
      _loading = null;
    }
  })();

  return _loading;
}

/**
 * Every slot-fillable spell in the world's compendiums.
 *
 * The returned list never contains a ritual, which is what every caller that writes to
 * a spellcasting slot relies on.
 *
 * @param {object} [options]
 * @param {boolean} [options.force=false] Bypass the cache and re-read the packs.
 * @returns {Promise<{ spells: object[], packCount: number }>}
 */
export async function loadAllSpells(options = {}) {
  const { spells, packCount } = await loadCompendiumSpells(options);
  return { spells, packCount };
}

/**
 * Every ritual in the world's compendiums.
 *
 * @param {object} [options]
 * @param {boolean} [options.force=false] Bypass the cache and re-read the packs.
 * @returns {Promise<{ rituals: object[], packCount: number }>}
 */
export async function loadAllRituals(options = {}) {
  const { rituals, packCount } = await loadCompendiumSpells(options);
  return { rituals, packCount };
}

/**
 * Every publication a spell in the world's compendiums came from.
 *
 * Sorted by label so the picker reads like a shelf, with the count each source
 * contributes so a GM can see at a glance which ones matter.
 *
 * @returns {Promise<{ key: string, label: string, count: number }[]>}
 */
export async function listSpellSources() {
  const { spells } = await loadAllSpells();

  const sources = new Map();
  for (const spell of spells) {
    const entry = sources.get(spell.sourceKey);
    if (entry) entry.count++;
    else sources.set(spell.sourceKey, { key: spell.sourceKey, label: spell.sourceLabel, count: 1 });
  }

  return [...sources.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Query, filter and group spells for rendering.
 *
 * @param {object} [options]
 * @param {string} [options.tradition="all"] One of `all`, `arcane`, `divine`, `occult`, `primal`.
 * @param {boolean} [options.includeFocus=false] Include focus spells in the results.
 * @param {string} [options.search=""] Case-insensitive match against name and traits.
 * @param {number[]|null} [options.ranks=null] Ranks to keep, 0 for cantrips. Empty or null
 *   means every rank, so callers that do not care about rank can omit it entirely.
 * @param {string} [options.kind="spells"] `spells` to search what can fill a slot, or
 *   `rituals` to search rituals instead. The two pools never overlap.
 * @returns {Promise<{ groups: object[], shown: number, indexed: number, packCount: number }>}
 *   `groups` is sorted by rank ascending, each with its own name-sorted `spells` array.
 */
export async function querySpells({
  tradition = "all",
  includeFocus = false,
  search = "",
  ranks = null,
  kind = BOOK_KINDS.SPELLS
} = {}) {
  const cache = await loadCompendiumSpells();
  const { packCount } = cache;
  const isRituals = kind === BOOK_KINDS.RITUALS;
  const spells = isRituals ? cache.rituals : cache.spells;
  const needle = search.trim().toLowerCase();
  // Built once rather than per-spell: the predicate below runs over every indexed spell.
  const rankSet = Array.isArray(ranks) && ranks.length ? new Set(ranks.map(Number)) : null;

  const filtered = spells.filter((spell) => {
    // Cheapest discriminator first; `normaliseSpell` already folds cantrips down to rank 0.
    if (rankSet && !rankSet.has(spell.rank)) return false;
    // No ritual is a focus spell, so the toggle has nothing to say about that pool.
    if (!isRituals && !includeFocus && spell.isFocus) return false;
    if (tradition !== "all" && !spell.traditions.includes(tradition)) return false;
    if (needle && !spell.searchKey.includes(needle)) return false;
    return true;
  });

  // Bucket by rank, then emit in ascending rank order.
  const buckets = new Map();
  for (const spell of filtered) {
    if (!buckets.has(spell.rank)) buckets.set(spell.rank, []);
    buckets.get(spell.rank).push(spell);
  }

  const groups = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rank, list]) => ({
      rank,
      label: getRankLabel(rank),
      count: list.length,
      countLabel:
        list.length === 1
          ? game.i18n.localize("SWS.Creator.SpellCountOne")
          : game.i18n.format("SWS.Creator.SpellCount", { count: list.length }),
      spells: list.sort((a, b) => a.name.localeCompare(b.name))
    }));

  return { groups, shown: filtered.length, indexed: spells.length, packCount };
}

/**
 * Resolve a normalised spell record back into a live document for embedding.
 * @param {string} uuid The spell's compendium UUID.
 * @returns {Promise<object|null>} The SpellPF2e document, or null if it no longer exists.
 */
export async function resolveSpell(uuid) {
  try {
    return await fromUuid(uuid);
  } catch (err) {
    console.error("Sargas Wondrous Spellbook | Failed to resolve spell", uuid, err);
    return null;
  }
}
