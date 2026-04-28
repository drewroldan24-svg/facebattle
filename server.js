const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── In-memory state ──────────────────────────────────────────────────────────
const clients = new Map();     // socketId → { ws, name, score, inQueue, roomId, wins, losses, bestScore }
const rooms   = new Map();     // roomId  → { players: [id, id], timer, started, scores, chatHistory }
const queue   = [];            // socketIds waiting for a match
let leaderboard = [];          // persisted across restarts only in memory

// ── Helpers ──────────────────────────────────────────────────────────────────
function broadcast(socketId, msg) {
  const c = clients.get(socketId);
  if (c && c.ws.readyState === WebSocket.OPEN) {
    c.ws.send(JSON.stringify(msg));
  }
}

function broadcastRoom(roomId, msg, excludeId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.players.forEach(id => {
    if (id !== excludeId) broadcast(id, msg);
  });
}

function updateLeaderboard(name, wins, losses, bestScore) {
  const idx = leaderboard.findIndex(e => e.name === name);
  const entry = { name, wins, losses, bestScore, ratio: wins / Math.max(1, wins + losses) };
  if (idx >= 0) {
    leaderboard[idx] = entry;
  } else {
    leaderboard.push(entry);
  }
  leaderboard.sort((a, b) => b.wins - a.wins || b.bestScore - a.bestScore);
  leaderboard = leaderboard.slice(0, 100);
}

function getLeaderboard() {
  return leaderboard.slice(0, 50);
}

function tryMatch() {
  while (queue.length >= 2) {
    const idA = queue.shift();
    const idB = queue.shift();
    const cA  = clients.get(idA);
    const cB  = clients.get(idB);
    if (!cA || cA.ws.readyState !== 1) { 
      if (cB && cB.ws.readyState === 1) queue.unshift(idB);
      continue; 
    }
    if (!cB || cB.ws.readyState !== 1) { 
      if (cA && cA.ws.readyState === 1) queue.unshift(idA);
      continue; 
    }
    if (cA.roomId || cB.roomId) { continue; }

    const roomId = uuidv4();
    cA.roomId = roomId;
    cB.roomId = roomId;
    cA.inQueue = false;
    cB.inQueue = false;

    const room = {
      players: [idA, idB],
      timer: null,
      started: false,
      scores: { [idA]: [], [idB]: [] },
      finalScores: {},
      chatHistory: [],
      countdown: null,
    };
    rooms.set(roomId, room);

    // Notify both players — tell each who the opponent is
    broadcast(idA, { type: 'matched', roomId, opponentName: cB.name, yourId: idA, opponentId: idB });
    broadcast(idB, { type: 'matched', roomId, opponentName: cA.name, yourId: idB, opponentId: idA });
  }
}

function startBattle(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.started) return;
  room.started = true;

  broadcastRoom(roomId, { type: 'battle_start', duration: 15 });

  // 15 second battle timer
  room.timer = setTimeout(() => endBattle(roomId), 15000);
}

function endBattle(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTimeout(room.timer);

  const [idA, idB] = room.players;
  const cA = clients.get(idA);
  const cB = clients.get(idB);

  const avgA = room.scores[idA].length
    ? room.scores[idA].reduce((a, b) => a + b, 0) / room.scores[idA].length
    : 0;
  const avgB = room.scores[idB].length
    ? room.scores[idB].reduce((a, b) => a + b, 0) / room.scores[idB].length
    : 0;

  const winnerName = avgA > avgB ? (cA ? cA.name : 'Unknown') : (cB ? cB.name : 'Unknown');
  const winnerId   = avgA > avgB ? idA : idB;
  const loserId    = avgA > avgB ? idB : idA;

  // Update stats
  if (cA) {
    if (winnerId === idA) cA.wins++;  else cA.losses++;
    if (avgA > cA.bestScore) cA.bestScore = Math.round(avgA * 10) / 10;
    updateLeaderboard(cA.name, cA.wins, cA.losses, cA.bestScore);
  }
  if (cB) {
    if (winnerId === idB) cB.wins++; else cB.losses++;
    if (avgB > cB.bestScore) cB.bestScore = Math.round(avgB * 10) / 10;
    updateLeaderboard(cB.name, cB.wins, cB.losses, cB.bestScore);
  }

  const result = {
    type: 'battle_end',
    winnerName,
    scores: {
      [idA]: Math.round(avgA * 10) / 10,
      [idB]: Math.round(avgB * 10) / 10,
    },
    playerStats: {
      [idA]: cA ? { wins: cA.wins, losses: cA.losses, bestScore: cA.bestScore } : {},
      [idB]: cB ? { wins: cB.wins, losses: cB.losses, bestScore: cB.bestScore } : {},
    },
    leaderboard: getLeaderboard(),
  };

  broadcastRoom(roomId, result);

  // Cleanup room after 30s
  setTimeout(() => {
    rooms.delete(roomId);
    if (cA) cA.roomId = null;
    if (cB) cB.roomId = null;
  }, 30000);
}

// ── WebSocket handler ─────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const socketId = uuidv4();
  clients.set(socketId, {
    ws, name: 'Anonymous', score: 0,
    inQueue: false, roomId: null,
    wins: 0, losses: 0, bestScore: 0,
  });

  ws.send(JSON.stringify({ type: 'connected', socketId, leaderboard: getLeaderboard() }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const client = clients.get(socketId);
    if (!client) return;

    switch (msg.type) {

      // ── Identity ────────────────────────────────────────────────────────────
      case 'set_name':
        client.name = (msg.name || 'Anonymous').slice(0, 30).replace(/[<>]/g, '');
        ws.send(JSON.stringify({ type: 'name_set', name: client.name }));
        break;

      // ── Matchmaking ─────────────────────────────────────────────────────────
      case 'join_queue':
        if (!client.inQueue && !client.roomId) {
          // Remove any stale entry first
          const existing = queue.indexOf(socketId);
          if (existing >= 0) queue.splice(existing, 1);
          client.inQueue = true;
          queue.push(socketId);
          ws.send(JSON.stringify({ type: 'queued', position: queue.length }));
          console.log(`Queue size: ${queue.length}`);
          tryMatch();
        }
        break;

      case 'leave_queue':
        const qi = queue.indexOf(socketId);
        if (qi >= 0) queue.splice(qi, 1);
        client.inQueue = false;
        break;

      // ── WebRTC signaling ─────────────────────────────────────────────────────
      case 'offer':
      case 'answer':
      case 'ice_candidate':
        if (client.roomId) {
          broadcastRoom(client.roomId, { ...msg, fromId: socketId }, socketId);
        }
        break;

      // ── Ready (both players signal ready → start) ────────────────────────────
      case 'ready': {
        const room = client.roomId ? rooms.get(client.roomId) : null;
        if (!room) break;
        room[`ready_${socketId}`] = true;
        const [idA, idB] = room.players;
        if (room[`ready_${idA}`] && room[`ready_${idB}`]) {
          startBattle(client.roomId);
        }
        break;
      }

      // ── Score submission (from AI analysis) ─────────────────────────────────
      case 'submit_score': {
        const room = client.roomId ? rooms.get(client.roomId) : null;
        if (!room || !room.started) break;
        const score = Math.max(0, Math.min(100, Number(msg.score) || 0));
        room.scores[socketId].push(score);
        // Relay current score to opponent so they can see live
        broadcastRoom(client.roomId, {
          type: 'opponent_score_update',
          score,
          fromId: socketId,
        }, socketId);
        break;
      }

      // ── Chat ────────────────────────────────────────────────────────────────
      case 'chat': {
        const room = client.roomId ? rooms.get(client.roomId) : null;
        if (!room) break;
        const chatMsg = {
          type: 'chat',
          fromId: socketId,
          fromName: client.name,
          text: (msg.text || '').slice(0, 300).replace(/[<>]/g, ''),
          ts: Date.now(),
        };
        room.chatHistory.push(chatMsg);
        broadcastRoom(client.roomId, chatMsg);
        break;
      }

      // ── Leaderboard request ──────────────────────────────────────────────────
      case 'get_leaderboard':
        ws.send(JSON.stringify({ type: 'leaderboard', data: getLeaderboard() }));
        break;

      // ── Rematch ─────────────────────────────────────────────────────────────
      case 'rematch':
        client.roomId = null;
        client.inQueue = false;
        const ri = queue.indexOf(socketId);
        if (ri >= 0) queue.splice(ri, 1);
        client.inQueue = true;
        queue.push(socketId);
        ws.send(JSON.stringify({ type: 'queued', position: queue.length }));
        tryMatch();
        break;
    }
  });

  ws.on('close', () => {
    const client = clients.get(socketId);
    if (client) {
      // Remove from queue
      const qi = queue.indexOf(socketId);
      if (qi >= 0) queue.splice(qi, 1);

      // Notify room partner
      if (client.roomId) {
        broadcastRoom(client.roomId, { type: 'opponent_disconnected' }, socketId);
        const room = rooms.get(client.roomId);
        if (room) {
          clearTimeout(room.timer);
          rooms.delete(client.roomId);
        }
      }
    }
    clients.delete(socketId);
  });

  ws.on('error', () => {});
});

// ── REST endpoints ────────────────────────────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  res.json(getLeaderboard());
});

app.get('/api/stats', (req, res) => {
  res.json({
    online: clients.size,
    inQueue: queue.length,
    activeRooms: rooms.size,
  });
});

// Catch-all → serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`FaceBattle server running on port ${PORT}`);
});
