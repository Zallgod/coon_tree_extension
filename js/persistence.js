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
 * CT018 — Last-Known-Good Backup & Recovery Hardening
 *
 *   ct_data_lkg: Same workspace envelope format as ct_data.
 *     Holds the previous successfully-persisted state, rotated from ct_data
 *     inside saveNow() before each primary overwrite. Not a second canonical
 *     save path — it is a subordinate step within the single sanctioned pipeline.
 *
 *   ct_wal: { intent:"SAVING"|"MUTATING", ver:number, ts:ms }
 *     WAL written before primary ct_data write, cleared after write completes.
 *     On load: WAL presence signals a possible interrupted save. load() validates
 *     primary ct_data; if invalid, falls back to ct_data_lkg. If both fail,
 *     falls through to the default empty tree.
 *
 *   _validatePayload(data): Pre-deserialization structural check on the serialized
 *     workspace envelope. Separate from CT015 (which validates the deserialized
 *     live tree post-mutation inside stateManager.apply).
 *
 * Undo is stored as an in-memory stack of normalized tree snapshots (not workspace).
 */

const persistence = (() => {
  const STORAGE_KEY = "ct_data";
  const BACKUP_KEY = "ct_data_lkg";   // CT018: Last-known-good backup slot
  const WAL_KEY = "ct_wal";
  const SETTINGS_KEY = "ct_settings";
  const MAX_UNDO = 40;
  const SAVE_DEBOUNCE_MS = 1500;

  let _saveTimer = null;
  let _undoStack = [];
  let _lastSavedVersion = -1;
  let _lastSavedData = null;          // CT018: Cached previous save payload for LKG rotation
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

  // ─── CT018: Pre-deserialization structural validator ───
  // Lightweight check on the serialized workspace envelope BEFORE deserialization.
  // Separate from CT015 (_validateCanonicalTree in stateManager), which validates
  // the deserialized live tree post-mutation inside apply(REPLACE_TREE).
  // Returns true if the payload has valid envelope structure; false otherwise.
  function _validatePayload(data) {
    try {
      if (!data || typeof data !== "object") return false;
      if (!data.workspace || typeof data.workspace !== "object") return false;
      const tree = data.workspace.tree;
      if (!tree || typeof tree !== "object") return false;
      if (!tree.ent || typeof tree.ent !== "object") return false;
      if (typeof tree.root !== "string" || !tree.root) return false;
      // root must reference an existing entity
      if (!tree.ent[tree.root]) return false;
      // ent must have at least one entry (the root)
      if (Object.keys(tree.ent).length === 0) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  // ─── CT018: Attempt to restore workspace from a validated payload ───
  // Shared by primary and LKG load paths. Returns true on success, false on failure.
  // Uses the same sanctioned replaceWorkspace entrypoint as existing load logic.
  function _tryRestorePayload(data) {
    try {
      if (data.workspace && data.workspace.tree) {
        const tree = deserialize(data.workspace.tree);
        const ws = {
          id: data.workspace.id || "ws1",
          createdAt: data.workspace.createdAt || Date.now(),
          updatedAt: data.workspace.updatedAt || Date.now(),
          tree: tree,
          meta: data.workspace.meta || {}
        };
        stateManager.replaceWorkspace(ws);
        return true;
      }
      return false;
    } catch (e) {
      console.error("[persistence] CT018: _tryRestorePayload failed:", e);
      return false;
    }
  }

  // ─── Load from storage ───
  // CT018: Reads primary (ct_data), backup (ct_data_lkg), and WAL.
  // Validates primary before use. Falls back to LKG if primary is invalid
  // or if WAL indicates an interrupted save and primary fails validation.
  // If both fail, falls through to default empty tree (stateManager init state).
  async function load() {
    return new Promise(resolve => {
      chrome.storage.local.get([STORAGE_KEY, BACKUP_KEY, WAL_KEY, SETTINGS_KEY], result => {
        const walPresent = !!result[WAL_KEY];
        if (walPresent) {
          console.warn("[persistence] CT018: WAL detected — previous session may have crashed mid-save. Validating primary data.");
        }

        // CT018: Always clear WAL after reading — recovery decision is made below
        if (walPresent) {
          chrome.storage.local.remove(WAL_KEY);
        }

        _settingsCache = result[SETTINGS_KEY] || {};

        let loaded = false;

        // ─── Attempt primary ct_data ───
        if (result[STORAGE_KEY]) {
          try {
            const raw =
              typeof result[STORAGE_KEY] === "string"
                ? JSON.parse(result[STORAGE_KEY])
                : result[STORAGE_KEY];

            // CT010: Detect format and migrate if legacy
            const data = _migrateIfLegacy(raw);

            // CT018: Validate payload structure before deserializing
            if (_validatePayload(data)) {
              if (_tryRestorePayload(data)) {
                // CT016: forceReindex() removed — replaceWorkspace → replaceTree → apply(REPLACE_TREE)
                // already rebuilds indexes on success via _rebuildIndexes() inside apply().
                console.log("[persistence] Loaded workspace with", Object.keys(data.workspace.tree.ent || {}).length, "nodes");
                loaded = true;
              } else {
                console.warn("[persistence] CT018: Primary ct_data deserialized but replaceWorkspace rejected it.");
              }
            } else {
              console.warn("[persistence] CT018: Primary ct_data failed structural validation.");
            }
          } catch (e) {
            console.error("[persistence] CT018: Failed to parse primary ct_data:", e);
          }
        }

        // ─── CT018: Attempt LKG fallback if primary failed ───
        if (!loaded && result[BACKUP_KEY]) {
          console.warn("[persistence] CT018: Attempting last-known-good backup (ct_data_lkg).");
          try {
            const rawLkg =
              typeof result[BACKUP_KEY] === "string"
                ? JSON.parse(result[BACKUP_KEY])
                : result[BACKUP_KEY];

            const lkgData = _migrateIfLegacy(rawLkg);

            if (_validatePayload(lkgData)) {
              if (_tryRestorePayload(lkgData)) {
                console.log("[persistence] CT018: Restored from last-known-good backup with",
                  Object.keys(lkgData.workspace.tree.ent || {}).length, "nodes");
                loaded = true;
              } else {
                console.error("[persistence] CT018: LKG backup deserialized but replaceWorkspace rejected it.");
              }
            } else {
              console.error("[persistence] CT018: LKG backup also failed structural validation.");
            }
          } catch (e) {
            console.error("[persistence] CT018: Failed to parse LKG backup:", e);
          }
        }

        // ─── CT016: Legacy raw-tree fallback (no workspace envelope) ───
        // Only reached if primary had data but wasn't a valid workspace envelope,
        // and no LKG was available. Preserves pre-CT018 behavior for edge cases.
        if (!loaded && result[STORAGE_KEY]) {
          try {
            const raw =
              typeof result[STORAGE_KEY] === "string"
                ? JSON.parse(result[STORAGE_KEY])
                : result[STORAGE_KEY];

            // Only attempt this path if the data has some tree-like shape
            // but did not pass workspace validation (e.g., very old format)
            if (raw && (raw.children || raw.id)) {
              const tree = deserialize(raw);
              const now = Date.now();
              stateManager.replaceWorkspace({
                id: "ws1",
                createdAt: now,
                updatedAt: now,
                tree: tree,
                meta: {}
              });
              console.log("[persistence] Loaded tree (legacy fallback, wrapped) with unknown node count");
              loaded = true;
            }
          } catch (e) {
            console.error("[persistence] CT018: Legacy fallback also failed:", e);
          }
        }

        if (!loaded && (result[STORAGE_KEY] || result[BACKUP_KEY])) {
          console.error("[persistence] CT018: All recovery paths exhausted. Starting with default empty tree.");
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
  // CT018: LKG rotation and WAL bracketing are subordinate steps within this
  // single pipeline — not a second canonical save path.
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

    // CT018: Write WAL before primary write — signals save-in-progress
    chrome.storage.local.set({
      [WAL_KEY]: { intent: "SAVING", ver: ver, ts: Date.now() }
    });

    // CT018: Rotate previous saved payload to LKG backup slot.
    // _lastSavedData is populated from saveNow() itself after each successful write.
    // On first save of the session (_lastSavedData is null), skip rotation.
    if (_lastSavedData !== null) {
      chrome.storage.local.set({ [BACKUP_KEY]: _lastSavedData });
    }

    // Primary write
    chrome.storage.local.set({ [STORAGE_KEY]: data }, () => {
      // CT018: Clear WAL after primary write completes
      chrome.storage.local.remove(WAL_KEY);
    });

    // CT018: Cache this payload for next rotation
    _lastSavedData = data;
    _lastSavedVersion = ver;
  }

  // ─── WAL ───
  // CT018: External writeWAL() retains "MUTATING" intent for callers outside saveNow().
  // saveNow() writes its own WAL with intent "SAVING" directly (see above).
  function writeWAL() {
    chrome.storage.local.set({
      [WAL_KEY]: { intent: "MUTATING", ver: stateManager.getVersion(), ts: Date.now() }
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
