// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const locationsData = require('./locations.json');
app.use(express.static(__dirname));

const games = {};
const playerSessions = {};

const TAUNTS = ["ว้าย! โหวตผิดเพราะไม่สวยอะดิ", "เอิ้ก ๆ ๆ ๆ", "ชัดขนาดนี้!", "มองยังไงเนี่ย?", "ไปพักผ่อนบ้างนะ"];

// ===== Spectator Global Key =====
const SPECTATOR_KEY = process.env.SPECTATOR_KEY || 'letmein';

// ===== Helpers =====
function generateRoomCode() {
  let code;
  do { code = Math.random().toString(36).substring(2, 6).toUpperCase(); } while (games[code]);
  return code;
}
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}
function clearTimers(game) {
  if (game.timer) clearInterval(game.timer);
  if (game.voteTimer) clearTimeout(game.voteTimer);
  game.timer = null;
  game.voteTimer = null;
}
function getAvailableLocations(theme) {
  if (theme === 'default') return locationsData.filter(loc => loc.category === 'default');
  if (theme === 'fairytale') return locationsData.filter(loc => loc.category === 'fairytale');
  return locationsData;
}
// สุ่ม N รายการและ “การันตี” มีคำตอบจริงอยู่ในชุด
function pickSpyOptions(allNames, currentLocation, count = 25) {
  const pool = allNames.filter(n => n !== currentLocation);
  shuffleArray(pool);
  const picks = pool.slice(0, Math.max(0, count - 1));
  picks.push(currentLocation);
  shuffleArray(picks);
  return picks;
}

io.on('connection', (socket) => {
  let currentRoomCode = null;
  let isSpectator = false;

  // ===== Rejoin =====
  socket.on('rejoinGame', (playerToken) => {
    const session = playerSessions[playerToken];
    if (session && games[session.roomCode]) {
      const game = games[session.roomCode];
      const player = game.players.find(p => p.id === session.playerId);
      if (player && player.disconnected) {
        player.socketId = socket.id;
        player.disconnected = false;
        currentRoomCode = session.roomCode;
        socket.join(currentRoomCode);
        socket.emit('rejoinSuccess', { game, roomCode: currentRoomCode, self: player });
        io.to(currentRoomCode).emit('playerReconnected', player.name);
        io.to(currentRoomCode).emit('updatePlayerList', game.players);
        // ถ้าเป็นสปายระหว่างเกม ให้ส่งรายการสถานที่ทั้งหมดไปให้
        if (player.role === 'สายลับ' && ['playing','voting','revoting'].includes(game.state)) {
          const allNames = getAvailableLocations(game.settings.theme).map(l => l.name);
          io.to(player.socketId).emit('spyPossibleLocations', { locations: allNames });
        }
      }
    }
  });

  // ===== Create Room (รองรับสร้างเป็นผู้ชม) =====
  socket.on('createRoom', ({ playerName, playerToken, asSpectator }) => {
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
      const spec = { id: uuidv4(), socketId: socket.id, name: playerName };
      games[roomCode].spectators.push(spec);
      // ยังไม่มี host จนกว่าจะมีผู้เล่นเข้าห้อง
    } else {
      const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: true, score: 0, token: playerToken };
      games[roomCode].players.push(player);
      playerSessions[playerToken] = { roomCode, playerId: player.id };
    }

    socket.join(roomCode);
    socket.emit('roomCreated', { roomCode });
    io.to(roomCode).emit('updatePlayerList', games[roomCode].players);
    io.to(roomCode).emit('updateSpectators', games[roomCode].spectators.map(s => s.name));
  });

  // ===== Join as Player =====
  socket.on('joinRoom', ({ playerName, roomCode, playerToken }) => {
    const roomCodeUpper = (roomCode || '').toUpperCase();
    if (!games[roomCodeUpper]) return socket.emit('error', 'ไม่พบห้องนี้');
    if (games[roomCodeUpper].state !== 'lobby') return socket.emit('error', 'เกมเริ่มไปแล้ว');
    currentRoomCode = roomCodeUpper;

    // ถ้ายังไม่มี host (เช่น คนสร้างเป็นผู้ชม) → ผู้เล่นคนแรกที่เข้ามาจะเป็น host
    const noHostYet = !games[roomCodeUpper].players.some(p => p.isHost);
    const player = {
      id: uuidv4(),
      socketId: socket.id,
      name: playerName,
      isHost: noHostYet,
      score: 0,
      token: playerToken
    };
    games[roomCodeUpper].players.push(player);
    playerSessions[playerToken] = { roomCode: roomCodeUpper, playerId: player.id };

    socket.join(roomCodeUpper);
    socket.emit('joinSuccess', { roomCode: roomCodeUpper });
    io.to(roomCodeUpper).emit('updatePlayerList', games[roomCodeUpper].players);
    io.to(roomCodeUpper).emit('updateSpectators', games[roomCodeUpper].spectators.map(s => s.name));
  });

  // ===== Join as Spectator =====
  socket.on('joinSpectator', ({ roomCode, name, spectatorKey }) => {
    const code = (roomCode || '').toUpperCase();
    if (!games[code]) return socket.emit('error', 'ไม่พบห้องนี้');
    if (spectatorKey !== SPECTATOR_KEY) return socket.emit('error', 'รหัสผู้ชมไม่ถูกต้อง');

    currentRoomCode = code;
    isSpectator = true;

    const spec = { id: uuidv4(), socketId: socket.id, name: name || 'ผู้ชม' };
    games[code].spectators.push(spec);
    socket.join(code);

    socket.emit('spectatorJoined', { roomCode: code, name: spec.name });
    io.to(code).emit('updatePlayerList', games[code].players);
    io.to(code).emit('updateSpectators', games[code].spectators.map(s => s.name));
  });

  // ===== Controls =====
  socket.on('startGame', ({ time, rounds, theme }) => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    if (isSpectator) return; // ผู้ชมสั่งไม่ได้
    const game = games[currentRoomCode];
    if (!game.players.find(p => p.socketId === socket.id && p.isHost)) return;
    game.settings = { time: parseInt(time), rounds: parseInt(rounds), theme };
    startNewRound(currentRoomCode);
  });

  socket.on('hostEndRound', () => {
    if (currentRoomCode && games[currentRoomCode]) {
      if (isSpectator) return;
      const game = games[currentRoomCode];
      const p = game.players.find(pl => pl.socketId === socket.id);
      if (p && p.isHost && game.state === 'playing') startVote(currentRoomCode, "host_ended");
    }
  });

  socket.on('submitVote', (votedPlayerId) => {
    if (currentRoomCode && games[currentRoomCode]) {
      if (isSpectator) return;
      const game = games[currentRoomCode];
      if (['voting', 'revoting'].includes(game.state)) {
        game.votes[socket.id] = votedPlayerId;
        const playersToVote = game.state === 'revoting' ? game.revoteCandidates : game.players;
        if (Object.keys(game.votes).length === playersToVote.filter(p => !p.disconnected).length) {
          calculateVoteResults(currentRoomCode);
        }
      }
    }
  });

  // ===== Spy Guessing =====
  socket.on('spyGuessLocation', (guessedLocation) => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    if (isSpectator) return;
    const game = games[currentRoomCode];
    if (game.state !== 'spy-guessing') return;
    if (!game.spy || socket.id !== game.spy.socketId) return;
    if (typeof guessedLocation !== 'string' || !guessedLocation.trim()) return;

    let resultText = `สายลับหนีรอด! แต่ตอบสถานที่ผิด\nสายลับได้รับ 1 คะแนน`;
    if (guessedLocation === game.currentLocation) {
      game.spy.score++;
      resultText = `สายลับหนีรอด และตอบสถานที่ถูกต้อง!\nสายลับได้รับเพิ่มอีก 1 คะแนน!`;
    }
    endGamePhase(currentRoomCode, resultText);
  });

  socket.on('requestNextRound', () => {
    if (currentRoomCode && games[currentRoomCode]) {
      if (isSpectator) return;
      const game = games[currentRoomCode];
      if (game.players.find(p => p.socketId === socket.id && p.isHost) && game.currentRound < game.settings.rounds) {
        startNewRound(currentRoomCode);
      }
    }
  });

  socket.on('resetGame', () => {
    if (currentRoomCode && games[currentRoomCode]) {
      if (isSpectator) return;
      const game = games[currentRoomCode];
      if (game.players.find(p => p.socketId === socket.id && p.isHost)) {
        game.state = 'lobby';
        game.currentRound = 0;
        game.usedLocations = [];
        game.players.forEach(p => p.score = 0);
        clearTimers(game);
        io.to(currentRoomCode).emit('returnToLobby');
        io.to(currentRoomCode).emit('updatePlayerList', game.players);
        io.to(currentRoomCode).emit('updateSpectators', game.spectators.map(s => s.name));
      }
    }
  });

  socket.on('kickPlayer', (playerIdToKick) => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    if (isSpectator) return;
    const game = games[currentRoomCode];
    const host = game.players.find(p => p.isHost);
    if (!host || host.socketId !== socket.id) return;

    const idx = game.players.findIndex(p => p.id === playerIdToKick);
    if (idx > -1) {
      const kickedPlayer = game.players[idx];
      const kickedSocket = io.sockets.sockets.get(kickedPlayer.socketId);
      if (kickedSocket) {
        kickedSocket.leave(currentRoomCode);
        kickedSocket.emit('kicked');
      }
      delete playerSessions[kickedPlayer.token];
      game.players.splice(idx, 1);
      io.to(currentRoomCode).emit('updatePlayerList', game.players);
    }
  });

  // ===== Disconnect =====
  socket.on('disconnect', () => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    const game = games[currentRoomCode];

    if (isSpectator) {
      game.spectators = (game.spectators || []).filter(s => s.socketId !== socket.id);
      io.to(currentRoomCode).emit('updateSpectators', game.spectators.map(s => s.name));
      return;
    }

    const player = game.players.find(p => p.socketId === socket.id);
    if (player) {
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
    }
  });
});

// ===== Rounds & Voting =====
function startNewRound(roomCode) {
  const game = games[roomCode];
  if (!game) return;

  clearTimers(game);
  game.state = 'playing';
  game.currentRound++;
  game.votes = {};

  const availableLocations = getAvailableLocations(game.settings.theme);
  if (game.usedLocations.length >= availableLocations.length) game.usedLocations = [];
  let locationPool = availableLocations.filter(loc => !game.usedLocations.includes(loc.name));
  if (locationPool.length === 0) { game.usedLocations = []; locationPool = availableLocations; }

  const location = locationPool[Math.floor(Math.random() * locationPool.length)];
  game.usedLocations.push(location.name);
  game.currentLocation = location.name;

  const playersInRoom = game.players.filter(p => !p.disconnected);
  shuffleArray(playersInRoom);

  const spyIndex = Math.floor(Math.random() * playersInRoom.length);
  let roles = [...location.roles];
  shuffleArray(roles);

  playersInRoom.forEach((player, index) => {
    player.role = (index === spyIndex) ? 'สายลับ' : (roles.pop() || location.roles[0]);
    if (player.role === 'สายลับ') game.spy = player;

    const s = io.sockets.sockets.get(player.socketId);
    if (s) {
      s.emit('gameStarted', {
        location: player.role === 'สายลับ' ? 'ไม่ทราบ' : location.name,
        role: player.role,
        round: game.currentRound,
        totalRounds: game.settings.rounds,
        isHost: player.isHost,
        players: game.players
      });
      // ให้สปายเห็นรายการสถานที่ทั้งหมดที่เป็นไปได้ตั้งแต่เริ่มรอบ
      if (player.role === 'สายลับ') {
        const allNames = availableLocations.map(l => l.name);
        io.to(player.socketId).emit('spyPossibleLocations', { locations: allNames });
      }
    }
  });

  // นาฬิการอบ (ยังเดินแม้เข้าสู่โหวต)
  let timeLeft = game.settings.time;
  io.to(roomCode).emit('timerUpdate', { timeLeft, players: game.players });
  game.timer = setInterval(() => {
    timeLeft--;
    io.to(roomCode).emit('timerUpdate', { timeLeft, players: game.players });
    if (timeLeft <= 0) {
      const g = games[roomCode]; if (!g) return;
      if (g.state === 'playing') startVote(roomCode, "timer_end");
      else if (g.state === 'voting' || g.state === 'revoting') calculateVoteResults(roomCode);
    }
  }, 1000);

  // อัปเดตรายชื่อผู้ชมด้วย
  io.to(roomCode).emit('updatePlayerList', game.players);
  io.to(roomCode).emit('updateSpectators', (game.spectators || []).map(s => s.name));
}

function startVote(roomCode, reason) {
  const game = games[roomCode];
  if (!game) return;

  // ถ้าหมดเวลารอบระหว่างกำลังโหวต → สรุปผลเลย
  if ((game.state === 'voting' || game.state === 'revoting') && reason === 'timer_end') {
    return calculateVoteResults(roomCode);
  }

  // อย่าแตะ game.timer (ปล่อยให้เดินต่อ)
  if (game.voteTimer) { clearTimeout(game.voteTimer); game.voteTimer = null; }

  game.state = 'voting';
  const voteReason = reason === "timer_end" ? "หมดเวลา! โหวตหาตัวสายลับ" : "หัวหน้าห้องสั่งจบรอบ!";
  io.to(roomCode).emit('startVote', { players: game.players.filter(p => !p.disconnected), reason: voteReason });

  // เดดไลน์การโหวต 120 วินาที
  game.voteTimer = setTimeout(() => calculateVoteResults(roomCode), 120000);
}

function calculateVoteResults(roomCode) {
  const game = games[roomCode];
  if (!game || !['voting', 'revoting'].includes(game.state)) return;

  // จับ candidates ก่อนเปลี่ยน state (กัน revote เพี้ยน)
  const playersToConsider = (game.state === 'revoting' ? game.revoteCandidates : game.players)
    .filter(p => !p.disconnected);

  game.state = 'calculating';
  if (game.voteTimer) { clearTimeout(game.voteTimer); game.voteTimer = null; }

  const voteCounts = {};
  Object.values(game.votes || {}).forEach(votedId => {
    if (votedId) voteCounts[votedId] = (voteCounts[votedId] || 0) + 1;
  });

  let maxVotes = 0;
  let mostVotedIds = [];
  for (const playerId in voteCounts) {
    if (voteCounts[playerId] > maxVotes) { maxVotes = voteCounts[playerId]; mostVotedIds = [playerId]; }
    else if (voteCounts[playerId] === maxVotes) { mostVotedIds.push(playerId); }
  }

  const spyId = game.spy ? game.spy.id : null;
  const isSpyAmongstMostVoted = mostVotedIds.includes(spyId);

  if (mostVotedIds.length === 1 && isSpyAmongstMostVoted) {
    // จับสปายถูก
    let resultText = `ถูกต้อง! ${game.spy.name} คือสายลับ!\nผู้เล่นที่โหวตถูกได้รับ 1 คะแนน:\n`;
    const correctVoters = [];
    for (const voterSocketId in game.votes) {
      if (game.votes[voterSocketId] === spyId) {
        const voter = game.players.find(p => p.socketId === voterSocketId);
        if (voter) { voter.score++; correctVoters.push(voter.name); }
      }
    }
    resultText += correctVoters.join(', ') || "ไม่มี";
    endGamePhase(roomCode, resultText);
  } else if (mostVotedIds.length > 1 && isSpyAmongstMostVoted) {
    // เสมอและมีสปายในกลุ่ม -> รีโหวต
    game.state = 'revoting';
    game.votes = {};
    game.revoteCandidates = playersToConsider.filter(p => mostVotedIds.includes(p.id));
    io.to(roomCode).emit('startVote', { players: game.revoteCandidates, reason: "ผลโหวตเสมอ! โหวตอีกครั้ง" });
    game.voteTimer = setTimeout(() => calculateVoteResults(roomCode), 120000);
  } else {
    // โหวตพลาด -> ให้สปายเดา (สุ่ม 25 รายการ มีคำตอบจริงแน่)
    if (game.spy) game.spy.score++;
    game.state = 'spy-guessing';

    const allNames = getAvailableLocations(game.settings.theme).map(l => l.name);
    const options25 = pickSpyOptions(allNames, game.currentLocation, 25);
    const taunt = (mostVotedIds.length > 0 && !isSpyAmongstMostVoted) ? TAUNTS[Math.floor(Math.random() * TAUNTS.length)] : "";

    io.to(game.spy.socketId).emit('spyGuessPhase', { locations: options25, taunt });
    game.players.forEach(p => {
      if (p.socketId !== game.spy.socketId) io.to(p.socketId).emit('spyIsGuessing', { spyName: game.spy.name, taunt });
    });
  }
}

function endGamePhase(roomCode, resultText) {
  const game = games[roomCode];
  if (!game) return;

  game.state = 'post-round';
  if (game.timer) { clearInterval(game.timer); game.timer = null; }

  io.to(roomCode).emit('roundOver', {
    location: game.currentLocation,
    spyName: game.spy ? game.spy.name : 'ไม่มี',
    resultText,
    isFinalRound: game.currentRound >= game.settings.rounds,
    players: game.players
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
