/**
 * JB2A animation support, played through Sargas Visual Automation (SVA).
 *
 * Every entry point here is conditional on both JB2A and SVA being active.
 * Availability is re-checked on each call rather than cached at init, so enabling
 * either module mid-session makes the controls appear on the next render.
 *
 * The animation path is stored as a flag on the *spell item owned by the actor*,
 * not on the spellbook journal: the spellbook is storage only. The same choice is
 * written to the item as an SVA recipe, and SVA's own automation plays it when the
 * actor casts that item from their character sheet. This module never plays anything
 * itself, so a spell animates exactly once however it was configured.
 */

import { MODULE_ID } from "./constants.js";

/** Flag key holding the JB2A database path or file path. */
export const ANIMATION_FLAG = "jb2aAnimation";

/** Module id of Sargas Visual Automation, which plays the effects for us. */
export const SVA_MODULE_ID = "sargas-visual-automation";

/** SVA's world setting that turns its automation on or off. */
const SVA_AUTOMATION_SETTING = "automationEnabled";

/**
 * The SVA public API, once the module is active and has finished initialising.
 *
 * SVA attaches its areas (`db`, `ui`, `sequence`...) to the api object during its
 * own init, so an api object without `sequence` belongs to a module that is still
 * starting up and cannot play anything yet.
 *
 * @returns {object|null} The api object, or null when SVA cannot be used.
 */
export function getSVA() {
  const module = game.modules.get(SVA_MODULE_ID);
  if (!module?.active) return null;
  const api = module.api ?? globalThis.SVA;
  return typeof api?.sequence === "function" ? api : null;
}

/**
 * Which JB2A library SVA is reading, if any.
 *
 * SVA owns provider detection (Patreon or free module, custom asset location), so
 * this module never keeps its own list of JB2A module ids. JB2A is never declared
 * as a dependency either, so Foundry never offers to install it.
 *
 * @returns {string|null} The provider module's id, or null when none is usable.
 */
export function getActiveAnimationLibrary() {
  return getSVA()?.db?.provider ?? null;
}

/**
 * Can animations be configured and played right now: SVA active, its JB2A catalog
 * loaded.
 *
 * Deliberately not memoised: the catalog finishes loading after `ready`, and a GM
 * can enable a module mid-session, so the controls must appear on the next render
 * without a reload.
 *
 * @returns {boolean} True when animation features can be used.
 */
export function getAnimationsAvailable() {
  return !!getSVA()?.db?.available;
}

/**
 * Is SVA's automation switched on in this world? Playback goes through it, so an
 * animation configured while it is off is stored but never plays.
 * @returns {boolean}
 */
export function isAutomationEnabled() {
  try {
    return game.settings.get(SVA_MODULE_ID, SVA_AUTOMATION_SETTING) !== false;
  } catch {
    return true;
  }
}

/**
 * The SVA recipe stored on an item, or null when there is none (or SVA is unavailable).
 * @param {object} item An owned Item document.
 * @returns {object|null}
 */
function getItemRecipe(item) {
  try {
    return getSVA()?.automation?.getItemRecipe?.(item) ?? null;
  } catch (err) {
    console.warn("Blizzard's Wondrous Spellbook | Could not read the SVA recipe", err);
    return null;
  }
}

/**
 * Read the animation path stored on a spell item.
 *
 * While SVA is active its recipe is the source of truth: the user may have changed
 * the animation in SVA's own editor since the gear last wrote it. The module's flag
 * is the fallback, kept so the choice survives SVA being disabled and so the sheet
 * importer can still carry it into a book.
 *
 * @param {object} item An owned Item document.
 * @returns {string} The stored path, or an empty string.
 */
export function getAnimationPath(item) {
  const animation = getItemRecipe(item)?.animation;
  if (typeof animation === "string" && animation) return animation;
  return item?.getFlag?.(MODULE_ID, ANIMATION_FLAG) ?? "";
}

/**
 * Build the SVA recipe for a path: the effect on the caster's token when the spell is
 * cast, which is what the spellbook's single-path choice has always meant.
 * @param {string} path JB2A database path or file URL.
 * @returns {object} A plain-JSON SVA Recipe.
 */
export function buildAnimationRecipe(path) {
  const castEvent = getSVA()?.EVENT_TYPES?.CAST ?? "cast";
  return {
    version: 1,
    preset: "onToken",
    animation: path,
    options: { target: "source" },
    triggers: [castEvent]
  };
}

/**
 * Does the item carry an SVA recipe flag at all, valid or not?
 *
 * The raw flag is checked rather than SVA's validated getter on purpose: that getter
 * returns null for a recipe SVA rejects, and treating "invalid" as "missing" would
 * overwrite a hand-edited recipe, or loop forever if SVA kept rejecting what we wrote.
 *
 * @param {object} item An Item document.
 * @returns {boolean}
 */
function hasRecipeFlag(item) {
  return item?.flags?.[SVA_MODULE_ID]?.recipe !== undefined;
}

/**
 * Give a spell flagged by an older release, before playback moved to SVA, its recipe.
 *
 * Only a spell with a path and *no* recipe flag at all is touched. One that already
 * has a recipe is left alone whatever it plays: SVA's editor may have changed it since.
 *
 * @param {object} item An owned Item document.
 * @returns {Promise<boolean>} True when a recipe was written.
 */
export async function syncAnimationRecipe(item) {
  const automation = getSVA()?.automation;
  if (!item?.isOwner || typeof automation?.setItemRecipe !== "function") return false;
  const path = item.getFlag?.(MODULE_ID, ANIMATION_FLAG);
  if (!path || hasRecipeFlag(item)) return false;
  await automation.setItemRecipe(item, buildAnimationRecipe(path));
  return true;
}

/**
 * One-shot migration, run once SVA is ready: every spell in the world with a stored
 * path and no SVA recipe gets one, so casts animate again without each sheet having
 * to be opened first. Only the GM runs it, so several clients never race on the same
 * items; `syncAnimationRecipe` on sheet render remains as the backstop for synthetic
 * token actors, which are not in the world collection.
 *
 * @returns {Promise<number>} How many recipes were written.
 */
export async function migrateLegacyAnimations() {
  if (!game.user?.isGM || !getSVA()?.automation) return 0;
  let written = 0;
  for (const actor of game.actors ?? []) {
    for (const item of actor.items ?? []) {
      if (item.type !== "spell" || !item.getFlag?.(MODULE_ID, ANIMATION_FLAG)) continue;
      try {
        if (await syncAnimationRecipe(item)) written++;
      } catch (err) {
        console.warn(`Blizzard's Wondrous Spellbook | Could not migrate "${item.name}"`, err);
      }
    }
  }
  if (written) console.log(`Blizzard's Wondrous Spellbook | Wrote ${written} SVA recipe(s) for stored animations`);
  return written;
}

/** Most suggestions put into the datalist for one query. */
const MAX_SUGGESTIONS = 50;

/**
 * Suggest JB2A database paths matching what the user has typed so far.
 *
 * SVA's catalog search is ranked and fuzzy, and only returns leaves, so every
 * suggestion is a path that actually plays something.
 *
 * @param {string} query Text typed into the path field.
 * @returns {string[]} Matching full paths, best first, or an empty array.
 */
function getSuggestedPaths(query) {
  try {
    const db = getSVA()?.db;
    if (!db?.available || !query?.trim()) return [];
    return db
      .search(query, { limit: MAX_SUGGESTIONS })
      .map((entry) => entry?.path)
      .filter((path) => typeof path === "string" && path);
  } catch (err) {
    console.warn("Blizzard's Wondrous Spellbook | Could not search the JB2A catalog", err);
    return [];
  }
}

/**
 * Open the animation configuration dialog for an owned spell item.
 *
 * No-ops with a notification if JB2A or SVA went inactive between the button
 * rendering and the click landing.
 *
 * @param {object} item An owned SpellPF2e document on an actor.
 * @returns {Promise<void>}
 */
export async function openAnimationConfigDialog(item) {
  if (!getAnimationsAvailable()) {
    ui.notifications.warn(game.i18n.localize("BWS.Anim.Unavailable"));
    return;
  }
  if (!item) return;

  const current = getAnimationPath(item);
  const listId = `bws-anim-paths-${foundry.utils.randomID()}`;

  const content = `
    <div class="bws-anim-dialog">
      <div class="bws-anim-spell">
        <img src="${foundry.utils.escapeHTML(item.img ?? "")}" alt="" />
        <div class="bws-anim-spell-text">
          <span class="bws-anim-spell-name">${foundry.utils.escapeHTML(item.name)}</span>
          <span class="bws-anim-spell-sub">${
            current
              ? game.i18n.format("BWS.Anim.Current", { path: foundry.utils.escapeHTML(current) })
              : game.i18n.localize("BWS.Anim.None")
          }</span>
        </div>
      </div>
      <label class="bws-anim-label" for="bws-anim-path">${game.i18n.localize("BWS.Anim.PathLabel")}</label>
      <input id="bws-anim-path" type="text" name="path" list="${listId}"
             value="${foundry.utils.escapeHTML(current)}"
             placeholder="${game.i18n.localize("BWS.Anim.PathPlaceholder")}" autocomplete="off" />
      <datalist id="${listId}"></datalist>
      <p class="bws-anim-hint">${game.i18n.localize("BWS.Anim.Hint")}</p>
      ${
        isAutomationEnabled()
          ? ""
          : `<p class="bws-anim-hint bws-anim-warning"><i class="fa-solid fa-triangle-exclamation"></i> ${game.i18n.localize("BWS.Anim.AutomationOff")}</p>`
      }
      <button type="button" class="bws-anim-browse">
        <i class="fa-solid fa-film"></i> ${game.i18n.localize("BWS.Anim.Browse")}
      </button>
    </div>
  `;

  try {
    await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize("BWS.Anim.Title"), icon: "fa-solid fa-wand-sparkles" },
      classes: ["bws-dialog"],
      content,
      buttons: [
        {
          action: "save",
          label: game.i18n.localize("BWS.Anim.Save"),
          icon: "fa-solid fa-floppy-disk",
          default: true,
          callback: async (_event, _button, dialog) => {
            const path = dialog.element.querySelector("#bws-anim-path")?.value?.trim() ?? "";
            await setAnimationPath(item, path);
          }
        },
        {
          action: "clear",
          label: game.i18n.localize("BWS.Anim.Clear"),
          icon: "fa-solid fa-eraser",
          callback: async () => setAnimationPath(item, "")
        },
        { action: "cancel", label: game.i18n.localize("BWS.Anim.Cancel"), icon: "fa-solid fa-xmark" }
      ],
      rejectClose: false,
      render: (_event, dialog) => {
        const input = dialog.element.querySelector("#bws-anim-path");
        const datalist = dialog.element.querySelector(`#${listId}`);

        // The catalog holds thousands of leaves, so the datalist is filled per query
        // from SVA's ranked search instead of listing everything up front.
        const refreshSuggestions = () => {
          if (!input || !datalist) return;
          datalist.replaceChildren(
            ...getSuggestedPaths(input.value).map((path) => {
              const option = document.createElement("option");
              option.value = path;
              return option;
            })
          );
        };
        input?.addEventListener("input", refreshSuggestions);
        refreshSuggestions();

        // SVA's animation browser in picker mode: choosing a card closes the browser
        // and hands the path back, which lands in the field ready to be saved.
        dialog.element.querySelector(".bws-anim-browse")?.addEventListener("click", () => {
          try {
            getSVA()?.ui?.openBrowser?.({
              path: input?.value?.trim() || undefined,
              onPick: (path) => {
                if (!input || typeof path !== "string") return;
                input.value = path;
                refreshSuggestions();
                input.focus();
              }
            });
          } catch (err) {
            console.warn("Blizzard's Wondrous Spellbook | Could not open the animation browser", err);
          }
        });
      }
    });
  } catch (err) {
    console.error("Blizzard's Wondrous Spellbook | Animation dialog failed", err);
    ui.notifications.error(game.i18n.localize("BWS.Error.AnimSaveFailed"));
  }
}

/**
 * Persist (or clear) the animation path on a spell item, and the SVA recipe with it.
 *
 * The recipe is written first: it is what plays, and SVA may reject it. If it does,
 * the flag is left as it was, so the two never disagree about which animation the
 * spell has. Saving a path the recipe already plays leaves the recipe alone, so
 * stages, outcomes or a sound added in SVA's editor around that animation are not
 * flattened away. A different path replaces the recipe. Clearing removes both.
 *
 * @param {object} item An owned Item document.
 * @param {string} path JB2A database path or file URL. An empty string clears the flag.
 * @returns {Promise<void>}
 */
export async function setAnimationPath(item, path) {
  try {
    const automation = getSVA()?.automation;
    if (path) {
      if (getItemRecipe(item)?.animation !== path) {
        await automation?.setItemRecipe?.(item, buildAnimationRecipe(path));
      }
      await item.setFlag(MODULE_ID, ANIMATION_FLAG, path);
      ui.notifications.info(game.i18n.format("BWS.Anim.Saved", { spell: item.name }));
    } else {
      if (hasRecipeFlag(item)) await automation?.setItemRecipe?.(item, null);
      await item.unsetFlag(MODULE_ID, ANIMATION_FLAG);
      ui.notifications.info(game.i18n.format("BWS.Anim.Cleared", { spell: item.name }));
    }
  } catch (err) {
    console.error("Blizzard's Wondrous Spellbook | Failed to write the animation flag", err);
    ui.notifications.error(game.i18n.localize("BWS.Error.AnimSaveFailed"));
  }
}
