const { v4: uuidv4 } = require('uuid');
const gameManager = require('./gameManager');

const games = {};
const playerSessions = {}; // Maps playerToken to { roomCode, playerId }

function initializeSocketHandlers(io) {
    io.on('connection', (socket) => {

        const getCurrentState = () => {
            const roomCode = socket.roomCode;
            if (!roomCode || !games[roomCode]) return { game: null, player: null };
            const game = games[roomCode];
            const player = game.players.find(p => p.socketId === socket.id);
            return { game, player };
        };

        socket.on('createRoom', ({ playerName, playerToken }) => {
            const roomCode = gameManager.generateRoomCode(games);
            socket.roomCode = roomCode;
            games[roomCode] = { players: [], state: 'lobby', settings: { time: 300, rounds: 5, themes: ['default'], voteTime: 120 }, currentRound: 0, usedLocations: [] };
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

            // --- SIMPLIFIED JOIN LOGIC ---
            // If game is in progress, ALWAYS join as a spectator.
            if (game.state !== 'lobby') {
                socket.roomCode = roomCodeUpper;
                const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: false, score: 0, token: playerToken, isSpectator: 'waiting', disconnected: false };
                game.players.push(player);
                playerSessions[playerToken] = { roomCode: roomCodeUpper, playerId: player.id };
                socket.join(roomCodeUpper);
                socket.emit('joinSuccessAsSpectator', { roomCode: roomCodeUpper });
                io.to(roomCodeUpper).emit('updatePlayerList', {players: game.players, settings: game.settings});
                return;
            }

            // Normal lobby join logic
            socket.roomCode = roomCodeUpper;
            const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: false, score: 0, token: playerToken, isSpectator: false, disconnected: false };
            game.players.push(player);
            playerSessions[playerToken] = { roomCode: roomCodeUpper, playerId: player.id };
            socket.join(roomCodeUpper);
            socket.emit('joinSuccess', { roomCode: roomCodeUpper });
            io.to(roomCodeUpper).emit('updatePlayerList', {players: game.players, settings: game.settings});
        });
        
        // REMOVED rejoinAsPlayer handler as it's no longer needed.

        socket.on('startGame', (settings) => {
            const { game, player } = getCurrentState();
            if (game && player && player.isHost) {
                gameManager.startGame(socket.roomCode, settings, games, io);
            }
        });
        
        socket.on('settingChanged', ({ setting, value }) => {
            const { game, player } = getCurrentState();
            if (game && player && player.isHost && game.state === 'lobby') {
                if(setting === 'themes' && value.length === 0){
                   value.push('default');
                }
                game.settings[setting] = value;
                io.to(socket.roomCode).emit('settingsUpdated', game.settings);
            }
        });

        socket.on('toggleSpectatorMode', () => {
            const { game, player } = getCurrentState();
            if (game && player && !player.isHost) {
                player.isSpectator = !player.isSpectator;
                io.to(socket.roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
            }
        });

        socket.on('hostEndRound', () => {
            const { game, player } = getCurrentState();
             if (game && player && player.isHost && game.state === 'playing') {
                gameManager.endRound(socket.roomCode, "host_ended", games, io);
             }
        });
        
        socket.on('submitVote', (votedPlayerId) => {
            if (socket.roomCode) {
                gameManager.submitVote(socket.roomCode, socket.id, votedPlayerId, games, io);
            }
        });

        socket.on('spyGuessLocation', (guessedLocation) => {
            if (socket.roomCode) {
                gameManager.spyGuessLocation(socket.roomCode, socket.id, guessedLocation, games, io);
            }
        });

        socket.on('requestNextRound', () => {
            const { game, player } = getCurrentState();
            if (game && player && player.isHost && game.currentRound < game.settings.rounds) {
                gameManager.startNewRound(socket.roomCode, games, io);
            }
        });

        socket.on('resetGame', () => {
            const { game, player } = getCurrentState();
            if (game && player && player.isHost) {
                game.state = 'lobby';
                game.currentRound = 0;
                game.usedLocations = [];
                game.players.forEach(p => p.score = 0);
                gameManager.clearTimers(game);
                io.to(socket.roomCode).emit('returnToLobby');
                io.to(socket.roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
            }
        });

        socket.on('kickPlayer', (playerIdToKick) => {
            const { game, player } = getCurrentState();
            if (game && player && player.isHost) {
                const playerIndex = game.players.findIndex(p => p.id === playerIdToKick);
                if (playerIndex > -1) {
                    const kickedPlayer = game.players[playerIndex];
                    const kickedSocket = io.sockets.sockets.get(kickedPlayer.socketId);
                    if (kickedSocket) {
                        kickedSocket.leave(socket.roomCode);
                        kickedSocket.emit('kicked');
                    }
                    delete playerSessions[kickedPlayer.token];
                    game.players.splice(playerIndex, 1);
                    io.to(socket.roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
                }
            }
        });

        socket.on('disconnect', () => {
            let playerFound = null;
            let roomCodeFound = null;

            for (const rc in games) {
                const p = games[rc].players.find(player => player.socketId === socket.id);
                if (p) {
                    playerFound = p;
                    roomCodeFound = rc;
                    break;
                }
            }
            
            if (playerFound && roomCodeFound) {
                const game = games[roomCodeFound];
                playerFound.disconnected = true;
                
                io.to(roomCodeFound).emit('playerDisconnected', playerFound.name);
                io.to(roomCodeFound).emit('updatePlayerList', { players: game.players, settings: game.settings });

                if (playerFound.isHost) {
                    const newHost = game.players.find(p => !p.disconnected);
                    if (newHost) {
                        newHost.isHost = true;
                        io.to(roomCodeFound).emit('newHost', newHost.name);
                        io.to(roomCodeFound).emit('updatePlayerList', { players: game.players, settings: game.settings });
                    }
                }

                if (game.players.every(p => p.disconnected)) {
                    setTimeout(() => {
                        if (games[roomCodeFound] && games[roomCodeFound].players.every(p => p.disconnected)) {
                            gameManager.clearTimers(games[roomCodeFound]);
                            delete games[roomCodeFound];
                        }
                    }, 600000);
                }
            }
        });
    });
}

module.exports = initializeSocketHandlers;

