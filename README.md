# Blizzard's Wondrous Spellbook

A spellbook creator and slot-fill tool for the **Pathfinder Second Edition** system on **Foundry VTT v14**.

Build reusable spellbooks from your compendium spells, then send those spells straight into a
character's spellcasting slots — without replacing or reskinning the PF2e character sheet.

---

## What it does

**A spellbook is storage only.** It holds spells so they can be sent into an actor's existing
slots. Casting, and any animation that plays on cast, happen on the PF2e character sheet — not
in this module's windows.

- **Spellbook Creator** — browse every spell in every Item compendium, filtered by tradition,
  focus category and a free-text search over names and traits. Tick spells to collect them into
  a book; save the book as a Journal Entry.
- **My Spellbooks** — an ownership-filtered browser. GMs see every spellbook; players see only
  the ones they own.
- **Import from a character sheet** — read the spells a character already has and store
  them as a spellbook, either as a new book or merged into an existing one. Each spell is
  matched back to its compendium original, so the book keeps working after that character
  is gone.
- **Send to Slot** — the one write path from a spellbook to an actor. Pick a spellcasting entry
  and a rank; the spell is created as an embedded item bound to that entry, so it appears in the
  sheet's own spellcasting tab.
- **Loot Spellbooks** — roll a random, level-appropriate spellbook as treasure. The result
  is a physical PF2e item you can drop in a chest or hand to a party; whoever holds it can
  open it and learn spells straight out of it.
- **Animations (optional)** — when JB2A *and* Sequencer are both active, spell rows on the
  character sheet gain a gear button for attaching a Sequencer effect that fires when the spell
  is cast.

---

## Requirements

| | |
|---|---|
| **Foundry VTT** | v14 (verified against build 366) |
| **Game system** | Pathfinder Second Edition (verified against 8.4.1) |
| **Sequencer** | Optional |
| **JB2A** (`jb2a_patreon`, or the free `JB2A_DnD5e`) | Optional, never installed for you |

Sequencer and JB2A are **soft dependencies**. Without them the module works normally and every
animation control is simply not rendered — no warnings, no broken buttons.

JB2A is deliberately **not** declared in the manifest's `relationships`, so Foundry never offers
to install it alongside this module. If you already own the Patreon library it is used; the free
library is used only when it is the sole one installed.

---

## Installation

Paste this manifest URL into Foundry's **Add-on Modules → Install Module** dialog:

```
https://github.com/sargas79/wondrous-spellbook/releases/latest/download/module.json
```

Or clone into your Foundry `Data/modules` directory:

```bash
git clone https://github.com/sargas79/wondrous-spellbook.git blizzards-wondrous-spellbook
```

---

## Usage

1. Click the **book icon** in the scene controls toolbar on the left of the canvas to open *My Spellbooks*.
2. Hit **New** to open the Spellbook Creator.
3. Filter by tradition, toggle focus spells, or search by name or trait.
4. **Tick a spell** to add it to the book. **Click the ↓ arrow** to send that spell directly to
   the selected token's spellcasting entry — this works immediately and does not require saving.
5. Name the book and hit **Save spellbook**.

### Sending a spell to a slot

Select a token (or rely on your assigned character), then click ↓ on any spell row. The dialog
lists the actor's spellcasting entries and the ranks available on the chosen entry, with free
prepared-slot counts where applicable. Prepared entries get the spell placed into an actual
open slot; spontaneous and innate entries just receive the spell.

If the actor has no spellcasting entries, the dialog says so rather than offering an empty
dropdown.

### Importing a character's spells

*My Spellbooks* has an **Import** button, and every PF2e character sheet you own grows a
small import icon in its window header. Either opens the importer on that character.

The window lists the sheet's spells grouped by spellcasting entry, everything ticked to
start with. Untick what you don't want, tick an entry's name to take or drop the whole
entry, then either create a new book or pick an existing one from **Import into** to merge
into it. Merging appends only what the book does not already hold, so importing the same
sheet twice adds nothing the second time.

**Nothing is written to the character.** The importer only reads the sheet and writes a
Journal Entry.

An owned spell is a copy rather than a reference, so each row is matched back to its
compendium original — by source id, then slug, then name. A spell that matches nothing (a
homebrew spell that lives only on that sheet) is marked **Unlinked**: it is still importable,
but the book points at that character's own copy and stops resolving if the character is
deleted. Rituals are left out, since a spellbook exists to fill spell slots and a ritual
never occupies one. Both cases are counted in a note above the list.

Any animation you have configured on a sheet's spell rides along into the book, so sending
that spell to another character carries the effect with it.

### Rolling a spellbook as treasure

GMs get a **Roll loot** button in *My Spellbooks*. Pick a level, a tradition and a book
size; the generator rolls a spell list capped at the rank that level can hold, previews
it, and lets you swap or drop individual pages before committing.

Each rolled page shows its rarity next to its traditions, and the **All sources** button
opens a picker listing every book your compendiums provide spells from — Player Core,
Secrets of Magic, a homebrew pack — with the number of spells each contributes. Tick only
the ones your table uses and the roll draws from those alone; the choice is remembered for
the next book, and per-page rerolls stay inside the same shelf. Leaving everything ticked
means "no restriction", so a compendium installed later is picked up automatically.

**Create item** writes the book either into the `Spellbook Loot` item folder or straight
onto the selected token's actor. It is an ordinary `equipment` item — priced, rarity-tagged
and carrying a readable spell list in its description — so it drags into loot chests and
inventories like any other treasure.

Generation is seeded, and the seed is stored on the item. Re-entering a seed with the same
settings rolls the same book again. Editing a book by hand marks it as edited, because it
no longer reproduces from its seed.

### Learning from a loot spellbook

Open the item and click **Open spellbook** in its sheet header (or right-click it in the
Items directory). Each spell has a **Learn** button, which opens the same *Send to Slot*
dialog the Spellbook Creator uses — so learning goes through one write path with all its
prepared-slot and heightening handling intact.

The reader learns as the actor carrying the book, falling back to the selected token or
assigned character. Who learned what is recorded on the book, so a shared grimoire
remembers which characters have already copied a spell out of it.

### Attaching an animation

With JB2A and Sequencer both active, each spell row on the PF2e character sheet grows a small
gear button. Click it, enter a Sequencer database path (the field autocompletes against the
Sequencer database, and there's a button to open the Database Viewer), and save. The effect
plays on the caster's token when that spell is cast from the sheet.

The path is stored as a flag on the actor's spell item. If JB2A or Sequencer is later disabled,
**the flag is preserved** — the editing controls just disappear and playback is skipped
silently until both modules are active again.

---

## Permissions

Spellbooks are created with **ownership default NONE**, **OWNER for the creator**, and
**OWNER for every GM**, so any GM can always reach any spellbook regardless of who made it.

Players see only spellbooks they own, tested via `testUserPermission(user, "OWNER")` rather
than by comparing creator ids — so ownership granted after the fact is respected. Edit and
delete controls are disabled per-row for anyone without OWNER on that entry.

---

## Settings

| Setting | Scope | Default | Description |
|---|---|---|---|
| Character Sheet Integration | World | On | Inject the animation gear button into PF2e spell rows |
| Show Toolbar Button | Client | On | Add the spellbook button to the scene controls toolbar |
| Spellbook Folder Name | World | `Blizzard's Spellbooks` | Journal folder that stores every spellbook |
| Loot Spellbook Folder Name | World | `Spellbook Loot` | Item folder that stores generated loot spellbooks |
| Default Loot Book Size | World | Grimoire | Book shape the loot generator starts on |
| Loot Rarity Ceiling | World | Common | Rarest spell a generated book may contain |
| Track Learned Spells | World | On | Record which characters copied each spell out of a book |
| Spend Pages On Learning | World | Off | A learned page is spent for that character only; the book survives |

---

## API

The module exposes an API on its module entry and as a global:

```js
const api = game.modules.get("blizzards-wondrous-spellbook").api;

api.openCreator();                          // open a blank Spellbook Creator
api.openBrowser();                          // open My Spellbooks
api.sendToSlot({ uuid: "Compendium....." }); // open the Send to Slot dialog
api.getUserSpellbooks();                    // JournalEntry[] the current user may see
api.getAnimationsAvailable();               // boolean, re-evaluated live

api.openImport();                           // open the character sheet importer
api.openImport({ actor });                  // ...on a particular actor
api.collectActorSpells(actor);              // -> { groups, total, unlinked, rituals }
api.importIntoSpellbook({ spells, name });  // write records to a new or existing book

api.listSpellSources();                     // [{ key, label, count }] of every source
api.openLootGenerator();                    // open the loot roller (GM)
api.generateLootSpellbook({ level: 7 });    // headless roll -> { spells, meta, name }
api.createLootSpellbook({ name, spells, meta, actors: [] }); // write it as an Item
api.openLootBook(item);                     // open a rolled book's reader
api.isLootSpellbook(item);                  // boolean
```

`generateLootSpellbook` also takes `sources: [...]` — the same source keys the picker
writes — to restrict a headless roll to particular books.

`generateLootSpellbook` writes nothing, so it can be driven from a RollTable macro:

```js
const api = game.modules.get("blizzards-wondrous-spellbook").api;
const roll = await api.generateLootSpellbook({ level: 12, tradition: "occult" });
await api.createLootSpellbook({ ...roll, actors: [game.actors.getName("Treasure Chest")] });
```

---

## Project structure

```
module.json                      Manifest (Foundry v14, PF2e system relationship)
lang/en.json                     All UI strings
styles/spellbook.css             Nocturne-flavoured dark theme, scoped to .bws
scripts/
  constants.js                   Shared ids, settings keys, template path helper
  main.js                        init/ready hooks, settings, scene control button
  spell-query.js                 Compendium query, filtering, rank grouping
  persistence.js                 Folder + JournalEntry writes, ownership rules
  spellbook-app.js               Spellbook Creator (ApplicationV2)
  my-spellbooks-app.js           My Spellbooks browser (ApplicationV2)
  slot-manager.js                Send to Slot dialog, character sheet injection
  import-spells.js               Sheet reading, compendium matching, book merging
  import-app.js                  Import from Character Sheet (ApplicationV2)
  loot-generator.js              Seeded random book rolling, pricing, Item creation
  loot-generator-app.js          Loot Spellbook Generator (GM, ApplicationV2)
  loot-book-app.js               Loot book reader, learn flow, item sheet injection
  animation-config.js            JB2A/Sequencer detection, config dialog, cast hooks
templates/                       Handlebars templates for the above
```

---

## Notes on PF2e compatibility

PF2e renamed spell "level" to "rank" in its interface, but the stored source data still lives at
`system.level.value`. Every accessor in `spell-query.js` reads the document getter first and falls
back to raw source paths, so the module tolerates data-model changes across PF2e releases.

Similarly, `slot-manager.js` prefers PF2e's own `SpellcastingEntryPF2e#addSpell` and
`#prepareSpell` helpers and only falls back to a manual `Item.create` + `system.location` write
if those are unavailable.

The importer reads a sheet spell's origin from `_stats.compendiumSource` and from the older
`flags.core.sourceId`, and falls back to matching on PF2e's `system.slug` and then on the
spell name, so a spell keeps its compendium link across both Foundry's move of that field and
a compendium being renamed or replaced.

The spell-cast signal has moved between PF2e releases. The module listens on `pf2e.castSpell`
and additionally on `createChatMessage` (reading the cast card's origin flags) as a
version-tolerant fallback, de-duplicating so a single cast animates once.

---

## License

See [LICENSE](LICENSE).
