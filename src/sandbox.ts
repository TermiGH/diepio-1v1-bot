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
const BROWSER_AUTO_CLOSE_MS = 30 * 60 * 1000;

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

    browser = await puppeteer.launch({
      headless: process.env.BROWSER_VISIBLE === 'true' ? false : true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Poll for URL change (room ID assigned by game)
    const deadline = Date.now() + ROOM_ID_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      const currentUrl = page.url();
      if (currentUrl !== baseUrl && currentUrl.includes('_')) break;
    }

    await new Promise(r => setTimeout(r, 2000));

    const finalUrl = page.url();

    const timer = setTimeout(async () => {
      try { await browser.close(); } catch {}
    }, BROWSER_AUTO_CLOSE_MS);

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
    if (browser) {
      try { await browser.close(); } catch {}
    }
    return { link: '', success: false, error: err?.message || 'Error al crear sandbox', close: async () => {} };
  }
}
