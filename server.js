const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const locationsData = require('./locations.json');

// เสิร์ฟไฟล์ static (index.html / asset) จากโฟลเดอร์เดียวกับ server.js
app.use(express.static(__dirname));

/** ====== In-Memory State ====== */
const games = {};             // { [roomCode]: GameState }
const playerSessions = {};    // { [playerToken]: { roomCode, playerId } }

const TAUNTS = [
  "ว้าย! โหวตผิดเพราะไม่สวยอะดิ",
  "เอิ้ก ๆ ๆ ๆ",
  "ชัดขนาดนี้!",
  "มองยังไงเนี่ย?",
  "ไปพักผ่อนบ้างนะ"
];

/** ====== Helpers ====== */
function generateRoomCode() {
  let code;
  do { code = Math.random().toString(36).substring(2, 6).toUpperCase(); }
  while (games[code]);
  return code;
}
function shuffleArray(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
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
/** ให้ Spy เห็น 25 ตัวเลือก (รวมคำตอบจริงเสมอ) */
function pickSpyOptions(allNames, currentName, count = 25) {
  const pool = allNames.filter(n => n !== currentName);
  shuffleArray(pool);
  const picks = pool.slice(0, Math.max(0, count - 1));
  picks.push(currentName);
  shuffleArray(picks);
  return picks;
}

/** ====== Socket.IO ====== */
io.on('connection', (socket) => {
  let currentRoomCode = null;

  /** ---------- Rejoin ---------- */
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

    // เติมรายการสถานที่ตามบทบาทหลังรีจอย
    const allNames = getAvailableLocations(game.settings.theme).map(l => l.name);
    if (['playing', 'voting', 'revoting'].includes(game.state)) {
      if (player.role === 'สายลับ') {
        socket.emit('allLocations', pickSpyOptions(allNames, game.currentLocation, 25));
      } else {
        socket.emit('allLocations', allNames);
      }
    }
  });

  /** ---------- สร้างห้อง ---------- */
  socket.on('createRoom', ({ playerName, playerToken }) => {
    if (!playerName || !String(playerName).trim()) return socket.emit('error', 'กรุณาระบุชื่อผู้เล่น');

    const roomCode = generateRoomCode();
    currentRoomCode = roomCode;
    games[roomCode] = {
      players: [],
      state: 'lobby',
      settings: { time: 300, rounds: 5, theme: 'all' },
      currentRound: 0,
      usedLocations: [],
      timer: null,
      voteTimer: null,
      votes: {}
    };

    if (!playerToken) playerToken = uuidv4();
    const player = {
      id: uuidv4(),
      socketId: socket.id,
      name: playerName.trim(),
      isHost: true,
      score: 0,
      token: playerToken
    };
    games[roomCode].players.push(player);
    playerSessions[playerToken] = { roomCode, playerId: player.id };

    socket.join(roomCode);
    socket.emit('roomCreated', { roomCode });
    io.to(roomCode).emit('updatePlayerList', games[roomCode].players);
  });

  /** ---------- เข้าห้อง ---------- */
  socket.on('joinRoom', ({ playerName, roomCode, playerToken }) => {
    const code = (roomCode || '').toUpperCase();
    if (!games[code]) return socket.emit('error', 'ไม่พบห้องนี้');
    if (games[code].state !== 'lobby') return socket.emit('error', 'เกมเริ่มไปแล้ว');
    if (!playerName || !String(playerName).trim()) return socket.emit('error', 'กรุณาระบุชื่อผู้เล่น');

    currentRoomCode = code;
    if (!playerToken) playerToken = uuidv4();

    // คนแรกที่เข้า ถ้ายังไม่มี host ให้เป็น host
    const noHost = !games[code].players.some(p => p.isHost);

    const player = {
      id: uuidv4(),
      socketId: socket.id,
      name: playerName.trim(),
      isHost: noHost,
      score: 0,
      token: playerToken
    };
    games[code].players.push(player);
    playerSessions[playerToken] = { roomCode: code, playerId: player.id };

    socket.join(code);
    socket.emit('joinSuccess', { roomCode: code });
    io.to(code).emit('updatePlayerList', games[code].players);
  });

  /** ---------- เริ่มเกม ---------- */
  socket.on('startGame', ({ time, rounds, theme }) => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    const game = games[currentRoomCode];
    // ต้องเป็น host เท่านั้น
    if (!game.players.find(p => p.socketId === socket.id && p.isHost)) return;

    const t = parseInt(time, 10);
    const r = parseInt(rounds, 10);
    game.settings = {
      time: Number.isFinite(t) ? t : 300,
      rounds: Number.isFinite(r) ? r : 5,
      theme: theme || 'all'
    };
    startNewRound(currentRoomCode);
  });

  /** ---------- Host บังคับจบรอบ ---------- */
  socket.on('hostEndRound', () => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    const game = games[currentRoomCode];
    const me = game.players.find(pl => pl.socketId === socket.id);
    if (!me || !me.isHost) return;

    if (game.state === 'playing') {
      startVote(currentRoomCode, 'host_ended');
    } else if (game.state === 'voting' || game.state === 'revoting') {
      // กำลังโหวตอยู่ → สรุปผลทันที
      calculateVoteResults(currentRoomCode);
    }
  });

  /** ---------- โหวต ---------- */
  socket.on('submitVote', (votedPlayerId) => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    const game = games[currentRoomCode];
    if (!['voting', 'revoting'].includes(game.state)) return;

    game.votes[socket.id] = votedPlayerId;

    const playersToVote = (game.state === 'revoting') ? (game.revoteCandidates || []) : game.players;
    const active = playersToVote.filter(p => !p.disconnected).length;
    const received = Object.keys(game.votes).length;

    if (received === active) {
      // โหวตครบ → ตัดจบทันที
      calculateVoteResults(currentRoomCode);
    }
  });

  /** ---------- ขอรายชื่อ 25 สำหรับ Spy (เมื่อกดเปิด modal ทีหลัง) ---------- */
  socket.on('requestSpyLocations', () => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    const game = games[currentRoomCode];
    const me = game.players.find(p => p.socketId === socket.id);
    if (!me || me.role !== 'สายลับ') return;

    const allNames = getAvailableLocations(game.settings.theme).map(l => l.name);
    socket.emit('allLocations', pickSpyOptions(allNames, game.currentLocation, 25));
  });

  /** ---------- Spy ทายสถานที่ ---------- */
  socket.on('spyGuessLocation', (guessedLocation) => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
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

  /** ---------- ขอรอบถัดไป / รีเซ็ต ---------- */
  socket.on('requestNextRound', () => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    const game = games[currentRoomCode];
    const me = game.players.find(p => p.socketId === socket.id);
    if (!me || !me.isHost) return;
    if (game.currentRound < game.settings.rounds) startNewRound(currentRoomCode);
  });

  socket.on('resetGame', () => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    const game = games[currentRoomCode];
    const me = game.players.find(p => p.socketId === socket.id);
    if (!me || !me.isHost) return;

    game.state = 'lobby';
    game.currentRound = 0;
    game.usedLocations = [];
    game.players.forEach(p => { p.score = 0; p.role = null; });
    clearTimers(game);

    io.to(currentRoomCode).emit('returnToLobby');
    io.to(currentRoomCode).emit('updatePlayerList', game.players);
  });

  /** ---------- เตะผู้เล่น ---------- */
  socket.on('kickPlayer', (playerId) => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    const game = games[currentRoomCode];
    const host = game.players.find(p => p.isHost);
    if (!host || host.socketId !== socket.id) return;

    const idx = game.players.findIndex(p => p.id === playerId);
    if (idx > -1) {
      const kicked = game.players[idx];
      const kickedSock = io.sockets.sockets.get(kicked.socketId);
      if (kickedSock) {
        kickedSock.leave(currentRoomCode);
        kickedSock.emit('kicked');
      }
      delete playerSessions[kicked.token];
      game.players.splice(idx, 1);
      io.to(currentRoomCode).emit('updatePlayerList', game.players);
    }
  });

  /** ---------- Disconnect ---------- */
  socket.on('disconnect', () => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    const game = games[currentRoomCode];
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player) return;

    player.disconnected = true;
    io.to(currentRoomCode).emit('playerDisconnected', player.name);
    io.to(currentRoomCode).emit('updatePlayerList', game.players);

    if (player.isHost) {
      // ย้าย host
      const newHost = game.players.find(p => !p.disconnected);
      if (newHost) {
        newHost.isHost = true;
        io.to(currentRoomCode).emit('newHost', newHost.name);
        io.to(currentRoomCode).emit('updatePlayerList', game.players);
      }
    }

    // ถ้าทุกคนหลุด → ลบทิ้งใน 60 วิ
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

/** ====== Game Flow ====== */
function startNewRound(roomCode) {
  const game = games[roomCode];
  if (!game) return;

  clearTimers(game);
  game.state = 'playing';
  game.currentRound++;
  game.votes = {};
  game.revoteCandidates = null;

  // เลือกสถานที่ (หมุนไม่ให้ซ้ำจนหมด)
  const available = getAvailableLocations(game.settings.theme);
  if (game.usedLocations.length >= available.length) game.usedLocations = [];
  let pool = available.filter(l => !game.usedLocations.includes(l.name));
  if (pool.length === 0) { pool = available; game.usedLocations = []; }

  const location = pool[Math.floor(Math.random() * pool.length)];
  game.usedLocations.push(location.name);
  game.currentLocation = location.name;

  // สุ่มบทบาท + เลือกสปาย
  const players = game.players.filter(p => !p.disconnected);
  shuffleArray(players);
  const spyIndex = Math.floor(Math.random() * players.length);
  let roles = [...location.roles];
  shuffleArray(roles);

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
    if (player.role === 'สายลับ') {
      s.emit('allLocations', pickSpyOptions(allNames, game.currentLocation, 25));
    } else {
      s.emit('allLocations', allNames); // ผู้เล่นทั่วไปเห็นทั้งหมด
    }
  });

  // นาฬิการอบหลัก
  let timeLeft = game.settings.time;
  io.to(roomCode).emit('timerUpdate', { timeLeft, players: game.players });
  game.timer = setInterval(() => {
    timeLeft--;
    io.to(roomCode).emit('timerUpdate', { timeLeft, players: game.players });
    if (timeLeft <= 0) {
      const g = games[roomCode];
      if (!g) return;
      if (g.state === 'playing') startVote(roomCode, 'timer_end');
      clearInterval(g.timer);
      g.timer = null;
    }
  }, 1000);

  io.to(roomCode).emit('updatePlayerList', game.players);
}

function startVote(roomCode, reason) {
  const game = games[roomCode]; if (!game) return;

  // หยุดนาฬิการอบ (เราใช้เฉพาะนาฬิกาโหวต)
  if (game.timer) { clearInterval(game.timer); game.timer = null; }
  if (game.voteTimer) { clearTimeout(game.voteTimer); game.voteTimer = null; }

  game.state = 'voting';
  const msg = reason === 'timer_end' ? 'หมดเวลา! โหวตหาตัวสายลับ' : 'หัวหน้าห้องสั่งจบรอบ!';
  io.to(roomCode).emit('startVote', {
    players: game.players.filter(p => !p.disconnected),
    reason: msg
  });

  // Safety timer 120 วิ (แต่ถ้าโหวตครบ เราจะตัดจบทันทีอยู่แล้ว)
  game.voteTimer = setTimeout(() => calculateVoteResults(roomCode), 120000);
}

function calculateVoteResults(roomCode) {
  const game = games[roomCode];
  if (!game || !['voting', 'revoting'].includes(game.state)) return;

  game.state = 'calculating';
  if (game.voteTimer) { clearTimeout(game.voteTimer); game.voteTimer = null; }

  // เลือกกลุ่มที่จะนับ (revote จะนับเฉพาะ candidates)
  const playersToConsider = (game.state === 'revoting' ? game.revoteCandidates : game.players) || game.players;
  const activeIds = new Set(playersToConsider.filter(p => !p.disconnected).map(p => p.id));

  // นับคะแนน
  const voteMap = {};
  for (const [voterSocketId, votedId] of Object.entries(game.votes || {})) {
    if (votedId && activeIds.has(votedId)) {
      voteMap[votedId] = (voteMap[votedId] || 0) + 1;
    }
  }

  let maxVotes = 0;
  let top = [];
  for (const pid in voteMap) {
    if (voteMap[pid] > maxVotes) { maxVotes = voteMap[pid]; top = [pid]; }
    else if (voteMap[pid] === maxVotes) top.push(pid);
  }

  const spyId = game.spy ? game.spy.id : null;
  const spyInTop = top.includes(spyId);

  // กรณีต่าง ๆ
  if (top.length === 1 && spyInTop) {
    // จับสปายถูก (ไม่มีเสมอ)
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

  } else if (top.length > 1 && spyInTop) {
    // เสมอและมีสปายอยู่ในกลุ่ม → revote
    game.state = 'revoting';
    game.votes = {};
    game.revoteCandidates = game.players.filter(p => top.includes(p.id)).filter(p => !p.disconnected);
    io.to(roomCode).emit('startVote', { players: game.revoteCandidates, reason: 'ผลโหวตเสมอ! โหวตอีกครั้ง' });
    game.voteTimer = setTimeout(() => calculateVoteResults(roomCode), 120000);

  } else {
    // โหวตพลาด → สปายได้ 1 คะแนน และเข้าสู่โหมดทายสถานที่
    if (game.spy) game.spy.score++;
    game.state = 'spy-guessing';

    const allNames = getAvailableLocations(game.settings.theme).map(l => l.name);
    const opts = pickSpyOptions(allNames, game.currentLocation, 25);
    const taunt = (top.length > 0 && !spyInTop) ? TAUNTS[Math.floor(Math.random() * TAUNTS.length)] : '';

    io.to(game.spy.socketId).emit('spyGuessPhase', { locations: opts, taunt });
    game.players.forEach(p => {
      if (p.socketId !== game.spy.socketId) {
        io.to(p.socketId).emit('spyIsGuessing', { spyName: game.spy.name, taunt });
      }
    });
  }
}

function endGamePhase(roomCode, resultText) {
  const game = games[roomCode];
  if (!game) return;

  game.state = 'post-round';
  io.to(roomCode).emit('roundOver', {
    location: game.currentLocation,
    spyName: game.spy ? game.spy.name : 'ไม่มี',
    resultText,
    isFinalRound: game.currentRound >= game.settings.rounds,
    players: game.players
  });
}

/** ====== Boot ====== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
