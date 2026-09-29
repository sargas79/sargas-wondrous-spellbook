/**
 * JB2A / Sequencer animation support.
 *
 * Every entry point here is conditional on both JB2A and Sequencer being active.
 * Availability is re-checked on each call rather than cached at init, so enabling
 * either module mid-session makes the controls appear on the next render.
 *
 * The animation path is stored as a flag on the *spell item owned by the actor*,
 * not on the spellbook journal: the spellbook is storage only, and the animation
 * fires when the actor casts that item from their character sheet.
 */

import { MODULE_ID } from "./constants.js";

/** Flag key holding the Sequencer database path or file path. */
export const ANIMATION_FLAG = "jb2aAnimation";

/**
 * Module ids of the JB2A libraries we can read effects from, most complete first.
 * JB2A is never declared as a dependency, so Foundry never offers to install it;
 * we only light up the animation features if the user already has one installed.
 */
const JB2A_MODULE_IDS = ["jb2a_patreon", "JB2A_DnD5e"];

/**
 * Is a JB2A library active, and which one?
 * @returns {string|null} The active module's id, or null when none is present.
 */
export function getActiveAnimationLibrary() {
  return JB2A_MODULE_IDS.find((id) => game.modules.get(id)?.active) ?? null;
}

/**
 * Are a JB2A library and Sequencer both installed and active right now?
 *
 * Deliberately not memoised: a GM can enable either module mid-session and the
 * controls must appear on the next render without a reload.
 *
 * @returns {boolean} True when animation features can be used.
 */
export function getAnimationsAvailable() {
  const sequencerActive = game.modules.get("sequencer")?.active;
  return !!(getActiveAnimationLibrary() && sequencerActive);
}

/**
 * Read the animation path stored on a spell item.
 * @param {object} item An owned Item document.
 * @returns {string} The stored path, or an empty string.
 */
export function getAnimationPath(item) {
  return item?.getFlag?.(MODULE_ID, ANIMATION_FLAG) ?? "";
}

/** Most suggestions put into the datalist; the browser filters them as the user types. */
const MAX_SUGGESTIONS = 3000;

/**
 * Suggest Sequencer database paths for the autocomplete list.
 *
 * Read from Sequencer's flattened entry list, which holds full dotted paths such as
 * `jb2a.fire_bolt.orange`. `getPathsUnder` returns only the next path segment, so the
 * list built from it offered `jb2a.fire_bolt` and never a path that plays anything.
 *
 * @param {string} [prefix="jb2a"] Database namespace to enumerate.
 * @returns {string[]} Known full paths under the namespace, or an empty array.
 */
function getSuggestedPaths(prefix = "jb2a") {
  try {
    const db = globalThis.Sequencer?.Database;
    if (!db) return [];
    const all = db.publicFlattenedSimpleEntries ?? db.publicFlattenedEntries ?? db.flattenedEntries;
    if (!Array.isArray(all)) return [];
    const namespace = `${prefix}.`;
    return all.filter((path) => String(path).startsWith(namespace)).slice(0, MAX_SUGGESTIONS);
  } catch (err) {
    console.warn("Blizzard's Wondrous Spellbook | Could not read the Sequencer database", err);
    return [];
  }
}

/**
 * Open the animation configuration dialog for an owned spell item.
 *
 * No-ops with a notification if JB2A or Sequencer went inactive between the button
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
  const suggestions = getSuggestedPaths();
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
      <datalist id="${listId}">
        ${suggestions.map((p) => `<option value="${foundry.utils.escapeHTML(p)}"></option>`).join("")}
      </datalist>
      <p class="bws-anim-hint">${game.i18n.localize("BWS.Anim.Hint")}</p>
      <button type="button" class="bws-anim-browse">
        <i class="fa-solid fa-folder-open"></i> ${game.i18n.localize("BWS.Anim.Browse")}
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
        dialog.element.querySelector(".bws-anim-browse")?.addEventListener("click", () => {
          try {
            globalThis.Sequencer?.DatabaseViewer?.show?.();
          } catch (err) {
            console.warn("Blizzard's Wondrous Spellbook | Could not open the Database Viewer", err);
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
 * Persist (or clear) the animation path on a spell item.
 * @param {object} item An owned Item document.
 * @param {string} path Sequencer database path. An empty string clears the flag.
 * @returns {Promise<void>}
 */
export async function setAnimationPath(item, path) {
  try {
    if (path) {
      await item.setFlag(MODULE_ID, ANIMATION_FLAG, path);
      ui.notifications.info(game.i18n.format("BWS.Anim.Saved", { spell: item.name }));
    } else {
      await item.unsetFlag(MODULE_ID, ANIMATION_FLAG);
      ui.notifications.info(game.i18n.format("BWS.Anim.Cleared", { spell: item.name }));
    }
  } catch (err) {
    console.error("Blizzard's Wondrous Spellbook | Failed to write the animation flag", err);
    ui.notifications.error(game.i18n.localize("BWS.Error.AnimSaveFailed"));
  }
}

/** Roll option PF2e adds to a spell card's origin when the spell is actually cast. */
const CAST_ROLL_OPTION = "origin:action:slug:cast-a-spell";

/**
 * Recently played animations, keyed by item uuid, used to swallow a card that is
 * posted twice for one cast.
 * @type {Map<string, number>}
 */
const _recentlyPlayed = new Map();
const DEDUPE_WINDOW_MS = 1500;

/**
 * Has this item already animated within the dedupe window?
 * @param {string} key Item uuid.
 * @returns {boolean}
 */
function isDuplicate(key) {
  const now = Date.now();
  for (const [k, t] of _recentlyPlayed) if (now - t > DEDUPE_WINDOW_MS) _recentlyPlayed.delete(k);
  if (_recentlyPlayed.has(key)) return true;
  _recentlyPlayed.set(key, now);
  return false;
}

/**
 * Play the configured animation for a cast spell.
 *
 * Silently does nothing when animations are unavailable, so a spellbook that was
 * built while JB2A was active keeps working (minus the visuals) after it is disabled.
 * The stored flag is never removed.
 *
 * @param {object} spell The cast SpellPF2e item.
 * @param {object} [actor] The casting actor. Defaults to the spell's parent.
 * @returns {Promise<void>}
 */
export async function playSpellAnimation(spell, actor = spell?.actor) {
  if (!getAnimationsAvailable()) return;

  const path = getAnimationPath(spell);
  if (!path) return;
  if (isDuplicate(spell.uuid)) return;

  try {
    // The caster's own placed token; Sequencer needs something with a canvas position.
    // No fallback to the user's selection: that may be a different creature entirely.
    const target = actor?.getActiveTokens?.(true, false)?.[0] ?? actor?.token?.object;
    if (!target) return;

    await new Sequence().effect().file(path).atLocation(target).play();
  } catch (err) {
    // A bad path or a mid-cast module toggle must never break the cast itself.
    console.error("Blizzard's Wondrous Spellbook | Animation playback failed", err);
  }
}

/**
 * Register the spell-cast listener that triggers animation playback.
 *
 * PF2e fires no dedicated cast hook (8.5.1 has none), but every cast posts a chat card
 * whose `flags.pf2e.origin` names the spell item. That card is the signal, read here.
 * `playSpellAnimation` still de-duplicates, so a card re-posted within a moment of the
 * first does not animate twice.
 */
export function registerAnimationHooks() {
  Hooks.on("createChatMessage", async (message) => {
    // Only the author plays their own animation, otherwise every client fires it.
    if (message.author?.id !== game.user.id) return;
    if (!getAnimationsAvailable()) return;

    try {
      const origin = message.flags?.pf2e?.origin;
      if (origin?.type !== "spell" || !origin?.uuid) return;
      // Sharing a spell to chat posts the same card. PF2e adds this roll option only
      // when the spell is actually cast, so a description posted to chat stays quiet.
      if (!origin.rollOptions?.includes(CAST_ROLL_OPTION)) return;

      const spell = await fromUuid(origin.uuid);
      if (!spell?.actor) return;
      await playSpellAnimation(spell, spell.actor);
    } catch (err) {
      console.warn("Blizzard's Wondrous Spellbook | Chat-message animation fallback failed", err);
    }
  });
}
