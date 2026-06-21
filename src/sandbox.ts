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
const ROOM_ID_TIMEOUT_MS = 40000;

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

    // Escuchar eventos de navegacion (para detectar cambios de URL)
    let urlChanged = false;
    page.on('framenavigated', (frame: any) => {
      if (frame === page.mainFrame()) {
        const u = frame.url();
        if (u !== baseUrl) {
          console.log(`[sandbox] framenavigated: ${u}`);
          urlChanged = true;
        }
      }
    });

    await page.goto(baseUrl, { waitUntil: 'load', timeout: 20000 });
    console.log(`[sandbox] Cargada: ${page.url()}`);

    // Esperar hasta 40s a que aparezca el room ID en la URL
    let finalUrl = page.url();
    const deadline = Date.now() + ROOM_ID_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const current = page.url();
      const found = extractRoomId(current);
      if (found) {
        console.log(`[sandbox] Room ID detectado en URL: ${found}`);
        finalUrl = current;
        break;
      }
      // Tambien buscar via evaluate (por si la URL no cambia pero el juego tiene el dato)
      try {
        const jsRoomId = await page.evaluate(() => {
          const g = globalThis as any;
          const keys = Object.getOwnPropertyNames(g);
          for (const key of keys) {
            try {
              const val = g[key];
              if (val && typeof val === 'object') {
                if (val.room && val.room.id && /^\d{6,}$/.test(String(val.room.id)))
                  return String(val.room.id);
                if (val.roomId && /^\d{6,}$/.test(String(val.roomId)))
                  return String(val.roomId);
                if (val.entities && typeof val.entities === 'object') {
                  const entityCount = Object.keys(val.entities).length;
                  if (entityCount > 0) {
                    // Encontro game state con entidades - buscar room ID en otras props
                    for (const prop of ['roomId', 'room', 'matchId', 'match']) {
                      if (val[prop]) {
                        const id = typeof val[prop] === 'object' ? val[prop].id : val[prop];
                        if (id && /^\d{6,}$/.test(String(id)))
                          return String(id);
                      }
                    }
                  }
                }
              }
            } catch {}
          }
          return null;
        }).catch(() => null);
        if (jsRoomId) {
          console.log(`[sandbox] Room ID detectado via evaluate: ${jsRoomId}`);
          finalUrl = `https://diep.io/?lobby=${target.regionCode}_${target.lobby.gamemode}_${target.lobby.ip}_${jsRoomId}_0`;
          break;
        }
      } catch {}

      await new Promise(r => setTimeout(r, 500));
    }

    // Eliminar #r del hash
    finalUrl = finalUrl.split('#')[0];
    console.log(`[sandbox] URL final: ${finalUrl}`);

    // Monitor en segundo plano: cuando entre alguien, cerrar pagina
    monitorInterval = setInterval(async () => {
      if (closed || !page || page.isClosed()) {
        if (monitorInterval) clearInterval(monitorInterval);
        return;
      }
      try {
        const count = await page.evaluate(() => {
          const g = globalThis as any;
          const keys = Object.getOwnPropertyNames(g);
          for (const key of keys) {
            try {
              const val = g[key];
              if (val && typeof val === 'object') {
                if (val.entities && typeof val.entities === 'object') {
                  const n = Object.keys(val.entities).length;
                  if (n > 0) return n;
                }
                if (val.tanks && Array.isArray(val.tanks)) {
                  return val.tanks.length;
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
