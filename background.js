// Opens (or refocuses) a floating popup window for the control panel when the
// toolbar icon is clicked, instead of a pinned side panel.
let panelWindowId = null;

chrome.action.onClicked.addListener(async () => {
  if (panelWindowId !== null) {
    try {
      await chrome.windows.update(panelWindowId, { focused: true });
      return;
    } catch (e) {
      panelWindowId = null; // window was closed since we last tracked it
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('sidepanel.html'),
    type: 'popup',
    width: 380,
    height: 700
  });
  panelWindowId = win.id;
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === panelWindowId) panelWindowId = null;
});

// Explicitly targets the last-focused *normal* browser window, excluding our own
// floating control-panel window — otherwise, whenever the panel itself has focus,
// commands could end up acting on the panel instead of the page you're browsing.
async function getActiveTab() {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  if (!win) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return tab;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleCommand(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // keep the message channel open for the async response
});

async function handleCommand(msg) {
  const tab = await getActiveTab();
  if (!tab) return { ok: false, error: 'no active tab' };

  switch (msg.type) {
    case 'scroll':
    case 'scrollTo':
    case 'cursorInit':
    case 'cursorMove':
    case 'cursorClick':
    case 'cursorRemove':
      // these fire frequently (up to ~20x/sec) — relay to the persistent content
      // script rather than injecting a fresh script via executeScript every time,
      // which is real overhead at that rate and was a contributor to overall lag
      await chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      return { ok: true };

    case 'getZoom': {
      const zoom = await chrome.tabs.getZoom(tab.id);
      return { ok: true, zoom };
    }

    case 'zoom': {
      const current = await chrome.tabs.getZoom(tab.id);
      const next = msg.absolute
        ? clamp(msg.factor, 0.25, 5)
        : clamp(current * msg.factor, 0.25, 5);
      await chrome.tabs.setZoom(tab.id, next);
      return { ok: true, zoom: next };
    }

    case 'navigate':
      await chrome.tabs.update(tab.id, { url: msg.url });
      return { ok: true };

    case 'back':
      await chrome.tabs.goBack(tab.id);
      return { ok: true };

    case 'forward':
      await chrome.tabs.goForward(tab.id);
      return { ok: true };

    case 'refresh':
      await chrome.tabs.reload(tab.id);
      return { ok: true };

    case 'newTab':
      await chrome.tabs.create({});
      return { ok: true };

    case 'closeTab':
      await chrome.tabs.remove(tab.id);
      return { ok: true };

    case 'switchTab': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      tabs.sort((a, b) => a.index - b.index);
      const idx = tabs.findIndex((t) => t.id === tab.id);
      if (idx === -1) return { ok: false };
      const nextIdx = (idx + (msg.dir === 'next' ? 1 : -1) + tabs.length) % tabs.length;
      await chrome.tabs.update(tabs[nextIdx].id, { active: true });
      return { ok: true };
    }

    default:
      return { ok: false, error: 'unknown command: ' + msg.type };
  }
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}
