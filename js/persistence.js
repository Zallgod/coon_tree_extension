"use strict";

/*
 * persistence.js — Coon Tree Persistence Engine
 *
 * CT010 — Workspace-level persistence
 *
 * Storage format (normalized, workspace envelope):
 *   ct_data: {
 *     workspace: {
 *       id: string,
 *       createdAt: number,
 *       updatedAt: number,
 *       tree: { ent:{id→flat_node}, ord:{id→[childIds]}, root:id },
 *       meta: {}
 *     },
 *     ver: number
 *   }
 *
 * Legacy format (auto-migrated on load):
 *   ct_data: { ent:{id→flat_node}, ord:{id→[childIds]}, root:id, ver:number }
 *
 * Crash recovery via Write-Ahead Log:
 *   ct_wal: { intent:"MUTATING", timestamp:ms }
 *   If ct_wal exists on load, we know a crash occurred mid-mutation.
 *   The stored ct_data is the last known-good state (written before mutation started).
 *
 * Undo is stored as an in-memory stack of normalized tree snapshots (not workspace).
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
    return { ent, ord, root: tree.id };
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

  // ─── CT010: Detect and migrate legacy format ───
  function _migrateIfLegacy(data) {
    // New format: has workspace envelope
    if (data.workspace && data.workspace.tree) {
      return data;
    }
    // Legacy format: top-level ent/ord/root — wrap into workspace
    if (data.ent) {
      const now = Date.now();
      console.log("[persistence] CT010: Migrating legacy tree format to workspace envelope");
      return {
        workspace: {
          id: "ws1",
          createdAt: now,
          updatedAt: now,
          tree: { ent: data.ent, ord: data.ord, root: data.root },
          meta: {}
        },
        ver: data.ver || 0
      };
    }
    // Unknown format — return as-is, let downstream handle failure
    return data;
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
            const raw =
              typeof result[STORAGE_KEY] === "string"
                ? JSON.parse(result[STORAGE_KEY])
                : result[STORAGE_KEY];

            // CT010: Detect format and migrate if legacy
            const data = _migrateIfLegacy(raw);

            if (data.workspace && data.workspace.tree) {
              // New workspace format
              const tree = deserialize(data.workspace.tree);
              const ws = {
                id: data.workspace.id || "ws1",
                createdAt: data.workspace.createdAt || Date.now(),
                updatedAt: data.workspace.updatedAt || Date.now(),
                tree: tree,
                meta: data.workspace.meta || {}
              };
              stateManager.replaceWorkspace(ws);
              // CT016: forceReindex() removed — replaceWorkspace → replaceTree → apply(REPLACE_TREE)
              // already rebuilds indexes on success via _rebuildIndexes() inside apply().
              console.log("[persistence] Loaded workspace with", Object.keys(data.workspace.tree.ent || {}).length, "nodes");
            } else {
              // CT016: Fallback — wrap raw tree into workspace envelope and use
              // the same sanctioned replaceWorkspace entrypoint as the primary path.
              const tree = deserialize(raw);
              const now = Date.now();
              stateManager.replaceWorkspace({
                id: "ws1",
                createdAt: now,
                updatedAt: now,
                tree: tree,
                meta: {}
              });
              console.log("[persistence] Loaded tree (fallback, wrapped) with unknown node count");
            }
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

  // ─── CT016: saveNow() is THE single sanctioned canonical save entry ───
  // All persisted workspace/tree writes to chrome.storage.local flow through here.
  // Data is sourced exclusively from stateManager canonical state.
  // No other function may write canonical workspace/tree data to storage.
  function saveNow() {
    const ver = stateManager.getVersion();
    if (ver === _lastSavedVersion) return;
    // CT010: Save full workspace envelope
    const ws = stateManager.getWorkspace();
    const treeData = serialize(stateManager.getTree());
    const data = {
      workspace: {
        id: ws.id,
        createdAt: ws.createdAt,
        updatedAt: ws.updatedAt,
        tree: treeData,
        meta: ws.meta
      },
      ver: ver
    };
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

  // ─── Undo (tree-only snapshots, ephemeral) ───
  function pushUndo() {
    const treeData = serialize(stateManager.getTree());
    treeData.ver = stateManager.getVersion();
    _undoStack.push(treeData);
    if (_undoStack.length > MAX_UNDO) _undoStack.shift();
  }

  function popUndo() {
    if (!_undoStack.length) return false;
    const snapshot = _undoStack.pop();
    const tree = deserialize(snapshot);
    stateManager.replaceTree(tree);
    // CT016: forceReindex() removed — replaceTree → apply(REPLACE_TREE)
    // already rebuilds indexes on success via _rebuildIndexes() inside apply().
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
