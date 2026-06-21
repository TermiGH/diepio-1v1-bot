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

function extractRoomIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const lobby = u.searchParams.get('lobby');
    if (!lobby) return null;
    const parts = lobby.split('_');
    // Format: region_gamemode_hostname:port_roomID_0 (5+ parts)
    if (parts.length >= 5) {
      const roomId = parts[parts.length - 2]; // second to last
      if (roomId && /^\d{6,}$/.test(roomId)) return roomId;
    }
  } catch {}
  return null;
}

async function tryDetectRoomId(page: any, baseUrl: string): Promise<{ url: string } | null> {
  const startedAt = Date.now();
  const deadline = startedAt + ROOM_ID_TIMEOUT_MS;
  let lastUrl = page.url();

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const currentUrl = page.url();

    if (currentUrl !== lastUrl) {
      console.log(`[sandbox] URL cambió: ${currentUrl}`);
      lastUrl = currentUrl;
    }

    const roomId = extractRoomIdFromUrl(currentUrl);
    if (roomId) {
      console.log(`[sandbox] Room ID detectado en URL: ${roomId}`);
      return { url: currentUrl };
    }

    const stateChanged = await page.evaluate(`window.__urlChanged === true`).catch(() => false);
    if (stateChanged) {
      console.log(`[sandbox] pushState/replaceState detectado`);
      // Volver a chequear URL en el próximo ciclo
    }
  }

  const finalCheck = extractRoomIdFromUrl(page.url());
  if (finalCheck) {
    console.log(`[sandbox] Room ID detectado al final: ${finalCheck}`);
    return { url: page.url() };
  }

  return null;
}

export async function createSandbox(region?: string): Promise<SandboxBrowserResult> {
  let page: any = null;
  try {
    console.log('[sandbox] Obteniendo servidores...');
    const response: ServerListResponse = await fetchJson('https://lb.diep.io/api/lb/pc');

    const sandboxLobbies: { lobby: Lobby; regionCode: string }[] = [];
    for (const regionData of response.regions) {
      for (const lobby of regionData.lobbies) {
        if (SANDBOX_GAMEMODES.includes(lobby.gamemode)) {
          sandboxLobbies.push({ lobby, regionCode: regionData.region });
        }
      }
    }

    if (sandboxLobbies.length === 0) {
      return { link: '', success: false, error: 'No hay servidores sandbox disponibles', close: async () => {} };
    }

    let filtered = sandboxLobbies;
    if (region && region !== 'auto') {
      filtered = sandboxLobbies.filter(s => s.regionCode === region);
      if (filtered.length === 0) {
        return { link: '', success: false, error: `No hay servidores sandbox en la región "${region}"`, close: async () => {} };
      }
    }

    filtered.sort((a, b) => a.lobby.numPlayers - b.lobby.numPlayers);
    const target = filtered[0];

    const partyCode = Math.random().toString(36).substring(2, 10);
    const baseUrl = `https://diep.io/?lobby=${target.regionCode}_${target.lobby.gamemode}_${target.lobby.ip}#r${partyCode}`;
    console.log(`[sandbox] URL base: ${baseUrl}`);

    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );

    await page.evaluateOnNewDocument(`
      (() => {
        const origPushState = history.pushState.bind(history);
        history.pushState = function() {
          origPushState(...arguments);
          window.__urlChanged = true;
        };
        const origReplaceState = history.replaceState.bind(history);
        history.replaceState = function() {
          origReplaceState(...arguments);
          window.__urlChanged = true;
        };
      })();
    `);

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log(`[sandbox] Página cargada. URL inicial: ${page.url()}`);

    const detected = await tryDetectRoomId(page, baseUrl);

    let finalUrl: string;
    if (detected) {
      finalUrl = detected.url;
      console.log(`[sandbox] URL con room ID: ${finalUrl}`);
    } else {
      console.log(`[sandbox] Fallback: generando room ID aleatorio`);
      const roomId = Math.floor(100000000 + Math.random() * 900000000);
      finalUrl = `https://diep.io/?lobby=${target.regionCode}_${target.lobby.gamemode}_${target.lobby.ip}_${roomId}_0#r${partyCode}`;
    }

    return {
      link: finalUrl,
      success: true,
      region: target.regionCode,
      close: async () => {
        try { await page.close(); } catch {}
      },
    };
  } catch (err: any) {
    console.error(`[sandbox] Error: ${err?.message || err}`);
    if (page) {
      try { await page.close(); } catch {}
    }
    return { link: '', success: false, error: err?.message || 'Error al crear sandbox', close: async () => {} };
  }
}
