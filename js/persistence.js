"use strict";

/*
 * persistence.js — Coon Tree Persistence Engine
 *
 * Storage format (normalized, no nested children):
 *   ct_data: { ent:{id→flat_node}, ord:{id→[childIds]}, root:id, ver:number }
 *
 * Crash recovery via Write-Ahead Log:
 *   ct_wal: { intent:"MUTATING", timestamp:ms }
 *   If ct_wal exists on load, we know a crash occurred mid-mutation.
 *   The stored ct_data is the last known-good state (written before mutation started).
 *
 * Undo is stored as an in-memory stack of normalized snapshots.
 */

const persistence = (() => {
  const STORAGE_KEY = "ct_data";
  const WAL_KEY = "ct_wal";
  const SETTINGS_KEY = "ct_settings";
  const MAX_UNDO = 40;
  const SAVE_DEBOUNCE_MS = 1500;

  let _saveTimer = null;
  let _undoStack = [];
  let _lastSavedVersion = -1;
  let _settingsCache = {};

  // ─── Serialize tree to normalized format ───
  function serialize(tree) {
    const ent = {}, ord = {};
    const stk = [tree];
    while (stk.length) {
      const cur = stk.pop();
      const { children, ...flat } = cur;
      ent[cur.id] = flat;
      ord[cur.id] = (children || []).map(c => c.id);
      if (children) {
        for (let i = children.length - 1; i >= 0; i--) stk.push(children[i]);
      }
    }
    return { ent, ord, root: tree.id, ver: stateManager.getVersion() };
  }

  // ─── Deserialize normalized format to tree ───
  function deserialize(data) {
    const { ent, ord, root } = data;
    const nodes = new Map();
    const ids = Object.keys(ent || {});

    for (let i = 0; i < ids.length; i++) {
      nodes.set(ids[i], { ...ent[ids[i]], children: [] });
    }

    for (let i = 0; i < ids.length; i++) {
      const n = nodes.get(ids[i]);
      const childIds = (ord && ord[ids[i]]) || [];
      for (let j = 0; j < childIds.length; j++) {
        const child = nodes.get(childIds[j]);
        if (child) n.children.push(child);
      }
    }

    return nodes.get(root) || {
      id: "root",
      kind: "root",
      title: "Coon Tree",
      children: [],
      collapsed: false
    };
  }

  // ─── Load from storage ───
  async function load() {
    return new Promise(resolve => {
      chrome.storage.local.get([STORAGE_KEY, WAL_KEY, SETTINGS_KEY], result => {
        if (result[WAL_KEY]) {
          console.warn("[persistence] WAL detected — previous session may have crashed mid-mutation. Using last saved state.");
          chrome.storage.local.remove(WAL_KEY);
        }

        _settingsCache = result[SETTINGS_KEY] || {};

        if (result[STORAGE_KEY]) {
          try {
            const data =
              typeof result[STORAGE_KEY] === "string"
                ? JSON.parse(result[STORAGE_KEY])
                : result[STORAGE_KEY];

            const tree = deserialize(data);
            stateManager.replaceTree(tree);
            stateManager.forceReindex();
            console.log("[persistence] Loaded tree with", Object.keys(data.ent || {}).length, "nodes");
          } catch (e) {
            console.error("[persistence] Failed to load tree:", e);
          }
        }

        resolve();
      });
    });
  }

  // ─── Save to storage (debounced) ───
  function scheduleSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  function saveNow() {
    const ver = stateManager.getVersion();
    if (ver === _lastSavedVersion) return;
    const data = serialize(stateManager.getTree());
    chrome.storage.local.set({ [STORAGE_KEY]: data });
    _lastSavedVersion = ver;
  }

  // ─── WAL ───
  function writeWAL() {
    chrome.storage.local.set({
      [WAL_KEY]: { intent: "MUTATING", ts: Date.now() }
    });
  }

  function clearWAL() {
    chrome.storage.local.remove(WAL_KEY);
  }

  // ─── Undo ───
  function pushUndo() {
    _undoStack.push(serialize(stateManager.getTree()));
    if (_undoStack.length > MAX_UNDO) _undoStack.shift();
  }

  function popUndo() {
    if (!_undoStack.length) return false;
    const snapshot = _undoStack.pop();
    const tree = deserialize(snapshot);
    stateManager.replaceTree(tree);
    stateManager.forceReindex();
    return true;
  }

  function hasUndo() {
    return _undoStack.length > 0;
  }

  // ─── Settings ───
  async function loadSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get(SETTINGS_KEY, result => {
        _settingsCache = result[SETTINGS_KEY] || {};
        resolve(_settingsCache);
      });
    });
  }

  function getSettings() {
    return _settingsCache || {};
  }

  function saveSettings(settings) {
    _settingsCache = settings || {};
    chrome.storage.local.set({ [SETTINGS_KEY]: _settingsCache });
  }

  // ─── Export / Import ───
  function exportTree() {
    const tree = stateManager.cloneAsKept("root") || stateManager.getTree();
    const stk = [tree];
    while (stk.length) {
      const cur = stk.pop();
      delete cur.chromeId;
      if (cur.children) {
        for (let i = cur.children.length - 1; i >= 0; i--) stk.push(cur.children[i]);
      }
    }
    return { tree, exportDate: Date.now(), exportVersion: 7 };
  }

  function prepareImport(data) {
    if (data.tree) {
      stateManager.assignFreshIds(data.tree);
      return data.tree;
    }
    if (data.children) {
      stateManager.assignFreshIds(data);
      return data;
    }
    return null;
  }

  return {
    load,
    scheduleSave,
    saveNow,
    writeWAL,
    clearWAL,
    pushUndo,
    popUndo,
    hasUndo,
    loadSettings,
    getSettings,
    saveSettings,
    exportTree,
    prepareImport,
    serialize,
    deserialize
  };
})();