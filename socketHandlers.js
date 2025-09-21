const { v4: uuidv4 } = require('uuid');
const gameManager = require('./gameManager');

const games = {};
const playerSessions = {}; // Maps playerToken to { roomCode, playerId }

function parseRole(roleString) {
    if (!roleString) return { name: '', description: null };
    const match = roleString.match(/^(.*?)\s*\((.*?)\)$/);
    return match ? { name: match[1].trim(), description: match[2].trim() } : { name: roleString, description: null };
}

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
            games[roomCode] = { 
                players: [], 
                state: 'lobby', 
                settings: { time: 300, rounds: 5, themes: ['default'], voteTime: 120, bountyHuntEnabled: false }, 
                currentRound: 0, 
                usedLocations: [],
                isTransitioning: false // Add lock flag
            };
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

            socket.roomCode = roomCodeUpper;
            const shouldBeSpectator = game.state !== 'lobby';
            const player = { 
                id: uuidv4(), 
                socketId: socket.id, 
                name: playerName, 
                isHost: false, 
                score: 0, 
                token: playerToken, 
                isSpectator: shouldBeSpectator, 
                disconnected: false 
            };
            game.players.push(player);
            playerSessions[playerToken] = { roomCode: roomCodeUpper, playerId: player.id };
            socket.join(roomCodeUpper);

            if(shouldBeSpectator){
                gameManager.sendGameStateToSpectator(game, player, io);
            } else {
                socket.emit('joinSuccess', { roomCode: roomCodeUpper });
            }
            io.to(roomCodeUpper).emit('updatePlayerList', {players: game.players, settings: game.settings});
        });
        
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
                if (game.state === 'lobby') {
                    player.isSpectator = !player.isSpectator;
                    io.to(socket.roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings});
                }
            }
        });

        socket.on('hostEndRound', () => {
            const { game, player } = getCurrentState();
             if (game && player && player.isHost && game.state === 'playing') {
                gameManager.endRound(socket.roomCode, "host_ended", games, io);
             }
        });
        
        socket.on('submitVote', (votedPlayerId) => {
            if (socket.roomCode) gameManager.submitVote(socket.roomCode, socket.id, votedPlayerId, games, io);
        });

        socket.on('spyGuessLocation', (guessedLocation) => {
            if (socket.roomCode) gameManager.spyGuessLocation(socket.roomCode, socket.id, guessedLocation, games, io);
        });
        
        socket.on('spyDeclareBounty', () => {
            const { game, player } = getCurrentState();
            if (game && player && parseRole(player.role).name === 'สายลับ' && game.state === 'playing') {
                gameManager.initiateBountyHunt(socket.roomCode, games, io);
            }
        });

        socket.on('submitBountyGuess', (guess) => {
            const { game, player } = getCurrentState();
            if (game && player && parseRole(player.role).name === 'สายลับ' && game.state === 'bounty-hunting') {
                gameManager.resolveBountyHunt(socket.roomCode, guess, games, io);
            }
        });

        socket.on('requestNextRound', () => {
            const { game, player } = getCurrentState();
            
            // BUG FIX: Add a transition lock to prevent spamming and ensure clean state changes.
            if (game && player && player.isHost && game.state === 'post-round' && !game.isTransitioning && game.currentRound < game.settings.rounds) {
                
                game.isTransitioning = true; // Lock the state
                
                const countdown = 5;
                io.to(socket.roomCode).emit('startingNextRoundCountdown', countdown);

                setTimeout(() => {
                    // Re-check game existence in case everyone disconnected during countdown
                    if (games[socket.roomCode]) {
                        gameManager.startNewRound(socket.roomCode, games, io);
                        games[socket.roomCode].isTransitioning = false; // Unlock the state
                    }
                }, countdown * 1000);
            }
        });

        socket.on('resetGame', () => {
            const { game, player } = getCurrentState();
            if (game && player && player.isHost) {
                game.state = 'lobby';
                game.currentRound = 0;
                game.usedLocations = [];
                game.players.forEach(p => {
                    p.score = 0;
                    if (p.isSpectator !== true) {
                        p.isSpectator = false;
                    }
                });
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
            setTimeout(() => {
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
                        }, 600000); // 10 minutes
                    }
                }
            }, 1500);
        });
    });
}

module.exports = initializeSocketHandlers;

