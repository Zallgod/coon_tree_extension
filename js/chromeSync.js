"use strict";

/*
 * chromeSync.js — Chrome ↔ State Bridge
 */

const chromeSync = (() => {
  let _panelTabId = null;
  let _panelWindowId = null;
  let _onUpdate = null;

  const PANEL_URL = chrome.runtime.getURL("panel.html");

  function isPanelTab(tab) {
    return (
      tab.id === _panelTabId ||
      tab.url === PANEL_URL ||
      tab.pendingUrl === PANEL_URL
    );
  }

  function isPanelWin(win) {
    return (
      win.id === _panelWindowId ||
      (win.tabs && win.tabs.some(t => t.url === PANEL_URL || t.id === _panelTabId))
    );
  }

  function setPanelIds(tabId, winId) {
    _panelTabId = tabId;
    _panelWindowId = winId;
  }

  function getPanelTabId() {
    return _panelTabId;
  }

  function getPanelWindowId() {
    return _panelWindowId;
  }

  async function reconcile() {
    const wins = await chrome.windows.getAll({ populate: true });
    const liveWinIds = [];
    const liveTabIds = [];

    for (const win of wins) {
      if (win.type !== "normal" || isPanelWin(win)) continue;

      liveWinIds.push(win.id);

      for (const tab of win.tabs) {
        if (isPanelTab(tab)) continue;
        liveTabIds.push(tab.id);
      }
    }

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT TRACE] reconcile:start", {
      windows: liveWinIds,
      tabs: liveTabIds,
      panelTabId: _panelTabId,
      panelWindowId: _panelWindowId
    });

    const pruneResult = stateManager.apply({
      op: "RECONCILE_PRUNE",
      liveWindowIds: liveWinIds,
      liveTabIds
    });

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT TRACE] reconcile:pruneResult", pruneResult);

    for (const win of wins) {
      if (win.type !== "normal" || isPanelWin(win)) continue;

      let branchNode = stateManager.findByChrome("branch", win.id);

      if (!branchNode) {
        const r = stateManager.apply({
          op: "SYNC_ADD_BRANCH",
          chromeWin: win
        });

        if (r.ok) branchNode = stateManager.getNode(r.nodeId);
      }

      if (!branchNode) continue;

      stateManager.apply({
        op: "SYNC_WIN_FOCUS",
        chromeWindowId: win.focused ? win.id : -1
      });

      for (const tab of win.tabs) {
        if (isPanelTab(tab)) continue;

        const existing = stateManager.findByChrome("tab", tab.id);

        if (!existing) {
          stateManager.apply({
            op: "SYNC_ADD_TAB",
            chromeTab: tab,
            parentNodeId: branchNode.id
          });
        } else {
          stateManager.apply({
            op: "SYNC_UPDATE_TAB",
            nodeId: existing.id,
            changes: tab
          });
        }
      }

      stateManager.apply({
        op: "SYNC_REORDER_TABS",
        branchNodeId: branchNode.id,
        chromeTabOrder: win.tabs
          .filter(t => !isPanelTab(t))
          .map(t => t.id)
      });
    }

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT TRACE] reconcile:end");
  }

  function onTabCreated(tab) {

    // DEBUG LOG (temporary)
    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT DEBUG] TAB OBJECT", tab);

    if (isPanelTab(tab)) {
      if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT TRACE] onTabCreated:panel", {
        tabId: tab.id,
        windowId: tab.windowId
      });
      _panelTabId = tab.id;
      return;
    }

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT EVENT] tabs.onCreated", {
      tabId: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      url: tab.url || tab.pendingUrl || ""
    });

    const branch = stateManager.findByChrome("branch", tab.windowId);

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT TRACE] onTabCreated", {
      tabId: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      branchFound: !!branch,
      tracked: !!stateManager.findByChrome("tab", tab.id)
    });

    if (!branch) return;

    const r = stateManager.apply({
      op: "SYNC_ADD_TAB",
      chromeTab: tab,
      parentNodeId: branch.id
    });

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT TRACE] onTabCreated:result", {
      tabId: tab.id,
      result: r
    });

    if (r.ok) _notify();
  }

  function onTabRemoved(tabId, removeInfo) {

    if (tabId === _panelTabId) {
      if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT TRACE] onTabRemoved:panel", { tabId });
      _panelTabId = null;
      return;
    }

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT EVENT] tabs.onRemoved", {
      tabId: tabId,
      windowId: removeInfo.windowId,
      isWindowClosing: removeInfo.isWindowClosing
    });

    const r = stateManager.apply({
      op: "SYNC_REMOVE",
      kind: "tab",
      chromeId: tabId
    });

    if (r.ok) _notify();
  }

  function onTabUpdated(tabId, changeInfo, tab) {

    if (isPanelTab(tab)) return;

    const node = stateManager.findByChrome("tab", tabId);
    if (!node) return;

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT EVENT] tabs.onUpdated", {
      tabId: tabId,
      windowId: tab.windowId,
      changed: Object.keys(changeInfo),
      url: changeInfo.url || undefined
    });

    const r = stateManager.apply({
      op: "SYNC_UPDATE_TAB",
      nodeId: node.id,
      changes: changeInfo
    });

    if (r.ok) _notify();
  }

  function onTabMoved(tabId, moveInfo) {

    if (isPanelTab({ id: tabId })) return;

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT EVENT] tabs.onMoved", {
      tabId: tabId,
      windowId: moveInfo.windowId,
      fromIndex: moveInfo.fromIndex,
      toIndex: moveInfo.toIndex
    });

    const r = stateManager.apply({
      op: "SYNC_TAB_MOVED",
      chromeTabId: tabId,
      toIndex: moveInfo.toIndex,
      chromeWindowId: moveInfo.windowId
    });

    if (r.ok) _notify();
  }

  function onTabDetached(tabId, detachInfo) {

    if (isPanelTab({ id: tabId })) return;

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT EVENT] tabs.onDetached", {
      tabId: tabId,
      windowId: detachInfo.oldWindowId,
      oldPosition: detachInfo.oldPosition
    });

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT TRACE] onTabDetached", {
      tabId,
      detachInfo
    });
  }

  function onTabAttached(tabId, attachInfo) {

    chrome.tabs.get(tabId, tab => {

      if (chrome.runtime.lastError || !tab) return;

      if (isPanelTab(tab)) return;

      if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT EVENT] tabs.onAttached", {
        tabId: tabId,
        windowId: attachInfo.newWindowId,
        newPosition: attachInfo.newPosition,
        url: tab.url || ""
      });

      const branch = stateManager.findByChrome(
        "branch",
        attachInfo.newWindowId
      );

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

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT EVENT] tabs.onActivated", {
      tabId: activeInfo.tabId,
      windowId: activeInfo.windowId
    });

    const r = stateManager.apply({
      op: "SYNC_TAB_ACTIVATED",
      chromeWindowId: activeInfo.windowId,
      chromeTabId: activeInfo.tabId
    });

    if (r.ok) _notify();
  }

  function onWinCreated(win) {

    if (win.type !== "normal" || isPanelWin(win)) {
      return;
    }

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT EVENT] windows.onCreated", {
      windowId: win.id,
      windowType: win.type,
      focused: win.focused
    });

    const r = stateManager.apply({
      op: "SYNC_ADD_BRANCH",
      chromeWin: win
    });

    if (r.ok) _notify();
  }

  function onWinRemoved(winId) {

    if (winId === _panelWindowId) {
      _panelWindowId = null;
      _panelTabId = null;
      return;
    }

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT EVENT] windows.onRemoved", {
      windowId: winId
    });

    const r = stateManager.apply({
      op: "SYNC_REMOVE",
      kind: "branch",
      chromeId: winId
    });

    if (r.ok) _notify();
  }

  function onWinFocusChanged(winId) {

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT EVENT] windows.onFocusChanged", {
      windowId: winId
    });

    const r = stateManager.apply({
      op: "SYNC_WIN_FOCUS",
      chromeWindowId: winId
    });

    if (r.ok) _notify();
  }

  function executeSideEffects(effects) {

    if (!effects) return;

    for (const eff of effects) {

      switch (eff.type) {

        case "CHROME_MOVE_TAB":

          if (eff.toWin) {
            chrome.tabs.move(eff.tabId, {
              windowId: eff.toWin,
              index: -1
            }).catch(() => {});
          } else {
            chrome.windows.create({
              tabId: eff.tabId
            }).catch(() => {});
          }

          break;

        case "CHROME_CLOSE_WINDOW":

          chrome.windows.remove(eff.windowId).catch(() => {});
          break;
      }
    }
  }

  function registerListeners(onUpdateCb) {

    _onUpdate = onUpdateCb;

    chrome.tabs.onCreated.addListener(onTabCreated);
    chrome.tabs.onRemoved.addListener(onTabRemoved);
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.onMoved.addListener(onTabMoved);
    chrome.tabs.onAttached.addListener(onTabAttached);
    chrome.tabs.onDetached.addListener(onTabDetached);
    chrome.tabs.onActivated.addListener(onTabActivated);
    chrome.tabs.onReplaced.addListener(() => {});

    chrome.windows.onCreated.addListener(onWinCreated);
    chrome.windows.onRemoved.addListener(onWinRemoved);
    chrome.windows.onFocusChanged.addListener(onWinFocusChanged);

    if (CT_DEBUG.all || CT_DEBUG.lifecycle) console.log("[CT TRACE] registerListeners");
  }

  function _notify() {
    if (_onUpdate) _onUpdate();
  }

  return {
    reconcile,
    registerListeners,
    executeSideEffects,
    setPanelIds,
    getPanelTabId,
    getPanelWindowId,
    isPanelTab,
    isPanelWin
  };
})();
