"use strict";

// Load engine modules — order matters: stateManager first, then persistence, then chromeSync
importScripts("stateManager.js", "persistence.js", "chromeSync.js");

/*
 * background.js — Coon Tree Orchestrator
 *
 * Thin coordination layer only.
 * Tree logic lives in stateManager / chromeSync / persistence.
 */

const PANEL_URL = chrome.runtime.getURL("panel.html");

let panelMode = "popup";
let focusedWindowId = null;
let selectedNodeId = null;
let theme = "dark";
let customBg = null;
let connectedPorts = [];

init().catch((e) => {
  console.error("[CT] init crashed", e);
});

async function init() {
  await persistence.load();

  const settings = await persistence.loadSettings();
  if (settings.panelMode) panelMode = settings.panelMode;
  if (settings.theme) theme = settings.theme;
  if (settings.customBg) customBg = settings.customBg;

  await chromeSync.reconcile();
  persistence.scheduleSave();

  chromeSync.registerListeners(() => {
    persistence.scheduleSave();
    broadcastTree();
  });

  chrome.action.onClicked.addListener(openPanel);

  chrome.commands.onCommand.addListener((cmd) => {
    if (cmd === "save_close_current_window") {
      chrome.windows.getCurrent((w) => {
        if (w) userAction({ action: "save-and-close-window", chromeId: w.id });
      });
    }
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== "ct-panel") return;

    connectedPorts.push(port);

    port.onMessage.addListener((msg) => {
      try {
        userAction(msg, port);
      } catch (e) {
        console.error("[CT] port message handling failed", e, msg);
      }
    });

    port.onDisconnect.addListener(() => {
      connectedPorts = connectedPorts.filter((p) => p !== port);
    });

    port.postMessage({ ...buildTreeMsg(), type: "full-tree" });
  });

  chrome.action.setBadgeText({ text: "" });
}

async function openPanel() {
  const panelWinId = chromeSync.getPanelWindowId();
  const panelTabId = chromeSync.getPanelTabId();

  if (panelWinId) {
    try {
      await chrome.windows.update(panelWinId, { focused: true });
      return;
    } catch (e) {
      chromeSync.setPanelIds(null, null);
    }
  }

  if (panelTabId) {
    try {
      const t = await chrome.tabs.get(panelTabId);
      await chrome.windows.update(t.windowId, { focused: true });
      await chrome.tabs.update(panelTabId, { active: true });
      return;
    } catch (e) {
      chromeSync.setPanelIds(null, null);
    }
  }

  if (panelMode === "popup") {
    const w = await chrome.windows.create({
      url: PANEL_URL,
      type: "popup",
      width: 420,
      height: 800,
      left: 0,
      top: 0
    });
    chromeSync.setPanelIds((w.tabs && w.tabs[0] && w.tabs[0].id) || null, w.id);
  } else {
    const t = await chrome.tabs.create({ url: PANEL_URL });
    chromeSync.setPanelIds(t.id, null);
  }
}

async function togglePanelMode() {
  const panelWinId = chromeSync.getPanelWindowId();
  const panelTabId = chromeSync.getPanelTabId();

  if (panelWinId) {
    try {
      await chrome.windows.remove(panelWinId);
    } catch (e) {}
  } else if (panelTabId) {
    try {
      await chrome.tabs.remove(panelTabId);
    } catch (e) {}
  }

  chromeSync.setPanelIds(null, null);

  panelMode = panelMode === "popup" ? "tab" : "popup";
  saveSettings();
  await openPanel();
}

function saveSettings() {
  persistence.saveSettings({ panelMode, theme, customBg });
}

function buildTreeMsg() {
  return {
    type: "tree-update",
    tree: stateManager.getTree(),
    focusedWindowId,
    selectedNodeId,
    panelMode,
    theme,
    customBg
  };
}

function broadcastTree() {
  const msg = buildTreeMsg();

  connectedPorts.forEach((p) => {
    try {
      p.postMessage(msg);
    } catch (e) {}
  });
}

function userAction(msg, port) {
  if (!msg || !msg.action) return;

  switch (msg.action) {
    case "activate-tab":
      if (msg.chromeId) chrome.tabs.update(msg.chromeId, { active: true }).catch(() => {});
      if (msg.windowId) chrome.windows.update(msg.windowId, { focused: true }).catch(() => {});
      break;

    case "close-tab":
      safeApply({ op: "SYNC_REMOVE", kind: "tab", chromeId: msg.chromeId }, true);
      chrome.tabs.remove(msg.chromeId).catch(() => {});
      break;

    case "close-window":
      safeApply({ op: "SYNC_REMOVE", kind: "branch", chromeId: msg.chromeId }, true);
      chrome.windows.remove(msg.chromeId).catch(() => {});
      break;

    case "save-and-close-window": {
      const branch = stateManager.findByChrome("branch", msg.chromeId);
      if (!branch) break;
      const r = safeApply({ op: "SAVE_AND_CLOSE", nodeId: branch.id }, true);
      if (r.ok && r.sideEffects) chromeSync.executeSideEffects(r.sideEffects);
      break;
    }

    case "toggle-panel-mode":
      togglePanelMode();
      break;

    case "restore-window": {
      const urls = stateManager.collectUrls(msg.nodeId);
      if (!urls.length) urls.push("chrome://newtab");
      safeApply({ op: "REMOVE", nodeId: msg.nodeId }, true);
      chrome.windows.create({ url: urls });
      break;
    }

    case "restore-tab": {
      const nd = stateManager.getNode(msg.nodeId);
      if (!nd || !nd.url) break;
      safeApply({ op: "REMOVE", nodeId: msg.nodeId }, true);
      chrome.tabs.create({ url: nd.url });
      break;
    }

    case "remove-node":
      safeApply({ op: "REMOVE", nodeId: msg.nodeId }, true);
      break;

    case "toggle-collapse": {
      const nd = stateManager.getNode(msg.nodeId);
      if (nd) {
        stateManager.apply({
          op: "PATCH",
          nodeId: msg.nodeId,
          props: { collapsed: !nd.collapsed }
        });
        broadcastTree();
        persistence.scheduleSave();
      }
      break;
    }

    case "collapse-all":
      stateManager.walkSubtree("root", (n) => {
        if (n.children && n.children.length > 0) n.collapsed = true;
      });
      stateManager.forceReindex();
      broadcastTree();
      persistence.scheduleSave();
      break;

    case "expand-all":
      stateManager.walkSubtree("root", (n) => {
        n.collapsed = false;
      });
      stateManager.forceReindex();
      broadcastTree();
      persistence.scheduleSave();
      break;

    case "select-node":
      selectedNodeId = msg.nodeId;
      broadcastTree();
      break;

    case "add-group":
      safeApply(
        { op: "APPEND", parentId: msg.targetId, node: stateManager.makeGroup(msg.title) },
        true
      );
      break;

    case "add-note":
      safeApply(
        { op: "APPEND", parentId: msg.targetId, node: stateManager.makeMemo(msg.text) },
        true
      );
      break;

    case "add-separator":
      safeApply(
        { op: "APPEND", parentId: msg.targetId, node: stateManager.makeDivider() },
        true
      );
      break;

    case "rename-node": {
      const nd = stateManager.getNode(msg.nodeId);
      if (!nd) break;

      const props = nd.kind === "memo"
        ? { title: msg.newTitle }
        : { customTitle: msg.newTitle };

      safeApply({ op: "PATCH", nodeId: msg.nodeId, props }, true);
      break;
    }

    case "set-color":
      safeApply(
        { op: "PATCH", nodeId: msg.nodeId, props: { customColor: msg.color || null } },
        true
      );
      break;

    case "set-custom-icon":
      safeApply(
        { op: "PATCH", nodeId: msg.nodeId, props: { customIcon: msg.iconData || null } },
        true
      );
      break;

    case "set-theme":
      theme = msg.theme || "dark";
      customBg = msg.customBg !== undefined ? msg.customBg : customBg;
      saveSettings();
      broadcastTree();
      break;

    case "set-custom-bg":
      customBg = msg.data || null;
      saveSettings();
      broadcastTree();
      break;

    case "undo":
      if (persistence.popUndo()) {
        broadcastTree();
        persistence.scheduleSave();
      }
      break;

    case "save-selected": {
      persistence.pushUndo();

      const nd = msg.nodeId ? stateManager.getNode(msg.nodeId) : null;

      if (nd) {
        const cp = stateManager.cloneAsKept(nd.id);
        if (cp) safeApply({ op: "INSERT_AFTER", afterId: nd.id, node: cp }, false);
      } else {
        const pstDate = new Date().toLocaleString("en-US", {
          timeZone: "America/Los_Angeles",
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true
        });

        const g = stateManager.makeGroup(pstDate);
        const tree = stateManager.getTree();

        tree.children.forEach((c) => {
          if (c.kind === "branch" && c.state === "live") {
            const cp = stateManager.cloneAsKept(c.id);
            if (cp) g.children.push(cp);
          }
        });

        safeApply({ op: "APPEND", parentId: null, node: g }, false);
      }

      break;
    }

    case "save-tab-copy": {
      const nd = stateManager.getNode(msg.nodeId);
      if (!nd || nd.kind !== "tab" || nd.state !== "live") break;

      const pstDate = new Date().toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      });

      const cp = {
        ...nd,
        id: stateManager.newId(),
        state: "kept",
        chromeId: null,
        savedDate: Date.now(),
        customTitle: msg.name || pstDate,
        children: []
      };

      safeApply({ op: "INSERT_AFTER", afterId: nd.id, node: cp }, true);
      break;
    }

    case "move-node": {
      const r = safeApply(
        { op: "RELOCATE", sourceId: msg.sourceId, targetId: msg.targetId, slot: msg.slot },
        true
      );
      if (r.ok && r.sideEffects) chromeSync.executeSideEffects(r.sideEffects);
      break;
    }

    case "duplicate-node": {
      const cp = stateManager.cloneAsKept(msg.nodeId);
      if (cp) safeApply({ op: "INSERT_AFTER", afterId: msg.nodeId, node: cp }, true);
      break;
    }

    case "copy-node": {
      const cp = stateManager.cloneAsKept(msg.nodeId);
      if (cp && port) {
        port.postMessage({
          type: "clipboard-data",
          data: JSON.stringify(cp)
        });
      }
      break;
    }

    case "paste-node": {
      try {
        const parsed = JSON.parse(msg.data);
        stateManager.assignFreshIds(parsed);
        safeApply({ op: "APPEND", parentId: msg.parentId, node: parsed }, true);
      } catch (e) {}
      break;
    }

    case "paste-text": {
      try {
        const text = msg.text;

        try {
          const parsed = JSON.parse(text);
          stateManager.assignFreshIds(parsed);
          safeApply({ op: "APPEND", parentId: msg.parentId, node: parsed }, true);
          break;
        } catch (e) {}

        const lines = text.split("\n").map((l) => l.trim()).filter((l) => l);

        if (lines.some((l) => l.startsWith("http"))) {
          const pstDate = new Date().toLocaleString("en-US", {
            timeZone: "America/Los_Angeles",
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true
          });

          const g = stateManager.makeGroup(pstDate);

          lines.forEach((l) => {
            const m = l.match(/(https?:\/\/\S+)/);
            if (m) {
              const url = m[1].replace(/[)>]$/, "");
              const title = l.replace(m[0], "").replace(/[()]/g, "").trim() || url;

              g.children.push({
                id: stateManager.newId(),
                kind: "tab",
                state: "kept",
                title,
                url,
                favIconUrl: "",
                children: [],
                collapsed: false
              });
            }
          });

          if (g.children.length) {
            safeApply({ op: "APPEND", parentId: msg.parentId, node: g }, true);
          }
        }
      } catch (e) {}
      break;
    }

    case "copy-urls": {
      const urls = stateManager.collectUrls(msg.nodeId);
      if (port) {
        port.postMessage({
          type: "urls-data",
          urls: urls.join("\n")
        });
      }
      break;
    }

    case "export-tree": {
      const exported = persistence.exportTree();
      if (port) {
        port.postMessage({
          type: "export-data",
          data: JSON.stringify(exported, null, 2)
        });
      }
      break;
    }

    case "import-tree": {
      try {
        const data = JSON.parse(msg.data);
        persistence.pushUndo();
        const imported = persistence.prepareImport(data);

        if (imported && imported.children) {
          for (const child of imported.children) {
            safeApply({ op: "APPEND", parentId: null, node: child }, false);
          }
        }
      } catch (e) {
        console.warn("Import error", e);
      }
      break;
    }

    default:
      console.log("[CT] unhandled action:", msg.action, msg);
      break;
  }
}

function safeApply(action, withUndo) {
  persistence.writeWAL();

  if (withUndo) persistence.pushUndo();

  const result = stateManager.apply(action);

  persistence.clearWAL();

  if (result && result.ok) {
    persistence.scheduleSave();
    broadcastTree();
  }

  return result;
}