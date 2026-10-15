import Store from 'electron-store';
import { AppConfig, DEFAULT_CONFIG } from './config-defaults';

// Re-export types + defaults so existing `from './config'` imports keep working.
export * from './config-defaults';

export const config = new Store<AppConfig>({
  name: 'krunker-civilian-config',
  defaults: DEFAULT_CONFIG,
});

// One-time layout migration: the overlays used to default to spots that collided with the in-game HUD
// (spotify card over the mode info, nuke counter under the killfeed, twitch chat over the game chat).
// Move them to the new default spots once; after that the user's own positions are left alone.
const OVERLAY_LAYOUT = 2;
try {
  if ((Number(config.get('overlayLayout')) || 0) < OVERLAY_LAYOUT) {
    const sp = config.get('spotify');
    config.set('spotify', { ...sp, x: DEFAULT_CONFIG.spotify.x, y: DEFAULT_CONFIG.spotify.y });
    const nc = config.get('nukeCounter');
    config.set('nukeCounter', { ...nc, x: DEFAULT_CONFIG.nukeCounter.x, y: DEFAULT_CONFIG.nukeCounter.y });
    const tw: any = { ...config.get('twitch') };
    delete tw.fadeAfter;
    config.set('twitch', { ...tw, autoPlace: true });
    config.set('overlayLayout', OVERLAY_LAYOUT);
  }
} catch { /* a broken config file must never stop the client from starting */ }

// One-time: the Discord Presence+ pictures (class icon + map picture) used to be off by default, so a presence
// stayed on the plain KRH logo even when the art assets were uploaded. They are on by default now; switch them on
// once for configs created before that. (Join button stays as the user set it. After this the user's choice is kept.)
const RPC_RICH_DEFAULTS = 1;
try {
  if ((Number(config.get('rpcRichDefaults')) || 0) < RPC_RICH_DEFAULTS) {
    const ex: any = config.get('extras') || {};
    config.set('extras', { ...ex, rpcRich: { ...DEFAULT_CONFIG.extras.rpcRich, ...(ex.rpcRich || {}), classIcon: true, mapArt: true } });
    config.set('rpcRichDefaults', RPC_RICH_DEFAULTS);
  }
} catch { /* a broken config file must never stop the client from starting */ }

// Skins Per Account was removed (Krunker keeps skins on its own servers, per account): drop what it had saved.
try {
  const c: any = config;
  if (c.has('accountSkinSets')) c.delete('accountSkinSets');
} catch { /* never stop the client from starting */ }
