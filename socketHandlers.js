const { v4: uuidv4 } = require('uuid');
const gameManager = require('./gameManager');

const games = {};
const playerSessions = {};

function initializeSocketHandlers(io) {
    io.on('connection', (socket) => {

        socket.on('createRoom', ({ playerName, playerToken }) => {
            const roomCode = gameManager.generateRoomCode(games);
            socket.roomCode = roomCode;
            socket.playerToken = playerToken; // Attach persistent token
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

            socket.roomCode = roomCodeUpper;
            socket.playerToken = playerToken; // Attach persistent token
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
                socket.roomCode = roomCode;
                socket.playerToken = playerToken; // Attach persistent token
                player.socketId = socket.id;
                player.disconnected = false;
                player.token = playerToken;

                playerSessions[playerToken] = { roomCode, playerId: player.id };
                
                socket.join(roomCode);
                socket.emit('rejoinSuccess', { game, roomCode: roomCode, self: player });
                
                io.to(roomCode).emit('playerReconnected', player.name);
                io.to(roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
            } else {
                socket.emit('error', 'ไม่สามารถเข้าร่วมในฐานะผู้เล่นคนนี้ได้');
            }
        });

        socket.on('joinAsSpectator', ({ roomCode, playerName, playerToken }) => {
            const game = games[roomCode];
            if (!game) return socket.emit('error', 'ไม่พบห้อง');
            
            socket.roomCode = roomCode;
            socket.playerToken = playerToken; // Attach persistent token
            const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: false, score: 0, token: playerToken, isSpectator: 'waiting', disconnected: false };
            game.players.push(player);
            playerSessions[playerToken] = { roomCode, playerId: player.id };
            
            socket.join(roomCode);
            socket.emit('joinSuccessAsSpectator', { roomCode });
            io.to(roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
        });

        socket.on('startGame', (settings) => {
            const roomCode = socket.roomCode;
            if (!roomCode || !games[roomCode]) return;
            const game = games[roomCode];
            const self = game.players.find(p => p.socketId === socket.id);
            if (!self || !self.isHost) return;
            gameManager.startGame(roomCode, settings, games, io);
        });
        
        socket.on('settingChanged', ({ setting, value }) => {
            const roomCode = socket.roomCode;
            if (!roomCode || !games[roomCode]) return;
            const game = games[roomCode];
            const player = game.players.find(p => p.socketId === socket.id);
            
            if (player && player.isHost && game.state === 'lobby') {
                const parsedValue = isNaN(parseInt(value)) ? value : parseInt(value);
                game.settings[setting] = parsedValue;
                io.to(roomCode).emit('settingsUpdated', game.settings);
            }
        });

        socket.on('toggleSpectatorMode', () => {
            const roomCode = socket.roomCode;
            if (!roomCode || !games[roomCode]) return;
            const game = games[roomCode];
            const player = game.players.find(p => p.socketId === socket.id);
            if (player && !player.isHost) {
                player.isSpectator = !player.isSpectator;
                io.to(roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
            }
        });

        socket.on('hostEndRound', () => {
             const roomCode = socket.roomCode;
             if (!roomCode || !games[roomCode]) return;
             const game = games[roomCode];
             const p = game.players.find(pl => pl.socketId === socket.id);
             if (p && p.isHost && game.state === 'playing') {
                gameManager.endRound(roomCode, "host_ended", games, io);
             }
        });
        
        socket.on('submitVote', (votedPlayerId) => {
            const roomCode = socket.roomCode;
            if (!roomCode || !games[roomCode]) return;
            gameManager.submitVote(roomCode, socket.id, votedPlayerId, games, io);
        });

        socket.on('spyGuessLocation', (guessedLocation) => {
            const roomCode = socket.roomCode;
            if (!roomCode || !games[roomCode]) return;
            gameManager.spyGuessLocation(roomCode, socket.id, guessedLocation, games, io);
        });

        socket.on('requestNextRound', () => {
            const roomCode = socket.roomCode;
            if (!roomCode || !games[roomCode]) return;
            const game = games[roomCode];
            const player = game.players.find(p => p.socketId === socket.id);
            if (player && player.isHost && game.currentRound < game.settings.rounds) {
                gameManager.startNewRound(roomCode, games, io);
            }
        });

        socket.on('resetGame', () => {
            const roomCode = socket.roomCode;
            if (!roomCode || !games[roomCode]) return;
            const game = games[roomCode];
            const player = game.players.find(p => p.socketId === socket.id);
            if (player && player.isHost) {
                game.state = 'lobby';
                game.currentRound = 0;
                game.usedLocations = [];
                game.players.forEach(p => p.score = 0);
                gameManager.clearTimers(game);
                io.to(roomCode).emit('returnToLobby');
                io.to(roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
            }
        });

        socket.on('kickPlayer', (playerIdToKick) => {
            const roomCode = socket.roomCode;
            if (!roomCode || !games[roomCode]) return;
            const game = games[roomCode];
            const host = game.players.find(p => p.isHost);
            if (!host || host.socketId !== socket.id) return;
            const playerIndex = game.players.findIndex(p => p.id === playerIdToKick);
            if (playerIndex > -1) {
                const kickedPlayer = game.players[playerIndex];
                const kickedSocket = io.sockets.sockets.get(kickedPlayer.socketId);
                if (kickedSocket) {
                    kickedSocket.leave(roomCode);
                    kickedSocket.emit('kicked');
                }
                delete playerSessions[kickedPlayer.token];
                game.players.splice(playerIndex, 1);
                io.to(roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
            }
        });

        socket.on('disconnect', () => {
            const playerToken = socket.playerToken;
            if (!playerToken) return; // Socket was never a player

            const session = playerSessions[playerToken];
            if (!session || !games[session.roomCode]) {
                return;
            }

            const roomCode = session.roomCode;
            const game = games[roomCode];
            const player = game.players.find(p => p.token === playerToken);

            // Only mark as disconnected if this was their last known connection
            if (player && player.socketId === socket.id) {
                player.disconnected = true;
                io.to(roomCode).emit('playerDisconnected', player.name);
                io.to(roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
                
                if (player.isHost) {
                    const newHost = game.players.find(p => !p.disconnected);
                    if (newHost) {
                        newHost.isHost = true;
                        io.to(roomCode).emit('newHost', newHost.name);
                        io.to(roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
                    }
                }

                if (game.players.every(p => p.disconnected)) {
                    setTimeout(() => {
                        if (games[roomCode] && games[roomCode].players.every(p => p.disconnected)) {
                            gameManager.clearTimers(games[roomCode]);
                            delete games[roomCode];
                        }
                    }, 600000); // 10 minutes cleanup
                }
            }
        });
    });
}

module.exports = initializeSocketHandlers;

