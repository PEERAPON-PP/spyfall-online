const { v4: uuidv4 } = require('uuid');
const gameManager = require('./gameManager');

const games = {};
const playerSessions = {};

function initializeSocketHandlers(io) {
    io.on('connection', (socket) => {
        let currentRoomCode = null;

        socket.on('createRoom', ({ playerName, playerToken }) => {
            const roomCode = gameManager.generateRoomCode(games);
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

        socket.on('startGame', (settings) => {
            if (!currentRoomCode || !games[currentRoomCode]) return;
            const game = games[currentRoomCode];
            const self = game.players.find(p => p.socketId === socket.id);
            if (!self || !self.isHost) return;
            gameManager.startGame(currentRoomCode, settings, games, io);
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

        socket.on('hostEndRound', () => {
             if (!currentRoomCode || !games[currentRoomCode]) return;
             const game = games[currentRoomCode];
             const p = game.players.find(pl => pl.socketId === socket.id);
             if (p && p.isHost && game.state === 'playing') {
                gameManager.endRound(currentRoomCode, "host_ended", games, io);
             }
        });
        
        socket.on('submitVote', (votedPlayerId) => {
            if (!currentRoomCode || !games[currentRoomCode]) return;
            gameManager.submitVote(currentRoomCode, socket.id, votedPlayerId, games, io);
        });

        socket.on('spyGuessLocation', (guessedLocation) => {
            if (!currentRoomCode || !games[currentRoomCode]) return;
            gameManager.spyGuessLocation(currentRoomCode, socket.id, guessedLocation, games, io);
        });

        socket.on('requestNextRound', () => {
            if (!currentRoomCode || !games[currentRoomCode]) return;
            const game = games[currentRoomCode];
            const player = game.players.find(p => p.socketId === socket.id);
            if (player && player.isHost && game.currentRound < game.settings.rounds) {
                gameManager.startNewRound(currentRoomCode, games, io);
            }
        });

        socket.on('resetGame', () => {
            if (!currentRoomCode || !games[currentRoomCode]) return;
            const game = games[currentRoomCode];
            const player = game.players.find(p => p.socketId === socket.id);
            if (player && player.isHost) {
                game.state = 'lobby';
                game.currentRound = 0;
                game.usedLocations = [];
                game.players.forEach(p => p.score = 0);
                gameManager.clearTimers(game);
                io.to(currentRoomCode).emit('returnToLobby');
                io.to(currentRoomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
            }
        });

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
                            gameManager.clearTimers(games[currentRoomCode]);
                            delete games[currentRoomCode];
                        }
                    }, 600000); // 10 minutes cleanup
                }
            }
        });
    });
}

module.exports = initializeSocketHandlers;
