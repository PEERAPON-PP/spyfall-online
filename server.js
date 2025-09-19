const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const locationsData = require('./locations.json');

app.use(express.static(__dirname));

const games = {};

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

// Main Socket Logic
io.on('connection', (socket) => {
    let currentRoomCode = null;

    socket.on('createRoom', ({ playerName }) => {
        const roomCode = generateRoomCode();
        currentRoomCode = roomCode;
        games[roomCode] = {
            players: [],
            state: 'lobby',
            settings: { time: 480, rounds: 5, includeFairytales: true },
            currentRound: 0,
            usedLocations: [],
            votes: {}, // NEW: For voting system
        };

        const hostPlayer = { id: socket.id, name: playerName, isHost: true, score: 0 };
        games[roomCode].players.push(hostPlayer);
        
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode });
        io.to(roomCode).emit('updatePlayerList', games[roomCode].players);
    });

    socket.on('joinRoom', ({ playerName, roomCode }) => {
        const roomCodeUpper = roomCode.toUpperCase();
        if (!games[roomCodeUpper]) {
            return socket.emit('error', 'ไม่พบห้องนี้');
        }
        if (games[roomCodeUpper].state !== 'lobby') {
            return socket.emit('error', 'ไม่สามารถเข้าร่วมห้องที่กำลังเล่นอยู่ได้');
        }

        currentRoomCode = roomCodeUpper;
        const newPlayer = { id: socket.id, name: playerName, isHost: false, score: 0 };
        games[roomCodeUpper].players.push(newPlayer);

        socket.join(roomCodeUpper);
        socket.emit('joinSuccess', { roomCode: roomCodeUpper });
        io.to(roomCodeUpper).emit('updatePlayerList', games[roomCodeUpper].players);
    });
    
    socket.on('startGame', ({ time, rounds, includeFairytales }) => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        if (socket.id !== game.players.find(p => p.isHost).id) return;
        
        game.settings.time = parseInt(time, 10);
        game.settings.rounds = parseInt(rounds, 10);
        game.settings.includeFairytales = includeFairytales;
        game.state = 'playing';
        startNewRound(currentRoomCode);
    });

    // NEW FEATURE: Host manually ends the round
    socket.on('hostEndRound', () => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        const player = game.players.find(p => p.id === socket.id);
        if (player && player.isHost && game.state === 'playing') {
            endRound(currentRoomCode, "host_ended");
        }
    });

    // NEW FEATURE: Player submits a vote
    socket.on('submitVote', (votedPlayerId) => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        if (game.state !== 'voting') return;

        game.votes[socket.id] = votedPlayerId;
        
        const totalPlayers = game.players.length;
        const totalVotes = Object.keys(game.votes).length;

        // Check if everyone has voted
        if (totalVotes === totalPlayers) {
            calculateVoteResultsAndEndRound(currentRoomCode);
        }
    });
    
    socket.on('requestNextRound', () => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        if (socket.id !== game.players.find(p => p.isHost).id) return;
        
        if (game.currentRound < game.settings.rounds) {
            startNewRound(currentRoomCode);
        }
    });
    
    socket.on('resetGame', () => {
         if (!currentRoomCode || !games[currentRoomCode]) return;
         const game = games[currentRoomCode];
         if (socket.id !== game.players.find(p => p.isHost).id) return;
         
         game.state = 'lobby';
         game.currentRound = 0;
         game.usedLocations = [];
         game.players.forEach(p => p.score = 0);
         
         io.to(currentRoomCode).emit('returnToLobby');
         io.to(currentRoomCode).emit('updatePlayerList', game.players);
    });

    socket.on('kickPlayer', (playerIdToKick) => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        const host = game.players.find(p => p.isHost);
        
        if (socket.id !== host.id) return;

        game.players = game.players.filter(p => p.id !== playerIdToKick);
        const kickedSocket = io.sockets.sockets.get(playerIdToKick);
        if (kickedSocket) {
            kickedSocket.leave(currentRoomCode);
            kickedSocket.emit('kicked');
        }
        io.to(currentRoomCode).emit('updatePlayerList', game.players);
    });

    socket.on('disconnect', () => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        
        const game = games[currentRoomCode];
        const playerIndex = game.players.findIndex(p => p.id === socket.id);
        if (playerIndex === -1) return;

        const wasHost = game.players[playerIndex].isHost;
        game.players.splice(playerIndex, 1);

        if (game.players.length === 0) {
            delete games[currentRoomCode];
            return;
        }

        if (wasHost && game.players.length > 0) {
            game.players[0].isHost = true;
        }
        
        io.to(currentRoomCode).emit('updatePlayerList', game.players);
    });
});

function startNewRound(roomCode) {
    const game = games[roomCode];
    if (!game) return;
    game.currentRound++;
    
    let availableLocations = locationsData;
    if (!game.settings.includeFairytales) {
        availableLocations = locationsData.filter(loc => loc.category !== 'fairytale');
    }
    
    if (game.usedLocations.length >= availableLocations.length) {
        game.usedLocations = []; 
    }
    let locationPool = availableLocations.filter(loc => !game.usedLocations.includes(loc.name));
    if (locationPool.length === 0) {
        game.usedLocations = [];
        locationPool = availableLocations;
    }
    const location = locationPool[Math.floor(Math.random() * locationPool.length)];
    game.usedLocations.push(location.name);
    game.currentLocation = location.name;
    game.votes = {}; // Reset votes for the new round
    
    const playersInRoom = game.players;
    shuffleArray(playersInRoom);
    const spyIndex = Math.floor(Math.random() * playersInRoom.length);
    let roles = [...location.roles];
    shuffleArray(roles);

    const allLocationsForSpy = availableLocations.map(l => l.name);

    playersInRoom.forEach((player, index) => {
        let assignedRole;
        if (index === spyIndex) {
            assignedRole = 'สายลับ';
            game.spy = player;
        } else {
            assignedRole = roles.pop() || location.roles[0];
        }
        
        const socket = io.sockets.sockets.get(player.id);
        if (socket) {
            socket.emit('gameStarted', {
                location: assignedRole === 'สายลับ' ? 'ไม่ทราบ' : location.name,
                role: assignedRole,
                round: game.currentRound,
                totalRounds: game.settings.rounds,
                isHost: player.isHost
            });
            socket.emit('allLocations', allLocationsForSpy);
        }
    });
    
    if (game.timer) clearInterval(game.timer);
    let timeLeft = game.settings.time;
    io.to(roomCode).emit('timerUpdate', timeLeft);
    game.timer = setInterval(() => {
        timeLeft--;
        io.to(roomCode).emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) {
            endRound(roomCode, "timer_end");
        }
    }, 1000);
}

function endRound(roomCode, reason) {
    const game = games[roomCode];
    if (!game || game.state !== 'playing') return;
    
    clearInterval(game.timer);
    game.state = 'voting'; // Change state to voting

    let voteReason = "";
    if (reason === "timer_end") voteReason = "หมดเวลา! โหวตหาตัวสายลับ";
    if (reason === "host_ended") voteReason = "หัวหน้าห้องสั่งจบรอบ! โหวตหาตัวสายลับ";

    io.to(roomCode).emit('startVote', {
        players: game.players.map(p => ({ id: p.id, name: p.name })),
        reason: voteReason
    });
}

function calculateVoteResultsAndEndRound(roomCode) {
    const game = games[roomCode];
    if (!game || game.state !== 'voting') return;

    const voteCounts = {};
    for (const voterId in game.votes) {
        const votedId = game.votes[voterId];
        if (votedId) { // Skip abstain votes
            voteCounts[votedId] = (voteCounts[votedId] || 0) + 1;
        }
    }

    let maxVotes = 0;
    let votedPlayerId = null;
    for (const playerId in voteCounts) {
        if (voteCounts[playerId] > maxVotes) {
            maxVotes = voteCounts[playerId];
            votedPlayerId = playerId;
        }
    }
    
    const spyId = game.spy ? game.spy.id : null;
    let resultText = "";

    const votedPlayer = game.players.find(p => p.id === votedPlayerId);
    const votedPlayerName = votedPlayer ? votedPlayer.name : "ไม่มีใคร";

    if (votedPlayerId === spyId) {
        resultText = `ถูกต้อง! ${votedPlayerName} คือสายลับ!\nผู้เล่นทุกคน (ยกเว้นสายลับ) ได้รับ 1 คะแนน`;
        game.players.forEach(p => {
            if (p.id !== spyId) p.score = (p.score || 0) + 1;
        });
    } else {
        resultText = `โหวตผิดคน! ${votedPlayerName} ไม่ใช่สายลับ\nสายลับได้รับ 2 คะแนน`;
        if(game.spy) game.spy.score = (game.spy.score || 0) + 2;
    }

    game.state = 'post-round';
    io.to(roomCode).emit('roundOver', {
        location: game.currentLocation,
        spyName: game.spy ? game.spy.name : 'ไม่มี',
        resultText: resultText,
        isFinalRound: game.currentRound >= game.settings.rounds,
        players: game.players
    });
    io.to(roomCode).emit('updatePlayerList', game.players);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
