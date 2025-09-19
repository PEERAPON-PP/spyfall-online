const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// ✅ เสิร์ฟ index.html และไฟล์ static อื่น ๆ จากโฟลเดอร์เดียวกับ server.js
app.use(express.static(__dirname));

const locationsData = require('./locations.json');

const games = {};           // { [roomCode]: GameState }
const playerSessions = {};  // { [playerToken]: { roomCode, playerId } }
const SPECTATOR_KEY = process.env.SPECTATOR_KEY || 'letmein';

const TAUNTS = [
  "ว้าย! โหวตผิดเพราะไม่สวยอะดิ",
  "เอิ้ก ๆ ๆ ๆ",
  "ชัดขนาดนี้!",
  "มองยังไงเนี่ย?",
  "ไปพักผ่อนบ้างนะ"
];

/* -------------------- Helpers -------------------- */
function generateRoomCode() {
  let code;
  do { code = Math.random().toString(36).substring(2, 6).toUpperCase(); }
  while (games[code]);
  return code;
}
function shuffleArray(a) {
  for (let i=a.length-1; i>0; i--) { const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
}
function clearTimers(game) {
  if (game.timer) clearInterval(game.timer);
  if (game.voteTimer) clearTimeout(game.voteTimer);
  game.timer = null;
  game.voteTimer = null;
}
function getAvailableLocations(theme) {
  if (theme === 'default') return locationsData.filter(l => l.category === 'default');
  if (theme === 'fairytale') return locationsData.filter(l => l.category === 'fairytale');
  return locationsData;
}
function pickSpyOptions(allNames, currentName, count=25) {
  // ให้มี "คำตอบจริง" อยู่ในชุดเสมอ แล้วสุ่มเรียง
  const pool = allNames.filter(n => n !== currentName);
  shuffleArray(pool);
  const picks = pool.slice(0, Math.max(0, count - 1));
  picks.push(currentName);
  shuffleArray(picks);
  return picks;
}

/* -------------------- Socket.IO -------------------- */
io.on('connection', (socket) => {
  let currentRoomCode = null;
  let isSpectator = false;

  /* ---------- Rejoin ---------- */
  socket.on('rejoinGame', (playerToken) => {
    const session = playerSessions[playerToken];
    if (!session || !games[session.roomCode]) return;
    const game = games[session.roomCode];
    const player = game.players.find(p => p.id === session.playerId);
    if (!player || !player.disconnected) return;

    player.socketId = socket.id;
    player.disconnected = false;
    currentRoomCode = session.roomCode;
    socket.join(currentRoomCode);
    socket.emit('rejoinSuccess', { game, roomCode: currentRoomCode, self: player });
    io.to(currentRoomCode).emit('playerReconnected', player.name);
    io.to(currentRoomCode).emit('updatePlayerList', game.players);

    // เติมรายการสถานที่
    const allNames = getAvailableLocations(game.settings.theme).map(l => l.name);
    if (player.role === 'สายลับ') {
      socket.emit('allLocations', pickSpyOptions(allNames, game.currentLocation, 25));
    } else {
      socket.emit('allLocations', allNames);
    }
  });

  /* ---------- Request spy locations on demand ---------- */
  socket.on('requestSpyLocations', () => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    const game = games[currentRoomCode];
    const me = game.players.find(p => p.socketId === socket.id);
    if (!me || me.role !== 'สายลับ') return;
    const allNames = getAvailableLocations(game.settings.theme).map(l => l.name);
    socket.emit('allLocations', pickSpyOptions(allNames, game.currentLocation, 25));
  });

  /* ---------- Create / Join / Spectator ---------- */
  socket.on('createRoom', ({ playerName, playerToken, asSpectator }) => {
    if (!playerName || !String(playerName).trim()) return socket.emit('error','กรุณาระบุชื่อผู้เล่น');

    const roomCode = generateRoomCode();
    currentRoomCode = roomCode;
    games[roomCode] = {
      players: [],
      spectators: [],
      state: 'lobby',
      settings: { time: 300, rounds: 5, theme: 'all' },
      currentRound: 0,
      usedLocations: []
    };

    if (asSpectator) {
      isSpectator = true;
      games[roomCode].spectators.push({ id: uuidv4(), socketId: socket.id, name: playerName });
    } else {
      if (!playerToken) playerToken = uuidv4();
      const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: true, score: 0, token: playerToken };
      games[roomCode].players.push(player);
      playerSessions[playerToken] = { roomCode, playerId: player.id };
    }

    socket.join(roomCode);
    socket.emit('roomCreated', { roomCode, assignedToken: playerToken });
    io.to(roomCode).emit('updatePlayerList', games[roomCode].players);
    io.to(roomCode).emit('updateSpectators', games[roomCode].spectators.map(s=>s.name));
  });

  socket.on('joinRoom', ({ playerName, roomCode, playerToken }) => {
    const code = (roomCode || '').toUpperCase();
    if (!games[code]) return socket.emit('error', 'ไม่พบห้องนี้');
    if (games[code].state !== 'lobby') return socket.emit('error', 'เกมเริ่มไปแล้ว');
    if (!playerName || !String(playerName).trim()) return socket.emit('error', 'กรุณาระบุชื่อผู้เล่น');

    currentRoomCode = code;
    if (!playerToken) playerToken = uuidv4();
    const noHost = !games[code].players.some(p => p.isHost);
    const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: noHost, score: 0, token: playerToken };
    games[code].players.push(player);
    playerSessions[playerToken] = { roomCode: code, playerId: player.id };

    socket.join(code);
    socket.emit('joinSuccess', { roomCode: code, assignedToken: playerToken });
    io.to(code).emit('updatePlayerList', games[code].players);
    io.to(code).emit('updateSpectators', games[code].spectators.map(s=>s.name));
  });

  socket.on('joinSpectator', ({ roomCode, name, spectatorKey }) => {
    const code = (roomCode || '').toUpperCase();
    if (!games[code]) return socket.emit('error','ไม่พบห้องนี้');
    if (spectatorKey !== SPECTATOR_KEY) return socket.emit('error','รหัสผู้ชมไม่ถูกต้อง');

    currentRoomCode = code;
    isSpectator = true;
    games[code].spectators.push({ id: uuidv4(), socketId: socket.id, name: name || 'ผู้ชม' });
    socket.join(code);
    socket.emit('spectatorJoined', { roomCode: code, name: name || 'ผู้ชม' });
    io.to(code).emit('updateSpectators', games[code].spectators.map(s=>s.name));
  });

  /* ---------- Controls ---------- */
  socket.on('startGame', ({ time, rounds, theme }) => {
    if (!currentRoomCode || !games[currentRoomCode] || isSpectator) return;
    const game = games[currentRoomCode];
    if (!game.players.find(p => p.socketId === socket.id && p.isHost)) return;
    game.settings = { time: parseInt(time), rounds: parseInt(rounds), theme };
    startNewRound(currentRoomCode);
  });

  // Host skip:
  // - playing  -> เปิดโหวต (startVote)
  // - voting/* -> คำนวณผลทันที (calculateVoteResults)
  socket.on('hostEndRound', () => {
    if (!currentRoomCode || !games[currentRoomCode] || isSpectator) return;
    const game = games[currentRoomCode];
    const me = game.players.find(pl => pl.socketId === socket.id);
    if (!me || !me.isHost) return;
    if (game.state === 'playing') startVote(currentRoomCode, 'host_ended');
    else if (game.state === 'voting' || game.state === 'revoting') calculateVoteResults(currentRoomCode);
  });

  socket.on('submitVote', (votedPlayerId) => {
    if (!currentRoomCode || !games[currentRoomCode] || isSpectator) return;
    const game = games[currentRoomCode];
    if (!['voting', 'revoting'].includes(game.state)) return;

    game.votes[socket.id] = votedPlayerId;
    const playersToVote = (game.state === 'revoting') ? game.revoteCandidates : game.players;
    const activeVoters = playersToVote.filter(p => !p.disconnected).length;
    if (Object.keys(game.votes).length === activeVoters) {
      calculateVoteResults(currentRoomCode); // ✅ โหวตครบ → จบทันที
    }
  });

  socket.on('spyGuessLocation', (guessedLocation) => {
    if (!currentRoomCode || !games[currentRoomCode] || isSpectator) return;
    const game = games[currentRoomCode];
    if (game.state !== 'spy-guessing') return;
    if (!game.spy || socket.id !== game.spy.socketId) return;

    let resultText = `สายลับหนีรอด! แต่ตอบสถานที่ผิด\nสายลับได้รับ 1 คะแนน`;
    if (guessedLocation === game.currentLocation) {
      game.spy.score++;
      resultText = `สายลับหนีรอด และตอบสถานที่ถูกต้อง!\nสายลับได้รับเพิ่มอีก 1 คะแนน!`;
    }
    endGamePhase(currentRoomCode, resultText);
  });

  socket.on('requestNextRound', () => {
    if (!currentRoomCode || !games[currentRoomCode] || isSpectator) return;
    const game = games[currentRoomCode];
    if (game.players.find(p => p.socketId === socket.id && p.isHost) && game.currentRound < game.settings.rounds) {
      startNewRound(currentRoomCode);
    }
  });

  socket.on('resetGame', () => {
    if (!currentRoomCode || !games[currentRoomCode] || isSpectator) return;
    const game = games[currentRoomCode];
    if (!game.players.find(p => p.socketId === socket.id && p.isHost)) return;
    game.state = 'lobby'; game.currentRound = 0; game.usedLocations = [];
    game.players.forEach(p => p.score = 0);
    clearTimers(game);
    io.to(currentRoomCode).emit('returnToLobby');
    io.to(currentRoomCode).emit('updatePlayerList', game.players);
    io.to(currentRoomCode).emit('updateSpectators', game.spectators.map(s=>s.name));
  });

  socket.on('kickPlayer', (playerId) => {
    if (!currentRoomCode || !games[currentRoomCode] || isSpectator) return;
    const game = games[currentRoomCode];
    const host = game.players.find(p => p.isHost);
    if (!host || host.socketId !== socket.id) return;
    const idx = game.players.findIndex(p => p.id === playerId);
    if (idx > -1) {
      const kicked = game.players[idx];
      const ks = io.sockets.sockets.get(kicked.socketId);
      if (ks) { ks.leave(currentRoomCode); ks.emit('kicked'); }
      delete playerSessions[kicked.token];
      game.players.splice(idx, 1);
      io.to(currentRoomCode).emit('updatePlayerList', game.players);
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    const game = games[currentRoomCode];

    if (isSpectator) {
      game.spectators = (game.spectators || []).filter(s => s.socketId !== socket.id);
      io.to(currentRoomCode).emit('updateSpectators', game.spectators.map(s=>s.name));
      return;
    }

    const player = game.players.find(p => p.socketId === socket.id);
    if (!player) return;

    player.disconnected = true;
    io.to(currentRoomCode).emit('playerDisconnected', player.name);
    io.to(currentRoomCode).emit('updatePlayerList', game.players);

    if (player.isHost) {
      const newHost = game.players.find(p => !p.disconnected);
      if (newHost) {
        newHost.isHost = true;
        io.to(currentRoomCode).emit('newHost', newHost.name);
        io.to(currentRoomCode).emit('updatePlayerList', game.players);
      }
    }

    if (game.players.every(p => p.disconnected)) {
      setTimeout(() => {
        if (games[currentRoomCode] && games[currentRoomCode].players.every(p => p.disconnected)) {
          clearTimers(games[currentRoomCode]);
          delete games[currentRoomCode];
        }
      }, 60000);
    }
  });
});

/* -------------------- Round & Voting Flow -------------------- */
function startNewRound(roomCode) {
  const game = games[roomCode]; if (!game) return;

  clearTimers(game);
  game.state = 'playing';
  game.currentRound++;
  game.votes = {};

  const available = getAvailableLocations(game.settings.theme);
  // หมุน location: ไม่ให้ซ้ำมากเกิน (ถ้าใช้ครบแล้วเคลียร์)
  if (game.usedLocations.length >= available.length) game.usedLocations = [];
  let pool = available.filter(l => !game.usedLocations.includes(l.name));
  if (pool.length === 0) { game.usedLocations = []; pool = available; }

  const location = pool[Math.floor(Math.random() * pool.length)];
  game.usedLocations.push(location.name);
  game.currentLocation = location.name;

  const players = game.players.filter(p => !p.disconnected);
  shuffleArray(players);
  const spyIndex = Math.floor(Math.random() * players.length);
  let roles = [...location.roles]; shuffleArray(roles);

  players.forEach((player, idx) => {
    player.role = (idx === spyIndex) ? 'สายลับ' : (roles.pop() || location.roles[0]);
    if (player.role === 'สายลับ') game.spy = player;

    const s = io.sockets.sockets.get(player.socketId);
    if (!s) return;
    s.emit('gameStarted', {
      location: player.role === 'สายลับ' ? 'ไม่ทราบ' : location.name,
      role: player.role,
      round: game.currentRound,
      totalRounds: game.settings.rounds,
      isHost: player.isHost,
      players: game.players
    });

    const allNames = available.map(l => l.name);
    if (player.role === 'สายลับ') s.emit('allLocations', pickSpyOptions(allNames, game.currentLocation, 25));
    else s.emit('allLocations', allNames);
  });

  // ตั้งนาฬิกา “เล่นรอบ”
  let timeLeft = game.settings.time;
  io.to(roomCode).emit('timerUpdate', { timeLeft, players: game.players });
  game.timer = setInterval(() => {
    timeLeft--;
    io.to(roomCode).emit('timerUpdate', { timeLeft, players: game.players });
    if (timeLeft <= 0) {
      const g = games[roomCode]; if (!g) return;
      if (g.state === 'playing') startVote(roomCode, 'timer_end');
      clearInterval(g.timer); g.timer = null;
    }
  }, 1000);

  io.to(roomCode).emit('updatePlayerList', game.players);
  io.to(roomCode).emit('updateSpectators', (game.spectators || []).map(s => s.name));
}

function startVote(roomCode, reason) {
  const game = games[roomCode]; if (!game) return;

  // หยุดนาฬิการอบ (ไม่ต้องเดินต่อในหน้าโหวต)
  if (game.timer) { clearInterval(game.timer); game.timer = null; }
  if (game.voteTimer) { clearTimeout(game.voteTimer); game.voteTimer = null; }

  game.state = 'voting';
  const msg = (reason === 'timer_end') ? 'หมดเวลา! โหวตหาตัวสายลับ' : 'หัวหน้าห้องสั่งจบรอบ!';
  io.to(roomCode).emit('startVote', {
    players: game.players.filter(p => !p.disconnected),
    reason: msg
  });

  // Safety timeout 120 วิ (กันค้าง) — แต่ถ้าโหวตครบจะคำนวณทันทีอยู่แล้ว
  game.voteTimer = setTimeout(() => calculateVoteResults(roomCode), 120000);
}

function calculateVoteResults(roomCode) {
  const game = games[roomCode]; if (!game || !['voting','revoting'].includes(game.state)) return;

  game.state = 'calculating';
  if (game.voteTimer) { clearTimeout(game.voteTimer); game.voteTimer = null; }

  const voteCounts = {};
  Object.values(game.votes || {}).forEach(id => { if (id) voteCounts[id] = (voteCounts[id] || 0) + 1; });

  let max = 0, mostVotedIds = [];
  for (const id in voteCounts) {
    if (voteCounts[id] > max) { max = voteCounts[id]; mostVotedIds = [id]; }
    else if (voteCounts[id] === max) { mostVotedIds.push(id); }
  }

  const spyId = game.spy ? game.spy.id : null;
  const spyInTop = mostVotedIds.includes(spyId);

  if (mostVotedIds.length === 1 && spyInTop) {
    // จับสายลับถูกแบบไม่เสมอ
    let text = `ถูกต้อง! ${game.spy.name} คือสายลับ!\nผู้เล่นที่โหวตถูกได้รับ 1 คะแนน:\n`;
    const winners = [];
    for (const voterSocketId in game.votes) {
      if (game.votes[voterSocketId] === spyId) {
        const voter = game.players.find(p => p.socketId === voterSocketId);
        if (voter) { voter.score++; winners.push(voter.name); }
      }
    }
    text += winners.join(', ') || 'ไม่มี';
    endGamePhase(roomCode, text);
  } else if (mostVotedIds.length > 1 && spyInTop) {
    // เสมอและมีสายลับปน → โหวตรอบสองระหว่างผู้ที่เสมอ
    game.state = 'revoting';
    game.votes = {};
    game.revoteCandidates = game.players.filter(p => mostVotedIds.includes(p.id)).filter(p => !p.disconnected);
    io.to(roomCode).emit('startVote', { players: game.revoteCandidates, reason: 'ผลโหวตเสมอ! โหวตอีกครั้ง' });
    game.voteTimer = setTimeout(() => calculateVoteResults(roomCode), 120000);
  } else {
    // โหวตพลาด/ไม่เจอสายลับ → ให้สายลับเดา
    if (game.spy) game.spy.score++;
    game.state = 'spy-guessing';
    const allNames = getAvailableLocations(game.settings.theme).map(l => l.name);
    const opts = pickSpyOptions(allNames, game.currentLocation, 25);
    const taunt = (mostVotedIds.length > 0 && !spyInTop) ? TAUNTS[Math.floor(Math.random() * TAUNTS.length)] : '';
    io.to(game.spy.socketId).emit('spyGuessPhase', { locations: opts, taunt });
    game.players.forEach(p => {
      if (p.socketId !== game.spy.socketId) io.to(p.socketId).emit('spyIsGuessing', { spyName: game.spy.name, taunt });
    });
  }
}

function endGamePhase(roomCode, resultText) {
  const game = games[roomCode]; if (!game) return;
  game.state = 'post-round';
  io.to(roomCode).emit('roundOver', {
    location: game.currentLocation,
    spyName: game.spy ? game.spy.name : 'ไม่มี',
    resultText,
    isFinalRound: game.currentRound >= game.settings.rounds,
    players: game.players
  });
}

/* -------------------- Boot -------------------- */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
