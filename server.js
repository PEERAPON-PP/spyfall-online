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

// Helper Functions
function generateRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 6).toUpperCase();
  } while (games[code]);
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

io.on('connection', (socket) => {
  let currentRoomCode = null;

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
      }
    }
  });

  socket.on('createRoom', ({ playerName, playerToken }) => {
    const roomCode = generateRoomCode();
    currentRoomCode = roomCode;
    games[roomCode] = {
      players: [],
      state: 'lobby',
      settings: { time: 300, rounds: 5, theme: 'all' },
      currentRound: 0,
      usedLocations: []
    };
    const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: true, score: 0, token: playerToken };
    games[roomCode].players.push(player);
    playerSessions[playerToken] = { roomCode, playerId: player.id };
    socket.join(roomCode);
    socket.emit('roomCreated', { roomCode });
    io.to(roomCode).emit('updatePlayerList', games[roomCode].players);
  });

  socket.on('joinRoom', ({ playerName, roomCode, playerToken }) => {
    const roomCodeUpper = roomCode.toUpperCase();
    if (!games[roomCodeUpper]) return socket.emit('error', 'ไม่พบห้องนี้');
    if (games[roomCodeUpper].state !== 'lobby') return socket.emit('error', 'เกมเริ่มไปแล้ว');
    currentRoomCode = roomCodeUpper;
    const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: false, score: 0, token: playerToken };
    games[roomCodeUpper].players.push(player);
    playerSessions[playerToken] = { roomCode: roomCodeUpper, playerId: player.id };
    socket.join(roomCodeUpper);
    socket.emit('joinSuccess', { roomCode: roomCodeUpper });
    io.to(roomCodeUpper).emit('updatePlayerList', games[roomCodeUpper].players);
  });

  socket.on('startGame', ({ time, rounds, theme }) => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    const game = games[currentRoomCode];
    if (!game.players.find(p => p.socketId === socket.id && p.isHost)) return;
    game.settings = { time: parseInt(time), rounds: parseInt(rounds), theme };
    startNewRound(currentRoomCode);
  });

  socket.on('hostEndRound', () => {
    if (currentRoomCode && games[currentRoomCode]) {
      const game = games[currentRoomCode];
      const p = game.players.find(pl => pl.socketId === socket.id);
      if (p && p.isHost && game.state === 'playing') startVote(currentRoomCode, "host_ended");
    }
  });

  socket.on('submitVote', (votedPlayerId) => {
    if (currentRoomCode && games[currentRoomCode]) {
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

  // ✅ แก้บั๊ก: ใช้ currentRoomCode ที่อยู่ในสโคปนี้จริง และเพิ่มการ์ดกันพัง
  socket.on('spyGuessLocation', (guessedLocation) => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
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
      const game = games[currentRoomCode];
      if (game.players.find(p => p.socketId === socket.id && p.isHost) && game.currentRound < game.settings.rounds) {
        startNewRound(currentRoomCode);
      }
    }
  });

  socket.on('resetGame', () => {
    if (currentRoomCode && games[currentRoomCode]) {
      const game = games[currentRoomCode];
      if (game.players.find(p => p.socketId === socket.id && p.isHost)) {
        game.state = 'lobby';
        game.currentRound = 0;
        game.usedLocations = [];
        game.players.forEach(p => p.score = 0);
        clearTimers(game);
        io.to(currentRoomCode).emit('returnToLobby');
        io.to(currentRoomCode).emit('updatePlayerList', game.players);
      }
    }
  });

  socket.on('kickPlayer', (playerIdToKick) => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    const game = games[currentRoomCode];
    const host = game.players.find(p => p.isHost);
    if (host.socketId !== socket.id) return;
    const playerIndex = game.players.findIndex(p => p.id === playerIdToKick);
    if (playerIndex > -1) {
      const kickedPlayer = game.players[playerIndex];
      const kickedSocket = io.sockets.sockets.get(kickedPlayer.socketId);
      if (kickedSocket) {
        kickedSocket.leave(currentRoomCode);
        kickedSocket.emit('kicked');
      }
      delete playerSessions[kickedPlayer.token];
      game.players.splice(playerIndex, 1);
      io.to(currentRoomCode).emit('updatePlayerList', game.players);
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoomCode || !games[currentRoomCode]) return;
    const game = games[currentRoomCode];
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

function getAvailableLocations(theme) {
  if (theme === 'default') return locationsData.filter(loc => loc.category === 'default');
  if (theme === 'fairytale') return locationsData.filter(loc => loc.category === 'fairytale');
  return locationsData;
}

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
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket) {
      socket.emit('gameStarted', {
        location: player.role === 'สายลับ' ? 'ไม่ทราบ' : location.name,
        role: player.role,
        round: game.currentRound,
        totalRounds: game.settings.rounds,
        isHost: player.isHost,
        players: game.players
      });
      if (player.role === 'สายลับ') socket.emit('allLocations', availableLocations.map(l => l.name));
    }
  });

  let timeLeft = game.settings.time;
  io.to(roomCode).emit('timerUpdate', { timeLeft, players: game.players });
  game.timer = setInterval(() => {
    timeLeft--;
    io.to(roomCode).emit('timerUpdate', { timeLeft, players: game.players });
    if (timeLeft <= 0) startVote(roomCode, "timer_end");
  }, 1000);
}

function startVote(roomCode, reason) {
  const game = games[roomCode];
  if (!game) return;
  clearTimers(game);
  game.state = 'voting';
  const voteReason = reason === "timer_end" ? "หมดเวลา! โหวตหาตัวสายลับ" : "หัวหน้าห้องสั่งจบรอบ!";
  io.to(roomCode).emit('startVote', { players: game.players.filter(p => !p.disconnected), reason: voteReason });
  game.voteTimer = setTimeout(() => calculateVoteResults(roomCode), 120000);
}

function calculateVoteResults(roomCode) {
  const game = games[roomCode];
  if (!game || !['voting', 'revoting'].includes(game.state)) return;

  // ✅ จับ candidates ก่อนเปลี่ยน state เพื่อไม่ให้เงื่อนไข revoting เพี้ยน
  const playersToConsider = (game.state === 'revoting' ? game.revoteCandidates : game.players)
    .filter(p => !p.disconnected);

  game.state = 'calculating';
  clearTimers(game);

  const voteCounts = {};
  Object.values(game.votes || {}).forEach(votedId => {
    if (votedId) voteCounts[votedId] = (voteCounts[votedId] || 0) + 1;
  });

  let maxVotes = 0;
  let mostVotedIds = [];
  for (const playerId in voteCounts) {
    if (voteCounts[playerId] > maxVotes) {
      maxVotes = voteCounts[playerId];
      mostVotedIds = [playerId];
    } else if (voteCounts[playerId] === maxVotes) {
      mostVotedIds.push(playerId);
    }
  }

  const spyId = game.spy ? game.spy.id : null;
  const isSpyAmongstMostVoted = mostVotedIds.includes(spyId);

  if (mostVotedIds.length === 1 && isSpyAmongstMostVoted) {
    // Correctly voted for the spy with no ties
    let resultText = `ถูกต้อง! ${game.spy.name} คือสายลับ!\nผู้เล่นที่โหวตถูกได้รับ 1 คะแนน:\n`;
    let correctVoters = [];
    for (const voterSocketId in game.votes) {
      if (game.votes[voterSocketId] === spyId) {
        const voter = game.players.find(p => p.socketId === voterSocketId);
        if (voter) {
          voter.score++;
          correctVoters.push(voter.name);
        }
      }
    }
    resultText += correctVoters.join(', ') || "ไม่มี";
    endGamePhase(roomCode, resultText);
  } else if (mostVotedIds.length > 1 && isSpyAmongstMostVoted) {
    // A tie vote and the spy is in the tie, start revote
    game.state = 'revoting';
    game.votes = {};
    // ✅ ใช้เฉพาะผู้เล่นที่ยังอยู่ในเกม (กรอง disconnect แล้ว)
    game.revoteCandidates = playersToConsider.filter(p => mostVotedIds.includes(p.id));
    io.to(roomCode).emit('startVote', { players: game.revoteCandidates, reason: "ผลโหวตเสมอ! โหวตอีกครั้ง" });
    game.voteTimer = setTimeout(() => calculateVoteResults(roomCode), 120000); // 2 minute revote timer
  } else {
    // Vote failed to find the spy (either wrong vote or spy was not in the tie)
    game.spy.score++;
    game.state = 'spy-guessing';
    const taunt = (mostVotedIds.length > 0 && !isSpyAmongstMostVoted) ? TAUNTS[Math.floor(Math.random() * TAUNTS.length)] : "";
    io.to(game.spy.socketId).emit('spyGuessPhase', {
      locations: getAvailableLocations(game.settings.theme).map(l => l.name).slice(0, 25),
      taunt
    });
    game.players.forEach(p => {
      if (p.socketId !== game.spy.socketId) io.to(p.socketId).emit('spyIsGuessing', { spyName: game.spy.name, taunt });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
