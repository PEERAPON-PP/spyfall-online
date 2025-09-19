const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const locationsData = require('./locations.json');

const games = {};
const playerSessions = {};

// ✅ serve index.html + static จาก root
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// helper
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
function generateRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 6).toUpperCase();
  } while (games[code]);
  return code;
}
function getAvailableLocations(theme) {
  if (theme === 'default') return locationsData.filter(l => l.category === 'default');
  if (theme === 'fairytale') return locationsData.filter(l => l.category === 'fairytale');
  return locationsData;
}

// socket.io
io.on('connection', (socket) => {
  let currentRoomCode = null;

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
    const code = roomCode.toUpperCase();
    if (!games[code]) return socket.emit('error', 'ไม่พบห้อง');
    if (games[code].state !== 'lobby') return socket.emit('error', 'เกมเริ่มไปแล้ว');
    currentRoomCode = code;
    const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: false, score: 0, token: playerToken };
    games[code].players.push(player);
    playerSessions[playerToken] = { roomCode: code, playerId: player.id };
    socket.join(code);
    socket.emit('joinSuccess', { roomCode: code });
    io.to(code).emit('updatePlayerList', games[code].players);
  });

  socket.on('startGame', ({ time, rounds, theme }) => {
    const g = games[currentRoomCode];
    if (!g) return;
    const host = g.players.find(p => p.socketId === socket.id && p.isHost);
    if (!host) return;
    g.settings = { time: parseInt(time), rounds: parseInt(rounds), theme };
    startNewRound(currentRoomCode);
  });

  socket.on('hostEndRound', () => {
    const g = games[currentRoomCode];
    if (!g) return;
    const host = g.players.find(p => p.socketId === socket.id && p.isHost);
    if (host && g.state === 'playing') startVote(currentRoomCode, "host_ended");
  });

  socket.on('submitVote', (votedPlayerId) => {
    const g = games[currentRoomCode];
    if (!g || !['voting','revoting'].includes(g.state)) return;
    const me = g.players.find(p => p.socketId === socket.id);
    if (!me) return;
    if (votedPlayerId && votedPlayerId === me.id) {
      io.to(socket.id).emit('voteRejected', { reason: 'no-self' });
      return;
    }
    g.votes[socket.id] = votedPlayerId;
    const voters = g.state === 'revoting' ? g.revoteCandidates : g.players;
    if (Object.keys(g.votes).length === voters.filter(p => !p.disconnected).length) {
      calculateVoteResults(currentRoomCode);
    }
  });

  socket.on('spyGuessLocation', (guess) => {
    const g = games[currentRoomCode];
    if (!g || g.state !== 'spy-guessing') return;
    if (socket.id !== g.spy.socketId) return;
    let txt = `สายลับหนีรอด! แต่ตอบผิด ได้ 1 คะแนน`;
    if (guess === g.currentLocation) {
      g.spy.score++;
      txt = `สายลับหนีรอดและตอบถูก ได้เพิ่มอีก 1 คะแนน!`;
    }
    endGamePhase(currentRoomCode, txt);
  });

  socket.on('requestNextRound', () => {
    const g = games[currentRoomCode];
    if (!g) return;
    const host = g.players.find(p => p.socketId === socket.id && p.isHost);
    if (host && g.currentRound < g.settings.rounds) startNewRound(currentRoomCode);
  });

  socket.on('resetGame', () => {
    const g = games[currentRoomCode];
    if (!g) return;
    const host = g.players.find(p => p.socketId === socket.id && p.isHost);
    if (host) {
      g.state='lobby'; g.currentRound=0; g.usedLocations=[]; g.players.forEach(p=>p.score=0);
      io.to(currentRoomCode).emit('returnToLobby');
      io.to(currentRoomCode).emit('updatePlayerList', g.players);
    }
  });
});

// game functions
function startNewRound(roomCode){
  const g=games[roomCode]; if(!g)return;
  g.state='playing'; g.currentRound++; g.votes={};
  const avail=getAvailableLocations(g.settings.theme);
  if(g.usedLocations.length>=avail.length) g.usedLocations=[];
  let pool=avail.filter(l=>!g.usedLocations.includes(l.name));
  if(pool.length===0){g.usedLocations=[];pool=avail;}
  const location=pool[Math.floor(Math.random()*pool.length)];
  g.usedLocations.push(location.name); g.currentLocation=location.name;
  const active=g.players.filter(p=>!p.disconnected);
  shuffleArray(active);
  const spyIdx=Math.floor(Math.random()*active.length);
  let roles=[...location.roles]; shuffleArray(roles);
  active.forEach((p,i)=>{
    p.role=(i===spyIdx)?'สายลับ':(roles.pop()||location.roles[0]);
    if(p.role==='สายลับ') g.spy=p;
    const s=io.sockets.sockets.get(p.socketId);
    if(s){
      s.emit('gameStarted',{
        location:p.role==='สายลับ'?'ไม่ทราบ':location.name,
        role:p.role, round:g.currentRound,
        totalRounds:g.settings.rounds,
        isHost:p.isHost, players:g.players
      });
      if(p.role!=='สายลับ'){
        s.emit('allLocations', avail.map(l=>l.name));
      }
    }
  });
  let timeLeft=g.settings.time;
  g.timer=setInterval(()=>{
    timeLeft--;
    io.to(roomCode).emit('timerUpdate',{timeLeft,players:g.players});
    if(timeLeft<=0){clearInterval(g.timer);startVote(roomCode,"timer_end");}
  },1000);
}

function startVote(roomCode,reason){
  const g=games[roomCode]; if(!g)return;
  g.state='voting'; g.votes={};
  const r=reason==="timer_end"?"หมดเวลา! โหวตหาสายลับ":"หัวหน้าห้องสั่งจบ!";
  io.to(roomCode).emit('startVote',{players:g.players.filter(p=>!p.disconnected),reason:r});
  g.voteTimer=setTimeout(()=>calculateVoteResults(roomCode),120000);
}

function calculateVoteResults(roomCode){
  const g=games[roomCode]; if(!g)return;
  const votes={};
  Object.values(g.votes).forEach(id=>{if(id)votes[id]=(votes[id]||0)+1;});
  let max=0;let top=[];
  for(const id in votes){if(votes[id]>max){max=votes[id];top=[id];}else if(votes[id]===max){top.push(id);}}
  const spyId=g.spy?.id; const spyIn=top.includes(spyId);
  if(top.length===1 && spyIn){
    let txt=`ถูกต้อง! ${g.spy.name} คือสายลับ!`;
    Object.entries(g.votes).forEach(([sid,vid])=>{
      if(vid===spyId){const v=g.players.find(p=>p.socketId===sid);if(v)v.score++;}});
    endGamePhase(roomCode,txt);
  } else {
    g.spy.score++;
    g.state='spy-guessing';
    const allLocs=getAvailableLocations(g.settings.theme).map(l=>l.name);
    shuffleArray(allLocs);
    io.to(g.spy.socketId).emit('spyGuessPhase',{locations:allLocs.slice(0,25),taunt:""});
    g.players.forEach(p=>{
      if(p.socketId!==g.spy.socketId) io.to(p.socketId).emit('spyIsGuessing',{spyName:g.spy.name,taunt:""});
    });
  }
}

function endGamePhase(roomCode,text){
  const g=games[roomCode]; if(!g)return;
  g.state='post-round';
  io.to(roomCode).emit('roundOver',{
    location:g.currentLocation,spyName:g.spy?.name||'ไม่มี',
    resultText:text,isFinalRound:g.currentRound>=g.settings.rounds,players:g.players
  });
}

// run server
const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log(`Server running on ${PORT}`));
