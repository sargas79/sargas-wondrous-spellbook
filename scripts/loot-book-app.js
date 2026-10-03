/**
 * The loot spellbook reader.
 *
 * Player-facing half of the loot feature: open a generated book and learn a spell from
 * it. Learning routes into `openSendToSlotDialog`, the module's single actor write
 * path, so nothing here writes to an actor itself.
 *
 * Which spells have been learned is recorded back onto the item's loot flag, keyed by
 * spell uuid, so a shared book remembers who already copied what. The write is guarded
 * by item ownership: a player reading a book they do not own simply gets no tracking
 * rather than a rejected update.
 */

import { MODULE_ID, LOOT_FLAG, SETTINGS, template } from "./constants.js";
import { getStoredSpells } from "./persistence.js";
import { getRankBadge, getRankLabel, getRarityLabel } from "./spell-query.js";
import { openSendToSlotDialog, resolveTargetActor } from "./slot-manager.js";
import { getLootMeta, isLootSpellbook } from "./loot-generator.js";
import { domSafe, injectHeaderControl, openOrFocus } from "./app-utils.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Read a world setting, treating a missing registration as its default.
 * @param {string} key A key from `SETTINGS`.
 * @param {*} fallback Value to use when the setting cannot be read.
 * @returns {*}
 */
function setting(key, fallback) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch {
    return fallback;
  }
}

/**
 * Key under which a spell's learners are recorded.
 *
 * A uuid is full of dots, and Foundry expands dotted keys into nested objects when a
 * document is updated: stored as-is, `Compendium.pf2e.spells-srd.Item.x` became a tree
 * that a lookup by the uuid never found, so nothing ever showed as learned.
 *
 * @param {string} uuid Spell uuid.
 * @returns {string}
 */
function learnedKey(uuid) {
  return String(uuid).replaceAll(".", "~");
}

export class LootBookApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {object} options
   * @param {object} options.item The loot spellbook Item to read.
   */
  constructor(options = {}) {
    // Keyed per item so two books can be open side by side and reopening one focuses
    // it. The uuid, not the id: copies on two actors are different books.
    super({ ...options, id: LootBookApp.idFor(options.item) });
    /** @type {object} */
    this.item = options.item;
  }

  /** @inheritdoc */
  static DEFAULT_OPTIONS = {
    classes: ["sws", "sws-loot-book"],
    tag: "div",
    window: {
      title: "SWS.Loot.ReaderTitle",
      icon: "fa-solid fa-book-sparkles",
      resizable: true
    },
    position: { width: 520, height: 600 },
    actions: {
      learn: LootBookApp.#onLearn
    }
  };

  /** @inheritdoc */
  static PARTS = {
    body: { template: template("loot-book.hbs"), scrollable: [".sws-loot-spells"] }
  };

  /**
   * Window id for a given book.
   * @param {object} item A loot spellbook Item.
   * @returns {string}
   */
  static idFor(item) {
    return `sws-loot-book-${domSafe(item?.uuid)}`;
  }

  /** @inheritdoc */
  get title() {
    return this.item?.name ?? game.i18n.localize("SWS.Loot.ReaderTitle");
  }

  /** @inheritdoc */
  async _prepareContext(options) {
    const meta = getLootMeta(this.item) ?? {};
    const learned = meta.learned ?? {};
    const learnedBy = (uuid) =>
      learned[learnedKey(uuid)] ??
      // Books written before the key was encoded hold it nested under the uuid's parts.
      foundry.utils.getProperty(learned, uuid) ??
      [];
    const target = this.#resolveActor();
    const consume = !!setting(SETTINGS.CONSUME_ON_LEARN, false);

    const groups = [];
    // Copied before sorting: `getStoredSpells` hands back the array stored on the
    // document, and sorting it in place would reorder the item's own flag data.
    const stored = [...getStoredSpells(this.item)].sort(
      (a, b) => a.rank - b.rank || a.name.localeCompare(b.name)
    );

    for (const spell of stored) {
      const actorIds = Array.isArray(learnedBy(spell.uuid)) ? learnedBy(spell.uuid) : [];
      const names = actorIds.map((id) => game.actors.get(id)?.name).filter(Boolean);
      const alreadyLearned = !!target && actorIds.includes(target.actor.id);

      let group = groups.at(-1);
      if (!group || group.rank !== spell.rank) {
        group = { rank: spell.rank, label: getRankLabel(spell.rank), spells: [] };
        groups.push(group);
      }
      group.spells.push({
        ...spell,
        rankBadge: getRankBadge(spell.rank),
        // Older books carry no rarity; those rows just render without the pill.
        rarityLabel: spell.rarity ? getRarityLabel(spell.rarity) : "",
        learnedBy: names.length ? game.i18n.format("SWS.Loot.LearnedBy", { actors: names.join(", ") }) : "",
        alreadyLearned,
        // Consumption is per-actor: the page is spent for whoever copied it, not for
        // the next reader.
        disabled: !target || (consume && alreadyLearned)
      });
    }

    return {
      ...(await super._prepareContext(options)),
      img: this.item?.img,
      groups,
      hasSpells: groups.length > 0,
      meta,
      metaLine: meta.level
        ? game.i18n.format("SWS.Loot.MetaLine", {
            level: meta.level,
            tradition: game.i18n.localize(`SWS.Loot.Tradition.${meta.tradition}`),
            profile: game.i18n.localize(`SWS.Loot.Profile.${meta.profile}`)
          })
        : "",
      seedLine: meta.seed
        ? game.i18n.format(meta.edited ? "SWS.Loot.SeedEdited" : "SWS.Loot.SeedLine", { seed: meta.seed })
        : "",
      targetLine: target
        ? game.i18n.format("SWS.Loot.TargetLine", { actor: target.actor.name })
        : game.i18n.localize("SWS.Loot.NoTarget"),
      hasTarget: !!target
    };
  }

  /**
   * Who is learning from this book.
   *
   * The book's own carrier wins: a book sitting in a character's inventory is being
   * read by that character. Otherwise fall back to the module's usual token/assigned
   * character resolution, which is what makes a book in a loot chest usable.
   *
   * @returns {{ actor: object, source: string }|null}
   */
  #resolveActor() {
    const parent = this.item?.parent;
    if (parent?.documentName === "Actor" && parent.isOwner && parent.type !== "loot") {
      return { actor: parent, source: game.i18n.localize("SWS.Loot.SourceCarrier") };
    }
    return resolveTargetActor();
  }

  /** Send one spell from the book into the reader's spellcasting entry. */
  static async #onLearn(event, target) {
    const uuid = target.dataset.uuid;
    if (!uuid) return;

    const resolved = this.#resolveActor();
    if (!resolved) {
      ui.notifications.warn(game.i18n.localize("SWS.Slot.NoActor"));
      return;
    }

    const created = await openSendToSlotDialog({ uuid, actor: resolved.actor });
    if (!created) return;

    if (setting(SETTINGS.TRACK_LEARNED, true)) await this.#recordLearned(uuid, resolved.actor.id);
    await this.render();
  }

  /**
   * Record that an actor has copied a spell out of this book.
   *
   * Silently skipped when the reader cannot write to the item - tracking is a
   * convenience, not something worth failing a successful learn over.
   *
   * @param {string} uuid Spell uuid.
   * @param {string} actorId Actor that learned it.
   * @returns {Promise<void>}
   */
  async #recordLearned(uuid, actorId) {
    if (!this.item?.isOwner) return;
    try {
      const meta = getLootMeta(this.item);
      if (!meta) return;
      const key = learnedKey(uuid);
      const previous = meta.learned?.[key] ?? foundry.utils.getProperty(meta.learned ?? {}, uuid);
      const actors = new Set(Array.isArray(previous) ? previous : []);
      actors.add(actorId);
      // One targeted key, not the whole map: a write of the full object would merge
      // into the stored one anyway, and this cannot clobber another reader's entry.
      await this.item.update({ [`flags.${MODULE_ID}.${LOOT_FLAG}.learned.${key}`]: [...actors] });
    } catch (err) {
      console.warn("Sargas Wondrous Spellbook | Failed to record a learned spell", err);
    }
  }
}

/**
 * Open the reader for an item, refusing anything that is not a loot spellbook.
 * @param {object} item An Item document.
 * @returns {LootBookApp|null}
 */
export function openLootBook(item) {
  if (!isLootSpellbook(item)) {
    ui.notifications.warn(game.i18n.localize("SWS.Loot.NotALootBook"));
    return null;
  }
  return openOrFocus(LootBookApp.idFor(item), () => new LootBookApp({ item }));
}

/**
 * Add an "Open Spellbook" button to a loot book's item sheet header.
 *
 * Injected into the window header rather than registered as a sheet header control,
 * because PF2e's physical item sheet is not this module's to subclass. The button is
 * marked so repeated renders never stack copies of it.
 *
 * @param {object} app The rendered item sheet.
 * @param {HTMLElement|object} html The sheet's root element, or a jQuery wrapper.
 * @returns {void}
 */
export function injectLootBookButton(app, html) {
  const item = app?.document ?? app?.item;
  if (!isLootSpellbook(item)) return;
  injectHeaderControl(app, html, { ...OPEN_CONTROL, onClick: () => openLootBook(item) });
}

/** Shared description of the item sheet's "open spellbook" control. */
const OPEN_CONTROL = Object.freeze({
  cssClass: "sws-open-loot-book",
  icon: "fa-solid fa-book-sparkles",
  label: "SWS.Loot.OpenBookShort",
  tooltip: "SWS.Loot.OpenBook"
});

/**
 * Add "Open spellbook" to an Application V1 item sheet's header buttons.
 *
 * Registered on `getItemSheetPF2eHeaderButtons`, which V1 fires while it builds the
 * header of every PF2e item sheet; anything that is not a loot book is left alone.
 *
 * @param {object} app The item sheet being rendered.
 * @param {object[]} buttons The header buttons being assembled.
 * @returns {void}
 */
export function addLootBookHeaderButton(app, buttons) {
  const item = app?.document ?? app?.item;
  if (!isLootSpellbook(item) || buttons.some((b) => b.class === OPEN_CONTROL.cssClass)) return;
  buttons.unshift({
    label: OPEN_CONTROL.label,
    class: OPEN_CONTROL.cssClass,
    icon: OPEN_CONTROL.icon,
    tooltip: OPEN_CONTROL.tooltip,
    onclick: () => openLootBook(item)
  });
}

/**
 * Add an "Open Spellbook" entry to the Items directory context menu.
 *
 * Uses the v13+ entry shape (`label`, `visible`, `onClick`); the older `name`,
 * `condition` and `callback` keys log a deprecation warning on every menu open.
 *
 * @returns {void}
 */
export function registerLootBookContextMenu() {
  const itemFor = (li) => game.items.get(li?.dataset?.entryId);
  const entry = {
    label: "SWS.Loot.OpenBook",
    icon: "fa-solid fa-book-sparkles",
    visible: (li) => isLootSpellbook(itemFor(li)),
    onClick: (_event, li) => openLootBook(itemFor(li))
  };
  Hooks.on("getItemContextOptions", (_directory, options) => options.push(entry));
}
