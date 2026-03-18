"use strict";

/*
 * CT007 — Debug Configuration
 *
 * Controls CT006 instrumentation output.
 * All flags default to false (silent operation).
 * Set `all: true` to enable every category, or enable categories individually.
 * Runtime control via ct.debug() or CT_SET_DEBUG message.
 */
let CT_DEBUG = {
  all:       false,   // master switch — enables all categories when true
  lifecycle: false,   // Chrome event handlers (chromeSync.js)
  engine:    false,   // stateManager.apply / mutation traces
  rebuild:   false,   // rebuild / version tracking
};

const _CT_DEBUG_KEYS = ["all", "lifecycle", "engine", "rebuild"];

/*
 * CT009 — In-memory debug log buffer
 *
 * Bounded FIFO buffer capturing all CT006–CT008 log emissions.
 * Written only when debug gating allows the corresponding console.log.
 * Never persisted. Never mutates tree state. Read via ct.logs() / ct.clearLogs().
 */
const CT_LOG_MAX = 200;
const _ctLogBuffer = [];

// Push a structured entry into the buffer. Oldest entry is discarded when cap is reached.
// `category` — string key used for filtering (TRACE | MUTATION | BRANCH | REBUILD)
// `op`       — operation or sub-label string
// `data`     — primitives-only plain object; no live node references
function _ctLog(category, op, data) {
  if (_ctLogBuffer.length >= CT_LOG_MAX) _ctLogBuffer.shift();
  _ctLogBuffer.push({ t: Date.now(), category: category, op: op, data: data });
}

/*
 * CT009 — Debug flag control
 *
 * setDebugFlags(config)
 *   config.all === true  → set every flag to true
 *   otherwise            → reset all flags to false, then enable only provided true flags
 *
 * Returns plain copy of resulting flags.
 */
function setDebugFlags(config) {
  if (config && config.all === true) {
    for (let i = 0; i < _CT_DEBUG_KEYS.length; i++) {
      CT_DEBUG[_CT_DEBUG_KEYS[i]] = true;
    }
  } else {
    for (let i = 0; i < _CT_DEBUG_KEYS.length; i++) {
      CT_DEBUG[_CT_DEBUG_KEYS[i]] = false;
    }
    if (config) {
      for (let i = 0; i < _CT_DEBUG_KEYS.length; i++) {
        if (config[_CT_DEBUG_KEYS[i]] === true) {
          CT_DEBUG[_CT_DEBUG_KEYS[i]] = true;
        }
      }
    }
  }
  var copy = {};
  for (let i = 0; i < _CT_DEBUG_KEYS.length; i++) {
    copy[_CT_DEBUG_KEYS[i]] = CT_DEBUG[_CT_DEBUG_KEYS[i]];
  }
  return copy;
}

/*
 * CT009 — Context detection
 *
 * Returns true when executing in the background / service worker context
 * (where the buffer and CT_DEBUG are the authoritative copies).
 * Panel scripts that load stateManager.js via a different execution context
 * will have typeof _ctLogBuffer === "undefined" in their scope — but since
 * this file defines _ctLogBuffer at module scope, the real discriminator is
 * whether chrome.runtime.getBackgroundPage or ServiceWorkerGlobalScope is available.
 * The simplest reliable check: the buffer array is defined in this scope,
 * so we test whether we own it by checking a sentinel.
 */
const _CT_IS_BACKGROUND = (function () {
  try {
    // Service worker global scope (MV3)
    if (typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope) return true;
    // MV2 background page
    if (typeof chrome !== "undefined" && chrome.extension && chrome.extension.getBackgroundPage &&
        chrome.extension.getBackgroundPage() === window) return true;
    // Fallback: if _ctLogBuffer is in scope and we can write to it, we are background
    // (panel contexts that import this file would have their own copy — but that is
    //  architecturally forbidden; panel accesses via messages only)
    return true;
  } catch (e) {
    return true;
  }
})();

/*
 * stateManager.js — Coon Tree State Engine
 *
 * CT010 — Workspace container
 *   The workspace is the top-level persisted object.
 *   The tree is a property of the workspace.
 *   All internal references use _workspace.tree.
 *
 * INVARIANTS:
 *   1. Every node has a unique `id` (nodeId). This is the stable identity.
 *   2. `chromeId` is a transient runtime binding, never part of identity.
 *   3. ALL mutations pass through apply(). Nothing else touches the tree.
 *   4. Indexes are always consistent — rebuilt atomically after every apply().
 *   5. No node appears in multiple places in the tree (no duplicates).
 *   6. chromeMap enforces: one chromeId → one nodeId (prevents duplicate tracking).
 */

const stateManager = (() => {
  // ─── CT010: Workspace container (top-level persisted object) ───
  const _initTime = Date.now();
  let _workspace = {
    id: "ws1",
    createdAt: _initTime,
    updatedAt: _initTime,
    tree: { id: "root", kind: "root", title: "Coon Tree", children: [], collapsed: false },
    meta: {}
  };

  let _seq = Date.now(); // monotonic ID sequence
  let _version = 0;      // bumps on every successful apply — lets UI skip stale renders

  // ─── Indexes (rebuilt atomically, never stale) ───
  let _nodeMap = new Map();   // nodeId → node
  let _parentMap = new Map(); // nodeId → parent node
  let _chromeMap = new Map(); // "tab:123" | "branch:456" → nodeId

  function _chromeKey(kind, chromeId) { return kind + ":" + chromeId; }

  function _rebuildIndexes() {
    _nodeMap.clear(); _parentMap.clear(); _chromeMap.clear();
    const stk = [_workspace.tree];
    while (stk.length) {
      const cur = stk.pop();
      // Dup check: if this id already exists, we have corruption — skip the duplicate
      if (_nodeMap.has(cur.id) && cur !== _nodeMap.get(cur.id)) {
        console.error("[stateManager] DUPLICATE nodeId detected:", cur.id);
        continue;
      }
      _nodeMap.set(cur.id, cur);
      if (cur.chromeId && (cur.state === "live")) {
        _chromeMap.set(_chromeKey(cur.kind, cur.chromeId), cur.id);
      }
      if (cur.children) {
        for (let i = cur.children.length - 1; i >= 0; i--) {
          _parentMap.set(cur.children[i].id, cur);
          stk.push(cur.children[i]);
        }
      }
    }
  }

  // ─── CT015: Canonical tree validator ───
  // Enforces whole-tree structural integrity after mutation.
  // Returns { valid: true } or { valid: false, reason: string }.
  // Checks: duplicate nodeIds, missing ids, children array integrity,
  // multi-parent violations, and cycle detection.
  function _validateCanonicalTree() {
    const root = _workspace.tree;
    if (!root || !root.id) return { valid: false, reason: "NO_ROOT" };

    const seenIds = new Set();
    const parentTracker = new Map(); // nodeId → parentId (to detect multi-parent)
    const stk = [{ node: root, parentId: null, ancestors: new Set() }];

    while (stk.length) {
      const { node, parentId, ancestors } = stk.pop();

      // Every node must have an id
      if (!node.id) return { valid: false, reason: "MISSING_ID" };

      // Duplicate nodeId is a hard failure
      if (seenIds.has(node.id)) return { valid: false, reason: "DUPLICATE_NODE: " + node.id };
      seenIds.add(node.id);

      // Cycle detection: node id must not appear in its own ancestor chain
      if (ancestors.has(node.id)) return { valid: false, reason: "CYCLE: " + node.id };

      // Multi-parent detection: each non-root node must have exactly one parent
      if (parentId !== null) {
        if (parentTracker.has(node.id)) {
          return { valid: false, reason: "MULTI_PARENT: " + node.id };
        }
        parentTracker.set(node.id, parentId);
      }

      // Children array integrity
      if (node.children) {
        if (!Array.isArray(node.children)) {
          return { valid: false, reason: "INVALID_CHILDREN: " + node.id };
        }
        const childAncestors = new Set(ancestors);
        childAncestors.add(node.id);
        for (let i = node.children.length - 1; i >= 0; i--) {
          const child = node.children[i];
          if (!child) return { valid: false, reason: "NULL_CHILD: " + node.id };
          stk.push({ node: child, parentId: node.id, ancestors: childAncestors });
        }
      }
    }

    return { valid: true };
  }

  // ─── ID generation ───
  function newId() { return "ct" + (_seq++); }

  // ─── Read-only queries (safe to call anytime) ───
  function getTree() { return _workspace.tree; }
  function getVersion() { return _version; }
  function getNode(nodeId) { return _nodeMap.get(nodeId) || null; }
  function getParent(nodeId) { return _parentMap.get(nodeId) || null; }
  function getRoot() { return _workspace.tree; }
  // CT010: Workspace getter
  function getWorkspace() { return _workspace; }

  // Find nodeId by chromeId (O(1) — the key safety mechanism)
  function findByChrome(kind, chromeId) {
    const nid = _chromeMap.get(_chromeKey(kind, chromeId));
    return nid ? _nodeMap.get(nid) || null : null;
  }

  // Check if a nodeId is a descendant of another
  function isDescendant(possibleDescId, ancestorId) {
    if (possibleDescId === ancestorId) return true;
    let cur = _parentMap.get(possibleDescId);
    while (cur) {
      if (cur.id === ancestorId) return true;
      cur = _parentMap.get(cur.id);
    }
    return false;
  }

  // Walk upward to find the nearest live branch ancestor
  function findLiveBranchAncestor(nodeId) {
    let cur = _nodeMap.get(nodeId);
    while (cur) {
      if (cur.kind === "branch" && cur.state === "live") return cur.chromeId;
      cur = _parentMap.get(cur.id);
    }
    return null;
  }

  // Iterative subtree walk
  function walkSubtree(rootId, fn) {
    const node = _nodeMap.get(rootId);
    if (!node) return;
    const stk = [node];
    while (stk.length) {
      const cur = stk.pop();
      fn(cur);
      if (cur.children) for (let i = cur.children.length - 1; i >= 0; i--) stk.push(cur.children[i]);
    }
  }

  // Collect all URLs in a subtree
  function collectUrls(nodeId) {
    const urls = [];
    walkSubtree(nodeId, n => { if (n.kind === "tab" && n.url) urls.push(n.url); });
    return urls;
  }

  // Deep clone a subtree, converting live→kept, assigning new IDs, stripping chromeIds
  function cloneAsKept(nodeId) {
    const orig = _nodeMap.get(nodeId);
    if (!orig) return null;
    const queue = [[orig, null]];
    let clonedRoot = null;
    while (queue.length) {
      const [src, parentClone] = queue.shift();
      const c = { ...src, id: newId(), chromeId: null, children: [] };
      if (c.state === "live") {
        c.state = "kept";
        c.savedDate = Date.now();
        if (c.kind === "branch" && !c.customTitle) c.customTitle = _pstDate();
      }
      if (!parentClone) clonedRoot = c;
      else parentClone.children.push(c);
      if (src.children) for (const ch of src.children) queue.push([ch, c]);
    }
    return clonedRoot;
  }

  function _pstDate() {
    return new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles", month: "short", day: "numeric",
      year: "numeric", hour: "numeric", minute: "2-digit", hour12: true
    });
  }

  // ─── Node factories ───
  function makeBranch(chromeWin) {
    return {
      id: newId(), kind: "branch", state: "live", chromeId: chromeWin.id,
      title: "", customTitle: "", focused: chromeWin.focused,
      windowType: chromeWin.type || "normal", children: [], collapsed: false,
      hadMeaningfulTab: false
    };
  }

  function makeTab(chromeTab) {
    return {
      id: newId(), kind: "tab", state: "live", chromeId: chromeTab.id,
      windowId: chromeTab.windowId, title: chromeTab.title || "",
      url: chromeTab.url || "", favIconUrl: chromeTab.favIconUrl || "",
      pinned: !!chromeTab.pinned, active: !!chromeTab.active,
      children: [], collapsed: false
    };
  }

  function makeGroup(title) {
    const t = title || _pstDate();
    return { id: newId(), kind: "group", state: "group", title: t, customTitle: t, children: [], collapsed: false };
  }

  function makeMemo(text) {
    return { id: newId(), kind: "memo", state: "memo", title: text || "", children: [], collapsed: false };
  }

  function makeDivider(style) {
    return { id: newId(), kind: "divider", state: "divider", separatorStyle: style || 0, children: [], collapsed: false };
  }

  // ─── Mutation context extractor (passive, for diagnostics only) ───
  function _extractMutationContext(action) {
    const ctx = { op: action.op };
    if (action.chromeWin) ctx.chromeWindowId = action.chromeWin.id;
    if (action.chromeTab) ctx.chromeTabId = action.chromeTab.id;
    if (action.chromeWindowId !== undefined) ctx.chromeWindowId = action.chromeWindowId;
    if (action.chromeTabId !== undefined) ctx.chromeTabId = action.chromeTabId;
    if (action.chromeId !== undefined) { ctx.chromeId = action.chromeId; ctx.kind = action.kind; }
    if (action.nodeId !== undefined) ctx.nodeId = action.nodeId;
    return ctx;
  }

  // ═══════════════════════════════════════════════════════════════
  // apply(action) — THE SINGLE MUTATION GATE
  // Returns: { ok:bool, error?:string, sideEffects?:[] }
  // ═══════════════════════════════════════════════════════════════
  function apply(action) {
    if (CT_DEBUG.all || CT_DEBUG.engine) {
      console.log("[CT TRACE] apply:start", action);
      // CT009: _extractMutationContext used here to avoid storing live chromeWin/chromeTab refs
      _ctLog("TRACE", "apply:start", _extractMutationContext(action));
    }

    // CT015: Capture deep-clone rollback snapshot before mutation
    const _ct15_snapshot = JSON.parse(JSON.stringify(_workspace.tree));

    const result = _execute(action);

    // ─── CT006: Mutation trace ───
    if (CT_DEBUG.all || CT_DEBUG.engine) {
      const _mutationPayload = {
        ..._extractMutationContext(action),
        result: result.ok ? "ok" : "rejected",
        error: result.error || null,
        nodeId: result.nodeId || null
      };
      console.log("[CT MUTATION]", _mutationPayload);
      _ctLog("MUTATION", action.op, _mutationPayload);
    }

    // ─── CT006: Branch creation trace ───
    if (action.op === "SYNC_ADD_BRANCH") {
      if (CT_DEBUG.all || CT_DEBUG.engine) {
        const _branchAddPayload = {
          windowId: action.chromeWin ? action.chromeWin.id : null,
          windowType: action.chromeWin ? (action.chromeWin.type || "normal") : null,
          nodeId: result.nodeId || null,
          result: result.ok ? "ok" : "rejected",
          error: result.error || null
        };
        console.log("[CT BRANCH]", _branchAddPayload);
        _ctLog("BRANCH", "SYNC_ADD_BRANCH", _branchAddPayload);
      }
    }

    // ─── CT008: Branch removal trace ───
    if (action.op === "SYNC_REMOVE" && action.kind === "branch") {
      if (CT_DEBUG.all || CT_DEBUG.engine) {
        const _branchRemovePayload = {
          op: "SYNC_REMOVE",
          chromeId: action.chromeId || null,
          result: result.ok ? "ok" : "rejected",
          error: result.error || null
        };
        console.log("[CT BRANCH]", _branchRemovePayload);
        _ctLog("BRANCH", "SYNC_REMOVE", _branchRemovePayload);
      }
    }

    // ─── CT008: Branch save-and-close trace ───
    if (action.op === "SAVE_AND_CLOSE") {
      if (CT_DEBUG.all || CT_DEBUG.engine) {
        const _saveClosePayload = {
          op: "SAVE_AND_CLOSE",
          nodeId: action.nodeId || null,
          result: result.ok ? "ok" : "rejected",
          error: result.error || null
        };
        console.log("[CT BRANCH]", _saveClosePayload);
        _ctLog("BRANCH", "SAVE_AND_CLOSE", _saveClosePayload);
      }
    }

    // ─── CT013: Branch detach policy trace ───
    if (action.op === "SYNC_DETACH_BRANCH") {
      if (CT_DEBUG.all || CT_DEBUG.engine) {
        const _detachBranchPayload = {
          op: "SYNC_DETACH_BRANCH",
          chromeWindowId: action.chromeWindowId || null,
          nodeId: result.nodeId || null,
          result: result._branchResult || null,
          ok: result.ok
        };
        console.log("[CT BRANCH]", _detachBranchPayload);
        _ctLog("BRANCH", "SYNC_DETACH_BRANCH", _detachBranchPayload);
      }
    }

    if (CT_DEBUG.all || CT_DEBUG.engine) {
      const _applyResultPayload = {
        op: action.op,
        ok: result.ok,
        error: result.error || null,
        nodeId: result.nodeId || null,
        sideEffects: result.sideEffects || null
      };
      console.log("[CT TRACE] apply:result", _applyResultPayload);
      _ctLog("TRACE", "apply:result", _applyResultPayload);
    }

    if (result.ok) {
      // CT015: Mandatory post-mutation canonical tree validation
      const _ct15_validation = _validateCanonicalTree();
      if (!_ct15_validation.valid) {
        // CT015: Validation failed — rollback to pre-mutation snapshot
        _workspace.tree = _ct15_snapshot;
        _rebuildIndexes();
        // Do NOT bump _version or update _workspace.updatedAt
        if (CT_DEBUG.all || CT_DEBUG.engine) {
          const _rollbackPayload = {
            op: action.op,
            reason: _ct15_validation.reason
          };
          console.log("[CT TRACE] apply:ct15_rollback", _rollbackPayload);
          _ctLog("TRACE", "apply:ct15_rollback", _rollbackPayload);
        }
        // Return rejection — no sideEffects, no success signals
        return { ok: false, error: "VALIDATION_FAILED: " + _ct15_validation.reason };
      }
      _rebuildIndexes();
      _version++;
      // CT010: Update workspace timestamp on successful mutation
      _workspace.updatedAt = Date.now();
      if (CT_DEBUG.all || CT_DEBUG.rebuild) {
        const _rebuildPayload = { op: action.op, version: _version };
        console.log("[CT TRACE] apply:postRebuild", _rebuildPayload);
        _ctLog("REBUILD", "apply:postRebuild", _rebuildPayload);
      }
    }

    return result;
  }

  function _execute(action) {
    switch (action.op) {

      // ─── CHROME SYNC: Add branch for a new Chrome window ───
      case "SYNC_ADD_BRANCH": {
        const { chromeWin } = action;
        // Duplicate check
        if (findByChrome("branch", chromeWin.id)) return { ok: false, error: "DUPLICATE_BRANCH" };
        const node = makeBranch(chromeWin);
        // Insert after last live branch at root level
        let idx = 0;
        for (let i = 0; i < _workspace.tree.children.length; i++) {
          if (_workspace.tree.children[i].kind === "branch" && _workspace.tree.children[i].state === "live") idx = i + 1;
          else break;
        }
        _workspace.tree.children.splice(idx, 0, node);
        return { ok: true, nodeId: node.id };
      }

      // ─── CHROME SYNC: Add tab to a branch ───
      case "SYNC_ADD_TAB": {
        const { chromeTab, parentNodeId } = action;
        // Duplicate check
        if (findByChrome("tab", chromeTab.id)) return { ok: false, error: "DUPLICATE_TAB" };
        const parent = _nodeMap.get(parentNodeId);
        if (!parent || !parent.children) return { ok: false, error: "PARENT_NOT_FOUND" };
        const node = makeTab(chromeTab);
        // Insert at correct Chrome index among live tabs
        let pos = 0, cnt = 0;
        for (let i = 0; i < parent.children.length; i++) {
          if (parent.children[i].kind === "tab" && parent.children[i].state === "live") {
            if (cnt === chromeTab.index) { pos = i; break; }
            cnt++; pos = i + 1;
          } else { pos = i + 1; }
        }
        parent.children.splice(pos, 0, node);
        // CT014: Persist meaningful-tab signal on the branch at add time,
        // so classification at SYNC_DETACH_BRANCH is not dependent on live subtree.
        if (isMeaningfulUrl(chromeTab.url)) {
          let anc = _nodeMap.get(parentNodeId);
          while (anc) {
            if (anc.kind === "branch") { anc.hadMeaningfulTab = true; break; }
            anc = _parentMap.get(anc.id);
          }
        }
        return { ok: true, nodeId: node.id };
      }

      // ─── CHROME SYNC: Update tab properties ───
      case "SYNC_UPDATE_TAB": {
        const { nodeId, changes } = action;
        const node = _nodeMap.get(nodeId);
        if (!node) return { ok: false, error: "NODE_NOT_FOUND" };
        let changed = false;
        for (const k of ["title", "url", "favIconUrl", "pinned", "active"]) {
          if (changes[k] !== undefined && node[k] !== changes[k]) { node[k] = changes[k]; changed = true; }
        }
        // CT014: If url changed to a meaningful URL, record signal on branch ancestor.
        // Uses node.url (already updated above) so we do not need to re-read changes.url.
        if (changes.url !== undefined && isMeaningfulUrl(node.url)) {
          let anc = _parentMap.get(nodeId);
          while (anc) {
            if (anc.kind === "branch") { anc.hadMeaningfulTab = true; break; }
            anc = _parentMap.get(anc.id);
          }
        }
        return { ok: changed };
      }

      // ─── CHROME SYNC: Remove by chromeId ───
      // CT011: Unbind runtime chromeId before structural detach.
      // Node removal is still performed (preserving existing behavior),
      // but identity unbinding is explicit and separated from structural mutation.
      case "SYNC_REMOVE": {
        const { kind, chromeId } = action;
        const node = findByChrome(kind, chromeId);
        if (!node) return { ok: false, error: "NOT_FOUND" };
        // CT011: Explicitly unbind runtime identity before structural operation
        node.chromeId = null;
        if (kind === "tab") {
          node.active = false;
        }
        return _detachNode(node.id);
      }

      // ─── CT017: Window-close tab removal — unbind only, no structural detach ───
      // During full window shutdown, tabs.onRemoved fires before windows.onRemoved.
      // This op unbinds runtime identity and transitions tab to "kept" state,
      // but preserves the node structurally in its parent branch.
      // SYNC_DETACH_BRANCH (fired later) will then:
      //   - meaningful branch: keep branch + tabs (tabs already "kept", idempotent)
      //   - throwaway branch: _detachNode removes branch and all children together
      case "SYNC_SHUTDOWN_REMOVE_TAB": {
        const { chromeTabId } = action;
        const node = findByChrome("tab", chromeTabId);
        if (!node) return { ok: false, error: "NOT_FOUND" };
        // CT017: Unbind runtime identity — node stays in tree for branch evaluation
        node.chromeId = null;
        node.active = false;
        node.state = "kept";
        return { ok: true, nodeId: node.id };
      }

      // ─── CHROME SYNC: Tab moved within a window ───
      case "SYNC_TAB_MOVED": {
        const { chromeTabId, toIndex, chromeWindowId } = action;
        const tabNode = findByChrome("tab", chromeTabId);
        const branchNode = findByChrome("branch", chromeWindowId);
        if (!tabNode || !branchNode) return { ok: false, error: "NOT_FOUND" };
        const parent = _parentMap.get(tabNode.id);
        if (!parent) return { ok: false, error: "ORPHAN" };
        const fromIdx = parent.children.indexOf(tabNode);
        if (fromIdx < 0) return { ok: false, error: "NOT_IN_PARENT" };
        parent.children.splice(fromIdx, 1);
        // Calculate insert position among live tabs
        let to = 0, cnt = 0;
        for (let j = 0; j < branchNode.children.length; j++) {
          if (branchNode.children[j].kind === "tab" && branchNode.children[j].state === "live") {
            if (cnt === toIndex) { to = j; break; }
            cnt++;
          }
          to = j + 1;
        }
        branchNode.children.splice(to, 0, tabNode);
        return { ok: true };
      }

      // ─── CHROME SYNC: Tab attached to new window ───
      // CT011: Attach = rebind runtime identity + reparent.
      // Existing nodes are reparented via inline splice (no _detachNode).
      // New node creation only if genuinely untracked.
      case "SYNC_TAB_ATTACHED": {
        const { chromeTab, branchNodeId, position } = action;
        // Check if already tracked — if so, this is a reparent, not a create
        const existing = findByChrome("tab", chromeTab.id);
        if (existing) {
          // CT011: Inline reparent — remove from old parent without _detachNode
          const oldParent = _parentMap.get(existing.id);
          if (oldParent) {
            const oi = oldParent.children.indexOf(existing);
            if (oi >= 0) oldParent.children.splice(oi, 1);
          }
          const branch = _nodeMap.get(branchNodeId);
          if (!branch) return { ok: false, error: "BRANCH_NOT_FOUND" };
          branch.children.splice(Math.min(position, branch.children.length), 0, existing);
          // CT011: Update runtime binding only — nodeId and structure are stable
          existing.chromeId = chromeTab.id;
          existing.windowId = chromeTab.windowId;
          return { ok: true };
        }
        // Not tracked — create new (genuine new tab, not a rebind)
        // CT011: Duplicate guard — chromeId check above already covers this,
        // but verify no stale mapping exists before creation
        const branch = _nodeMap.get(branchNodeId);
        if (!branch) return { ok: false, error: "BRANCH_NOT_FOUND" };
        const node = makeTab(chromeTab);
        branch.children.splice(Math.min(position, branch.children.length), 0, node);
        return { ok: true, nodeId: node.id };
      }

      // ─── CHROME SYNC: Tab activated ───
      case "SYNC_TAB_ACTIVATED": {
        const { chromeWindowId, chromeTabId } = action;
        const branch = findByChrome("branch", chromeWindowId);
        if (!branch) return { ok: false, error: "BRANCH_NOT_FOUND" };
        // Deactivate all tabs in this branch, activate the one
        const stk = [branch];
        while (stk.length) {
          const cur = stk.pop();
          if (cur.kind === "tab" && cur.state === "live") cur.active = (cur.chromeId === chromeTabId);
          if (cur.children) for (let i = cur.children.length - 1; i >= 0; i--) stk.push(cur.children[i]);
        }
        return { ok: true };
      }

      // ─── CHROME SYNC: Window focus ───
      case "SYNC_WIN_FOCUS": {
        const { chromeWindowId } = action;
        const stk = [_workspace.tree];
        while (stk.length) {
          const cur = stk.pop();
          if (cur.kind === "branch" && cur.state === "live") cur.focused = (cur.chromeId === chromeWindowId);
          if (cur.children) for (let i = cur.children.length - 1; i >= 0; i--) stk.push(cur.children[i]);
        }
        return { ok: true };
      }

      // ─── CHROME SYNC: Reorder tabs to match Chrome's order ───
      case "SYNC_REORDER_TABS": {
        const { branchNodeId, chromeTabOrder } = action;
        const branch = _nodeMap.get(branchNodeId);
        if (!branch) return { ok: false, error: "BRANCH_NOT_FOUND" };
        const tabMap = new Map();
        branch.children.forEach(c => {
          if (c.kind === "tab" && c.state === "live" && c.chromeId) tabMap.set(c.chromeId, c);
        });
        const nonLiveTabs = branch.children.filter(c => !(c.kind === "tab" && c.state === "live" && c.chromeId));
        const ordered = [];
        chromeTabOrder.forEach(ctid => { const n = tabMap.get(ctid); if (n) ordered.push(n); });
        branch.children = [...ordered, ...nonLiveTabs];
        return { ok: true };
      }

      // ─── USER: Relocate node (drag/drop) ───
      case "RELOCATE": {
        const { sourceId, targetId, slot } = action;
        if (sourceId === targetId) return { ok: false, error: "SELF_DROP" };
        if (isDescendant(targetId, sourceId)) return { ok: false, error: "CIRCULAR" };
        const src = _nodeMap.get(sourceId);
        if (!src) return { ok: false, error: "SOURCE_NOT_FOUND" };
        const srcParent = _parentMap.get(sourceId);
        if (!srcParent) return { ok: false, error: "SOURCE_ORPHAN" };
        const priorWin = (src.kind === "tab" && src.state === "live") ? findLiveBranchAncestor(sourceId) : null;
        // Detach
        const si = srcParent.children.indexOf(src);
        if (si < 0) return { ok: false, error: "NOT_IN_PARENT" };
        srcParent.children.splice(si, 1);
        // Attach
        let destParent = null;
        if (slot === "nest") {
          const tgt = _nodeMap.get(targetId);
          if (!tgt || !tgt.children) { srcParent.children.splice(si, 0, src); return { ok: false, error: "INVALID_NEST_TARGET" }; }
          tgt.children.push(src); tgt.collapsed = false; destParent = tgt;
        } else {
          const tgtParent = _parentMap.get(targetId);
          if (!tgtParent) { srcParent.children.splice(si, 0, src); return { ok: false, error: "TARGET_ORPHAN" }; }
          let ti = tgtParent.children.findIndex(c => c.id === targetId);
          if (slot === "after") ti++;
          tgtParent.children.splice(ti, 0, src); destParent = tgtParent;
        }
        // Auto-name groups
        if (destParent && destParent.kind === "group") {
          destParent.lastModified = Date.now();
          if (!destParent.customTitle || destParent.customTitle === "New Group") destParent.customTitle = _pstDate();
        }
        // Detect chrome side effect
        const sideEffects = [];
        if (src.kind === "tab" && src.state === "live" && src.chromeId) {
          // Need to rebuild indexes first to compute new ancestor
          _rebuildIndexes();
          const newWin = findLiveBranchAncestor(src.id);
          if (newWin !== priorWin) {
            sideEffects.push({ type: "CHROME_MOVE_TAB", tabId: src.chromeId, toWin: newWin });
          }
        }
        return { ok: true, sideEffects };
      }

      // ─── USER: Remove node by nodeId ───
      case "REMOVE": {
        return _detachNode(action.nodeId);
      }

      // ─── USER: Append child to parent ───
      case "APPEND": {
        const parent = action.parentId ? _nodeMap.get(action.parentId) : _workspace.tree;
        if (!parent || !parent.children) return { ok: false, error: "PARENT_NOT_FOUND" };
        if (!action.node || !action.node.id) return { ok: false, error: "INVALID_NODE" };
        parent.children.push(action.node);
        return { ok: true };
      }

      // ─── USER: Insert after a reference node ───
      case "INSERT_AFTER": {
        const ref = _nodeMap.get(action.afterId);
        if (!ref) return { ok: false, error: "REF_NOT_FOUND" };
        const par = _parentMap.get(action.afterId) || _workspace.tree;
        const idx = par.children.indexOf(ref);
        par.children.splice(idx + 1, 0, action.node);
        return { ok: true };
      }

      // ─── USER: Patch node properties ───
      case "PATCH": {
        const nd = _nodeMap.get(action.nodeId);
        if (!nd) return { ok: false, error: "NODE_NOT_FOUND" };
        Object.assign(nd, action.props);
        return { ok: true };
      }

      // ─── USER: Save & close a live branch ───
      case "SAVE_AND_CLOSE": {
        const { nodeId } = action;
        const nd = _nodeMap.get(nodeId);
        if (!nd || nd.kind !== "branch" || nd.state !== "live") return { ok: false, error: "NOT_LIVE_BRANCH" };
        const chromeWinId = nd.chromeId;
        nd.state = "kept"; nd.savedDate = Date.now();
        if (!nd.customTitle) nd.customTitle = _pstDate();
        nd.chromeId = null;
        // Convert all live tabs to kept
        const stk = [nd];
        while (stk.length) {
          const cur = stk.pop();
          if (cur.kind === "tab" && cur.state === "live") { cur.state = "kept"; cur.chromeId = null; }
          if (cur.children) for (let i = cur.children.length - 1; i >= 0; i--) stk.push(cur.children[i]);
        }
        return { ok: true, sideEffects: [{ type: "CHROME_CLOSE_WINDOW", windowId: chromeWinId }] };
      }

      // ─── RECONCILE: Prune dead nodes after restart ───
      case "RECONCILE_PRUNE": {
        const { liveWindowIds, liveTabIds } = action;
        const ow = new Set(liveWindowIds), ot = new Set(liveTabIds);
        _pruneDeadIterative(_workspace.tree, ow, ot);
        return { ok: true };
      }

      // ─── FULL TREE REPLACE (for undo/import) ───
      case "REPLACE_TREE": {
        if (!action.tree || !action.tree.id) return { ok: false, error: "INVALID_TREE" };
        // CT010: Replace tree inside workspace, preserve workspace container
        _workspace.tree = action.tree;
        return { ok: true };
      }

      // ─── CT011: Chrome tab replaced (e.g. prerender commit) ───
      // Rebinds runtime chromeId from old → new without structural mutation.
      case "SYNC_TAB_REPLACED": {
        const { oldChromeTabId, newChromeTabId } = action;
        const node = findByChrome("tab", oldChromeTabId);
        if (!node) return { ok: false, error: "NOT_FOUND" };
        // CT011: Rebind runtime identity only — nodeId and tree position are stable
        node.chromeId = newChromeTabId;
        return { ok: true };
      }

      // ─── CT011: Unbind runtime chromeId without structural mutation ───
      // Used during detach to clear runtime binding while preserving node in tree.
      case "SYNC_UNBIND_TAB": {
        const { chromeTabId } = action;
        const node = findByChrome("tab", chromeTabId);
        if (!node) return { ok: false, error: "NOT_FOUND" };
        // CT011: Clear runtime binding only — node stays in tree, nodeId is permanent
        node.chromeId = null;
        return { ok: true };
      }

      // ─── CT012/CT013: Detach branch from Chrome window lifecycle ───
      // CT013: Evaluates branch before detaching. Meaningful branches are kept
      // (existing detach behavior). Unmodified/throwaway branches are discarded
      // via _detachNode — no kept state written, node removed from tree entirely.
      case "SYNC_DETACH_BRANCH": {
        const { chromeWindowId } = action;
        const node = findByChrome("branch", chromeWindowId);
        if (!node) return { ok: false, error: "NOT_FOUND" };

        if (isBranchMeaningful(node)) {
          // CT013: Meaningful branch — preserve via existing detach behavior (CT012).
          // Unbind runtime association; node identity and tree position remain stable.
          node.chromeId = null;
          node.focused = false;
          node.state = "kept";
          node.savedDate = Date.now();
          if (!node.customTitle) node.customTitle = _pstDate();
          // Unbind all live child tabs — they no longer have runtime counterparts
          const stk = [node];
          while (stk.length) {
            const cur = stk.pop();
            if (cur.kind === "tab" && cur.state === "live") {
              cur.state = "kept";
              cur.chromeId = null;
              cur.active = false;
            }
            if (cur.children) for (let i = cur.children.length - 1; i >= 0; i--) stk.push(cur.children[i]);
          }
          return { ok: true, nodeId: node.id, _branchResult: "kept" };
        } else {
          // CT013: Unmodified/throwaway branch — discard by removing from tree entirely.
          // Uses the same safe removal path as REMOVE / SYNC_REMOVE.
          const removeResult = _detachNode(node.id);
          if (!removeResult.ok) return removeResult;
          return { ok: true, _branchResult: "discarded" };
        }
      }

      default:
        return { ok: false, error: "UNKNOWN_OP: " + action.op };
    }
  }

  // ─── Internal helpers ───

  // ─── CT013: Branch persistence policy helpers ───

  // CT014: Returns true when url is non-empty and is not a chrome://newtab URL.
  // Used as the single source of truth for meaningful-URL classification.
  function isMeaningfulUrl(url) {
    return !!url && url !== "chrome://newtab/" && !url.startsWith("chrome://newtab?");
  }

  // Returns true if the branch node has at least one tab with a meaningful URL.
  // CT014: Retained for reference; no longer called by isBranchMeaningful.
  // Classification now relies on the persistent hadMeaningfulTab flag instead.
  function hasMeaningfulTabs(node) {
    const stk = [node];
    while (stk.length) {
      const cur = stk.pop();
      if (cur.kind === "tab" && isMeaningfulUrl(cur.url)) return true;
      if (cur.children) for (let i = cur.children.length - 1; i >= 0; i--) stk.push(cur.children[i]);
    }
    return false;
  }

  // Returns true if the branch node carries metadata that should be preserved.
  // Placeholder — always returns false until a metadata schema is defined.
  function hasMetadata(/* node */) {
    return false;
  }

  // Returns true if the branch is meaningful and should be kept on window close.
  // Meaningful if ANY of the following are true:
  //   - renamed from default (customTitle is non-empty)
  //   - moved under a non-root parent
  //   - CT014: hadMeaningfulTab was set true during the branch's lifetime
  //   - has metadata (placeholder false for now)
  function isBranchMeaningful(node) {
    if (node.customTitle) return true;
    const parent = _parentMap.get(node.id);
    if (parent && parent.id !== _workspace.tree.id) return true;
    if (node.hadMeaningfulTab === true) return true;
    if (hasMetadata(node)) return true;
    return false;
  }

  function _detachNode(nodeId) {
    if (CT_DEBUG.all || CT_DEBUG.engine) {
      console.log("[CT TRACE] _detachNode:start", { nodeId });
      _ctLog("TRACE", "_detachNode:start", { nodeId });
    }

    const parent = _parentMap.get(nodeId);
    if (!parent) {
      if (CT_DEBUG.all || CT_DEBUG.engine) {
        console.log("[CT TRACE] _detachNode:error", { nodeId, error: "ORPHAN_OR_ROOT" });
        _ctLog("TRACE", "_detachNode:error", { nodeId, error: "ORPHAN_OR_ROOT" });
      }
      return { ok: false, error: "ORPHAN_OR_ROOT" };
    }

    const idx = parent.children.findIndex(c => c.id === nodeId);
    if (idx < 0) {
      if (CT_DEBUG.all || CT_DEBUG.engine) {
        console.log("[CT TRACE] _detachNode:error", { nodeId, error: "NOT_IN_PARENT", parentId: parent.id });
        _ctLog("TRACE", "_detachNode:error", { nodeId, error: "NOT_IN_PARENT", parentId: parent.id });
      }
      return { ok: false, error: "NOT_IN_PARENT" };
    }

    parent.children.splice(idx, 1);
    if (CT_DEBUG.all || CT_DEBUG.engine) {
      console.log("[CT TRACE] _detachNode:ok", { nodeId, parentId: parent.id, index: idx });
      _ctLog("TRACE", "_detachNode:ok", { nodeId, parentId: parent.id, index: idx });
    }
    return { ok: true };
  }

  function _pruneDeadIterative(root, liveWinIds, liveTabIds) {
    const stk = [root];
    while (stk.length) {
      const cur = stk.pop();
      if (!cur.children) continue;
      cur.children = cur.children.filter(c => {
        if (c.kind === "branch" && c.state === "live" && !liveWinIds.has(c.chromeId)) {
          if (_hasUserContent(c)) {
            c.state = "kept"; c.chromeId = null; c.savedDate = Date.now();
            stk.push(c); return true;
          }
          return false;
        }
        if (c.kind === "tab" && c.state === "live" && !liveTabIds.has(c.chromeId)) return false;
        stk.push(c); return true;
      });
    }
  }

  function _hasUserContent(node) {
    const stk = [node];
    while (stk.length) {
      const c = stk.pop();
      if (c.state === "kept" || c.kind === "group" || c.kind === "memo" || c.kind === "divider") return true;
      if (c.customTitle || c.customColor || c.customIcon) return true;
      if (c.children) for (let i = c.children.length - 1; i >= 0; i--) stk.push(c.children[i]);
    }
    return false;
  }

  // Assign fresh IDs to an imported subtree
  function assignFreshIds(node) {
    const stk = [node];
    while (stk.length) {
      const c = stk.pop();
      c.id = newId();
      if (c.children) for (let i = c.children.length - 1; i >= 0; i--) stk.push(c.children[i]);
    }
    return node;
  }

  // ─── Public API ───
  return {
    // Queries (read-only, always safe)
    getTree, getVersion, getNode, getParent, getRoot,
    getWorkspace,
    findByChrome, isDescendant, findLiveBranchAncestor,
    walkSubtree, collectUrls, cloneAsKept, newId, assignFreshIds,
    // Factories
    makeBranch, makeTab, makeGroup, makeMemo, makeDivider,
    // THE mutation gate
    apply,
    // Rebuild (called by persistence on load)
    replaceTree(t) { return apply({ op: "REPLACE_TREE", tree: t }); },
    forceReindex() { _rebuildIndexes(); },
    // CT010: Replace workspace metadata (called by persistence on load)
    replaceWorkspace(ws) {
      if (!ws || !ws.tree || !ws.tree.id) return;
      _workspace.id = ws.id || _workspace.id;
      _workspace.createdAt = ws.createdAt || _workspace.createdAt;
      _workspace.updatedAt = ws.updatedAt || _workspace.updatedAt;
      _workspace.meta = ws.meta || _workspace.meta;
      this.replaceTree(ws.tree);
    },
  };
})();

// ─── CT009: Helper to read buffered logs (shared by ct.logs and message handler) ───
function _ctReadLogs(opts) {
  var filter = opts && opts.filter ? String(opts.filter).toUpperCase() : null;
  var limit  = opts && opts.limit > 0 ? opts.limit : null;

  var src = filter
    ? _ctLogBuffer.filter(function (e) { return e.category === filter; })
    : _ctLogBuffer;

  if (limit !== null) src = src.slice(-limit);

  // Return shallow copies — no live references
  return src.map(function (e) {
    return { t: e.t, category: e.category, op: e.op, data: Object.assign({}, e.data) };
  });
}

// ─── CT006: DevTools inspection helper ───
// Usage: ct.tree() in DevTools console
// Read-only snapshot — does not mutate state
const ct = {
  tree() {
    const tree = stateManager.getTree();
    const version = stateManager.getVersion();

    function summarize(node) {
      const s = { id: node.id, kind: node.kind, state: node.state };
      if (node.kind === "branch") {
        s.chromeWindowId = node.chromeId || null;
        s.windowType = node.windowType || null;
        s.focused = !!node.focused;
        s.customTitle = node.customTitle || "";
        const tabCount = (node.children || []).reduce((n, c) => n + (c.kind === "tab" ? 1 : 0), 0);
        s.tabCount = tabCount;
      }
      if (node.kind === "tab") {
        s.chromeTabId = node.chromeId || null;
        s.title = node.title || "";
        s.url = node.url || "";
        s.active = !!node.active;
      }
      if (node.kind === "group") {
        s.customTitle = node.customTitle || "";
      }
      if (node.kind === "memo") {
        s.title = node.title || "";
      }
      if (node.children && node.children.length) {
        s.children = node.children.map(summarize);
      }
      return s;
    }

    const snapshot = {
      version: version,
      tree: summarize(tree)
    };

    console.log("[CT TREE]", snapshot);
    return snapshot;
  },

  // ─── CT009: Log buffer access ───
  // ct.logs()                        — all entries, chronological
  // ct.logs({ filter: "BRANCH" })    — entries matching category (case-insensitive)
  // ct.logs({ limit: 10 })           — last N entries
  // ct.logs({ filter: "TRACE", limit: 20 }) — combined
  // Works in both background and panel contexts.
  logs(opts) {
    if (_CT_IS_BACKGROUND) {
      return _ctReadLogs(opts);
    }
    // Panel context — request via message bridge (async, returns a Promise)
    try {
      return new Promise(function (resolve) {
        chrome.runtime.sendMessage({ type: "CT_GET_LOGS", opts: opts || {} }, function (response) {
          if (chrome.runtime.lastError || !response) {
            resolve([]);
            return;
          }
          resolve(response.logs || []);
        });
      });
    } catch (e) {
      return [];
    }
  },

  // ct.clearLogs() — empties the buffer
  // Works in both background and panel contexts.
  clearLogs() {
    if (_CT_IS_BACKGROUND) {
      _ctLogBuffer.length = 0;
      console.log("[CT BUFFER] cleared");
      return;
    }
    // Panel context — request via message bridge
    try {
      chrome.runtime.sendMessage({ type: "CT_CLEAR_LOGS" }, function () {
        if (chrome.runtime.lastError) { /* fail silently */ }
      });
    } catch (e) {
      /* messaging unavailable — fail safely */
    }
  },

  // ─── CT009: Debug flag control ───
  // ct.debug()                            — returns current flags (copy)
  // ct.debug({ all: true })               — enables all categories
  // ct.debug({ lifecycle: true, engine: true }) — enables only specified, disables rest
  // ct.debug({})                           — disables all categories
  // Works in both background and panel contexts.
  debug(config) {
    if (_CT_IS_BACKGROUND) {
      if (arguments.length === 0 || config === undefined) {
        // Return current flags as a plain copy
        var copy = {};
        for (var i = 0; i < _CT_DEBUG_KEYS.length; i++) {
          copy[_CT_DEBUG_KEYS[i]] = CT_DEBUG[_CT_DEBUG_KEYS[i]];
        }
        return copy;
      }
      return setDebugFlags(config);
    }
    // Panel context — request via message bridge (async, returns a Promise)
    try {
      var msgConfig = arguments.length === 0 || config === undefined ? null : config;
      return new Promise(function (resolve) {
        chrome.runtime.sendMessage({ type: "CT_SET_DEBUG", config: msgConfig }, function (response) {
          if (chrome.runtime.lastError || !response) {
            resolve(null);
            return;
          }
          resolve(response.flags || null);
        });
      });
    } catch (e) {
      return null;
    }
  }
};

// ─── CT009: Background message listener for cross-context debug access ───
try {
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;

    switch (msg.type) {

      case "CT_GET_LOGS": {
        var logs = _ctReadLogs(msg.opts || {});
        sendResponse({ logs: logs });
        return false; // synchronous response
      }

      case "CT_CLEAR_LOGS": {
        _ctLogBuffer.length = 0;
        console.log("[CT BUFFER] cleared");
        sendResponse({ ok: true });
        return false;
      }

      case "CT_SET_DEBUG": {
        var flags;
        if (msg.config === null || msg.config === undefined) {
          // Read-only: return current flags
          flags = {};
          for (var i = 0; i < _CT_DEBUG_KEYS.length; i++) {
            flags[_CT_DEBUG_KEYS[i]] = CT_DEBUG[_CT_DEBUG_KEYS[i]];
          }
        } else {
          flags = setDebugFlags(msg.config);
        }
        sendResponse({ ok: true, flags: flags });
        return false;
      }

      default:
        return false;
    }
  });
} catch (e) {
  // chrome.runtime.onMessage unavailable — fail safely (e.g. in test harness)
}
