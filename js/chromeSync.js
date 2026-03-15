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

    // [CT002]
    console.log("[CT TRACE] reconcile", { windows: liveWinIds.length, tabs: liveTabIds.length, panelTabId: _panelTabId, panelWindowId: _panelWindowId });

    // Phase 1: Prune dead nodes
    stateManager.apply({ op: "RECONCILE_PRUNE", liveWindowIds: liveWinIds, liveTabIds });

    // Phase 2: Add windows/tabs that aren't tracked yet
    for (const win of wins) {
      if (isPanelWin(win)) continue;
      let branchNode = stateManager.findByChrome("branch", win.id);
      if (!branchNode) {
        const r = stateManager.apply({ op: "SYNC_ADD_BRANCH", chromeWin: win });
        if (r.ok) branchNode = stateManager.getNode(r.nodeId);
      }
      if (!branchNode) continue;

      // Update focus
      stateManager.apply({ op: "SYNC_WIN_FOCUS", chromeWindowId: win.focused ? win.id : -1 });

      for (const tab of win.tabs) {
        if (isPanelTab(tab)) continue;
        const existing = stateManager.findByChrome("tab", tab.id);
        if (!existing) {
          stateManager.apply({ op: "SYNC_ADD_TAB", chromeTab: tab, parentNodeId: branchNode.id });
        } else {
          stateManager.apply({ op: "SYNC_UPDATE_TAB", nodeId: existing.id, changes: tab });
        }
      }

      // Reorder to match Chrome's actual order
      stateManager.apply({
        op: "SYNC_REORDER_TABS",
        branchNodeId: branchNode.id,
        chromeTabOrder: win.tabs.filter(t => !isPanelTab(t)).map(t => t.id)
      });
    }
  }

  // ─── Event handlers ───
  function onTabCreated(tab) {
    if (isPanelTab(tab)) { _panelTabId = tab.id; return; }
    const branch = stateManager.findByChrome("branch", tab.windowId);
    // [CT002]
    console.log("[CT TRACE] onTabCreated", { tabId: tab.id, windowId: tab.windowId, branchFound: !!branch, tracked: !!stateManager.findByChrome("tab", tab.id) });
    if (!branch) return;
    // Duplicate check is inside stateManager — will reject if already tracked
    const r = stateManager.apply({ op: "SYNC_ADD_TAB", chromeTab: tab, parentNodeId: branch.id });
    if (r.ok) _notify();
  }

  function onTabRemoved(tabId) {
    if (tabId === _panelTabId) { _panelTabId = null; return; }
    // [CT002]
    console.log("[CT TRACE] onTabRemoved", { tabId, tracked: !!stateManager.findByChrome("tab", tabId) });
    const r = stateManager.apply({ op: "SYNC_REMOVE", kind: "tab", chromeId: tabId });
    if (r.ok) _notify();
  }

  function onTabUpdated(tabId, changeInfo, tab) {
    if (isPanelTab(tab)) return;
    const node = stateManager.findByChrome("tab", tabId);
    // [CT002]
    console.log("[CT TRACE] onTabUpdated", { tabId, windowId: tab.windowId, found: !!node, keys: Object.keys(changeInfo) });
    if (!node) return;
    const r = stateManager.apply({ op: "SYNC_UPDATE_TAB", nodeId: node.id, changes: changeInfo });
    if (r.ok) _notify();
  }

  function onTabMoved(tabId, moveInfo) {
    // [CT002]
    console.log("[CT TRACE] onTabMoved", { tabId, windowId: moveInfo.windowId, toIndex: moveInfo.toIndex });
    const r = stateManager.apply({
      op: "SYNC_TAB_MOVED",
      chromeTabId: tabId,
      toIndex: moveInfo.toIndex,
      chromeWindowId: moveInfo.windowId
    });
    if (r.ok) _notify();
  }

  function onTabDetached(tabId) {
    // [CT002]
    console.log("[CT TRACE] onTabDetached", { tabId, tracked: !!stateManager.findByChrome("tab", tabId) });
    // Tab is temporarily homeless — remove from tree (will be re-added on attach)
    const r = stateManager.apply({ op: "SYNC_REMOVE", kind: "tab", chromeId: tabId });
    if (r.ok) _notify();
  }

  function onTabAttached(tabId, attachInfo) {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError || !tab) return;
      const branch = stateManager.findByChrome("branch", attachInfo.newWindowId);
      // [CT002]
      console.log("[CT TRACE] onTabAttached", { tabId, newWindowId: attachInfo.newWindowId, newPosition: attachInfo.newPosition, branchFound: !!branch, tracked: !!stateManager.findByChrome("tab", tabId) });
      if (!branch) return;
      const r = stateManager.apply({
        op: "SYNC_TAB_ATTACHED",
        chromeTab: tab,
        branchNodeId: branch.id,
        position: attachInfo.newPosition
      });
      if (r.ok) _notify();
    });
  }

  function onTabActivated(activeInfo) {
    // [CT002]
    console.log("[CT TRACE] onTabActivated", { tabId: activeInfo.tabId, windowId: activeInfo.windowId });
    const r = stateManager.apply({
      op: "SYNC_TAB_ACTIVATED",
      chromeWindowId: activeInfo.windowId,
      chromeTabId: activeInfo.tabId
    });
    if (r.ok) _notify();
  }

  function onWinCreated(win) {
    if ((win.type !== "normal" && win.type !== "popup") || win.id === _panelWindowId) return;
    // [CT002]
    console.log("[CT TRACE] onWinCreated", { windowId: win.id, type: win.type });
    const r = stateManager.apply({ op: "SYNC_ADD_BRANCH", chromeWin: win });
    if (r.ok) _notify();
  }

  function onWinRemoved(winId) {
    if (winId === _panelWindowId) { _panelWindowId = null; _panelTabId = null; return; }
    // [CT002]
    console.log("[CT TRACE] onWinRemoved", { windowId: winId, tracked: !!stateManager.findByChrome("branch", winId) });
    const r = stateManager.apply({ op: "SYNC_REMOVE", kind: "branch", chromeId: winId });
    if (r.ok) _notify();
  }

  function onWinFocusChanged(winId) {
    const r = stateManager.apply({ op: "SYNC_WIN_FOCUS", chromeWindowId: winId });
    if (r.ok) _notify();
  }

  // ─── Execute chrome side effects ───
  function executeSideEffects(effects) {
    if (!effects) return;
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
    chrome.windows.onCreated.addListener(onWinCreated);
    chrome.windows.onRemoved.addListener(onWinRemoved);
    chrome.windows.onFocusChanged.addListener(onWinFocusChanged);
  }

  function _notify() { if (_onUpdate) _onUpdate(); }

  return {
    reconcile, registerListeners, executeSideEffects,
    setPanelIds, getPanelTabId, getPanelWindowId,
    isPanelTab, isPanelWin,
  };
})();
