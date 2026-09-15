// Runs once per page and stays alive, listening for lightweight messages from the
// side panel (relayed through background.js). This avoids the overhead of injecting
// a brand-new script via chrome.scripting.executeScript on every single frame for
// high-frequency actions like scrolling or moving the gesture cursor.

let cursorEl = null;

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'scroll':
      window.scrollBy({ top: msg.dy, left: 0, behavior: 'auto' });
      break;

    case 'scrollTo':
      window.scrollTo({ top: msg.pos === 'top' ? 0 : document.body.scrollHeight, behavior: 'smooth' });
      break;

    case 'cursorInit':
      if (!cursorEl) {
        cursorEl = document.createElement('div');
        cursorEl.id = '__gestureCursor';
        cursorEl.style.cssText =
          'position:fixed;top:0;left:0;width:18px;height:18px;border-radius:50%;' +
          'background:rgba(255,211,123,0.85);border:2px solid white;' +
          'box-shadow:0 0 10px rgba(255,211,123,0.8);pointer-events:none;' +
          'z-index:2147483647;transform:translate(-50%,-50%);';
        document.documentElement.appendChild(cursorEl);
      }
      break;

    case 'cursorMove':
      if (cursorEl) {
        cursorEl.style.left = (msg.nx * document.documentElement.clientWidth) + 'px';
        cursorEl.style.top = (msg.ny * document.documentElement.clientHeight) + 'px';
      }
      break;

    case 'cursorClick':
      if (cursorEl) {
        const rect = cursorEl.getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        // pointer-events:none on the cursor means elementFromPoint sees straight through
        // it to whatever's actually underneath
        const el = document.elementFromPoint(x, y);
        cursorEl.style.transform = 'translate(-50%,-50%) scale(0.55)';
        setTimeout(() => { if (cursorEl) cursorEl.style.transform = 'translate(-50%,-50%) scale(1)'; }, 130);
        // .click() (not a dispatched MouseEvent) triggers real default behavior like
        // link navigation and form submission, the same way a genuine user click does
        if (el && typeof el.click === 'function') el.click();
      }
      break;

    case 'cursorRemove':
      if (cursorEl) { cursorEl.remove(); cursorEl = null; }
      break;
  }
});
