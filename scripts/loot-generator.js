/**
 * Random loot spellbook generation.
 *
 * Rolls a level-appropriate spell list out of the same compendium cache the Spellbook
 * Creator uses, then writes it onto a physical PF2e Item (`equipment`) so it behaves
 * like any other treasure: draggable to a loot actor, carried in inventory, priced and
 * rarity-tagged. The spell list is stored under the module's usual `spells` flag, so
 * every reader helper in `persistence.js` works on a loot book unchanged.
 *
 * Generation is seeded. The seed is stored on the item, so a book can be rolled again
 * identically - handy for "the party lost it, here it is again" and for bug reports.
 */

import {
  MODULE_ID,
  LOOT_FLAG,
  SPELLS_FLAG,
  SETTINGS,
  DEFAULT_LOOT_FOLDER_NAME
} from "./constants.js";
import { MAX_RANK, RARITIES, TRADITIONS, getRankBadge, loadAllSpells } from "./spell-query.js";
import { buildOwnership, getStoredSpells, renderSpellsPage, toStoredSpell } from "./persistence.js";

/** Highest character level a book can be rolled for. */
export const MAX_LEVEL = 20;

/**
 * The three loot book shapes.
 *
 * `spread` is subtracted from the rank ceiling: a traveller's notebook never holds the
 * very best spell its level would allow. `topWeight` multiplies the weight of the
 * ceiling rank, so an archmage's tome leans on its highest ranks while the others taper.
 */
export const PROFILES = Object.freeze({
  traveler: { key: "traveler", min: 3, max: 6, spread: 1, topWeight: 0.4, cantrips: [1, 2], price: 0.6 },
  grimoire: { key: "grimoire", min: 6, max: 12, spread: 0, topWeight: 0.5, cantrips: [2, 4], price: 1 },
  archmage: { key: "archmage", min: 12, max: 20, spread: 0, topWeight: 1.5, cantrips: [3, 5], price: 1.8 }
});

/** @type {string} Profile key used when nothing else is configured. */
export const DEFAULT_PROFILE = "grimoire";

/** Fallback name tables, used when the language file carries no arrays for them. */
const FALLBACK_NAMES = Object.freeze({
  adjectives: ["Charred", "Gilded", "Weeping", "Silent", "Hollow", "Verdant", "Salt-Stained", "Cracked"],
  nouns: ["Codex", "Grimoire", "Folio", "Ledger", "Compendium", "Journal", "Tome", "Cypher"],
  authors: ["Vaskir", "Ilrune", "the Drowned Choir", "Maelis", "Orvo the Lesser", "the Ashen Circle"]
});

/** Item art per tradition, using Foundry's bundled icons so nothing extra ships. */
const TRADITION_ICONS = Object.freeze({
  arcane: "icons/sundries/books/book-worn-blue.webp",
  divine: "icons/sundries/books/book-embossed-gold.webp",
  occult: "icons/sundries/books/book-clasp-purple.webp",
  primal: "icons/sundries/books/book-worn-green.webp",
  mixed: "icons/sundries/books/book-stack.webp"
});

/* -------------------------------------------------- *
 * Seeded randomness
 * -------------------------------------------------- */

/**
 * Hash an arbitrary seed string into a 32-bit integer.
 * @param {string} seed
 * @returns {number}
 */
function hashSeed(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Build a deterministic PRNG (mulberry32) from a seed string.
 * @param {string} seed
 * @returns {() => number} Generator returning floats in [0, 1).
 */
function makeRng(seed) {
  let a = hashSeed(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @returns {string} A fresh 8-character seed. */
export function randomSeed() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Pick one entry from a list.
 * @param {() => number} rng
 * @param {Array} list
 * @returns {*} The chosen entry, or undefined when the list is empty.
 */
function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

/**
 * Inclusive integer in [min, max].
 * @param {() => number} rng
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function between(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/* -------------------------------------------------- *
 * Naming
 * -------------------------------------------------- */

/**
 * Read an array out of the language files.
 *
 * `game.i18n.localize` only ever returns strings, so the name tables are read straight
 * off the translation objects and fall back to the built-in English lists.
 *
 * @param {string} key Translation key.
 * @param {string[]} fallback Used when the key is missing or is not an array.
 * @returns {string[]}
 */
function localizeList(key, fallback) {
  const { getProperty } = foundry.utils;
  const value = getProperty(game.i18n.translations ?? {}, key) ?? getProperty(game.i18n._fallback ?? {}, key);
  return Array.isArray(value) && value.length ? value : fallback;
}

/**
 * Roll a book title.
 * @param {() => number} rng
 * @returns {string}
 */
export function rollBookName(rng) {
  const adjective = pick(rng, localizeList("BWS.Loot.Names.Adjectives", FALLBACK_NAMES.adjectives));
  const noun = pick(rng, localizeList("BWS.Loot.Names.Nouns", FALLBACK_NAMES.nouns));
  const author = pick(rng, localizeList("BWS.Loot.Names.Authors", FALLBACK_NAMES.authors));
  return game.i18n.format("BWS.Loot.Names.Pattern", { adjective, noun, author });
}

/* -------------------------------------------------- *
 * Generation
 * -------------------------------------------------- */

/**
 * Highest spell rank a book of this level may hold, following PF2e's own progression.
 * @param {number} level Character level the book is rolled for.
 * @returns {number} Rank 1-10.
 */
export function maxRankForLevel(level) {
  return Math.clamp(Math.ceil(Number(level) / 2), 1, MAX_RANK);
}

/**
 * Configured default profile, falling back to `grimoire` if the setting holds junk.
 * @returns {object} A profile from {@link PROFILES}.
 */
export function getDefaultProfile() {
  let key = DEFAULT_PROFILE;
  try {
    key = game.settings.get(MODULE_ID, SETTINGS.LOOT_PROFILE) ?? DEFAULT_PROFILE;
  } catch {
    /* settings not registered yet */
  }
  return PROFILES[key] ?? PROFILES[DEFAULT_PROFILE];
}

/**
 * Configured rarity ceiling.
 * @returns {string} A slug from {@link RARITIES}.
 */
export function getDefaultMaxRarity() {
  try {
    const value = game.settings.get(MODULE_ID, SETTINGS.LOOT_MAX_RARITY);
    if (RARITIES.includes(value)) return value;
  } catch {
    /* settings not registered yet */
  }
  return "common";
}

/**
 * Weight each rank so books cluster just below their ceiling rather than being
 * top-heavy: weight rises linearly with rank, then the ceiling itself is scaled by the
 * profile's `topWeight`.
 *
 * @param {number} ceiling Highest rank available.
 * @param {object} profile A profile from {@link PROFILES}.
 * @returns {number[]} Weight per rank, indexed 1..ceiling (index 0 unused).
 */
function buildRankWeights(ceiling, profile) {
  const weights = [0];
  for (let rank = 1; rank <= ceiling; rank++) {
    weights[rank] = rank === ceiling ? rank * profile.topWeight : rank;
  }
  return weights;
}

/**
 * Draw a rank from the weight table, ignoring ranks whose bucket has run dry.
 * @param {() => number} rng
 * @param {number[]} weights
 * @param {Map<number, object[]>} buckets Remaining spells per rank.
 * @returns {number} A rank with stock left, or -1 when every bucket is empty.
 */
function drawRank(rng, weights, buckets) {
  let total = 0;
  for (let rank = 1; rank < weights.length; rank++) {
    if (buckets.get(rank)?.length) total += weights[rank];
  }
  if (total <= 0) return -1;

  let roll = rng() * total;
  for (let rank = 1; rank < weights.length; rank++) {
    if (!buckets.get(rank)?.length) continue;
    roll -= weights[rank];
    if (roll <= 0) return rank;
  }
  // Floating-point slack: fall back to the highest stocked rank.
  for (let rank = weights.length - 1; rank >= 1; rank--) {
    if (buckets.get(rank)?.length) return rank;
  }
  return -1;
}

/**
 * Take one random spell out of a rank bucket, so no book ever repeats a spell.
 * @param {() => number} rng
 * @param {object[]} bucket
 * @returns {object} The removed spell record.
 */
function takeFrom(rng, bucket) {
  const index = Math.floor(rng() * bucket.length);
  return bucket.splice(index, 1)[0];
}

/**
 * Roll a random spell list.
 *
 * Nothing is written: this returns plain records, so it can be driven from a macro or a
 * RollTable without touching the world.
 *
 * @param {object} [options]
 * @param {number} [options.level=5] Character level the book is rolled for, 1-20.
 * @param {string} [options.tradition="random"] A tradition slug, `random`, or `mixed`.
 * @param {string} [options.profile] Key from {@link PROFILES}. Defaults to the setting.
 * @param {number|null} [options.count=null] Number of ranked spells, or null to take it
 *   from the profile. Cantrips are drawn on top of this, so a book can hold more entries
 *   than the count asks for.
 * @param {boolean} [options.includeCantrips=true] Add a handful of cantrips.
 * @param {boolean} [options.includeFocus=false] Allow focus spells, which are not
 *   normally learnable from a book.
 * @param {string} [options.maxRarity] Rarity ceiling. Defaults to the setting.
 * @param {string[]|null} [options.sources=null] Source keys (see `listSpellSources`) the
 *   book may draw from. Null or empty means every source in the world.
 * @param {string} [options.seed] Seed string. A fresh one is rolled when omitted.
 * @returns {Promise<{ spells: object[], meta: object, name: string, shortfall: number }>}
 *   `shortfall` is how many spells the compendiums could not supply.
 */
export async function generateLootSpellbook({
  level = 5,
  tradition = "random",
  profile: profileKey,
  count = null,
  includeCantrips = true,
  includeFocus = false,
  maxRarity,
  sources = null,
  seed
} = {}) {
  const profile = PROFILES[profileKey] ?? getDefaultProfile();
  const rarityCeiling = RARITIES.includes(maxRarity) ? maxRarity : getDefaultMaxRarity();
  const rarityLimit = RARITIES.indexOf(rarityCeiling);
  const bookLevel = Math.clamp(Number(level) || 1, 1, MAX_LEVEL);
  const bookSeed = String(seed ?? randomSeed());
  const rng = makeRng(bookSeed);

  // The tradition is drawn from the same stream as everything else, so a seed pins it too.
  const resolvedTradition =
    tradition === "random" ? pick(rng, TRADITIONS) : TRADITIONS.includes(tradition) ? tradition : "mixed";

  const ceiling = Math.max(1, maxRankForLevel(bookLevel) - profile.spread);
  const wanted = Number.isFinite(Number(count)) && count !== null
    ? Math.clamp(Number(count), 1, 60)
    : between(rng, profile.min, profile.max);

  const { spells: pool } = await loadAllSpells();

  // An empty selection means "no restriction" rather than "no spells": a GM who
  // unticks everything would otherwise be left with an unrollable form.
  const sourceSet = Array.isArray(sources) && sources.length ? new Set(sources) : null;

  const eligible = pool.filter((spell) => {
    if (!includeFocus && spell.isFocus) return false;
    if (RARITIES.indexOf(spell.rarity) > rarityLimit) return false;
    if (sourceSet && !sourceSet.has(spell.sourceKey)) return false;
    if (resolvedTradition !== "mixed" && !spell.traditions.includes(resolvedTradition)) return false;
    return true;
  });

  // Bucket once. Buckets are drained as spells are drawn, which is what keeps the
  // result duplicate-free without a second membership check per draw.
  const buckets = new Map();
  const cantripPool = [];
  for (const spell of eligible) {
    if (spell.rank === 0) {
      cantripPool.push(spell);
      continue;
    }
    if (spell.rank > ceiling) continue;
    if (!buckets.has(spell.rank)) buckets.set(spell.rank, []);
    buckets.get(spell.rank).push(spell);
  }

  const weights = buildRankWeights(ceiling, profile);
  const chosen = [];

  if (includeCantrips) {
    const cantripCount = Math.min(between(rng, profile.cantrips[0], profile.cantrips[1]), cantripPool.length);
    for (let i = 0; i < cantripCount; i++) chosen.push(takeFrom(rng, cantripPool));
  }

  let drawn = 0;
  for (let i = 0; i < wanted; i++) {
    const rank = drawRank(rng, weights, buckets);
    if (rank < 0) break; // Sparse world: nothing left to give at any rank.
    chosen.push(takeFrom(rng, buckets.get(rank)));
    drawn++;
  }

  chosen.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  // The book is only as rare as its rarest page.
  const rarity = chosen.reduce(
    (worst, spell) => (RARITIES.indexOf(spell.rarity) > RARITIES.indexOf(worst) ? spell.rarity : worst),
    "common"
  );

  return {
    spells: chosen,
    name: rollBookName(rng),
    shortfall: wanted - drawn,
    meta: {
      isLootBook: true,
      seed: bookSeed,
      level: bookLevel,
      tradition: resolvedTradition,
      profile: profile.key,
      rarity,
      // Recorded so a reroll from the same seed - and every per-row replacement -
      // stays inside the same shelf of books.
      sources: sourceSet ? [...sourceSet] : null,
      maxRank: ceiling,
      generatedBy: game.user?.id ?? null,
      generatedAt: Date.now(),
      learned: {}
    }
  };
}

/**
 * Draw a single replacement spell, for the generator's per-row reroll.
 *
 * Unlike {@link generateLootSpellbook} this is not seeded: a book whose pages have been
 * swapped by hand no longer reproduces from its seed, so callers should mark the
 * metadata `edited`.
 *
 * @param {object} params
 * @param {object} params.meta Loot metadata describing the book. Its `rarity` - the rarity
 *   of the rarest page already present - is used as the ceiling for the replacement, and
 *   its `sources` list, when set, keeps the replacement inside the same books.
 * @param {string[]} [params.exclude=[]] Spell uuids already in the book.
 * @param {number} params.rank Rank the replacement must match.
 * @param {boolean} [params.includeFocus=false] Allow focus spells.
 * @returns {Promise<object|null>} A spell record, or null when the rank is exhausted.
 */
export async function drawReplacement({ meta, exclude = [], rank, includeFocus = false }) {
  const { spells: pool } = await loadAllSpells();
  const rarityLimit = RARITIES.indexOf(meta.rarity ?? "common");
  const skip = new Set(exclude);
  const sourceSet = Array.isArray(meta.sources) && meta.sources.length ? new Set(meta.sources) : null;

  const candidates = pool.filter((spell) => {
    if (spell.rank !== rank) return false;
    if (skip.has(spell.uuid)) return false;
    if (!includeFocus && spell.isFocus) return false;
    if (RARITIES.indexOf(spell.rarity) > rarityLimit) return false;
    if (sourceSet && !sourceSet.has(spell.sourceKey)) return false;
    if (meta.tradition !== "mixed" && !spell.traditions.includes(meta.tradition)) return false;
    return true;
  });

  return candidates.length ? pick(Math.random, candidates) : null;
}

/* -------------------------------------------------- *
 * Item creation
 * -------------------------------------------------- */

/**
 * Rough gold value of a book.
 *
 * Deliberately a heuristic rather than a table lookup: PF2e has no printed price for
 * "a book of arbitrary spells", and a GM who cares will edit the field anyway.
 *
 * @param {object} meta Loot metadata from {@link generateLootSpellbook}.
 * @param {object[]} spells The rolled spell records.
 * @returns {number} Price in gp, rounded.
 */
export function estimatePrice(meta, spells) {
  const profile = PROFILES[meta.profile] ?? PROFILES[DEFAULT_PROFILE];
  const rankValue = spells.reduce((sum, spell) => sum + Math.max(spell.rank, 0.5) ** 1.6, 0);
  const rarityFactor = 1 + RARITIES.indexOf(meta.rarity) * 0.5;
  return Math.max(1, Math.round(rankValue * 2 * profile.price * rarityFactor));
}

/**
 * Configured name of the loot folder.
 * @returns {string}
 */
export function getLootFolderName() {
  try {
    const configured = game.settings.get(MODULE_ID, SETTINGS.LOOT_FOLDER_NAME);
    if (configured?.trim()) return configured.trim();
  } catch {
    /* settings not registered yet */
  }
  return DEFAULT_LOOT_FOLDER_NAME;
}

/**
 * Find the loot folder, creating it if a GM asks for it.
 * @returns {Promise<object|null>} The Folder, or null when it does not exist and cannot
 *   be created.
 */
async function getOrCreateLootFolder() {
  const name = getLootFolderName();
  try {
    const existing = game.folders.find((f) => f.type === "Item" && f.name === name);
    if (existing) return existing;
    if (!game.user.isGM) return null;
    return await Folder.create({ name, type: "Item", color: "#6d5ce7", sorting: "a" });
  } catch (err) {
    console.error("Blizzard's Wondrous Spellbook | Failed to resolve the loot folder", err);
    return null;
  }
}

/**
 * Build the Item source for a loot spellbook.
 *
 * `equipment` rather than `treasure`: treasure is for coins and gems and carries no
 * usable description, while equipment gives the book a readable page, a rarity tag and
 * a level, which is what makes it look like real loot on the sheet.
 *
 * @param {object} params
 * @param {string} params.name Book title.
 * @param {object[]} params.spells Normalised spell records.
 * @param {object} params.meta Loot metadata.
 * @param {string|null} [params.folderId] Folder for a world item.
 * @returns {object} An Item creation source.
 */
export function buildLootItemSource({ name, spells, meta, folderId = null }) {
  const stored = spells.map(toStoredSpell);
  const description = [
    `<p><em>${game.i18n.format("BWS.Loot.ItemBlurb", {
      count: stored.length,
      tradition: game.i18n.localize(`BWS.Loot.Tradition.${meta.tradition}`)
    })}</em></p>`,
    renderSpellsPage(stored)
  ].join("\n");

  return {
    name,
    type: "equipment",
    img: TRADITION_ICONS[meta.tradition] ?? TRADITION_ICONS.mixed,
    folder: folderId,
    system: {
      description: { value: description },
      level: { value: meta.level },
      price: { value: { gp: estimatePrice(meta, stored) } },
      bulk: { value: 0.1 },
      quantity: 1,
      traits: { value: ["magical"], rarity: meta.rarity }
    },
    flags: { [MODULE_ID]: { [SPELLS_FLAG]: stored, [LOOT_FLAG]: meta } }
  };
}

/**
 * Create a loot spellbook as a real Item.
 *
 * With no `actors`, one world Item is created in the loot folder, owned by its creator
 * and every GM in the same way spellbook journals are. With `actors`, one copy is
 * embedded on each, inheriting that actor's ownership - which is what puts the book in
 * a player's hands.
 *
 * @param {object} params
 * @param {string} params.name Book title.
 * @param {object[]} params.spells Normalised spell records.
 * @param {object} params.meta Loot metadata.
 * @param {object[]} [params.actors=[]] Actors to embed a copy on.
 * @returns {Promise<object[]>} The created Items, or an empty array on failure.
 */
export async function createLootSpellbook({ name, spells, meta, actors = [] }) {
  try {
    if (actors.length) {
      const source = buildLootItemSource({ name, spells, meta });
      const created = [];
      for (const actor of actors) {
        if (!actor.isOwner) {
          ui.notifications.warn(game.i18n.format("BWS.Slot.NotOwner", { actor: actor.name }));
          continue;
        }
        const item = await Item.create(foundry.utils.deepClone(source), { parent: actor });
        if (item) created.push(item);
      }
      return created;
    }

    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("BWS.Loot.GMOnly"));
      return [];
    }

    const folder = await getOrCreateLootFolder();
    const source = buildLootItemSource({ name, spells, meta, folderId: folder?.id ?? null });
    source.ownership = buildOwnership();
    const item = await Item.create(source);
    return item ? [item] : [];
  } catch (err) {
    console.error("Blizzard's Wondrous Spellbook | Failed to create the loot spellbook", err);
    ui.notifications.error(game.i18n.localize("BWS.Loot.CreateFailed"));
    return [];
  }
}

/**
 * Loot metadata carried by an Item, if any.
 * @param {object} item An Item document.
 * @returns {object|null}
 */
export function getLootMeta(item) {
  const meta = item?.getFlag?.(MODULE_ID, LOOT_FLAG);
  return meta?.isLootBook ? meta : null;
}

/**
 * Is this Item a generated loot spellbook?
 * @param {object} item An Item document.
 * @returns {boolean}
 */
export function isLootSpellbook(item) {
  return !!getLootMeta(item);
}

/**
 * List the world loot spellbooks the current user may see.
 *
 * Mirrors `getUserSpellbooks`: the books live in the configured Item folder, a GM sees
 * every one of them and a player sees the ones they have at least OBSERVER on, which is
 * what the reader needs to let them learn a spell. Copies embedded on an actor are not
 * world items and stay on that actor's sheet.
 *
 * @returns {object[]} Item documents, sorted by name.
 */
export function getUserLootBooks() {
  const folderName = getLootFolderName();
  const folder = game.folders.find((f) => f.type === "Item" && f.name === folderName);

  return game.items
    .filter((item) => {
      if (!isLootSpellbook(item)) return false;
      if (folder && item.folder?.id !== folder.id) return false;
      if (game.user.isGM) return true;
      return item.testUserPermission(game.user, "OBSERVER");
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Summarise a loot spellbook for the browser list.
 *
 * Shaped like `summariseSpellbook` so both kinds of book render through one row
 * template. Only a GM may edit or delete a world item, so `canEdit` follows that.
 *
 * @param {object} item A loot spellbook Item.
 * @returns {object} View model with counts and permission flags.
 */
export function summariseLootBook(item) {
  const spells = getStoredSpells(item);
  const meta = getLootMeta(item) ?? {};
  const ranks = [...new Set(spells.map((s) => s.rank))].sort((a, b) => a - b);

  return {
    id: item.id,
    uuid: item.uuid,
    name: item.name,
    count: spells.length,
    countLabel:
      spells.length === 1
        ? game.i18n.localize("BWS.Browser.SpellSummaryOne")
        : game.i18n.format("BWS.Browser.SpellSummary", { count: spells.length }),
    ranks: ranks.map((r) => ({ rank: r, badge: getRankBadge(r) })),
    canEdit: game.user.isGM,
    lootLabel: game.i18n.format("BWS.Browser.LootTag", { level: meta.level ?? item.system?.level?.value ?? 0 })
  };
}
