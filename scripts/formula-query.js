/**
 * Crafting formula reading and writing.
 *
 * A PF2e formula is not an item on the sheet: it is a uuid in `system.crafting.formulas`
 * pointing at the physical item it produces. That makes formula books the easy half of
 * this module's data model - the sheet already stores exactly the compendium uuid a book
 * wants to keep, so there is no matching pass of the kind `import-spells.js` needs.
 *
 * The write path here is the formula equivalent of `slot-manager.js`: it is the only
 * place this module adds a formula to an actor.
 */

import { RARITIES } from "./spell-query.js";

/**
 * Read the raw formula list off an actor.
 *
 * PF2e has moved this between a plain array of `{ uuid }` on `system.crafting.formulas`
 * and a `crafting` helper object; the raw path is read first because it is what the
 * actor actually stores, with the helper as the fallback.
 *
 * @param {object} actor An ActorPF2e.
 * @returns {object[]} Raw formula entries, each with at least a `uuid`.
 */
export function getActorFormulaEntries(actor) {
  const raw = actor?.system?.crafting?.formulas;
  if (Array.isArray(raw)) return raw.filter((entry) => entry?.uuid);

  const helper = actor?.crafting?.formulas;
  if (Array.isArray(helper)) {
    return helper.map((entry) => ({ uuid: entry?.uuid ?? entry?.item?.uuid })).filter((e) => e.uuid);
  }
  return [];
}

/**
 * Every formula uuid an actor knows.
 * @param {object} actor An ActorPF2e.
 * @returns {string[]}
 */
export function getActorFormulaUuids(actor) {
  return [...new Set(getActorFormulaEntries(actor).map((entry) => String(entry.uuid)))];
}

/**
 * Does this actor already know a formula?
 * @param {object} actor An ActorPF2e.
 * @param {string} uuid Formula uuid.
 * @returns {boolean}
 */
export function actorKnowsFormula(actor, uuid) {
  return getActorFormulaUuids(actor).includes(uuid);
}

/**
 * Format an item's price for display.
 *
 * PF2e wraps prices in a `Coins` class whose `toString` produces "4 gp, 5 sp"; older
 * data and raw sources leave a plain object behind, which is assembled by hand rather
 * than converting everything to copper and losing the denominations.
 *
 * @param {object} item A PhysicalItemPF2e or raw item source.
 * @returns {string} A readable price, or an empty string.
 */
export function getItemPrice(item) {
  const value = item?.system?.price?.value ?? item?.price?.value;
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  // PF2e's Coins class knows how to print itself; a plain data object does not.
  if (value.constructor !== Object) return String(value);

  const parts = [];
  for (const coin of ["pp", "gp", "sp", "cp"]) {
    const amount = Number(value[coin]);
    if (Number.isFinite(amount) && amount > 0) parts.push(`${amount} ${coin}`);
  }
  return parts.join(", ");
}

/**
 * Read an item's level.
 * @param {object} item A PhysicalItemPF2e or raw item source.
 * @returns {number} Item level, or 0.
 */
export function getItemLevel(item) {
  const raw = item?.system?.level?.value ?? item?.level;
  const level = Number(raw);
  return Number.isFinite(level) ? Math.clamp(level, 0, 30) : 0;
}

/**
 * Read an item's rarity.
 * @param {object} item A PhysicalItemPF2e or raw item source.
 * @returns {string} One of common/uncommon/rare/unique.
 */
export function getItemRarity(item) {
  const raw = item?.system?.traits?.rarity ?? item?.rarity;
  const rarity = typeof raw === "string" ? raw.toLowerCase() : "";
  return RARITIES.includes(rarity) ? rarity : "common";
}

/**
 * Reduce a crafted item to the flat shape a formula book stores and renders.
 * @param {object} item The PhysicalItemPF2e a formula produces.
 * @returns {object} Normalised formula record.
 */
export function normaliseFormula(item) {
  const level = getItemLevel(item);
  const rarity = getItemRarity(item);
  return {
    uuid: item.uuid,
    id: item.id,
    // A formula points at a compendium item, so the pack is part of its identity.
    packId: item.pack ?? item.compendium?.collection ?? "",
    name: item.name,
    img: item.img,
    level,
    levelLabel: game.i18n.format("SWS.Formula.LevelHeading", { level }),
    price: getItemPrice(item),
    rarity,
    itemType: String(item.type ?? ""),
    // Pre-localised for the row pill, matching how spell records carry their labels.
    itemTypeLabel: describeItemType(item.type),
    traits: Array.isArray(item?.system?.traits?.value)
      ? item.system.traits.value.map((trait) => String(trait).toLowerCase())
      : []
  };
}

/**
 * Localised name for a physical item type.
 *
 * PF2e's item types are its own slugs (`weapon`, `consumable`, `treasure`, ...). The
 * system already localises them, so its key is tried first and the raw slug is the
 * fallback for a type this module has never heard of.
 *
 * @param {string} type An item type slug.
 * @returns {string}
 */
export function describeItemType(type) {
  const slug = String(type ?? "").trim();
  if (!slug) return "";
  const key = `TYPES.Item.${slug}`;
  const localised = game.i18n.localize(key);
  return localised === key ? slug : localised;
}

/**
 * Resolve one formula uuid into a normalised record.
 * @param {string} uuid Formula uuid.
 * @returns {Promise<object|null>} The record, or null when the item no longer exists.
 */
export async function resolveFormula(uuid) {
  try {
    const item = await fromUuid(uuid);
    return item ? normaliseFormula(item) : null;
  } catch (err) {
    console.warn("Sargas Wondrous Spellbook | Failed to resolve formula", uuid, err);
    return null;
  }
}

/**
 * Collect an actor's crafting formulas, grouped by item level.
 *
 * A uuid whose item has gone - an uninstalled compendium, a deleted homebrew item - is
 * counted rather than dropped silently, the same way the spell importer reports what it
 * could not match.
 *
 * @param {object} actor An ActorPF2e.
 * @returns {Promise<{ groups: object[], total: number, missing: number }>}
 */
export async function collectActorFormulas(actor) {
  if (!actor) return { groups: [], total: 0, missing: 0 };

  const uuids = getActorFormulaUuids(actor);
  const resolved = await Promise.all(uuids.map((uuid) => resolveFormula(uuid)));

  const records = [];
  let missing = 0;
  for (const record of resolved) {
    if (record) records.push(record);
    else missing++;
  }

  records.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

  const groups = [];
  for (const record of records) {
    let group = groups.at(-1);
    if (!group || group.level !== record.level) {
      group = {
        // The exporter keys its per-group controls off this, and a level is unique
        // across the list because the records are sorted by it.
        id: `level-${record.level}`,
        level: record.level,
        name: game.i18n.format("SWS.Formula.LevelHeading", { level: record.level }),
        kind: "",
        formulas: []
      };
      groups.push(group);
    }
    group.formulas.push(record);
  }

  return { groups, total: records.length, missing };
}

/**
 * Teach an actor a formula.
 *
 * The one write path from a formula book to a crafter. Duplicates are refused rather
 * than appended: PF2e shows one row per uuid, so a second copy is invisible clutter in
 * the actor's data.
 *
 * @param {object} actor The crafter to teach.
 * @param {string} uuid Formula uuid.
 * @returns {Promise<boolean>} True when the formula was added.
 */
export async function addFormulaToActor(actor, uuid) {
  if (!actor?.isOwner) {
    ui.notifications.warn(game.i18n.format("SWS.Slot.NotOwner", { actor: actor?.name ?? "" }));
    return false;
  }
  // Only a PF2e character has a formula list. An update to any other actor type - the
  // world's Party actor, an NPC - resolves happily with the unknown key discarded, which
  // would report a formula as added when nothing was stored.
  if (!isCrafter(actor)) {
    ui.notifications.warn(game.i18n.format("SWS.Formula.NotACrafter", { actor: actor.name }));
    return false;
  }
  if (actorKnowsFormula(actor, uuid)) return false;

  try {
    const existing = getActorFormulaEntries(actor).map((entry) => ({ ...entry }));
    await actor.update({ "system.crafting.formulas": [...existing, { uuid }] });
    return true;
  } catch (err) {
    console.error("Sargas Wondrous Spellbook | Failed to add a formula", uuid, err);
    ui.notifications.error(game.i18n.localize("SWS.Error.FormulaAddFailed"));
    return false;
  }
}

/**
 * Can this actor hold crafting formulas at all?
 * @param {object} actor An ActorPF2e.
 * @returns {boolean}
 */
export function isCrafter(actor) {
  return actor?.type === "character";
}

/**
 * Actors the current user could teach a formula to.
 *
 * Characters only: they are the one PF2e actor type with a formula list, and offering a
 * Party or NPC actor here would put it in front of the user as a valid choice.
 *
 * @returns {object[]} Owned character Actor documents, sorted by name.
 */
export function listCrafters() {
  return game.actors
    .filter((actor) => actor.isOwner && isCrafter(actor))
    .sort((a, b) => a.name.localeCompare(b.name));
}
