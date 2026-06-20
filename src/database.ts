import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(__dirname, '..', 'data', 'diepio.db');

let db: Database.Database;

export function initDatabase(): void {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      player1_id TEXT NOT NULL,
      player2_id TEXT NOT NULL,
      room_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      winner_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      tank TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );

    CREATE TABLE IF NOT EXISTS players (
      user_id TEXT PRIMARY KEY,
      elo INTEGER NOT NULL DEFAULT 500,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      reporter_id TEXT NOT NULL,
      accused_id TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  try {
    db.exec(`ALTER TABLE results ADD COLUMN tank TEXT DEFAULT NULL`);
  } catch {
    /* columna ya existe */
  }

  try {
    db.exec(`ALTER TABLE matches ADD COLUMN cancel_votes TEXT DEFAULT NULL`);
  } catch {
    /* columna ya existe */
  }
}

export interface Match {
  id: number;
  channel_id: string;
  player1_id: string;
  player2_id: string;
  room_code: string;
  status: string;
  winner_id: string | null;
  cancel_votes: string | null;
  created_at: string;
}

export interface Result {
  id: number;
  match_id: number;
  player_id: string;
  score: number;
  tank: string | null;
  created_at: string;
}

export interface Player {
  user_id: string;
  elo: number;
  wins: number;
  losses: number;
  updated_at: string;
}

export interface Report {
  id: number;
  match_id: number;
  reporter_id: string;
  accused_id: string;
  reason: string | null;
  created_at: string;
}

export interface TankStat {
  tank: string;
  games: number;
  wins: number;
  losses: number;
}

export interface PlayerInfo extends Player {
  tankStats: TankStat[];
}

export function createMatch(channelId: string, player1Id: string, player2Id: string, roomCode: string): Match {
  const stmt = db.prepare(
    `INSERT INTO matches (channel_id, player1_id, player2_id, room_code) VALUES (?, ?, ?, ?)`
  );
  const info = stmt.run(channelId, player1Id, player2Id, roomCode);
  return getMatch(info.lastInsertRowid as number)!;
}

export function getMatch(matchId: number): Match | undefined {
  const stmt = db.prepare(`SELECT * FROM matches WHERE id = ?`);
  return stmt.get(matchId) as Match | undefined;
}

export function getActiveMatch(playerId: string): Match | undefined {
  const stmt = db.prepare(
    `SELECT * FROM matches WHERE (player1_id = ? OR player2_id = ?) AND status = 'pending' ORDER BY id DESC LIMIT 1`
  );
  return stmt.get(playerId, playerId) as Match | undefined;
}

export function saveResult(matchId: number, playerId: string, score: number, tank?: string): Result {
  const stmt = db.prepare(
    `INSERT INTO results (match_id, player_id, score, tank) VALUES (?, ?, ?, ?)`
  );
  const info = stmt.run(matchId, playerId, score, tank || null);
  return { id: info.lastInsertRowid as number, match_id: matchId, player_id: playerId, score, tank: tank || null, created_at: new Date().toISOString() };
}

export function getResults(matchId: number): Result[] {
  const stmt = db.prepare(`SELECT * FROM results WHERE match_id = ?`);
  return stmt.all(matchId) as Result[];
}

export interface PlayerMatch {
  match_id: number;
  player1_id: string;
  player2_id: string;
  winner_id: string | null;
  my_score: number;
  opponent_score: number;
  tank: string | null;
  status: string;
}

export function completeMatch(matchId: number, winnerId: string | null): void {
  const stmt = db.prepare(`UPDATE matches SET status = 'completed', winner_id = ? WHERE id = ?`);
  stmt.run(winnerId, matchId);
}

export function requestCancel(matchId: number, playerId: string): boolean {
  const match = getMatch(matchId);
  if (!match) return false;

  let votes: string[] = match.cancel_votes ? JSON.parse(match.cancel_votes) : [];
  if (!votes.includes(playerId)) {
    votes.push(playerId);
    db.prepare(`UPDATE matches SET cancel_votes = ? WHERE id = ?`).run(JSON.stringify(votes), matchId);
  }

  return votes.includes(match.player1_id) && votes.includes(match.player2_id);
}

export function cancelMatch(matchId: number): void {
  db.prepare(`UPDATE matches SET status = 'cancelled' WHERE id = ?`).run(matchId);
}

export function getPlayer(userId: string): Player {
  const stmt = db.prepare(`SELECT * FROM players WHERE user_id = ?`);
  let player = stmt.get(userId) as Player | undefined;
  if (!player) {
    const insert = db.prepare(`INSERT INTO players (user_id) VALUES (?)`);
    insert.run(userId);
    player = stmt.get(userId) as Player;
  }
  return player;
}

export function getPlayerInfo(userId: string): PlayerInfo {
  const player = getPlayer(userId);
  const tankStats = db.prepare(`
    SELECT
      r.tank,
      COUNT(*) as games,
      SUM(CASE WHEN m.winner_id = r.player_id THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN m.winner_id IS NOT NULL AND m.winner_id != r.player_id THEN 1 ELSE 0 END) as losses
    FROM results r
    JOIN matches m ON r.match_id = m.id
    WHERE r.player_id = ? AND r.tank IS NOT NULL AND m.status = 'completed'
    GROUP BY r.tank
    ORDER BY games DESC
  `).all(userId) as TankStat[];
  return { ...player, tankStats };
}

export function getPlayerMatches(userId: string, tank?: string, limit: number = 5): PlayerMatch[] {
  let query = `
    SELECT
      m.id as match_id,
      m.player1_id,
      m.player2_id,
      m.winner_id,
      r.score as my_score,
      CASE
        WHEN r.player_id = m.player1_id THEN
          (SELECT r2.score FROM results r2 WHERE r2.match_id = m.id AND r2.player_id = m.player2_id)
        ELSE
          (SELECT r2.score FROM results r2 WHERE r2.match_id = m.id AND r2.player_id = m.player1_id)
      END as opponent_score,
      r.tank,
      m.status
    FROM results r
    JOIN matches m ON r.match_id = m.id
    WHERE r.player_id = ?
  `;
  const params: any[] = [userId];
  if (tank) { query += ` AND r.tank = ?`; params.push(tank); }
  query += ` AND m.status = 'completed' ORDER BY m.id DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(query).all(...params) as PlayerMatch[];
}

export function updatePlayerElo(userId: string, eloChange: number, won: boolean): Player {
  const player = getPlayer(userId);
  const newElo = Math.max(0, player.elo + eloChange);
  const stmt = db.prepare(`
    UPDATE players SET elo = ?, wins = wins + ?, losses = losses + ?, updated_at = datetime('now')
    WHERE user_id = ?
  `);
  stmt.run(newElo, won ? 1 : 0, won ? 0 : 1, userId);
  return { ...player, elo: newElo, wins: player.wins + (won ? 1 : 0), losses: player.losses + (won ? 0 : 1) };
}

export function resetPlayerElo(userId: string): void {
  getPlayer(userId);
  const stmt = db.prepare(`UPDATE players SET elo = 500, wins = 0, losses = 0, updated_at = datetime('now') WHERE user_id = ?`);
  stmt.run(userId);
}

export function setPlayerElo(userId: string, elo: number): void {
  getPlayer(userId);
  const stmt = db.prepare(`UPDATE players SET elo = ?, updated_at = datetime('now') WHERE user_id = ?`);
  stmt.run(elo, userId);
}

export function getLeaderboard(limit: number = 10): Player[] {
  const stmt = db.prepare(`SELECT * FROM players ORDER BY elo DESC LIMIT ?`);
  return stmt.all(limit) as Player[];
}

export function getLeaderboardByTank(tank: string, limit: number = 10): any[] {
  return db.prepare(`
    SELECT
      p.user_id,
      p.elo,
      p.wins as total_wins,
      p.losses as total_losses,
      COUNT(*) as tank_games,
      SUM(CASE WHEN m.winner_id = p.user_id THEN 1 ELSE 0 END) as tank_wins,
      SUM(CASE WHEN m.winner_id IS NOT NULL AND m.winner_id != p.user_id THEN 1 ELSE 0 END) as tank_losses
    FROM players p
    JOIN results r ON r.player_id = p.user_id
    JOIN matches m ON r.match_id = m.id
    WHERE r.tank = ? AND m.status = 'completed'
    GROUP BY p.user_id
    ORDER BY p.elo DESC
    LIMIT ?
  `).all(tank, limit);
}

export function calcEloChange(winnerScore: number, loserScore: number): number {
  const diff = winnerScore - loserScore;
  const change = Math.round(20 + (diff - 1) * 30 / 9);
  return Math.max(20, Math.min(50, change));
}

export function createReport(matchId: number, reporterId: string, accusedId: string, reason?: string): Report {
  const stmt = db.prepare(
    `INSERT INTO reports (match_id, reporter_id, accused_id, reason) VALUES (?, ?, ?, ?)`
  );
  const info = stmt.run(matchId, reporterId, accusedId, reason || null);
  return {
    id: info.lastInsertRowid as number,
    match_id: matchId,
    reporter_id: reporterId,
    accused_id: accusedId,
    reason: reason || null,
    created_at: new Date().toISOString(),
  };
}

export function getConfig(key: string): string | undefined {
  const stmt = db.prepare(`SELECT value FROM config WHERE key = ?`);
  const row = stmt.get(key) as { value: string } | undefined;
  return row?.value;
}

export function setConfig(key: string, value: string): void {
  const stmt = db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`);
  stmt.run(key, value);
}

export function closeDatabase(): void {
  if (db) db.close();
}
