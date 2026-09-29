/**
 * Blizzard's Wondrous Spellbook - module entry point.
 *
 * Registers settings and hooks at `init`, then wires up the scene control button, the PF2e
 * character sheet integration and the spell-cast animation listeners at `ready`.
 */

import { MODULE_ID, SETTINGS, DEFAULT_FOLDER_NAME, DEFAULT_LOOT_FOLDER_NAME } from "./constants.js";

/** Name of the scene control tool that opens the spellbook browser. */
const TOOL_NAME = "bws-spellbook";
import { SpellbookApp } from "./spellbook-app.js";
import { MySpellbooksApp, registerBrowserRefreshHooks } from "./my-spellbooks-app.js";
import { injectSheetControls, openSendToSlotDialog, resolveTargetActor } from "./slot-manager.js";
import { getAnimationsAvailable, registerAnimationHooks } from "./animation-config.js";
import { invalidateSpellCache, listSpellSources, querySpells } from "./spell-query.js";
import { LootGeneratorApp } from "./loot-generator-app.js";
import { ImportApp, addImportHeaderButton, injectImportButton, openImport } from "./import-app.js";
import {
  addLootBookHeaderButton,
  injectLootBookButton,
  openLootBook,
  registerLootBookContextMenu
} from "./loot-book-app.js";
import { FormulaBookApp, openFormulaBook } from "./formula-book-app.js";
import * as loot from "./loot-generator.js";
import * as importer from "./import-spells.js";
import * as formulas from "./formula-query.js";
import * as persistence from "./persistence.js";

/**
 * Register this module's world settings.
 * @returns {void}
 */
function registerSettings() {
  game.settings.register(MODULE_ID, SETTINGS.SHEET_INTEGRATION, {
    name: "BWS.Settings.SheetIntegration.Name",
    hint: "BWS.Settings.SheetIntegration.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.SIDEBAR_BUTTON, {
    name: "BWS.Settings.SidebarButton.Name",
    hint: "BWS.Settings.SidebarButton.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => ui.controls?.render()
  });

  game.settings.register(MODULE_ID, SETTINGS.FOLDER_NAME, {
    name: "BWS.Settings.FolderName.Name",
    hint: "BWS.Settings.FolderName.Hint",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_FOLDER_NAME
  });

  game.settings.register(MODULE_ID, SETTINGS.LOOT_FOLDER_NAME, {
    name: "BWS.Settings.LootFolderName.Name",
    hint: "BWS.Settings.LootFolderName.Hint",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_LOOT_FOLDER_NAME
  });

  game.settings.register(MODULE_ID, SETTINGS.LOOT_PROFILE, {
    name: "BWS.Settings.LootProfile.Name",
    hint: "BWS.Settings.LootProfile.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      traveler: "BWS.Loot.Profile.traveler",
      grimoire: "BWS.Loot.Profile.grimoire",
      archmage: "BWS.Loot.Profile.archmage"
    },
    default: "grimoire"
  });

  game.settings.register(MODULE_ID, SETTINGS.LOOT_MAX_RARITY, {
    name: "BWS.Settings.LootMaxRarity.Name",
    hint: "BWS.Settings.LootMaxRarity.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      common: "BWS.Loot.Rarity.common",
      uncommon: "BWS.Loot.Rarity.uncommon",
      rare: "BWS.Loot.Rarity.rare"
    },
    default: "common"
  });

  // Hidden: the source list is edited through the loot generator's own picker, which
  // knows which compendiums the world actually has. Stored so the choice sticks.
  game.settings.register(MODULE_ID, SETTINGS.LOOT_SOURCES, {
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  game.settings.register(MODULE_ID, SETTINGS.TRACK_LEARNED, {
    name: "BWS.Settings.TrackLearned.Name",
    hint: "BWS.Settings.TrackLearned.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.CONSUME_ON_LEARN, {
    name: "BWS.Settings.ConsumeOnLearn.Name",
    hint: "BWS.Settings.ConsumeOnLearn.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
}

/**
 * Add the spellbook button to the scene controls toolbar.
 *
 * The tool is appended to the journal notes control group so it sits with the
 * other left-hand map tools, falling back to the token group when a build does
 * not expose a notes group. Both the v13 record shape and the older array shape
 * of the hook payload are handled so the button survives Foundry version
 * differences.
 *
 * @param {object|Array} controls The scene control definitions being assembled.
 * @returns {void}
 */
function injectSceneControlButton(controls) {
  // Controls can be built before this module's settings exist in a partially
  // initialised world; treat a missing setting as "enabled".
  try {
    if (!game.settings.get(MODULE_ID, SETTINGS.SIDEBAR_BUTTON)) return;
  } catch {
    /* settings not registered yet - fall through and render the button */
  }

  const open = () => MySpellbooksApp.open();
  const tool = {
    name: TOOL_NAME,
    title: "BWS.ModuleTitle",
    icon: "fa-solid fa-book-open",
    visible: true,
    button: true,
    order: 100,
    // v13+ dispatches a button tool through `onChange`. `onClick` is deprecated there,
    // and core calls it as well as `onChange`, so setting both opened the window twice.
    onChange: open
  };

  const group = Array.isArray(controls)
    ? controls.find((c) => c.name === "notes") ?? controls.find((c) => c.name === "token")
    : controls?.notes ?? controls?.tokens ?? controls?.token;
  if (!group?.tools) return;

  if (Array.isArray(group.tools)) {
    if (!group.tools.some((t) => t.name === TOOL_NAME)) group.tools.push(tool);
  } else {
    group.tools[TOOL_NAME] ??= tool;
  }
}

Hooks.once("init", () => {
  registerSettings();

  // Public surface for macros and other modules.
  const api = {
    SpellbookApp,
    MySpellbooksApp,
    openCreator: (options = {}) => SpellbookApp.open(options),
    openBrowser: () => MySpellbooksApp.open(),
    sendToSlot: openSendToSlotDialog,
    resolveTargetActor,
    getAnimationsAvailable,
    querySpells,
    listSpellSources,
    invalidateSpellCache,
    LootGeneratorApp,
    openLootGenerator: (options = {}) => LootGeneratorApp.open(options),
    openLootBook,
    ImportApp,
    openImport,
    FormulaBookApp,
    openFormulaBook,
    ...importer,
    ...formulas,
    ...loot,
    ...persistence
  };

  game.modules.get(MODULE_ID).api = api;
  globalThis.BlizzardsWondrousSpellbook = api;
});

Hooks.once("ready", () => {
  if (game.system.id !== "pf2e") {
    ui.notifications.error(
      "Blizzard's Wondrous Spellbook requires the Pathfinder Second Edition system."
    );
    return;
  }

  registerAnimationHooks();
  registerBrowserRefreshHooks();
  registerLootBookContextMenu();

  // The spell cache is built from compendium contents, so drop it when a pack changes.
  for (const hook of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(hook, (item) => {
      if (item.pack && item.type === "spell") invalidateSpellCache();
    });
  }

  console.log(`${MODULE_ID} | Ready`);
});

Hooks.on("getSceneControlButtons", injectSceneControlButton);

/**
 * Run a sheet integration without letting its failure reach the sheet's own render.
 * @param {string} what Short description for the console.
 * @param {() => void} fn The integration.
 * @returns {void}
 */
function guarded(what, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`${MODULE_ID} | ${what} failed`, err);
  }
}

// PF2e 8.x sheets are Application V1, whose header buttons are assembled through a
// `get<Class>HeaderButtons` hook fired for every class in the sheet's inheritance chain.
// The PF2e class names are used so each hook fires once per sheet: `ItemSheetPF2e` for
// every PF2e item sheet, `CharacterSheetPF2e` for characters only.
Hooks.on("getItemSheetPF2eHeaderButtons", (app, buttons) =>
  guarded("Loot spellbook header button", () => addLootBookHeaderButton(app, buttons))
);
Hooks.on("getCharacterSheetPF2eHeaderButtons", (app, buttons) =>
  guarded("Import header button", () => addImportHeaderButton(app, buttons))
);

// Application V2 fallbacks, for a PF2e release that moves these sheets to V2. Both
// helpers return immediately for a V1 sheet, which the hooks above already served.
Hooks.on("renderItemSheetPF2e", (app, html) =>
  guarded("Loot spellbook sheet integration", () => injectLootBookButton(app, html))
);

// PF2e's character sheet render hook. Availability of JB2A/Sequencer is re-checked
// inside the handler on every render, so toggling either module mid-session takes
// effect without a reload. The setting gates the animation controls only: the import
// button is not part of that integration and must not vanish with it.
Hooks.on("renderCharacterSheetPF2e", (app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (game.settings.get(MODULE_ID, SETTINGS.SHEET_INTEGRATION)) {
    guarded("Character sheet animation controls", () => injectSheetControls(app, root));
  }
  guarded("Import button injection", () => injectImportButton(app, root));
});
