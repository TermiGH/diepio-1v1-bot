import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import https from 'https';

puppeteer.use(StealthPlugin());

export interface SandboxBrowserResult {
  link: string;
  success: boolean;
  region?: string;
  error?: string;
  close: () => Promise<void>;
}

interface Lobby {
  ip: string;
  gamemode: string;
  gamemodeName: string;
  numPlayers: number;
}

interface RegionData {
  region: string;
  regionName: string;
  countryCode: string;
  lobbies: Lobby[];
}

interface ServerListResponse {
  regions: RegionData[];
}

const SANDBOX_GAMEMODES = ['sandbox'];
const ROOM_ID_TIMEOUT_MS = 30000;

let sharedBrowser: any = null;

async function getBrowser() {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    console.log('[sandbox] Lanzando Chromium...');
    sharedBrowser = await puppeteer.launch({
      headless: process.env.BROWSER_VISIBLE === 'true' ? false : true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1366,768',
      ],
      defaultViewport: { width: 1366, height: 768 },
    });
  }
  return sharedBrowser;
}

export async function closeSharedBrowser() {
  if (sharedBrowser) {
    try { await sharedBrowser.close(); } catch {}
    sharedBrowser = null;
  }
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000, headers: { 'User-Agent': 'diepio-bot/1.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`)); }
      });
    }).on('error', reject);
  });
}

function extractRoomId(url: string): string | null {
  try {
    const u = new URL(url);
    const lobby = u.searchParams.get('lobby');
    if (!lobby) return null;
    const parts = lobby.split('_');
    if (parts.length >= 5 && /^\d{6,}$/.test(parts[parts.length - 2]))
      return parts[parts.length - 2];
  } catch {}
  return null;
}

export async function createSandbox(region?: string): Promise<SandboxBrowserResult> {
  let page: any = null;
  let monitorInterval: any = null;
  let closed = false;

  try {
    console.log('[sandbox] Obteniendo servidores...');
    const response: ServerListResponse = await fetchJson('https://lb.diep.io/api/lb/pc');

    const sandboxLobbies: { lobby: Lobby; regionCode: string }[] = [];
    for (const regionData of response.regions)
      for (const lobby of regionData.lobbies)
        if (SANDBOX_GAMEMODES.includes(lobby.gamemode))
          sandboxLobbies.push({ lobby, regionCode: regionData.region });

    if (sandboxLobbies.length === 0)
      return { link: '', success: false, error: 'No hay servidores sandbox disponibles', close: async () => {} };

    let filtered = sandboxLobbies;
    if (region && region !== 'auto') {
      filtered = sandboxLobbies.filter(s => s.regionCode === region);
      if (filtered.length === 0)
        return { link: '', success: false, error: `No hay servidores sandbox en la región "${region}"`, close: async () => {} };
    }

    filtered.sort((a, b) => a.lobby.numPlayers - b.lobby.numPlayers);
    const target = filtered[0];
    const baseUrl = `https://diep.io/?lobby=${target.regionCode}_${target.lobby.gamemode}_${target.lobby.ip}`;
    console.log(`[sandbox] URL base: ${baseUrl}`);

    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );

    await page.evaluateOnNewDocument(`
      (() => {
        const origPush = history.pushState.bind(history);
        history.pushState = function() { origPush(...arguments); window.__urlChanged = true; };
        const origReplace = history.replaceState.bind(history);
        history.replaceState = function() { origReplace(...arguments); window.__urlChanged = true; };
      })();
    `);

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log(`[sandbox] Cargada: ${page.url()}`);

    let finalUrl = page.url();
    const deadline = Date.now() + ROOM_ID_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      finalUrl = page.url();
      if (extractRoomId(finalUrl)) {
        console.log(`[sandbox] Room ID: ${extractRoomId(finalUrl)}`);
        break;
      }
    }

    // Eliminar #r del hash (no deja entrar a los jugadores)
    finalUrl = finalUrl.split('#')[0];

    console.log(`[sandbox] URL final: ${finalUrl}`);

    // Monitor en segundo plano: cuando entre alguien, cerrar la página
    monitorInterval = setInterval(async () => {
      if (closed || !page || page.isClosed()) {
        if (monitorInterval) clearInterval(monitorInterval);
        return;
      }
      try {
        const current = page.url();
        const roomId = extractRoomId(current);
        if (roomId && !finalUrl.includes(roomId)) {
          finalUrl = current;
          console.log(`[sandbox] URL actualizada: ${current}`);
        }
        const count = await page.evaluate(() => {
          const keys = Object.keys(window);
          for (const k of keys) {
            try {
              const v = (window as any)[k];
              if (v && typeof v === 'object') {
                if (v.entities && typeof v.entities === 'object') {
                  const n = Object.keys(v.entities).length;
                  if (n > 0) return n;
                }
                if (v.tanks && Array.isArray(v.tanks)) {
                  return v.tanks.length;
                }
              }
            } catch {}
          }
          return null;
        }).catch(() => null);
        if (count !== null && count >= 2) {
          console.log(`[sandbox] Jugador entró! (${count} tanques). Cerrando.`);
          clearInterval(monitorInterval);
          try { await page.close(); } catch {}
          closed = true;
        }
      } catch {}
    }, 3000);

    return {
      link: finalUrl,
      success: true,
      region: target.regionCode,
      close: async () => {
        closed = true;
        if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
        if (page && !page.isClosed()) {
          try { await page.close(); } catch {}
        }
      },
    };
  } catch (err: any) {
    console.error(`[sandbox] Error: ${err?.message || err}`);
    if (monitorInterval) clearInterval(monitorInterval);
    if (page) { try { await page.close(); } catch {} }
    return { link: '', success: false, error: err?.message || 'Error al crear sandbox', close: async () => {} };
  }
}
