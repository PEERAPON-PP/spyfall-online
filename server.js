const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    pingTimeout: 60000,
});

// --- โหลดข้อมูลสถานที่ทั้งหมดจากโฟลเดอร์ locations ---
let allLocations = [];
try {
    const locationsDir = path.join(__dirname, 'locations');
    const locationFiles = fs.readdirSync(locationsDir).filter(file => file.endsWith('.json'));

    for (const file of locationFiles) {
        const filePath = path.join(locationsDir, file);
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const locations = JSON.parse(fileContent);
        allLocations = allLocations.concat(locations);
    }
    console.log(`Loaded ${allLocations.length} locations from ${locationFiles.length} files.`);
} catch (error) {
    console.error("Could not load location files:", error);
    allLocations = [];
}
// ---------------------------------------------------------

app.use(express.static('public'));

const games = {};
const playerSessions = {}; // For rejoin system

const TAUNTS = ["ว้าย! โหวตผิดเพราะไม่สวยอะดิ", "เอิ้ก ๆ ๆ ๆ", "ชัดขนาดนี้!", "มองยังไงเนี่ย?", "ไปพักผ่อนบ้างนะ"];

// Helper Functions
function generateRoomCode() { let code; do { code = Math.random().toString(36).substring(2, 6).toUpperCase(); } while (games[code]); return code; }
function shuffleArray(array) { for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [array[i], array[j]] = [array[j], array[i]]; } }
function clearTimers(game) {
    if (game.timer) clearTimeout(game.timer);
    if (game.voteTimer) clearTimeout(game.voteTimer);
    game.timer = null;
    game.voteTimer = null;
}

// Function to parse role string into name and description
function parseRole(roleString) {
    const match = roleString.match(/^(.*?)\s*\((.*?)\)$/);
    if (match) {
        return { name: match[1].trim(), description: match[2].trim() };
    }
    return { name: roleString, description: null };
}


io.on('connection', (socket) => {
    let currentRoomCode = null;

    socket.on('createRoom', ({ playerName, playerToken }) => {
        const roomCode = generateRoomCode();
        currentRoomCode = roomCode;
        games[roomCode] = { players: [], state: 'lobby', settings: { time: 300, rounds: 5, theme: 'all', voteTime: 120 }, currentRound: 0, usedLocations: [] };
        const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: true, score: 0, token: playerToken, isSpectator: false, disconnected: false };
        games[roomCode].players.push(player);
        playerSessions[playerToken] = { roomCode, playerId: player.id };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode });
        io.to(roomCode).emit('updatePlayerList', {players: games[roomCode].players, settings: games[roomCode].settings});
    });

    socket.on('joinRoom', ({ playerName, roomCode, playerToken }) => {
        const roomCodeUpper = roomCode.toUpperCase();
        const game = games[roomCodeUpper];
        if (!game) return socket.emit('error', 'ไม่พบห้องนี้');

        if (game.state !== 'lobby') {
            const disconnectedPlayers = game.players.filter(p => p.disconnected);
            socket.emit('promptRejoinOrSpectate', { disconnectedPlayers, roomCode: roomCodeUpper });
            return;
        }

        currentRoomCode = roomCodeUpper;
        const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: false, score: 0, token: playerToken, isSpectator: false, disconnected: false };
        game.players.push(player);
        playerSessions[playerToken] = { roomCode: roomCodeUpper, playerId: player.id };
        socket.join(roomCodeUpper);
        socket.emit('joinSuccess', { roomCode: roomCodeUpper });
        io.to(roomCodeUpper).emit('updatePlayerList', {players: game.players, settings: game.settings});
    });
    
    socket.on('rejoinAsPlayer', ({ roomCode, playerId, playerToken }) => {
        const game = games[roomCode];
        if (!game) return socket.emit('error', 'ไม่พบห้องขณะพยายามเข้าร่วมอีกครั้ง');

        const player = game.players.find(p => p.id === playerId);
        if (player && player.disconnected) {
            player.socketId = socket.id;
            player.disconnected = false;
            player.token = playerToken;
            currentRoomCode = roomCode;

            playerSessions[playerToken] = { roomCode, playerId: player.id };
            
            socket.join(currentRoomCode);
            socket.emit('rejoinSuccess', { game, roomCode: currentRoomCode, self: player });
            
            io.to(currentRoomCode).emit('playerReconnected', player.name);
            io.to(currentRoomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
        } else {
            socket.emit('error', 'ไม่สามารถเข้าร่วมในฐานะผู้เล่นคนนี้ได้ (อาจมีคนอื่นเลือกไปแล้ว)');
        }
    });

    socket.on('joinAsSpectator', ({ roomCode, playerName, playerToken }) => {
        const game = games[roomCode];
        if (!game) return socket.emit('error', 'ไม่พบห้อง');
        
        currentRoomCode = roomCode;
        const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: false, score: 0, token: playerToken, isSpectator: 'waiting', disconnected: false };
        game.players.push(player);
        playerSessions[playerToken] = { roomCode, playerId: player.id };
        
        socket.join(roomCode);
        socket.emit('joinSuccessAsSpectator', { roomCode });
        io.to(roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
    });

    socket.on('startGame', ({ time, rounds, theme, voteTime }) => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        const self = game.players.find(p => p.socketId === socket.id);
        if (!self || !self.isHost) return;
        if (game.players.filter(p => !p.disconnected && !p.isSpectator).length < 1) return;
        
        game.settings = { time: parseInt(time), rounds: parseInt(rounds), theme, voteTime: parseInt(voteTime) || 120 };
        startNewRound(currentRoomCode);
    });
    
    socket.on('settingChanged', ({ setting, value }) => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        const player = game.players.find(p => p.socketId === socket.id);
        
        if (player && player.isHost && game.state === 'lobby') {
            const parsedValue = isNaN(parseInt(value)) ? value : parseInt(value);
            game.settings[setting] = parsedValue;
            io.to(currentRoomCode).emit('settingsUpdated', game.settings);
        }
    });

    socket.on('toggleSpectatorMode', () => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        const player = game.players.find(p => p.socketId === socket.id);
        if (player && !player.isHost) {
            player.isSpectator = !player.isSpectator;
            io.to(currentRoomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
        }
    });

    socket.on('hostEndRound', () => { if (currentRoomCode && games[currentRoomCode]) { const game = games[currentRoomCode]; const p = game.players.find(pl => pl.socketId === socket.id); if (p && p.isHost && game.state === 'playing') endRound(currentRoomCode, "host_ended"); } });
    
    socket.on('submitVote', (votedPlayerId) => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        if (!['voting', 'revoting'].includes(game.state)) return;
        
        const player = game.players.find(p => p.socketId === socket.id);
        if (player && !player.isSpectator) {
            game.votes[socket.id] = votedPlayerId;
            const playersWhoCanVote = game.players.filter(p => !p.disconnected && !p.isSpectator);
            if (Object.keys(game.votes).length === playersWhoCanVote.length) {
                clearTimeout(game.voteTimer);
                calculateVoteResults(currentRoomCode);
            }
        }
    });

    socket.on('spyGuessLocation', (guessedLocation) => { if (currentRoomCode && games[currentRoomCode]) { const game = games[currentRoomCode]; if (game.state === 'spy-guessing' && socket.id === game.spy.socketId) { let resultText; if (guessedLocation === game.currentLocation) { game.spy.score++; resultText = `สายลับหนีรอด และตอบสถานที่ถูกต้อง!\nสายลับได้รับเพิ่มอีก 1 คะแนน! (รวมเป็น 2)`; } else { resultText = `สายลับหนีรอด! แต่ตอบสถานที่ผิด\nสายลับได้รับ 1 คะแนน`; } endGamePhase(currentRoomCode, resultText); } } });
    socket.on('requestNextRound', () => { if (currentRoomCode && games[currentRoomCode]) { const game = games[currentRoomCode]; const player = game.players.find(p => p.socketId === socket.id); if (player && player.isHost && game.currentRound < game.settings.rounds) startNewRound(currentRoomCode); } });
    socket.on('resetGame', () => { if (currentRoomCode && games[currentRoomCode]) { const game = games[currentRoomCode]; const player = game.players.find(p => p.socketId === socket.id); if (player && player.isHost) { game.state = 'lobby'; game.currentRound = 0; game.usedLocations = []; game.players.forEach(p => p.score = 0); clearTimers(game); io.to(currentRoomCode).emit('returnToLobby'); io.to(currentRoomCode).emit('updatePlayerList', {players: game.players, settings: game.settings}); } } });

    socket.on('kickPlayer', (playerIdToKick) => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        const host = game.players.find(p => p.isHost);
        if (!host || host.socketId !== socket.id) return;
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
            io.to(currentRoomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
        }
    });

    socket.on('disconnect', () => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        const player = game.players.find(p => p.socketId === socket.id);
        if (player) {
            player.disconnected = true;
            io.to(currentRoomCode).emit('playerDisconnected', player.name);
            io.to(currentRoomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
            
            if (player.isHost) {
                const newHost = game.players.find(p => !p.disconnected);
                if (newHost) {
                    newHost.isHost = true;
                    io.to(currentRoomCode).emit('newHost', newHost.name);
                    io.to(currentRoomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
                }
            }

            if (game.players.every(p => p.disconnected)) {
                setTimeout(() => {
                    if (games[currentRoomCode] && games[currentRoomCode].players.every(p => p.disconnected)) {
                        clearTimers(games[currentRoomCode]);
                        delete games[currentRoomCode];
                    }
                }, 600000); // 10 minutes cleanup
            }
        }
    });
});

function gameLoop(roomCode) {
    const game = games[roomCode];
    if (!game || game.state !== 'playing') return;
    game.timeLeft--;
    io.to(roomCode).emit('timerUpdate', { timeLeft: Math.max(0, game.timeLeft), players: game.players });
    if (game.timeLeft <= 0) {
        endRound(roomCode, "timer_end");
    } else {
        game.timer = setTimeout(() => gameLoop(roomCode), 1000);
    }
}

function getAvailableLocations(theme) {
    if (theme === 'all') return allLocations;
    return allLocations.filter(loc => loc.category === theme);
}

function startNewRound(roomCode) {
    const game = games[roomCode]; if (!game) return;
    clearTimers(game);
    game.state = 'playing'; game.currentRound++; game.votes = {}; game.revoteCandidates = [];
    
    game.players.forEach(p => {
        if(p.isSpectator === 'waiting'){
            p.isSpectator = false;
        }
    });

    const availableLocations = getAvailableLocations(game.settings.theme);
    if (!availableLocations || availableLocations.length === 0) {
        console.error("No available locations for the selected theme:", game.settings.theme);
        io.to(roomCode).emit('error', 'ไม่พบสถานที่สำหรับโหมดที่เลือก');
        return;
    }

    if (game.usedLocations.length >= availableLocations.length) game.usedLocations = []; 
    let locationPool = availableLocations.filter(loc => !game.usedLocations.includes(loc.name));
    if (locationPool.length === 0) { game.usedLocations = []; locationPool = availableLocations; }
    
    const location = locationPool[Math.floor(Math.random() * locationPool.length)];
    game.usedLocations.push(location.name); game.currentLocation = location.name;
    
    const activePlayers = game.players.filter(p => !p.disconnected && !p.isSpectator);
    shuffleArray(activePlayers);
    
    if (activePlayers.length === 0) {
        console.log("No active players to start the round.");
        return;
    }
    
    const spyIndex = Math.floor(Math.random() * activePlayers.length);
    let roles = [...location.roles]; shuffleArray(roles);
    
    activePlayers.forEach((player, index) => {
        const fullRoleString = (index === spyIndex) ? 'สายลับ' : (roles.pop() || "พลเมืองดี");
        player.role = fullRoleString;
        if (player.role === 'สายลับ') game.spy = player;
    });

    const allPlayerRoles = activePlayers.map(p => ({id: p.id, role: p.role}));
    const allThemeLocationNames = availableLocations.map(l => l.name);

    game.players.forEach(player => {
        const socket = io.sockets.sockets.get(player.socketId);
        if (socket) {
            if (player.isSpectator) {
                socket.emit('gameStarted', {
                    location: game.currentLocation,
                    round: game.currentRound,
                    totalRounds: game.settings.rounds,
                    isHost: player.isHost,
                    players: game.players,
                    isSpectator: true,
                    allPlayerRoles
                });
            } else {
                let locationsForPlayer = allThemeLocationNames;
                if (parseRole(player.role).name === 'สายลับ') {
                   let shuffledLocations = [...allThemeLocationNames];
                   shuffleArray(shuffledLocations);
                   locationsForPlayer = shuffledLocations.slice(0, 20);
                }
                
                const { name: roleName, description: roleDesc } = parseRole(player.role);

                socket.emit('gameStarted', {
                    location: roleName === 'สายลับ' ? 'ไม่ทราบ' : game.currentLocation,
                    role: roleName,
                    roleDesc: roleDesc,
                    round: game.currentRound,
                    totalRounds: game.settings.rounds,
                    isHost: player.isHost,
                    players: game.players,
                    isSpectator: false,
                    allLocations: locationsForPlayer
                });
            }
        }
    });

    game.timeLeft = game.settings.time;
    io.to(roomCode).emit('timerUpdate', { timeLeft: game.timeLeft, players: game.players });
    game.timer = setTimeout(() => gameLoop(roomCode), 1000);
}

function endRound(roomCode, reason) {
    const game = games[roomCode];
    if (!game || game.state !== 'playing') return;
    clearTimers(game);
    game.state = 'voting';
    const voteReason = reason === 'timer_end' ? 'หมดเวลา! โหวตหาตัวสายลับ' : 'หัวหน้าห้องสั่งจบรอบ!';
    const activePlayers = game.players.filter(p => !p.disconnected && !p.isSpectator);
    const voteTime = game.settings.voteTime || 120;

    activePlayers.forEach(voter => {
        const voteOptions = activePlayers.filter(option => option.id !== voter.id);
        const socket = io.sockets.sockets.get(voter.socketId);
        if (socket) {
            socket.emit('startVote', { players: voteOptions, reason: voteReason, voteTime });
        }
    });
    game.voteTimer = setTimeout(() => calculateVoteResults(roomCode), voteTime * 1000);
}

function startReVote(roomCode, candidateIds) {
    const game = games[roomCode];
    if (!game) return;

    game.state = 'revoting';
    game.votes = {}; 
    game.revoteCandidates = game.players.filter(p => candidateIds.includes(p.id));

    const voteReason = "ผลโหวตเสมอ! โหวตอีกครั้งเฉพาะผู้ที่มีคะแนนสูงสุด";
    const activePlayers = game.players.filter(p => !p.disconnected && !p.isSpectator);
    const voteTime = game.settings.voteTime || 120;

    activePlayers.forEach(voter => {
        const voteOptions = game.revoteCandidates.filter(option => option.id !== voter.id);
        const socket = io.sockets.sockets.get(voter.socketId);
        if (socket) {
            socket.emit('startVote', { players: voteOptions, reason: voteReason, voteTime });
        }
    });
    
    game.voteTimer = setTimeout(() => calculateVoteResults(roomCode), voteTime * 1000);
}

function calculateVoteResults(roomCode) {
    const game = games[roomCode];
    if (!game || !['voting', 'revoting'].includes(game.state) || !game.spy) return;

    const spyId = game.spy.id;
    const voteCounts = {};
    
    Object.values(game.votes).forEach(votedId => {
        if (votedId) {
            voteCounts[votedId] = (voteCounts[votedId] || 0) + 1;
        }
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

    if (mostVotedIds.length === 1) {
        const votedPlayerId = mostVotedIds[0];
        if (votedPlayerId === spyId) {
            const resultText = `จับสายลับได้สำเร็จ!\nผู้เล่นทุกคน (ยกเว้นสายลับ) ได้รับ 1 คะแนน`;
            game.players.forEach(p => { if (p.id !== spyId && !p.disconnected && !p.isSpectator) p.score++; });
            endGamePhase(roomCode, resultText);
        } else {
            spyEscapes(roomCode, "โหวตผิดคน!");
        }
    } else if (mostVotedIds.length > 1) {
        const spyIsInTie = mostVotedIds.includes(spyId);
        if (game.state === 'voting' && spyIsInTie) {
            startReVote(roomCode, mostVotedIds);
        } else {
            spyEscapes(roomCode, "โหวตไม่เป็นเอกฉันท์!");
        }
    } else {
        spyEscapes(roomCode, "ไม่มีใครถูกโหวตเลย!");
    }
}

function spyEscapes(roomCode, reason) {
    const game = games[roomCode];
    if (!game || !game.spy) return;
    game.spy.score++;
    game.state = 'spy-guessing';

    const taunt = TAUNTS[Math.floor(Math.random() * TAUNTS.length)];
    
    const allLocNames = getAvailableLocations(game.settings.theme).map(l => l.name);
    shuffleArray(allLocNames);
    const spyLocations = allLocNames.slice(0, 20); 
    
    const spySocket = io.sockets.sockets.get(game.spy.socketId);
    if(spySocket) {
        spySocket.emit('spyGuessPhase', { locations: spyLocations, taunt: `${reason} ${taunt}` });
    }

    game.players.forEach(p => {
        if (p.id !== game.spy.id) {
            const playerSocket = io.sockets.sockets.get(p.socketId);
            if(playerSocket) {
                playerSocket.emit('spyIsGuessing', { spyName: game.spy.name, taunt: `${reason} ${taunt}` });
            }
        }
    });
}

function endGamePhase(roomCode, resultText) {
    const game = games[roomCode]; if (!game) return;
    clearTimers(game);
    game.state = 'post-round';
    io.to(roomCode).emit('roundOver', { location: game.currentLocation, spyName: game.spy ? parseRole(game.spy.role).name : 'ไม่มี', resultText, isFinalRound: game.currentRound >= game.settings.rounds, players: game.players });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

