// Krunker news for the dashboard. The KRH website publishes a small JSON feed (resources/news/news-feed.json, made by
// scripts/build-news-feed.mjs from the News section). It is fetched with a short timeout, cached for a while and kept
// on disk so the page still shows the last news when you are offline. Every field is checked and cut to a sane size.

import { net } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export const NEWS_FEED_URL = 'https://krunker-resources-hub.pages.dev/resources/news/news-feed.json';

export interface NewsCard { id: string; label: string; title: string; intro: string; sections: string[]; videos: number; route: string }
export interface NewsFeed { generated: string; siteUrl: string; updates: NewsCard[]; events: NewsCard[] }
export interface NewsResult { ok: boolean; feed?: NewsFeed; stale?: boolean; error?: string }

const str = (v: unknown, max: number): string => (typeof v === 'string' ? Array.from(v).map((c) => (c.charCodeAt(0) < 32 ? ' ' : c)).join('').trim().slice(0, max) : '');
const ROUTE = /^[a-z0-9-]{1,40}$/;

function card(raw: unknown): NewsCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 40), title = str(r.title, 200);
  if (!id || !title) return null;
  const route = typeof r.route === 'string' && ROUTE.test(r.route) ? r.route : 'news-updates';
  return {
    id, title, route,
    label: str(r.label, 80) || id,
    intro: str(r.intro, 340),
    sections: Array.isArray(r.sections) ? r.sections.map((s) => str(s, 90)).filter(Boolean).slice(0, 12) : [],
    videos: typeof r.videos === 'number' && r.videos >= 0 && r.videos < 100 ? Math.floor(r.videos) : 0,
  };
}

function parse(raw: unknown): NewsFeed | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const list = (v: unknown): NewsCard[] => (Array.isArray(v) ? v.map(card).filter((c): c is NewsCard => c !== null).slice(0, 30) : []);
  const updates = list(r.updates), events = list(r.events);
  if (updates.length + events.length === 0) return null;
  return { generated: str(r.generated, 20), siteUrl: 'https://krunker-resources-hub.pages.dev/', updates, events };
}

let memory: { at: number; feed: NewsFeed } | null = null;
const FRESH_MS = 30 * 60_000;

export async function getKrunkerNews(cachePath: string, force: boolean): Promise<NewsResult> {
  if (!force && memory && Date.now() - memory.at < FRESH_MS) return { ok: true, feed: memory.feed };
  try {
    const res = await net.fetch(NEWS_FEED_URL, { signal: AbortSignal.timeout(8000), cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (text.length > 400_000) throw new Error('feed too large');
    const feed = parse(JSON.parse(text));
    if (!feed) throw new Error('feed is empty or malformed');
    memory = { at: Date.now(), feed };
    try { mkdirSync(dirname(cachePath), { recursive: true }); writeFileSync(cachePath, JSON.stringify(feed), 'utf-8'); } catch { /* cache is optional */ }
    return { ok: true, feed };
  } catch (err) {
    try {
      const feed = parse(JSON.parse(readFileSync(cachePath, 'utf-8')));
      if (feed) return { ok: true, feed, stale: true };
    } catch { /* nothing cached */ }
    return { ok: false, error: err instanceof Error ? err.message : 'could not load the news' };
  }
}
