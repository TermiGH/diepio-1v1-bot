import https from 'https';

export interface SandboxResult {
  link: string;
  success: boolean;
  region?: string;
  error?: string;
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

const MAX_PLAYERS_SANDBOX = 12;
const SANDBOX_GAMEMODES = ['sandbox'];

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000, headers: { 'User-Agent': 'diepio-bot/1.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`));
        }
      });
    }).on('error', reject);
  });
}

export async function createSandbox(region?: string): Promise<SandboxResult> {
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
      return { link: '', success: false, error: 'No hay servidores sandbox disponibles' };
    }

    let filtered = sandboxLobbies;
    if (region && region !== 'auto') {
      filtered = sandboxLobbies.filter(s => s.regionCode === region);
      if (filtered.length === 0) {
        return { link: '', success: false, error: `No hay servidores sandbox en la región "${region}"` };
      }
    }

    filtered.sort((a, b) => a.lobby.numPlayers - b.lobby.numPlayers);
    const target = filtered[0];
    const link = `https://diep.io/?lobby=${target.regionCode}_${target.lobby.gamemode}_${target.lobby.ip}`;

    return { link, success: true, region: target.regionCode };
  } catch (err: any) {
    return { link: '', success: false, error: err?.message || 'Error al obtener servidores' };
  }
}
