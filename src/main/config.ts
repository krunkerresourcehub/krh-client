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
