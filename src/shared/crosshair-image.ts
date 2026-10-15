// A crosshair picture kept as bytes (a data: URL) inside the settings, not as a link. Krunker's own image crosshair
// fetches a URL, and a link from Discord's CDN stops working when it expires, which takes the crosshair with it
// (idea from NM/NZ Client, https://github.com/nmallik1029/nm-nez-client, GPL-3.0-or-later).

/** Largest picture accepted, in bytes before base64. Small on purpose: it lives in the config file. */
export const CROSSHAIR_IMAGE_MAX_BYTES = 150 * 1024;

const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

/** The data URL if it is a small PNG/JPEG/WebP/GIF one, else an empty string. SVG is refused on purpose. */
export function cleanCrosshairImage(value: unknown): string {
  if (typeof value !== 'string' || value.length > Math.ceil((CROSSHAIR_IMAGE_MAX_BYTES * 4) / 3) + 64) return '';
  return DATA_URL.test(value) ? value : '';
}
