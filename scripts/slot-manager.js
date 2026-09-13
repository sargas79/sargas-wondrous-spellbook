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
import { MAX_RANK, getRankLabel, isRitual, resolveSpell } from "./spell-query.js";
import { getAnimationsAvailable, openAnimationConfigDialog } from "./animation-config.js";

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
 * Cantrips are locked to the cantrip rank because PF2e auto-heightens them. Every
 * other spell may be slotted at its own rank or heightened up to the entry's
 * highest available rank.
 *
 * @param {object} entry A SpellcastingEntryPF2e.
 * @param {number} baseRank The spell's own rank.
 * @param {boolean} isCantrip Whether the spell is a cantrip.
 * @returns {object[]} Option view models.
 */
function buildRankOptions(entry, baseRank, isCantrip) {
  if (isCantrip) {
    return [{ rank: 0, label: getRankLabel(0), free: null, disabled: false }];
  }

  // `highestRank` is the modern accessor; fall back to the full range when absent.
  const highest = Number(entry?.highestRank);
  const ceiling = Number.isFinite(highest) && highest > 0 ? highest : MAX_RANK;
  const max = Math.clamp(ceiling, baseRank, MAX_RANK);

  const options = [];
  for (let rank = baseRank; rank <= max; rank++) {
    const slots = getPreparedSlots(entry, rank);
    const freeCount = entry.isPrepared ? slots.filter((s) => !s?.id).length : null;
    options.push({
      rank,
      label: getRankLabel(rank),
      free: freeCount,
      // A prepared entry with no slot array at all for this rank cannot hold it.
      disabled: entry.isPrepared && slots.length === 0
    });
  }
  return options;
}

/**
 * Attach a spell to a spellcasting entry at a chosen rank.
 *
 * @param {object} actor The target actor.
 * @param {object} entry The chosen SpellcastingEntryPF2e.
 * @param {object} spellDoc The source SpellPF2e document from a compendium.
 * @param {number} rank The chosen slot rank.
 * @returns {Promise<{ item: object, prepared: boolean }|null>}
 */
async function attachSpell(actor, entry, spellDoc, rank) {
  let item = null;

  // Preferred path: let PF2e do its own bookkeeping.
  if (typeof entry.addSpell === "function") {
    try {
      item = await entry.addSpell(spellDoc, { groupId: rank });
    } catch (err) {
      console.warn("Blizzard's Wondrous Spellbook | addSpell failed, falling back", err);
    }
  }

  // Fallback: create the embedded item and point it at the entry by hand.
  if (!item) {
    const source = spellDoc.toObject();
    source.system.location = { ...(source.system.location ?? {}), value: entry.id };
    if (rank > 0 && rank !== (source.system.level?.value ?? rank)) {
      source.system.location.heightenedLevel = rank;
    }
    const created = await Item.create(source, { parent: actor });
    item = Array.isArray(created) ? created[0] : created;
  }

  if (!item) return null;

  // Prepared entries need the spell placed into an actual slot to occupy it.
  let prepared = false;
  if (entry.isPrepared && rank > 0 && typeof entry.prepareSpell === "function") {
    const slotIndex = findFreeSlotIndex(entry, rank);
    if (slotIndex >= 0) {
      try {
        await entry.prepareSpell(item, rank, slotIndex);
        prepared = true;
      } catch (err) {
        console.warn("Blizzard's Wondrous Spellbook | prepareSpell failed", err);
      }
    }
  }

  return { item, prepared };
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
  const baseRank = isCantrip ? 0 : Number(spellDoc.rank ?? spellDoc.system?.level?.value ?? 1);

  const entryViews = entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: describeEntryKind(entry),
    tradition: entry.tradition ?? ""
  }));

  const content = await foundry.applications.handlebars.renderTemplate(template("send-to-slot.hbs"), {
    spell: { name: spellDoc.name, img: spellDoc.img },
    targetLine: game.i18n.format("BWS.Slot.TargetLine", { actor: actor.name, source }),
    entries: entryViews,
    ranks: buildRankOptions(entries[0], baseRank, isCantrip),
    baseRank,
    isCantrip
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
            const rank = Number(dialog.element.querySelector("[name='rank']")?.value ?? baseRank);
            const entry = entries.find((e) => e.id === entryId);
            if (!entry) return;

            try {
              const outcome = await attachSpell(actor, entry, spellDoc, rank);
              if (!outcome) return;
              result = outcome.item;

              if (outcome.prepared) {
                ui.notifications.info(
                  game.i18n.format("BWS.Slot.SuccessPrepared", {
                    spell: spellDoc.name,
                    entry: entry.name,
                    rank
                  })
                );
              } else if (entry.isPrepared && rank > 0 && findFreeSlotIndex(entry, rank) < 0) {
                ui.notifications.warn(
                  game.i18n.format("BWS.Slot.NoFreeSlot", { rank, entry: entry.name })
                );
              } else {
                ui.notifications.info(
                  game.i18n.format("BWS.Slot.Success", {
                    spell: spellDoc.name,
                    entry: entry.name,
                    rank
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
          const options = buildRankOptions(entry, baseRank, isCantrip);
          rankSelect.innerHTML = options
            .map((opt) => {
              const free = opt.free === null ? "" : ` (${opt.free} free)`;
              return `<option value="${opt.rank}"${opt.disabled ? " disabled" : ""}>${
                opt.label
              }${free}</option>`;
            })
            .join("");
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
 * init: toggling JB2A or Sequencer mid-session takes effect on the next render. When
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

    const hasAnimation = !!item.getFlag(MODULE_ID, "jb2aAnimation");
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
