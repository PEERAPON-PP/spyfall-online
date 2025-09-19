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

function clearTimers(game) {
    if (game.timer) clearInterval(game.timer);
    if (game.voteTimer) clearTimeout(game.voteTimer);
    game.timer = null;
    game.voteTimer = null;
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
        };
        const hostPlayer = { id: socket.id, name: playerName, isHost: true, score: 0 };
        games[roomCode].players.push(hostPlayer);
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode });
        io.to(roomCode).emit('updatePlayerList', games[roomCode].players);
    });

    socket.on('joinRoom', ({ playerName, roomCode }) => {
        const roomCodeUpper = roomCode.toUpperCase();
        if (!games[roomCodeUpper]) return socket.emit('error', 'ไม่พบห้องนี้');
        if (games[roomCodeUpper].state !== 'lobby') return socket.emit('error', 'ไม่สามารถเข้าร่วมห้องที่กำลังเล่นอยู่ได้');
        
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
        if (!game.players.find(p => p.id === socket.id && p.isHost)) return;
        
        game.settings.time = parseInt(time, 10);
        game.settings.rounds = parseInt(rounds, 10);
        game.settings.includeFairytales = includeFairytales;
        startNewRound(currentRoomCode);
    });

    socket.on('hostEndRound', () => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        const player = game.players.find(p => p.id === socket.id);
        if (player && player.isHost && game.state === 'playing') {
            endRound(currentRoomCode, "host_ended");
        }
    });

    socket.on('submitVote', (votedPlayerId) => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        if (game.state !== 'voting') return;
        game.votes[socket.id] = votedPlayerId;
        const totalPlayers = game.players.length;
        const totalVotes = Object.keys(game.votes).length;
        if (totalVotes === totalPlayers) {
            clearTimeout(game.voteTimer);
            calculateVoteResults(currentRoomCode);
        }
    });

    socket.on('spyGuessLocation', (guessedLocation) => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        if (game.state !== 'spy-guessing' || socket.id !== game.spy.id) return;

        let resultText = `สายลับหนีรอด! แต่ตอบสถานที่ผิด\nสายลับได้รับ 1 คะแนน`;
        if (guessedLocation === game.currentLocation) {
            game.spy.score++;
            resultText = `สายลับหนีรอด! และตอบสถานทีได้ถูกต้อง!\nสายลับได้รับเพิ่มอีก 1 คะแนน รวมเป็น 2 คะแนน`;
        }
        endGamePhase(currentRoomCode, resultText);
    });
    
    socket.on('requestNextRound', () => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        if (!game.players.find(p => p.id === socket.id && p.isHost)) return;
        if (game.currentRound < game.settings.rounds) {
            startNewRound(currentRoomCode);
        }
    });
    
    socket.on('resetGame', () => {
         if (!currentRoomCode || !games[currentRoomCode]) return;
         const game = games[currentRoomCode];
         if (!game.players.find(p => p.id === socket.id && p.isHost)) return;
         game.state = 'lobby';
         game.currentRound = 0;
         game.usedLocations = [];
         game.players.forEach(p => p.score = 0);
         clearTimers(game);
         io.to(currentRoomCode).emit('returnToLobby');
         io.to(currentRoomCode).emit('updatePlayerList', game.players);
    });

    socket.on('disconnect', () => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        const playerIndex = game.players.findIndex(p => p.id === socket.id);
        if (playerIndex === -1) return;

        const wasHost = game.players[playerIndex].isHost;
        game.players.splice(playerIndex, 1);

        if (game.state !== 'lobby') {
            io.to(currentRoomCode).emit('updatePlayerList', game.players);
        }

        if (game.players.length === 0) {
            clearTimers(game);
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

    clearTimers(game);
    game.state = 'playing';
    game.currentRound++;
    
    let availableLocations = locationsData;
    if (!game.settings.includeFairytales) {
        availableLocations = locationsData.filter(loc => loc.category !== 'fairytale');
    }
    if (game.usedLocations.length >= availableLocations.length) game.usedLocations = []; 
    let locationPool = availableLocations.filter(loc => !game.usedLocations.includes(loc.name));
    if (locationPool.length === 0) {
        game.usedLocations = [];
        locationPool = availableLocations;
    }
    const location = locationPool[Math.floor(Math.random() * locationPool.length)];
    game.usedLocations.push(location.name);
    game.currentLocation = location.name;
    game.votes = {};
    
    const playersInRoom = game.players;
    shuffleArray(playersInRoom);
    const spyIndex = Math.floor(Math.random() * playersInRoom.length);
    let roles = [...location.roles];
    shuffleArray(roles);
    const allLocationsForSpy = availableLocations.map(l => l.name);

    playersInRoom.forEach((player, index) => {
        player.role = (index === spyIndex) ? 'สายลับ' : (roles.pop() || location.roles[0]);
        if (player.role === 'สายลับ') game.spy = player;
        
        const socket = io.sockets.sockets.get(player.id);
        if (socket) {
            socket.emit('gameStarted', {
                location: player.role === 'สายลับ' ? 'ไม่ทราบ' : location.name,
                role: player.role,
                round: game.currentRound,
                totalRounds: game.settings.rounds,
                isHost: player.isHost,
                players: game.players.map(p => ({name: p.name, score: p.score}))
            });
            if (player.role === 'สายลับ') socket.emit('allLocations', allLocationsForSpy);
        }
    });
    
    let timeLeft = game.settings.time;
    io.to(roomCode).emit('timerUpdate', { timeLeft, players: game.players.map(p => ({name: p.name, score: p.score})) });
    game.timer = setInterval(() => {
        timeLeft--;
        io.to(roomCode).emit('timerUpdate', { timeLeft, players: game.players.map(p => ({name: p.name, score: p.score})) });
        if (timeLeft <= 0) {
            endRound(roomCode, "timer_end");
        }
    }, 1000);
}

function endRound(roomCode, reason) {
    const game = games[roomCode];
    if (!game || game.state !== 'playing') return;
    
    clearTimers(game);
    game.state = 'voting';

    let voteReason = "";
    if (reason === "timer_end") voteReason = "หมดเวลา! โหวตหาตัวสายลับ";
    if (reason === "host_ended") voteReason = "หัวหน้าห้องสั่งจบรอบ!";

    io.to(roomCode).emit('startVote', {
        players: game.players.map(p => ({ id: p.id, name: p.name })),
        reason: voteReason
    });

    game.voteTimer = setTimeout(() => {
        calculateVoteResults(roomCode);
    }, 30000); // 30 second vote timer
}

function calculateVoteResults(roomCode) {
    const game = games[roomCode];
    if (!game || game.state !== 'voting') return;

    game.state = 'calculating'; // Prevent double execution
    
    // Players who didn't vote are considered abstained
    game.players.forEach(p => {
        if (!game.votes[p.id]) game.votes[p.id] = null;
    });

    const voteCounts = {};
    Object.values(game.votes).forEach(votedId => {
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
    
    // Spy is caught if they are the *only* one with the most votes
    if (mostVotedIds.length === 1 && mostVotedIds[0] === spyId) {
        let resultText = `ถูกต้อง! ${game.spy.name} คือสายลับ!\nผู้เล่นที่โหวตถูกได้รับ 1 คะแนน:\n`;
        let correctVoters = [];
        for (const voterId in game.votes) {
            if (game.votes[voterId] === spyId) {
                const voter = game.players.find(p => p.id === voterId);
                if (voter) {
                    voter.score++;
                    correctVoters.push(voter.name);
                }
            }
        }
        resultText += correctVoters.join(', ') || "ไม่มี";
        endGamePhase(roomCode, resultText);
    } else {
        // Spy survives
        game.spy.score++;
        game.state = 'spy-guessing';
        io.to(spyId).emit('spyGuessPhase', {
            locations: locationsData.map(l => l.name) // Send all locations for spy to guess
        });
        io.to(roomCode).except(spyId).emit('spyIsGuessing', { spyName: game.spy.name });
    }
}

function endGamePhase(roomCode, resultText) {
    const game = games[roomCode];
    if (!game) return;

    game.state = 'post-round';
    io.to(roomCode).emit('roundOver', {
        location: game.currentLocation,
        spyName: game.spy ? game.spy.name : 'ไม่มี',
        resultText: resultText,
        isFinalRound: game.currentRound >= game.settings.rounds,
        players: game.players.map(p => ({name: p.name, score: p.score, id: p.id, isHost: p.isHost}))
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
