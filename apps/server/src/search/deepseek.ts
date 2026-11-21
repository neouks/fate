import type { Database } from '../db/index.js';

function officialBase(base: string): boolean {
  try { const url = new URL(base); return url.origin === 'https://api.deepseek.com' && !url.username && !url.password; }
  catch { return false; }
}

export async function searchCredentials(db: Database, enteredKey = '') {
  const key = enteredKey.trim() || await db.platform().getSetting('deepseek_search_api_key');
  if (key) return { key, proxy: '', source: '专用 DeepSeek API Key' };
  const active = await db.platform().activeProfile();
  if (active?.apiKey && officialBase(active.baseURL)) {
    return { key: active.apiKey, proxy: active.proxy, source: `当前官方模型配置 · ${active.name}` };
  }
  for (const candidate of await db.platform().listProfiles()) {
    if (!officialBase(candidate.baseURL)) continue;
    const profile = await db.platform().profileByID(candidate.id);
    if (profile?.apiKey && officialBase(profile.baseURL)) {
      return { key: profile.apiKey, proxy: profile.proxy, source: `官方模型配置 · ${profile.name}` };
    }
  }
  return null;
}
