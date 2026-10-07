// ── Area-screenshot overlay preload ──
// Runs in the borderless overlay window that covers the game window. The main process sends a frozen
// copy of the game view; the user drags a rectangle over it (Snipping Tool style) and the selection
// is sent back in overlay CSS pixels. Esc or right-click cancels.
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
  hint.textContent = 'Drag to select the area to capture   \u2022   Esc or right-click to cancel';
  doc.body.append(bg, dim, sel, size, hint);

  let sx = 0, sy = 0, dragging = false;
  let rect = { x: 0, y: 0, w: 0, h: 0 };
  const MIN = 4;

  const update = (cx: number, cy: number): void => {
    const x1 = Math.max(0, Math.min(sx, cx)), y1 = Math.max(0, Math.min(sy, cy));
    const x2 = Math.min(window.innerWidth, Math.max(sx, cx)), y2 = Math.min(window.innerHeight, Math.max(sy, cy));
    rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    Object.assign(sel.style, { display: 'block', left: x1 + 'px', top: y1 + 'px', width: rect.w + 'px', height: rect.h + 'px' });
    dim.style.display = 'none';
    size.textContent = `${Math.round(rect.w * data.scale)} \u00d7 ${Math.round(rect.h * data.scale)}`;
    size.style.display = 'block';
    size.style.left = x1 + 'px';
    size.style.top = (y1 > 26 ? y1 - 24 : y2 + 6) + 'px';
  };

  doc.addEventListener('mousedown', (e) => {
    if (e.button === 2) { ipcRenderer.send('krh-snip-cancel'); return; }
    if (e.button !== 0) return;
    dragging = true; sx = e.clientX; sy = e.clientY;
    hint.style.display = 'none';
    update(sx, sy);
  });
  doc.addEventListener('mousemove', (e) => { if (dragging) update(e.clientX, e.clientY); });
  doc.addEventListener('mouseup', (e) => {
    if (!dragging || e.button !== 0) return;
    dragging = false;
    update(e.clientX, e.clientY);
    if (rect.w >= MIN && rect.h >= MIN) ipcRenderer.send('krh-snip-done', rect);
    else { sel.style.display = 'none'; size.style.display = 'none'; dim.style.display = 'block'; hint.style.display = 'block'; }
  });
  doc.addEventListener('contextmenu', (e) => { e.preventDefault(); });
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') ipcRenderer.send('krh-snip-cancel'); });
});
