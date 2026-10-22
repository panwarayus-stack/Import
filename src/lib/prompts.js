'use strict';

const fs = require('node:fs');
const path = require('node:path');

const cache = new Map();

function loadPrompt(name, templatesDir) {
  const file = path.join(templatesDir, 'prompts', `${name}.md`);
  if (cache.has(file)) return cache.get(file);
  const text = fs.readFileSync(file, 'utf8');
  cache.set(file, text);
  return text;
}

/** Replace {{PLACEHOLDER}} tokens; unknown placeholders become empty strings. */
function render(template, values = {}) {
  return String(template).replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function getPrompt(name, values, templatesDir) {
  return render(loadPrompt(name, templatesDir), values);
}

function clearPromptCache() {
  cache.clear();
}

module.exports = { getPrompt, render, loadPrompt, clearPromptCache };
