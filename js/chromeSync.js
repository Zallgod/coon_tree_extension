"use strict";

/*
 * chromeSync.js — Chrome ↔ State Bridge
 *
 * Responsibilities:
 *   1. Listen to Chrome tab/window events
 *   2. Translate each event into a stateManager.apply() call
 *   3. Prevent duplicates using stateManager.findByChrome() (O(1) lookup)
 *   4. Handle reconciliation on startup
 *   5. Execute chrome side effects from user actions (tab moves, window creates)
 *
 * This module NEVER touches the tree directly.
 * All mutations go through stateManager.apply().
 */

const chromeSync = (() => {
  let _panelTabId = null;
  let _panelWindowId = null;
  let _onUpdate = null; // callback: () => void, called after every state change

  const PANEL_URL = chrome.runtime.getURL("panel.html");

  function isPanelTab(tab) { return tab.id === _panelTabId || (tab.url && tab.url === PANEL_URL); }
  function isPanelWin(win) { return win.id === _panelWindowId || (win.tabs && win.tabs.some(t => t.url === PANEL_URL || t.id === _panelTabId)); }

  function setPanelIds(tabId, winId) { _panelTabId = tabId; _panelWindowId = winId; }
  function getPanelTabId() { return _panelTabId; }
  function getPanelWindowId() { return _panelWindowId; }

  // ─── Startup reconciliation ───
  async function reconcile() {
    const wins = await chrome.windows.getAll({ populate: true });
    const liveWinIds = [], liveTabIds = [];

    for (const win of wins) {
      if (isPanelWin(win)) continue;
      liveWinIds.push(win.id);
      for (const tab of win.tabs) {
        if (isPanelTab(tab)) continue;
        liveTabIds.push(tab.id);
      }
    }

    console.log("[CT TRACE] reconcile:start", {
      windows: liveWinIds,
      tabs: liveTabIds,
      panelTabId: _panelTabId,
      panelWindowId: _panelWindowId
    });

    // Phase 1: Prune dead nodes
    const pruneResult = stateManager.apply({ op: "RECONCILE_PRUNE", liveWindowIds: liveWinIds, liveTabIds });
    console.log("[CT TRACE] reconcile:pruneResult", pruneResult);

    // Phase 2: Add windows/tabs that aren't tracked yet
    for (const win of wins) {
      if (isPanelWin(win)) continue;

      let branchNode = stateManager.findByChrome("branch", win.id);
      console.log("[CT TRACE] reconcile:window", {
        windowId: win.id,
        focused: !!win.focused,
        branchFound: !!branchNode,
        tabCount: (win.tabs || []).filter(t => !isPanelTab(t)).length
      });

      if (!branchNode) {
        const r = stateManager.apply({ op: "SYNC_ADD_BRANCH", chromeWin: win });
        console.log("[CT TRACE] reconcile:addBranch", { windowId: win.id, result: r });
        if (r.ok) branchNode = stateManager.getNode(r.nodeId);
      }
      if (!branchNode) continue;

      // Update focus
      const focusResult = stateManager.apply({ op: "SYNC_WIN_FOCUS", chromeWindowId: win.focused ? win.id : -1 });
      console.log("[CT TRACE] reconcile:focus", { windowId: win.id, result: focusResult });

      for (const tab of win.tabs) {
        if (isPanelTab(tab)) continue;
        const existing = stateManager.findByChrome("tab", tab.id);
        console.log("[CT TRACE] reconcile:tab", {
          tabId: tab.id,
          windowId: tab.windowId,
          existing: !!existing,
          branchNodeId: branchNode.id
        });

        if (!existing) {
          const addTabResult = stateManager.apply({ op: "SYNC_ADD_TAB", chromeTab: tab, parentNodeId: branchNode.id });
          console.log("[CT TRACE] reconcile:addTab", { tabId: tab.id, result: addTabResult });
        } else {
          const updateTabResult = stateManager.apply({ op: "SYNC_UPDATE_TAB", nodeId: existing.id, changes: tab });
          console.log("[CT TRACE] reconcile:updateTab", { tabId: tab.id, nodeId: existing.id, result: updateTabResult });
        }
      }

      // Reorder to match Chrome's actual order
      const reorderResult = stateManager.apply({
        op: "SYNC_REORDER_TABS",
        branchNodeId: branchNode.id,
        chromeTabOrder: win.tabs.filter(t => !isPanelTab(t)).map(t => t.id)
      });
      console.log("[CT TRACE] reconcile:reorder", {
        windowId: win.id,
        branchNodeId: branchNode.id,
        result: reorderResult
      });
    }

    console.log("[CT TRACE] reconcile:end");
  }

  // ─── Event handlers ───
  function onTabCreated(tab) {
    if (isPanelTab(tab)) {
      console.log("[CT TRACE] onTabCreated:panel", { tabId: tab.id, windowId: tab.windowId });
      _panelTabId = tab.id;
      return;
    }

    const branch = stateManager.findByChrome("branch", tab.windowId);
    console.log("[CT TRACE] onTabCreated", {
      tabId: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      branchFound: !!branch,
      tracked: !!stateManager.findByChrome("tab", tab.id)
    });

    if (!branch) return;

    const r = stateManager.apply({ op: "SYNC_ADD_TAB", chromeTab: tab, parentNodeId: branch.id });
    console.log("[CT TRACE] onTabCreated:result", { tabId: tab.id, result: r });

    if (r.ok) _notify();
  }

  function onTabRemoved(tabId, removeInfo) {
    if (tabId === _panelTabId) {
      console.log("[CT TRACE] onTabRemoved:panel", { tabId, removeInfo });
      _panelTabId = null;
      return;
    }

    console.log("[CT TRACE] onTabRemoved", {
      tabId,
      removeInfo,
      tracked: !!stateManager.findByChrome("tab", tabId)
    });

    const r = stateManager.apply({ op: "SYNC_REMOVE", kind: "tab", chromeId: tabId });
    console.log("[CT TRACE] onTabRemoved:result", { tabId, result: r });

    if (r.ok) _notify();
  }

  function onTabUpdated(tabId, changeInfo, tab) {
    if (isPanelTab(tab)) {
      console.log("[CT TRACE] onTabUpdated:panel", { tabId, keys: Object.keys(changeInfo || {}) });
      return;
    }

    const node = stateManager.findByChrome("tab", tabId);
    console.log("[CT TRACE] onTabUpdated", {
      tabId,
      windowId: tab.windowId,
      found: !!node,
      keys: Object.keys(changeInfo || {})
    });

    if (!node) return;

    const r = stateManager.apply({ op: "SYNC_UPDATE_TAB", nodeId: node.id, changes: changeInfo });
    console.log("[CT TRACE] onTabUpdated:result", { tabId, nodeId: node.id, result: r });

    if (r.ok) _notify();
  }

  function onTabMoved(tabId, moveInfo) {
    console.log("[CT TRACE] onTabMoved", {
      tabId,
      windowId: moveInfo.windowId,
      fromIndex: moveInfo.fromIndex,
      toIndex: moveInfo.toIndex,
      tracked: !!stateManager.findByChrome("tab", tabId)
    });

    const r = stateManager.apply({
      op: "SYNC_TAB_MOVED",
      chromeTabId: tabId,
      toIndex: moveInfo.toIndex,
      chromeWindowId: moveInfo.windowId
    });
    console.log("[CT TRACE] onTabMoved:result", { tabId, result: r });

    if (r.ok) _notify();
  }

  function onTabDetached(tabId, detachInfo) {
    // [CT003] Observational only — no structural mutation.
    // Node and chromeId index remain intact across detach.
    // Rebinding occurs in onTabAttached via SYNC_TAB_ATTACHED.
    console.log("[CT TRACE] onTabDetached", {
      tabId,
      detachInfo,
      tracked: !!stateManager.findByChrome("tab", tabId)
    });
  }

  function onTabAttached(tabId, attachInfo) {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError || !tab) {
        console.log("[CT TRACE] onTabAttached:getFailed", {
          tabId,
          attachInfo,
          error: chrome.runtime.lastError?.message || null
        });
        return;
      }

      const branch = stateManager.findByChrome("branch", attachInfo.newWindowId);
      console.log("[CT TRACE] onTabAttached", {
        tabId,
        newWindowId: attachInfo.newWindowId,
        newPosition: attachInfo.newPosition,
        branchFound: !!branch,
        tracked: !!stateManager.findByChrome("tab", tabId),
        chromeTabWindowId: tab.windowId
      });

      if (!branch) return;

      const r = stateManager.apply({
        op: "SYNC_TAB_ATTACHED",
        chromeTab: tab,
        branchNodeId: branch.id,
        position: attachInfo.newPosition
      });
      console.log("[CT TRACE] onTabAttached:result", { tabId, branchNodeId: branch.id, result: r });

      if (r.ok) _notify();
    });
  }

  function onTabActivated(activeInfo) {
    console.log("[CT TRACE] onTabActivated", {
      tabId: activeInfo.tabId,
      windowId: activeInfo.windowId,
      tracked: !!stateManager.findByChrome("tab", activeInfo.tabId)
    });

    const r = stateManager.apply({
      op: "SYNC_TAB_ACTIVATED",
      chromeWindowId: activeInfo.windowId,
      chromeTabId: activeInfo.tabId
    });
    console.log("[CT TRACE] onTabActivated:result", { tabId: activeInfo.tabId, result: r });

    if (r.ok) _notify();
  }

  function onTabReplaced(addedTabId, removedTabId) {
    console.log("[CT TRACE] onTabReplaced", {
      addedTabId,
      removedTabId,
      addedTracked: !!stateManager.findByChrome("tab", addedTabId),
      removedTracked: !!stateManager.findByChrome("tab", removedTabId)
    });
  }

  function onWinCreated(win) {
    if ((win.type !== "normal" && win.type !== "popup") || win.id === _panelWindowId) {
      console.log("[CT TRACE] onWinCreated:ignored", {
        windowId: win.id,
        type: win.type,
        panelWindowId: _panelWindowId
      });
      return;
    }

    console.log("[CT TRACE] onWinCreated", {
      windowId: win.id,
      type: win.type,
      focused: !!win.focused,
      tracked: !!stateManager.findByChrome("branch", win.id)
    });

    const r = stateManager.apply({ op: "SYNC_ADD_BRANCH", chromeWin: win });
    console.log("[CT TRACE] onWinCreated:result", { windowId: win.id, result: r });

    if (r.ok) _notify();
  }

  function onWinRemoved(winId) {
    if (winId === _panelWindowId) {
      console.log("[CT TRACE] onWinRemoved:panel", { windowId: winId });
      _panelWindowId = null;
      _panelTabId = null;
      return;
    }

    console.log("[CT TRACE] onWinRemoved", {
      windowId: winId,
      tracked: !!stateManager.findByChrome("branch", winId)
    });

    const r = stateManager.apply({ op: "SYNC_REMOVE", kind: "branch", chromeId: winId });
    console.log("[CT TRACE] onWinRemoved:result", { windowId: winId, result: r });

    if (r.ok) _notify();
  }

  function onWinFocusChanged(winId) {
    console.log("[CT TRACE] onWinFocusChanged", {
      windowId: winId,
      tracked: !!stateManager.findByChrome("branch", winId)
    });

    const r = stateManager.apply({ op: "SYNC_WIN_FOCUS", chromeWindowId: winId });
    console.log("[CT TRACE] onWinFocusChanged:result", { windowId: winId, result: r });

    if (r.ok) _notify();
  }

  // ─── Execute chrome side effects ───
  function executeSideEffects(effects) {
    if (!effects) return;
    console.log("[CT TRACE] executeSideEffects", effects);

    for (const eff of effects) {
      switch (eff.type) {
        case "CHROME_MOVE_TAB":
          if (eff.toWin) chrome.tabs.move(eff.tabId, { windowId: eff.toWin, index: -1 }).catch(() => {});
          else chrome.windows.create({ tabId: eff.tabId }).catch(() => {});
          break;
        case "CHROME_CLOSE_WINDOW":
          chrome.windows.remove(eff.windowId).catch(() => {});
          break;
      }
    }
  }

  // ─── Register all Chrome listeners ───
  function registerListeners(onUpdateCb) {
    _onUpdate = onUpdateCb;
    chrome.tabs.onCreated.addListener(onTabCreated);
    chrome.tabs.onRemoved.addListener(onTabRemoved);
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.onMoved.addListener(onTabMoved);
    chrome.tabs.onAttached.addListener(onTabAttached);
    chrome.tabs.onDetached.addListener(onTabDetached);
    chrome.tabs.onActivated.addListener(onTabActivated);
    chrome.tabs.onReplaced.addListener(onTabReplaced);
    chrome.windows.onCreated.addListener(onWinCreated);
    chrome.windows.onRemoved.addListener(onWinRemoved);
    chrome.windows.onFocusChanged.addListener(onWinFocusChanged);

    console.log("[CT TRACE] registerListeners");
  }

  function _notify() {
    console.log("[CT TRACE] notify");
    if (_onUpdate) _onUpdate();
  }

  return {
    reconcile, registerListeners, executeSideEffects,
    setPanelIds, getPanelTabId, getPanelWindowId,
    isPanelTab, isPanelWin,
  };
})();