/*
 * Adapted from NM/NZ Client (https://github.com/nmallik1029/nm-nez-client), src/shared/presets.ts.
 * NM/NZ Client is GPL-3.0-or-later, like KRH Client. See THIRD_PARTY_NOTICES.md.
 * Changes: the game's setting ids that NM/NZ keeps in krunker/constants.ts are inlined below.
 */

/** Krunker's own setting ids and defaults (stored in localStorage as kro_setngss_<id>). */
export const KRUNKER_SETTINGS = {
  presetPicker: 'selectSettingPre',
  customPreset: 2,
  sensitivityMode: 'gpSetts',
  fovMode: 'vmSetts',
  perWeaponMode: '1',
  sensitivity: [
    { key: 'sensitivityX', def: '1' },
    { key: 'sensitivityY', def: '1' },
    { key: 'aimSensitivityX', def: '1' },
    { key: 'aimSensitivityY', def: '1' },
  ],
  fov: [
    { key: 'fov', def: '100' },
    { key: 'fpsFOV', def: '95' },
    { key: 'adsFovMlt', def: '1' },
  ],
} as const;

/**
 * Setting presets: named snapshots of a handful of Krunker's own settings,
 * switched between from the Presets tab.
 *
 * A preset belongs to one scope, sensitivity or field of view, rather than
 * holding everything. A sniper sensitivity and a wide FOV are two separate
 * choices, and a preset that carried both could not change one without
 * dragging the other along. Supporting more of the game's settings means
 * adding a scope below. Nothing else in here needs to change.
 *
 * Everything here is pure: reading and writing the game is handed in, so the
 * part that decides what a switch writes can be tested without a game.
 *
 * WHAT A SNAPSHOT IS. The game stores a setting only once it has been changed.
 * A missing key means "at the default", which is a value like any other, so
 * a snapshot records the default where it finds nothing rather than leaving
 * the setting out. Otherwise switching from a preset with FOV 120 to one taken
 * at the default FOV would leave you on 120.
 *
 * Per-weapon copies (`fov_3`, see KRUNKER_SETTINGS) cannot be listed up front
 * without knowing how many weapons the game has, so they are taken from what
 * is actually in storage. A copy that is in storage now but not in the preset
 * was at its default when the preset was taken, and a switch puts it back
 * there.
 */

export type PresetScopeId = 'sensitivity' | 'fov';

export interface PresetSetting {
  /** The game's id, as `setSetting` and storage know it. */
  readonly key: string;
  /** The value the game starts from, as the string it would store. */
  readonly def: string;
  /** For the summary line. Settings sharing one are shown as a group. */
  readonly label: string;
}

export interface PresetScope {
  readonly id: PresetScopeId;
  readonly label: string;
  readonly hint: string;
  /** The game's "All / Per Weapon" picker for these settings. */
  readonly mode: string;
  readonly settings: readonly PresetSetting[];
}

const [sensX, sensY, adsX, adsY] = KRUNKER_SETTINGS.sensitivity;
const [fov, weaponFov, adsFov] = KRUNKER_SETTINGS.fov;

export const PRESET_SCOPES: readonly PresetScope[] = [
  {
    id: 'sensitivity',
    label: 'Sensitivity',
    hint: 'Mouse sensitivity for hip fire and aiming down sights, both axes. If you play with per-weapon settings, every weapon’s values are saved and switched too.',
    mode: KRUNKER_SETTINGS.sensitivityMode,
    settings: [
      { ...sensX, label: 'Sens' },
      { ...sensY, label: 'Sens' },
      { ...adsX, label: 'ADS' },
      { ...adsY, label: 'ADS' },
    ],
  },
  {
    id: 'fov',
    label: 'FOV',
    hint: 'Field of view, weapon field of view, and the ADS FOV multiplier. If you play with per-weapon settings, every weapon’s values are saved and switched too.',
    mode: KRUNKER_SETTINGS.fovMode,
    settings: [
      { ...fov, label: 'FOV' },
      { ...weaponFov, label: 'Weapon' },
      { ...adsFov, label: 'ADS ×' },
    ],
  },
];

export interface SettingPreset {
  readonly id: string;
  readonly name: string;
  readonly scope: PresetScopeId;
  /**
   * Setting id to value, as the game stores it. Every setting in the scope,
   * plus whichever per-weapon copies were in storage when it was taken.
   */
  readonly values: Readonly<Record<string, string>>;
}

/** One write a switch has to make, as `[id, value]`. */
export type PresetWrite = readonly [string, string];

/** What the game has stored for a setting id, or null for nothing. */
export type ReadSetting = (id: string) => string | null;

export const PRESET_NAME_MAX = 32;
/**
 * Per scope. Nothing about presets costs anything at this size; the cap is
 * there so a hand-edited or page-patched config cannot hand the tab ten
 * thousand rows to build.
 */
export const PRESET_LIMIT = 30;

/** Longest value kept from config. Every value in scope today is a number. */
const VALUE_MAX = 32;

/** `<key>_<weaponIndex>`, written the way `init` writes it: no leading zeros. */
const PER_WEAPON = /^(.+)_(0|[1-9]\d{0,3})$/;

export function presetScope(id: string): PresetScope | undefined {
  return PRESET_SCOPES.find((s) => s.id === id);
}

/** The setting a per-weapon copy belongs to, or null if `id` is not in scope. */
function settingFor(scope: PresetScope, id: string): PresetSetting | null {
  const direct = scope.settings.find((s) => s.key === id);
  if (direct) return direct;
  const match = PER_WEAPON.exec(id);
  if (!match) return null;
  return scope.settings.find((s) => s.key === match[1]) ?? null;
}

export function inScope(scope: PresetScope, id: string): boolean {
  return settingFor(scope, id) !== null;
}

/**
 * What the game is using for a setting, defaults filled in.
 *
 * The literal 'undefined' counts as missing because the game treats it that
 * way: both its init and its `set` replace it with the default.
 */
function current(read: ReadSetting, id: string, def: string): string {
  const value = read(id);
  return value === null || value === 'undefined' ? def : value;
}

/**
 * Every id a switch in this scope has to consider, in a fixed order: each
 * setting, then its per-weapon copies by weapon number.
 */
function idsInPlay(scope: PresetScope, ...sources: Iterable<string>[]): string[] {
  const copies = new Map<string, Set<number>>();
  for (const source of sources) {
    for (const id of source) {
      const match = PER_WEAPON.exec(id);
      if (!match || !inScope(scope, id)) continue;
      const [, key = '', index = ''] = match;
      if (scope.settings.some((s) => s.key === id)) continue;
      let set = copies.get(key);
      if (!set) copies.set(key, (set = new Set()));
      set.add(Number(index));
    }
  }
  const ids: string[] = [];
  for (const setting of scope.settings) {
    ids.push(setting.key);
    const indices = [...(copies.get(setting.key) ?? [])].sort((a, b) => a - b);
    for (const index of indices) ids.push(`${setting.key}_${index}`);
  }
  return ids;
}

/** Take a snapshot of the scope as the game has it now. */
export function capturePreset(
  scope: PresetScope,
  read: ReadSetting,
  storedIds: Iterable<string>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const id of idsInPlay(scope, storedIds)) {
    const setting = settingFor(scope, id);
    if (setting) values[id] = current(read, id, setting.def);
  }
  return values;
}

/**
 * The writes that take the game from where it is to `values`.
 *
 * Only what differs. Each write runs the setting's own setter, which for FOV
 * rebuilds the camera projection, and skipping the ones that would change
 * nothing is also what makes an empty plan mean "this preset is in use".
 *
 * Whatever the game's mode says is in force goes last: the per-weapon copies
 * on Per Weapon, the plain settings on All. Each FOV write moves the camera,
 * so the last one is what you see until the next weapon swap; see
 * KRUNKER_SETTINGS.fovMode. Sensitivity setters only fill in a table, so its
 * order changes nothing, and it follows the same rule anyway.
 */
export function planPreset(
  scope: PresetScope,
  values: Readonly<Record<string, string>>,
  read: ReadSetting,
  storedIds: Iterable<string>,
): PresetWrite[] {
  const writes: PresetWrite[] = [];
  for (const id of idsInPlay(scope, Object.keys(values), storedIds)) {
    const setting = settingFor(scope, id);
    if (!setting) continue;
    const want = values[id] ?? setting.def;
    if (!sameValue(want, current(read, id, setting.def))) writes.push([id, want]);
  }

  if (read(scope.mode) === KRUNKER_SETTINGS.perWeaponMode) return writes;
  const plain = (id: string): number => (scope.settings.some((s) => s.key === id) ? 1 : 0);
  // Stable, so each group keeps the order idsInPlay gave it.
  return writes.sort(([a], [b]) => plain(a) - plain(b));
}

/**
 * Equal as the game would see them.
 *
 * Sliders are stored as `String(Number(value))`, so '1' and '1.0' never both
 * come out of the game, but a hand-edited config could hold either and should
 * not read as a change.
 */
function sameValue(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.trim() === '' || b.trim() === '') return false;
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

/**
 * One line saying what a preset holds, e.g. "Sens 1.2 · ADS 0.8".
 *
 * The X and Y of a pair share a label and collapse to one number when they
 * match, which is how nearly everyone plays. When they differ both are
 * shown, X first.
 */
export function summarisePreset(scope: PresetScope, values: Readonly<Record<string, string>>): string {
  const groups = new Map<string, string[]>();
  for (const setting of scope.settings) {
    const list = groups.get(setting.label) ?? [];
    list.push(values[setting.key] ?? setting.def);
    groups.set(setting.label, list);
  }
  const parts = [...groups].map(([label, list]) =>
    list.every((v) => sameValue(v, list[0] ?? v)) ? `${label} ${list[0]}` : `${label} ${list.join(' / ')}`,
  );
  const perWeapon = Object.keys(values).some((id) => !scope.settings.some((s) => s.key === id));
  if (perWeapon) parts.push('per weapon');
  return parts.join(' · ');
}

/** Tidy a name as typed. Empty means there was nothing usable in it. */
export function presetName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, PRESET_NAME_MAX).trim();
}

/**
 * Make whatever came out of config safe to render and to write.
 *
 * Config is untrusted twice over: the store merges one level deep so this
 * section arrives as whatever the file held, and page script can patch config
 * through the same channel the tab does. A value in here ends up as an
 * argument to the game's own `setSetting`, so anything outside the preset's
 * scope is dropped rather than passed along.
 */
export function normalisePresets(raw: unknown): SettingPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: SettingPreset[] = [];
  const seen = new Set<string>();
  const perScope = new Map<PresetScopeId, number>();

  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const { id, name, scope: scopeId, values } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id === '' || id.length > 64 || seen.has(id)) continue;
    if (typeof name !== 'string' || typeof scopeId !== 'string') continue;
    const scope = presetScope(scopeId);
    const cleanName = presetName(name);
    if (!scope || cleanName === '') continue;
    const count = perScope.get(scope.id) ?? 0;
    if (count >= PRESET_LIMIT) continue;

    const clean: Record<string, string> = {};
    if (values !== null && typeof values === 'object' && !Array.isArray(values)) {
      for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length <= VALUE_MAX && inScope(scope, key)) {
          clean[key] = value;
        }
      }
    }

    seen.add(id);
    perScope.set(scope.id, count + 1);
    out.push({ id, name: cleanName, scope: scope.id, values: clean });
  }
  return out;
}
