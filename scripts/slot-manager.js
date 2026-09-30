/**
 * Slot-fill integration.
 *
 * This is the only write path from a spellbook to an actor. It does not replace or
 * subclass the PF2e character sheet: it creates the spell as an embedded Item on the
 * actor, bound to a chosen spellcasting entry and rank, so the spell shows up in the
 * sheet's own spellcasting tab exactly as a manually added spell would.
 *
 * Where PF2e exposes first-party helpers (`SpellcastingEntryPF2e#addSpell` /
 * `#prepareSpell`) they are preferred, because they handle the prepared/spontaneous
 * bookkeeping. A manual `Item.create` + `system.location` write is kept as a fallback
 * for data-model drift across PF2e releases.
 */

import { MODULE_ID, template } from "./constants.js";
import { MAX_RANK, getRankLabel, isFocusSpell, isRitual, resolveSpell } from "./spell-query.js";
import {
  getAnimationPath,
  getAnimationsAvailable,
  openAnimationConfigDialog,
  syncAnimationRecipe
} from "./animation-config.js";

/**
 * Resolve the actor a spell should be sent to.
 *
 * Prefers a controlled token so a GM can retarget without changing their assigned
 * character, then falls back to the user's assigned character.
 *
 * @returns {{ actor: object, source: string }|null} The target, or null if there is none.
 */
export function resolveTargetActor() {
  const controlled = canvas?.tokens?.controlled ?? [];
  const token = controlled.find((t) => t.actor?.isOwner);
  if (token?.actor) return { actor: token.actor, source: game.i18n.localize("BWS.Slot.SourceToken") };

  const assigned = game.user.character;
  if (assigned?.isOwner) {
    return { actor: assigned, source: game.i18n.localize("BWS.Slot.SourceAssigned") };
  }
  return null;
}

/**
 * Human-readable kind of a spellcasting entry.
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
 * Does this entry prepare spells into individual slots?
 *
 * A flexible caster is a prepared entry that keeps a spell collection instead: PF2e
 * empties its ranked slot arrays, so every rank above cantrips behaves like a
 * spontaneous repertoire. Cantrips still go into ordinary slots.
 *
 * @param {object} entry A SpellcastingEntryPF2e.
 * @param {number} rank Spell rank.
 * @returns {boolean}
 */
function usesSlots(entry, rank) {
  if (!entry?.isPrepared) return false;
  return rank === 0 || !entry.isFlexible;
}

/**
 * PF2e's group id for a rank: `cantrips` for rank 0, the number otherwise.
 * @param {number} rank Spell rank.
 * @returns {string|number}
 */
function groupIdFor(rank) {
  return rank === 0 ? "cantrips" : rank;
}

/**
 * Read the prepared-slot array for one rank of a prepared entry.
 * @param {object} entry A SpellcastingEntryPF2e.
 * @param {number} rank Spell rank.
 * @returns {object[]} The slot array, or an empty array.
 */
function getPreparedSlots(entry, rank) {
  const slots = entry?.system?.slots?.[`slot${rank}`]?.prepared;
  return Array.isArray(slots) ? slots : [];
}

/**
 * Index of the first empty prepared slot at a rank.
 * @param {object} entry A SpellcastingEntryPF2e.
 * @param {number} rank Spell rank.
 * @returns {number} Slot index, or -1 when the rank is full or not prepared.
 */
function findFreeSlotIndex(entry, rank) {
  return getPreparedSlots(entry, rank).findIndex((slot) => !slot?.id);
}

/**
 * Build the rank options offered for a given entry and spell.
 *
 * Cantrips and focus spells are locked to their own rank because PF2e auto-heightens
 * them. Every other spell may be slotted at its own rank or heightened up to the
 * entry's highest available rank.
 *
 * @param {object} entry A SpellcastingEntryPF2e.
 * @param {number} baseRank The spell's own rank.
 * @param {object} flags
 * @param {boolean} flags.isCantrip Whether the spell is a cantrip.
 * @param {boolean} flags.isFocus Whether the spell is a focus spell.
 * @returns {object[]} Option view models.
 */
function buildRankOptions(entry, baseRank, { isCantrip, isFocus }) {
  const option = (rank) => {
    const slotted = usesSlots(entry, rank);
    const slots = slotted ? getPreparedSlots(entry, rank) : [];
    const free = slotted ? slots.filter((s) => !s?.id).length : null;
    return {
      rank,
      label: getRankLabel(rank),
      free,
      freeLabel: free === null ? "" : game.i18n.format("BWS.Slot.FreeCount", { count: free }),
      // A slotted entry with no slot array at all for this rank cannot hold it.
      disabled: slotted && slots.length === 0
    };
  };

  if (isCantrip) return [option(0)];
  if (isFocus) return [{ ...option(baseRank), free: null, freeLabel: "", disabled: false }];

  // `highestRank` is the modern accessor; fall back to the full range when absent.
  const highest = Number(entry?.highestRank);
  const ceiling = Number.isFinite(highest) && highest > 0 ? highest : MAX_RANK;
  const max = Math.clamp(ceiling, baseRank, MAX_RANK);

  const options = [];
  for (let rank = baseRank; rank <= max; rank++) options.push(option(rank));
  return options;
}

/**
 * The live spell collection behind an entry.
 *
 * Re-read off the actor each time: PF2e rebuilds `entry.spells` whenever the actor is
 * prepared, so a collection captured before a write describes the old slot state.
 *
 * @param {object} actor The owning actor.
 * @param {string} entryId Spellcasting entry id.
 * @returns {{ entry: object|null, collection: object|null }}
 */
function liveEntry(actor, entryId) {
  const entry = actor.items.get(entryId) ?? null;
  return { entry, collection: entry?.spells ?? null };
}

/**
 * Attach a spell to a spellcasting entry at a chosen rank.
 *
 * Goes through PF2e's `SpellCollection` rather than the entry's own `addSpell` and
 * `prepareSpell`. Those wrappers return the spell they were handed (not the item they
 * created) and do not await the write, so preparing with their result pointed the slot
 * at the compendium document and reported success when PF2e had refused the spell.
 *
 * @param {object} actor The target actor.
 * @param {string} entryId The chosen spellcasting entry's id.
 * @param {object} spellDoc The source SpellPF2e document from a compendium.
 * @param {number} rank The chosen slot rank.
 * @returns {Promise<{ item: object, prepared: boolean, full: boolean }|null>} Null when
 *   PF2e refused the spell; it has already told the user why.
 */
async function attachSpell(actor, entryId, spellDoc, rank) {
  let { entry, collection } = liveEntry(actor, entryId);
  if (!entry) return null;

  let item = null;
  if (typeof collection?.addSpell === "function") {
    item = await collection.addSpell(spellDoc, { groupId: groupIdFor(rank) });
    // A collection exists and said no: PF2e has warned (wrong entry for a focus spell,
    // rank too low). Creating the item by hand would override that decision.
    if (!item) return null;
  } else {
    // No collection at all means a PF2e build this module does not know. Write the item
    // by hand and bind it to the entry the way PF2e's own drop handler does.
    const source = spellDoc.toObject();
    delete source._id;
    source.system.location = { ...(source.system.location ?? {}), value: entry.id };
    if (rank > 0 && rank !== (source.system.level?.value ?? rank)) {
      source.system.location.heightenedLevel = rank;
    }
    [item] = await actor.createEmbeddedDocuments("Item", [source]);
  }
  if (!item) return null;

  // Slotted entries need the spell placed into an actual slot to occupy it.
  if (!usesSlots(entry, rank)) return { item, prepared: false, full: false };

  ({ entry, collection } = liveEntry(actor, entryId));
  const slotIndex = findFreeSlotIndex(entry, rank);
  if (slotIndex < 0) return { item, prepared: false, full: true };

  let prepared = false;
  try {
    if (typeof collection?.prepareSpell === "function") {
      prepared = !!(await collection.prepareSpell(item, groupIdFor(rank), slotIndex));
    } else {
      const slots = foundry.utils.deepClone(getPreparedSlots(entry, rank));
      slots[slotIndex] = { id: item.id, expended: !!slots[slotIndex]?.expended };
      prepared = !!(await entry.update({ [`system.slots.slot${rank}.prepared`]: slots }));
    }
  } catch (err) {
    console.warn("Blizzard's Wondrous Spellbook | Preparing the spell failed", err);
  }
  return { item, prepared, full: false };
}

/**
 * Open the "Send to Slot" dialog for a spell.
 *
 * @param {object} params
 * @param {string} params.uuid Compendium UUID of the spell to send.
 * @param {object} [params.actor] Explicit target actor. Resolved from selection if omitted.
 * @returns {Promise<object|null>} The created owned Item, or null if nothing was written.
 */
export async function openSendToSlotDialog({ uuid, actor } = {}) {
  const spellDoc = await resolveSpell(uuid);
  if (!spellDoc) {
    ui.notifications.error(game.i18n.localize("BWS.Error.SpellMissing"));
    return null;
  }

  // PF2e casts rituals through a virtual ritual entry that is not an item, so every entry
  // this dialog could offer is a slot-based one - and a ritual prepared into a spell slot
  // is a corrupt sheet, not a feature. The creator hides the arrow on ritual rows; this
  // guard covers every other way in, the module API included.
  if (isRitual(spellDoc)) {
    ui.notifications.warn(game.i18n.format("BWS.Slot.RitualRefused", { spell: spellDoc.name }));
    return null;
  }

  let source = "";
  if (!actor) {
    const target = resolveTargetActor();
    if (!target) {
      ui.notifications.warn(game.i18n.localize("BWS.Slot.NoActor"));
      return null;
    }
    actor = target.actor;
    source = target.source;
  }

  // `resolveTargetActor` only ever returns owned actors, but an explicit actor from a
  // macro or the module API has had no such check. Fail here rather than opening a
  // dialog whose submit is guaranteed to be rejected by the server.
  if (!actor.isOwner) {
    ui.notifications.warn(game.i18n.format("BWS.Slot.NotOwner", { actor: actor.name }));
    return null;
  }

  const entries = actor.itemTypes.spellcastingEntry ?? [];

  // No-entries state: explain rather than offering an empty dropdown.
  if (!entries.length) {
    await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize("BWS.Slot.NoEntriesTitle"), icon: "fa-solid fa-book-sparkles" },
      classes: ["bws-dialog"],
      content: `<p class="bws-empty-note">${game.i18n.format("BWS.Slot.NoEntries", {
        actor: foundry.utils.escapeHTML(actor.name)
      })}</p>`,
      ok: { label: game.i18n.localize("BWS.Slot.Cancel") },
      rejectClose: false
    });
    return null;
  }

  const isCantrip = spellDoc.isCantrip ?? (spellDoc.system?.traits?.value ?? []).includes("cantrip");
  const isFocus = !isCantrip && isFocusSpell(spellDoc);
  // The base rank, never the heightened one: `rank` on an owned spell folds in its slot.
  const baseRank = isCantrip
    ? 0
    : Number(spellDoc.baseRank ?? spellDoc.system?.level?.value ?? spellDoc.rank ?? 1);
  const rankFlags = { isCantrip, isFocus };

  // A focus spell only fits a focus pool; offer those first so the default is valid.
  const ordered = isFocus
    ? [...entries.filter((e) => e.isFocusPool), ...entries.filter((e) => !e.isFocusPool)]
    : entries;

  const entryViews = ordered.map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: describeEntryKind(entry),
    tradition: entry.tradition ?? ""
  }));

  const content = await foundry.applications.handlebars.renderTemplate(template("send-to-slot.hbs"), {
    spell: { name: spellDoc.name, img: spellDoc.img },
    targetLine: source
      ? game.i18n.format("BWS.Slot.TargetLine", { actor: actor.name, source })
      : game.i18n.format("BWS.Slot.TargetLineBare", { actor: actor.name }),
    entries: entryViews,
    ranks: buildRankOptions(ordered[0], baseRank, rankFlags),
    baseRank,
    rankLocked: isCantrip || isFocus,
    // Two dialogs can be open at once; their labels must not point at each other's fields.
    uid: `bws-slot-${foundry.utils.randomID()}`
  });

  let result = null;

  try {
    await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize("BWS.Slot.Title"), icon: "fa-solid fa-arrow-down-to-line" },
      classes: ["bws-dialog", "bws-slot-dialog"],
      content,
      buttons: [
        {
          action: "send",
          label: game.i18n.localize("BWS.Slot.Submit"),
          icon: "fa-solid fa-arrow-down-to-line",
          default: true,
          callback: async (_event, _button, dialog) => {
            const entryId = dialog.element.querySelector("[name='entry']")?.value;
            const rankSelect = dialog.element.querySelector("[name='rank']");
            const entry = entries.find((e) => e.id === entryId);
            if (!entry) return;
            // Every rank disabled leaves the select empty, and `Number("")` is 0: without
            // this check the spell would be sent as a cantrip.
            if (!rankSelect?.value || rankSelect.selectedOptions[0]?.disabled) {
              ui.notifications.warn(game.i18n.format("BWS.Slot.NoRankAvailable", { entry: entry.name }));
              return;
            }
            const rank = Number(rankSelect.value);
            const rankLabel = getRankLabel(rank);

            try {
              const outcome = await attachSpell(actor, entry.id, spellDoc, rank);
              if (!outcome) return;
              result = outcome.item;

              if (outcome.prepared) {
                ui.notifications.info(
                  game.i18n.format("BWS.Slot.SuccessPrepared", {
                    spell: spellDoc.name,
                    entry: entry.name,
                    rank: rankLabel
                  })
                );
              } else if (usesSlots(entry, rank)) {
                // Added to the entry, but no slot took it: either the rank was full, or
                // PF2e refused the preparation and has already said why.
                ui.notifications.warn(
                  game.i18n.format(outcome.full ? "BWS.Slot.NoFreeSlot" : "BWS.Slot.NotPrepared", {
                    rank: rankLabel,
                    entry: entry.name,
                    spell: spellDoc.name
                  })
                );
              } else {
                ui.notifications.info(
                  game.i18n.format("BWS.Slot.Success", {
                    spell: spellDoc.name,
                    entry: entry.name,
                    rank: rankLabel
                  })
                );
              }
            } catch (err) {
              console.error("Blizzard's Wondrous Spellbook | Slot fill failed", err);
              ui.notifications.error(game.i18n.localize("BWS.Error.SlotFailed"));
            }
          }
        },
        { action: "cancel", label: game.i18n.localize("BWS.Slot.Cancel"), icon: "fa-solid fa-xmark" }
      ],
      rejectClose: false,
      render: (_event, dialog) => {
        // Rebuild the rank list when the entry changes: available ranks and free
        // slot counts are entry-specific.
        const entrySelect = dialog.element.querySelector("[name='entry']");
        const rankSelect = dialog.element.querySelector("[name='rank']");
        if (!entrySelect || !rankSelect) return;

        entrySelect.addEventListener("change", () => {
          const entry = entries.find((e) => e.id === entrySelect.value);
          if (!entry) return;
          const options = buildRankOptions(entry, baseRank, rankFlags);
          rankSelect.replaceChildren(
            ...options.map((opt) => {
              const node = document.createElement("option");
              node.value = String(opt.rank);
              node.textContent = opt.freeLabel ? `${opt.label} (${opt.freeLabel})` : opt.label;
              node.disabled = opt.disabled;
              return node;
            })
          );
          // Land on the first rank that can actually take the spell.
          const firstOpen = options.find((opt) => !opt.disabled);
          if (firstOpen) rankSelect.value = String(firstOpen.rank);
        });
        entrySelect.dispatchEvent(new Event("change"));
      }
    });
  } catch (err) {
    console.error("Blizzard's Wondrous Spellbook | Send to Slot dialog failed", err);
    ui.notifications.error(game.i18n.localize("BWS.Error.SlotFailed"));
  }

  return result;
}

/**
 * Inject the animation configuration button into PF2e character sheet spell rows.
 *
 * Availability is evaluated here, on every sheet render, rather than being cached at
 * init: toggling JB2A or Sargas Visual Automation mid-session takes effect on the next render. When
 * animations are unavailable nothing is injected at all.
 *
 * @param {object} app The rendered CharacterSheetPF2e application.
 * @param {HTMLElement|object} html The sheet's root element (or jQuery wrapper on AppV1).
 * @returns {void}
 */
export function injectSheetControls(app, html) {
  if (!getAnimationsAvailable()) return;

  const actor = app?.actor;
  if (!actor?.isOwner) return;

  // PF2e's sheet moved to ApplicationV2 during the v8 line, so `html` arrives as a
  // bare element on newer builds and as a jQuery wrapper on older ones.
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;

  const tab = root.querySelector(".tab[data-tab='spellcasting'], .tab[data-tab='spells']");
  if (!tab) return;

  for (const row of tab.querySelectorAll("[data-item-id]")) {
    const itemId = row.dataset.itemId;

    // PF2e repeats `data-item-id` on elements *inside* a spell row - the drag handle,
    // the name link, individual controls - so the same spell is visited several times.
    // Only the outermost element carrying an id is the row; anything below it repeating
    // that id belongs to the row rather than being a row of its own. Comparing ids (not
    // just "has an ancestor with the attribute") keeps spell rows nested inside a
    // spellcasting entry, which carries the entry's own id, from being skipped.
    if (row.parentElement?.closest("[data-item-id]")?.dataset.itemId === itemId) continue;

    const item = actor.items.get(itemId);
    if (item?.type !== "spell") continue;

    // Prefer the row's existing control cluster so the button inherits its layout, but
    // only a cluster belonging to *this* row - never one from a row nested inside it.
    const controls = [...row.querySelectorAll(".item-controls, .spell-controls, .controls")].find(
      (el) => el.closest("[data-item-id]") === row
    );
    const host = controls ?? row;
    if (host.querySelector(".bws-anim-button")) continue;

    // PF2e sizes the control cluster to the controls it knows about, and its own
    // buttons shrink to absorb anything extra - a spell row with several controls
    // squeezes the CAST button down to a sliver once ours is added. Tagging the
    // cluster lets the stylesheet size it to its contents instead.
    if (controls) controls.classList.add("bws-anim-host");

    // A spell flagged before playback moved to SVA has no recipe yet; give it one so
    // the next cast animates. The write re-renders the sheet once, then finds nothing
    // to do. Never awaited: the render must not wait on a document update.
    syncAnimationRecipe(item).catch((err) =>
      console.warn("Blizzard's Wondrous Spellbook | Could not sync the SVA recipe", err)
    );

    const hasAnimation = !!getAnimationPath(item);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `bws-anim-button${hasAnimation ? " is-set" : ""}`;
    button.dataset.itemId = itemId;
    button.title = game.i18n.localize("BWS.Anim.Configure");
    button.innerHTML = '<i class="fa-solid fa-gear"></i>';
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openAnimationConfigDialog(actor.items.get(itemId));
    });

    host.appendChild(button);
  }
}
