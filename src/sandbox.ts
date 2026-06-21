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

async function launchBrowser() {
  return await puppeteer.launch({
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

export async function createSandbox(region?: string): Promise<SandboxBrowserResult> {
  let browser: any;
  try {
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
    const baseUrl = `https://diep.io/?lobby=${target.regionCode}_${target.lobby.gamemode}_${target.lobby.ip}`;

    browser = await launchBrowser();
    const page = await browser.newPage();

    let pageErrors: string[] = [];
    page.on('pageerror', (err: Error) => pageErrors.push(err.message));
    page.on('console', (msg: any) => {
      if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
    });

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

    console.log(`[sandbox] Cargando: ${baseUrl}`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Wait for game to load and URL to change
    const deadline = Date.now() + ROOM_ID_TIMEOUT_MS;
    let finalUrl = page.url();

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
      finalUrl = page.url();

      const hasUrlChanged = await page.evaluate(`window.__urlChanged === true`).catch(() => false);

      if (finalUrl !== baseUrl || hasUrlChanged) {
        console.log(`[sandbox] URL cambió: ${finalUrl}`);
        break;
      }
    }

    // Extra wait for URL to settle
    await new Promise(r => setTimeout(r, 3000));
    finalUrl = page.url();

    console.log(`[sandbox] URL final: ${finalUrl}`);
    if (pageErrors.length > 0) {
      console.log(`[sandbox] Errores de página: ${pageErrors.slice(0, 3).join(' | ')}`);
    }

    // Check if URL still has the room ID
    const lobbyParam = new URL(finalUrl).searchParams.get('lobby') || '';
    const parts = lobbyParam.split('_');

    if (parts.length < 5 && parts.length >= 3) {
      // URL didn't get room ID — try fallback: add random room ID ourselves
      console.log(`[sandbox] No se detectó room ID. Usando fallback con ID generado.`);
      const roomId = Math.floor(100000000 + Math.random() * 900000000);
      const fallbackUrl = `https://diep.io/?lobby=${target.regionCode}_${target.lobby.gamemode}_${target.lobby.ip}_${roomId}_0`;
      finalUrl = fallbackUrl;
    }

    const timer = setTimeout(async () => {
      try { await browser.close(); } catch {}
    }, 30 * 60 * 1000);

    return {
      link: finalUrl,
      success: true,
      region: target.regionCode,
      close: async () => {
        clearTimeout(timer);
        try { await browser.close(); } catch {}
      },
    };
  } catch (err: any) {
    console.error(`[sandbox] Error: ${err?.message || err}`);
    if (browser) {
      try { await browser.close(); } catch {}
    }
    return { link: '', success: false, error: err?.message || 'Error al crear sandbox', close: async () => {} };
  }
}
