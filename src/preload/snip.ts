// ── Area-screenshot overlay preload ──
// Runs in the borderless overlay window that covers the game window. The main process sends a frozen
// copy of the game view; the user drags a rectangle over it (Snipping Tool style) and the selection
// is sent back in overlay CSS pixels. Esc or right-click cancels.
// Like the Snipping Tool: hold Shift while dragging for a perfect square, hold Space while dragging to move the
// box, and tap Shift once (without dragging) to capture the whole window.
import { ipcRenderer } from 'electron';

interface InitData { image: string; scale: number }

ipcRenderer.on('krh-snip-init', (_e, data: InitData) => {
  const doc = document;
  doc.title = 'KRH Screenshot';
  const style = doc.createElement('style');
  style.textContent = `
    html, body { margin: 0; height: 100%; overflow: hidden; background: #000; cursor: crosshair; user-select: none; }
    #bg { position: fixed; inset: 0; width: 100%; height: 100%; display: block; pointer-events: none; }
    #dim { position: fixed; inset: 0; background: rgba(0,0,0,0.45); pointer-events: none; }
    #sel { position: fixed; display: none; border: 1px solid #4da3ff; box-shadow: 0 0 0 100vmax rgba(0,0,0,0.45); pointer-events: none; box-sizing: border-box; }
    #size { position: fixed; display: none; padding: 2px 7px; background: #111c; color: #fff; font: 12px/18px system-ui, sans-serif; border-radius: 4px; pointer-events: none; white-space: nowrap; }
    #hint { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); padding: 7px 14px; background: #111d; color: #fff;
            font: 13px/18px system-ui, sans-serif; border-radius: 8px; pointer-events: none; white-space: nowrap; }
  `;
  doc.head.appendChild(style);

  const bg = doc.createElement('img'); bg.id = 'bg'; bg.src = data.image; bg.draggable = false;
  const dim = doc.createElement('div'); dim.id = 'dim';
  const sel = doc.createElement('div'); sel.id = 'sel';
  const size = doc.createElement('div'); size.id = 'size';
  const hint = doc.createElement('div'); hint.id = 'hint';
  hint.textContent = 'Drag to select the area   \u2022   Hold Shift: square   \u2022   Hold Space: move   \u2022   Tap Shift: whole window   \u2022   Esc: cancel';
  doc.body.append(bg, dim, sel, size, hint);

  // The box runs from a fixed corner (ax, ay) to the corner under the mouse (bx, by).
  let ax = 0, ay = 0, bx = 0, by = 0, lastX = 0, lastY = 0, dragging = false;
  let shiftDown = false, spaceDown = false;
  let shiftArmed = false; // a Shift press seen by this overlay (Shift still held from Shift+F9 must not count)
  let shiftUsed = false; // Shift was used for something else (dragging): releasing it is not a tap
  let rect = { x: 0, y: 0, w: 0, h: 0 };
  const MIN = 4;

  const draw = (): void => {
    let ex = bx, ey = by;
    if (shiftDown) { // square: the longer side wins, the box grows away from the fixed corner
      const size = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
      ex = ax + (bx >= ax ? size : -size);
      ey = ay + (by >= ay ? size : -size);
    }
    const x1 = Math.max(0, Math.min(ax, ex)), y1 = Math.max(0, Math.min(ay, ey));
    const x2 = Math.min(window.innerWidth, Math.max(ax, ex)), y2 = Math.min(window.innerHeight, Math.max(ay, ey));
    rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    Object.assign(sel.style, { display: 'block', left: x1 + 'px', top: y1 + 'px', width: rect.w + 'px', height: rect.h + 'px' });
    dim.style.display = 'none';
    size.textContent = `${Math.round(rect.w * data.scale)} \u00d7 ${Math.round(rect.h * data.scale)}`;
    size.style.display = 'block';
    size.style.left = x1 + 'px';
    size.style.top = (y1 > 26 ? y1 - 24 : y2 + 6) + 'px';
  };

  const finish = (): void => {
    dragging = false;
    if (rect.w >= MIN && rect.h >= MIN) ipcRenderer.send('krh-snip-done', rect);
    else { sel.style.display = 'none'; size.style.display = 'none'; dim.style.display = 'block'; hint.style.display = 'block'; }
  };

  doc.addEventListener('mousedown', (e) => {
    if (e.button === 2) { ipcRenderer.send('krh-snip-cancel'); return; }
    if (e.button !== 0) return;
    dragging = true; shiftUsed = true;
    ax = bx = lastX = e.clientX; ay = by = lastY = e.clientY;
    hint.style.display = 'none';
    draw();
  });
  doc.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    if (spaceDown) { // move the whole box (both corners) with the mouse
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      ax += dx; bx += dx; ay += dy; by += dy;
    } else { bx = e.clientX; by = e.clientY; }
    lastX = e.clientX; lastY = e.clientY;
    draw();
  });
  doc.addEventListener('mouseup', (e) => {
    if (!dragging || e.button !== 0) return;
    if (!spaceDown) { bx = e.clientX; by = e.clientY; }
    draw();
    finish();
  });
  doc.addEventListener('contextmenu', (e) => { e.preventDefault(); });
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { ipcRenderer.send('krh-snip-cancel'); return; }
    if (e.key === 'Shift') {
      if (!e.repeat) { shiftArmed = true; shiftUsed = dragging; }
      shiftDown = true;
      if (dragging) { shiftUsed = true; draw(); }
    } else if (e.key === ' ') {
      spaceDown = true; shiftUsed = true;
      e.preventDefault();
    }
  });
  doc.addEventListener('keyup', (e) => {
    if (e.key === ' ') { spaceDown = false; return; }
    if (e.key !== 'Shift') return;
    shiftDown = false;
    if (dragging) { draw(); return; }
    // A clean tap of Shift (no drag, not held over from Shift+F9): take the whole window.
    if (shiftArmed && !shiftUsed && rect.w < MIN) {
      ipcRenderer.send('krh-snip-done', { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
    }
    shiftArmed = false;
  });
});
