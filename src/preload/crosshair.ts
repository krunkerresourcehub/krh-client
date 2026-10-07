// ── Custom crosshair ──
// Idea from Lombre_Blanche's matchmaker script (https://lombreblanche34.github.io/krunker_scripts/);
// written from scratch. Unlike a per-frame overlay it is drawn ONCE (and again only when a setting or the
// window size changes) on a static canvas that is shown while you aim, so it costs nothing during play.

export type CrosshairShape = 'cross' | 'plus' | 'circle' | 'hCircle' | 'square' | 'hSquare' | 'symbol';

export interface CrosshairConfig {
  enabled: boolean;
  shape: CrosshairShape;
  symbol: string;
  color: string;
  outline: string;
  size: number;
  thick: number;
  gap: number;
  dot: number;
  outWidth: number;
}

const CANVAS_ID = 'krhCrosshair';
const STYLE_ID = 'krhCrosshairHide';

let cfg: CrosshairConfig | null = null;
let canvas: HTMLCanvasElement | null = null;
let started = false;

function draw(): void {
  if (!canvas || !cfg) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(Math.round(w / 2), Math.round(h / 2));
  const { size: S, thick: T, gap: G, dot: D, outWidth: O } = cfg;
  const rect = (x: number, y: number, rw: number, rh: number, c: string): void => { ctx.fillStyle = c; ctx.fillRect(x, y, rw, rh); };

  // Pass 1 draws the outline (slightly bigger shapes in the outline colour), pass 2 the real shapes.
  for (const pass of [0, 1]) {
    const grow = pass === 0 ? O : 0;
    if (pass === 0 && O <= 0) continue;
    const c = pass === 0 ? cfg.outline : cfg.color;
    const g2 = grow * 2;
    if (D > 0) rect(-D / 2 - grow, -D / 2 - grow, D + g2, D + g2, c);
    switch (cfg.shape) {
      case 'cross':
        rect(-T / 2 - grow, -G - S - grow, T + g2, S + g2, c);
        rect(-T / 2 - grow, G - grow, T + g2, S + g2, c);
        rect(-G - S - grow, -T / 2 - grow, S + g2, T + g2, c);
        rect(G - grow, -T / 2 - grow, S + g2, T + g2, c);
        break;
      case 'plus':
        rect(-T / 2 - grow, -S - grow, T + g2, S * 2 + g2, c);
        rect(-S - grow, -T / 2 - grow, S * 2 + g2, T + g2, c);
        break;
      case 'circle':
        ctx.beginPath(); ctx.arc(0, 0, S + grow, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
        break;
      case 'hCircle':
        ctx.beginPath(); ctx.arc(0, 0, S, 0, Math.PI * 2); ctx.strokeStyle = c; ctx.lineWidth = T + g2; ctx.stroke();
        break;
      case 'square':
        rect(-S - grow, -S - grow, S * 2 + g2, S * 2 + g2, c);
        break;
      case 'hSquare':
        ctx.strokeStyle = c; ctx.lineWidth = T + g2; ctx.strokeRect(-S, -S, S * 2, S * 2);
        break;
      case 'symbol':
        ctx.font = `${S * 2}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        if (pass === 0) { ctx.strokeStyle = c; ctx.lineWidth = O * 2; ctx.strokeText(cfg.symbol, 0, 0); }
        else { ctx.fillStyle = c; ctx.fillText(cfg.symbol, 0, 0); }
        break;
    }
  }
  ctx.restore();
}

function refreshVisibility(): void {
  if (!canvas || !cfg) return;
  const on = cfg.enabled && !!document.pointerLockElement;
  canvas.style.display = on ? 'block' : 'none';
  let st = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!st) {
    st = document.createElement('style');
    st.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(st);
  }
  // Only while the custom one is showing: hide the game's own crosshair
  st.textContent = on ? '#crosshair { display: none !important; }' : '';
}

export function setCrosshair(next: CrosshairConfig): void {
  cfg = next;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = CANVAS_ID;
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;display:none;';
    (document.body || document.documentElement).appendChild(canvas);
  }
  if (!started) {
    started = true;
    document.addEventListener('pointerlockchange', refreshVisibility);
    let t: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('resize', () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; draw(); }, 150);
    });
  }
  draw();
  refreshVisibility();
}
