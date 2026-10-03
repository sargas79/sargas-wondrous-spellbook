/**
 * Language file checks, run in CI.
 *
 * Foundry expands every language file with `foundry.utils.expandObject` before using it.
 * A key that is both a string and the parent of other keys (`A.B` next to `A.B.C`)
 * makes that expansion throw, and core then drops the whole file: every label in the
 * module renders as its raw key. This script fails on that, and on literal keys the
 * code uses that the file does not define.
 *
 * Usage: node tools/check-lang.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const LANG = "lang/en.json";
const SOURCES = ["scripts", "templates"];

const lang = JSON.parse(readFileSync(LANG, "utf8"));
const keys = Object.keys(lang);
const problems = [];

// 1. A leaf that is also a parent cannot be expanded.
const keySet = new Set(keys);
for (const key of keys) {
  const parts = key.split(".");
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join(".");
    if (keySet.has(parent)) problems.push(`"${parent}" is a string and also the parent of "${key}"`);
  }
}

// 2. Every literal key in the code must exist. Keys built at runtime from a template
// literal (`SWS.Kind.${kind}`) are not literals and are not checked here.
const files = SOURCES.flatMap((dir) =>
  readdirSync(dir, { recursive: true })
    .filter((name) => /\.(js|hbs)$/.test(name))
    .map((name) => join(dir, name))
);
const literal = /["'](SWS\.[A-Za-z0-9_.]+?)["']/g;
for (const file of files) {
  for (const [, key] of readFileSync(file, "utf8").matchAll(literal)) {
    if (!(key in lang)) problems.push(`${file}: "${key}" is not defined in ${LANG}`);
  }
}

if (problems.length) {
  console.error([...new Set(problems)].join("\n"));
  process.exit(1);
}
console.log(`${LANG}: ${keys.length} keys, all literal keys defined, no leaf/parent conflicts.`);
