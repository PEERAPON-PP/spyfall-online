const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path'); // Import the 'path' module

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const locationsData = require('./locations.json');

// Serve static files from the root directory
// This line is changed to serve index.html correctly
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
            settings: { time: 480, rounds: 5 },
            currentRound: 0,
            usedLocations: [],
        };

        const hostPlayer = {
            id: socket.id,
            name: playerName,
            isHost: true,
            score: 0,
        };
        games[roomCode].players.push(hostPlayer);
        
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode });
        io.to(roomCode).emit('updatePlayerList', games[roomCode].players);
    });

    socket.on('joinRoom', ({ playerName, roomCode }) => {
        const roomCodeUpper = roomCode.toUpperCase();
        if (!games[roomCodeUpper]) {
            socket.emit('error', 'ไม่พบห้องนี้');
            return;
        }
        if (games[roomCodeUpper].state !== 'lobby') {
            socket.emit('error', 'ไม่สามารถเข้าร่วมห้องที่กำลังเล่นอยู่ได้');
            return;
        }

        currentRoomCode = roomCodeUpper;
        const newPlayer = {
            id: socket.id,
            name: playerName,
            isHost: false,
            score: 0,
        };
        games[roomCodeUpper].players.push(newPlayer);

        socket.join(roomCodeUpper);
        socket.emit('joinSuccess', { roomCode: roomCodeUpper });
        io.to(roomCodeUpper).emit('updatePlayerList', games[roomCodeUpper].players);
    });
    
    socket.on('startGame', ({ time, rounds }) => {
        if (!currentRoomCode || !games[currentRoomCode]) return;
        const game = games[currentRoomCode];
        if (socket.id !== game.players.find(p => p.isHost).id) return; // Only host can start
        
        game.settings.time = parseInt(time, 10);
        game.settings.rounds = parseInt(rounds, 10);
        game.state = 'playing';
        startNewRound(currentRoomCode);
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
        
        if (socket.id !== host.id) return; // Only host can kick

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
    
    // Select a location
    if (game.usedLocations.length === locationsData.length) {
        game.usedLocations = []; // Reset if all locations have been used
    }
    let locationPool = locationsData.filter(loc => !game.usedLocations.includes(loc.name));
    const location = locationPool[Math.floor(Math.random() * locationPool.length)];
    game.usedLocations.push(location.name);
    game.currentLocation = location.name;
    
    // Assign roles
    const playersInRoom = game.players;
    shuffleArray(playersInRoom);
    const spyIndex = Math.floor(Math.random() * playersInRoom.length);
    let roles = [...location.roles];
    shuffleArray(roles);

    playersInRoom.forEach((player, index) => {
        let assignedRole;
        if (index === spyIndex) {
            assignedRole = 'สายลับ';
            game.spy = player;
        } else {
            assignedRole = roles.pop() || location.roles[0]; // Fallback role
        }
        
        const socket = io.sockets.sockets.get(player.id);
        if (socket) {
            socket.emit('gameStarted', {
                location: assignedRole === 'สายลับ' ? 'ไม่ทราบ' : location.name,
                role: assignedRole,
                round: game.currentRound,
                totalRounds: game.settings.rounds,
            });
            socket.emit('allLocations', locationsData.map(l => l.name));
        }
    });
    
    // Start timer
    if (game.timer) clearInterval(game.timer);
    let timeLeft = game.settings.time;
    io.to(roomCode).emit('timerUpdate', timeLeft); // Initial emit
    game.timer = setInterval(() => {
        timeLeft--;
        io.to(roomCode).emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) {
            endRound(roomCode, "spy_escaped");
        }
    }, 1000);
}

function endRound(roomCode, reason) {
    const game = games[roomCode];
    if (!game || game.state !== 'playing') return;
    clearInterval(game.timer);
    game.state = 'post-round';

    let resultText = "";
    if (reason === "spy_escaped") {
        resultText = "หมดเวลา! สายลับหนีไปได้\nสายลับได้รับ 2 คะแนน";
        if(game.spy) game.spy.score = (game.spy.score || 0) + 2;
    }
    // Add other win conditions and scoring here later

    io.to(roomCode).emit('gameOver', {
        location: game.currentLocation,
        spyName: game.spy ? game.spy.name : 'ไม่มี',
        resultText: resultText,
        isFinalRound: game.currentRound >= game.settings.rounds,
        players: game.players
    });
    io.to(roomCode).emit('updatePlayerList', game.players);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

