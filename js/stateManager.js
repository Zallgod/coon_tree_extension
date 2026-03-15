"use strict";

/*
 * stateManager.js — Coon Tree State Engine
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
  let _tree = { id: "root", kind: "root", title: "Coon Tree", children: [], collapsed: false };
  let _seq = Date.now(); // monotonic ID sequence
  let _version = 0;      // bumps on every successful apply — lets UI skip stale renders

  // ─── Indexes (rebuilt atomically, never stale) ───
  let _nodeMap = new Map();   // nodeId → node
  let _parentMap = new Map(); // nodeId → parent node
  let _chromeMap = new Map(); // "tab:123" | "branch:456" → nodeId

  function _chromeKey(kind, chromeId) { return kind + ":" + chromeId; }

  function _rebuildIndexes() {
    _nodeMap.clear(); _parentMap.clear(); _chromeMap.clear();
    const stk = [_tree];
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

  // ─── ID generation ───
  function newId() { return "ct" + (_seq++); }

  // ─── Read-only queries (safe to call anytime) ───
  function getTree() { return _tree; }
  function getVersion() { return _version; }
  function getNode(nodeId) { return _nodeMap.get(nodeId) || null; }
  function getParent(nodeId) { return _parentMap.get(nodeId) || null; }
  function getRoot() { return _tree; }

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
      windowType: chromeWin.type || "normal", children: [], collapsed: false
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

  // ═══════════════════════════════════════════════════════════════
  // apply(action) — THE SINGLE MUTATION GATE
  // Returns: { ok:bool, error?:string, sideEffects?:[] }
  // ═══════════════════════════════════════════════════════════════
  function apply(action) {
    const result = _execute(action);
    // [CT002] Summary trace — logs decision without touching _execute internals
    if (action.op && (action.op.startsWith("SYNC_") || action.op === "RECONCILE_PRUNE")) {
      console.log("[CT TRACE] apply", { op: action.op, ok: result.ok, error: result.error || null });
    }
    if (result.ok) {
      _rebuildIndexes();
      _version++;
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
        for (let i = 0; i < _tree.children.length; i++) {
          if (_tree.children[i].kind === "branch" && _tree.children[i].state === "live") idx = i + 1;
          else break;
        }
        _tree.children.splice(idx, 0, node);
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
        return { ok: changed };
      }

      // ─── CHROME SYNC: Remove by chromeId ───
      case "SYNC_REMOVE": {
        const { kind, chromeId } = action;
        const node = findByChrome(kind, chromeId);
        if (!node) return { ok: false, error: "NOT_FOUND" };
        return _detachNode(node.id);
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
      case "SYNC_TAB_ATTACHED": {
        const { chromeTab, branchNodeId, position } = action;
        // Check if already tracked — if so, this is a move, not a create
        const existing = findByChrome("tab", chromeTab.id);
        if (existing) {
          // Already tracked — detach from old parent, attach to new
          _detachNode(existing.id);
          const branch = _nodeMap.get(branchNodeId);
          if (!branch) return { ok: false, error: "BRANCH_NOT_FOUND" };
          branch.children.splice(Math.min(position, branch.children.length), 0, existing);
          // Update the tab's windowId
          existing.windowId = chromeTab.windowId;
          return { ok: true };
        }
        // Not tracked — create new
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
        const stk = [_tree];
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
        const parent = action.parentId ? _nodeMap.get(action.parentId) : _tree;
        if (!parent || !parent.children) return { ok: false, error: "PARENT_NOT_FOUND" };
        if (!action.node || !action.node.id) return { ok: false, error: "INVALID_NODE" };
        parent.children.push(action.node);
        return { ok: true };
      }

      // ─── USER: Insert after a reference node ───
      case "INSERT_AFTER": {
        const ref = _nodeMap.get(action.afterId);
        if (!ref) return { ok: false, error: "REF_NOT_FOUND" };
        const par = _parentMap.get(action.afterId) || _tree;
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
        _pruneDeadIterative(_tree, ow, ot);
        return { ok: true };
      }

      // ─── FULL TREE REPLACE (for undo/import) ───
      case "REPLACE_TREE": {
        if (!action.tree || !action.tree.id) return { ok: false, error: "INVALID_TREE" };
        _tree = action.tree;
        return { ok: true };
      }

      default:
        return { ok: false, error: "UNKNOWN_OP: " + action.op };
    }
  }

  // ─── Internal helpers ───
  function _detachNode(nodeId) {
    const parent = _parentMap.get(nodeId);
    if (!parent) return { ok: false, error: "ORPHAN_OR_ROOT" };
    const idx = parent.children.findIndex(c => c.id === nodeId);
    if (idx < 0) return { ok: false, error: "NOT_IN_PARENT" };
    parent.children.splice(idx, 1);
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
    findByChrome, isDescendant, findLiveBranchAncestor,
    walkSubtree, collectUrls, cloneAsKept, newId, assignFreshIds,
    // Factories
    makeBranch, makeTab, makeGroup, makeMemo, makeDivider,
    // THE mutation gate
    apply,
    // Rebuild (called by persistence on load)
    replaceTree(t) { return apply({ op: "REPLACE_TREE", tree: t }); },
    forceReindex() { _rebuildIndexes(); },
  };
})();
