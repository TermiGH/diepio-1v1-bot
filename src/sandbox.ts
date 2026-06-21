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
const ROOM_ID_TIMEOUT_MS = 50000;

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
        '--single-process',
        '--no-zygote',
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
  let cdp: any = null;
  let monitorInterval: any = null;
  let closed = false;
  let interceptedLink = '';

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

    // Interceptar WebSocket para capturar el party code (0x06)
    // Inyectamos un hook en el WebSocket antes de que cargue el juego
    await page.evaluateOnNewDocument(`
      (() => {
        const OrigWS = window.WebSocket;
        window.__partyCode = null;
        window.__wsOpened = false;
        window.WebSocket = function(url, protocols) {
          const ws = new OrigWS(url, protocols);
          ws.addEventListener('message', function(e) {
            if (e.data instanceof ArrayBuffer) {
              const arr = new Uint8Array(e.data);
              // Buscar header 0x06 (party link packet)
              for (let i = 0; i < arr.length - 8; i++) {
                if (arr[i] === 0x06 && i + 9 <= arr.length) {
                  // 06 + null-terminated string (party code)
                  let end = i + 1;
                  while (end < arr.length && arr[end] !== 0) end++;
                  if (end > i + 1) {
                    const code = new TextDecoder().decode(arr.slice(i + 1, end));
                    window.__partyCode = code;
                    console.log('[sandbox-ws] Party code:', code);
                  }
                }
              }
            }
          });
          ws.addEventListener('open', function() {
            window.__wsOpened = true;
          });
          return ws;
        };
        WebSocket.prototype = OrigWS.prototype;
        WebSocket.CONNECTING = OrigWS.CONNECTING;
        WebSocket.OPEN = OrigWS.OPEN;
        WebSocket.CLOSING = OrigWS.CLOSING;
        WebSocket.CLOSED = OrigWS.CLOSED;
      })();
    `);

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    console.log(`[sandbox] Cargada: ${page.url()}`);

    let finalUrl = page.url();
    let roomId: string | null = null;
    const deadline = Date.now() + ROOM_ID_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300));

      // 1. Revisar URL actual
      const current = page.url();
      if (current !== finalUrl) {
        console.log(`[sandbox] URL cambio: ${current}`);
        finalUrl = current;
      }
      roomId = extractRoomId(finalUrl);
      if (roomId) {
        console.log(`[sandbox] Room ID en URL: ${roomId}`);
        break;
      }

      // 2. Revisar location.hash via evaluate
      try {
        const hash = await page.evaluate('location.hash').catch(() => '');
        if (hash && hash.startsWith('#r') && hash.length > 3) {
          console.log(`[sandbox] Hash detectado: ${hash}`);
          finalUrl = finalUrl.split('#')[0]; // mantener solo lo anterior al hash
          // Revisar si el lobby ya tiene el room ID
          roomId = extractRoomId(finalUrl);
          if (!roomId) {
            // No room ID en URL pero tenemos hash - intentar construir URL
            // El juego pudo haber puesto el room ID en el hash en vez de lobby
            console.log('[sandbox] Usando hash como identificador');
          }
          break;
        }
      } catch {}

      // 3. Revisar party code interceptado
      try {
        const partyCode = await page.evaluate('window.__partyCode || null').catch(() => null);
        if (partyCode) {
          console.log(`[sandbox] Party code capturado: ${partyCode}`);
          interceptedLink = `${baseUrl}#r${partyCode}`;
        }
      } catch {}

      // 4. Revisar frames hijos
      try {
        for (const frame of page.frames()) {
          const fUrl = frame.url();
          if (fUrl !== 'about:blank') {
            const fid = extractRoomId(fUrl);
            if (fid) {
              console.log(`[sandbox] Room ID en frame: ${fid}`);
              roomId = fid;
              finalUrl = fUrl;
              break;
            }
          }
        }
      } catch {}
      if (roomId) break;
    }

    // Si encontramos room ID en URL, construir URL completa
    if (roomId) {
      const u = new URL(finalUrl);
      const lobby = u.searchParams.get('lobby');
      if (lobby && !lobby.includes(`_${roomId}_`)) {
        finalUrl = `https://diep.io/?lobby=${lobby}_${roomId}_0`;
      }
    } else if (interceptedLink) {
      // Usar party code capturado
      finalUrl = interceptedLink;
      console.log(`[sandbox] Usando link con party code: ${finalUrl}`);
    }

    // Eliminar #r del hash final (el usuario dijo que no funciona)
    finalUrl = finalUrl.split('#')[0];
    console.log(`[sandbox] URL final: ${finalUrl}`);

    // Monitor en segundo plano: detectar jugador y cerrar pagina
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
    if (cdp) { try { await cdp.detach(); } catch {} }
    if (page) { try { await page.close(); } catch {} }
    return { link: '', success: false, error: err?.message || 'Error al crear sandbox', close: async () => {} };
  }
}
