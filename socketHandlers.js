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
        let isStartingNextRound = false;

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
            games[roomCode] = { players: [], state: 'lobby', settings: { time: 300, rounds: 5, themes: ['default'], voteTime: 120, bountyHuntEnabled: false }, currentRound: 0, locationDeck: [] };
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

            // --- RECONNECT LOGIC ---
            const session = playerSessions[playerToken];
            if (session && session.roomCode === roomCodeUpper) {
                const existingPlayer = game.players.find(p => p.id === session.playerId);
                if (existingPlayer) {
                    console.log(`Player ${existingPlayer.name} is reconnecting.`);
                    existingPlayer.socketId = socket.id;
                    existingPlayer.disconnected = false;
                    socket.roomCode = roomCodeUpper;
                    socket.join(roomCodeUpper);

                    // Send the correct state back to the reconnected player
                    if (game.state === 'lobby') {
                         socket.emit('joinSuccess', { roomCode: roomCodeUpper });
                    } else {
                        // Resend game state
                        if(existingPlayer.isSpectator){
                            gameManager.sendGameStateToSpectator(game, existingPlayer, io);
                        } else {
                            const payload = {
                                round: game.currentRound,
                                totalRounds: game.settings.rounds,
                                isHost: existingPlayer.isHost,
                                players: game.players,
                                isSpectator: existingPlayer.isSpectator,
                                allLocationsData: gameManager.getAvailableLocations(game.settings.themes),
                                allPlayerRoles: game.players.filter(p => !p.disconnected && !p.isSpectator).map(p => ({ id: p.id, role: parseRole(p.role).name })),
                                allLocations: game.spyLocationList
                            };
                             const { name: roleName, description: roleDesc } = parseRole(existingPlayer.role);
                             const isSpy = roleName === 'สายลับ';
                             payload.role = roleName;
                             payload.roleDesc = roleDesc;
                             payload.location = isSpy ? 'ไม่ทราบ' : game.currentLocation;
                             if (isSpy && game.bountyTarget) {
                                 payload.bountyTargetName = game.bountyTarget.name;
                             }
                             socket.emit('gameStarted', payload);
                        }
                    }
                    io.to(roomCodeUpper).emit('updatePlayerList', {players: game.players, settings: game.settings});
                    io.to(roomCodeUpper).emit('playerReconnected', existingPlayer.name);
                    return; // Stop execution to prevent creating a new player
                }
            }

            // --- NORMAL JOIN LOGIC (New Player or Spectator) ---
            if (game.state !== 'lobby') {
                socket.roomCode = roomCodeUpper;
                const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: false, score: 0, token: playerToken, isSpectator: 'waiting', disconnected: false };
                game.players.push(player);
                playerSessions[playerToken] = { roomCode: roomCodeUpper, playerId: player.id };
                socket.join(roomCodeUpper);
                
                gameManager.sendGameStateToSpectator(game, player, io);

                io.to(roomCodeUpper).emit('updatePlayerList', {players: game.players, settings: game.settings});
                return;
            }

            socket.roomCode = roomCodeUpper;
            const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: false, score: 0, token: playerToken, isSpectator: false, disconnected: false };
            game.players.push(player);
            playerSessions[playerToken] = { roomCode: roomCodeUpper, playerId: player.id };
            socket.join(roomCodeUpper);
            socket.emit('joinSuccess', { roomCode: roomCodeUpper });
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

        socket.on('requestNextRound', async () => {
            if (isStartingNextRound) return;

            const { game, player } = getCurrentState();
            if (game && player && player.isHost) {
                if (game.currentRound < game.settings.rounds) {
                    isStartingNextRound = true;
                    try {
                        await gameManager.startNewRound(socket.roomCode, games, io);
                    } catch (error) {
                        console.error("Error starting next round:", error);
                        // Handle error, maybe emit an error message to the client
                    } finally {
                        isStartingNextRound = false;
                    }
                }
            }
        });

        socket.on('resetGame', () => {
            const { game, player } = getCurrentState();
            if (game && player && player.isHost) {
                game.state = 'lobby';
                game.currentRound = 0;
                game.locationDeck = [];
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
                    // Don't remove the player, just mark them as disconnected
                    playerFound.disconnected = true;
                    
                    io.to(roomCodeFound).emit('playerDisconnected', playerFound.name);
                    io.to(roomCodeFound).emit('updatePlayerList', { players: game.players, settings: game.settings });

                    if (playerFound.isHost) {
                        // Find a new host among connected players
                        const newHost = game.players.find(p => !p.disconnected && !p.isSpectator);
                        if (newHost) {
                            newHost.isHost = true;
                            playerFound.isHost = false; // Old host is no longer host
                            io.to(roomCodeFound).emit('newHost', newHost.name);
                            io.to(roomCodeFound).emit('updatePlayerList', { players: game.players, settings: game.settings });
                        }
                    }

                    // Check if the room should be cleaned up
                    if (game.players.every(p => p.disconnected)) {
                        setTimeout(() => {
                            if (games[roomCodeFound] && games[roomCodeFound].players.every(p => p.disconnected)) {
                                console.log(`Deleting empty room ${roomCodeFound}`);
                                gameManager.clearTimers(games[roomCodeFound]);
                                // Clean up player sessions for this room
                                games[roomCodeFound].players.forEach(p => {
                                    delete playerSessions[p.token];
                                });
                                delete games[roomCodeFound];
                            }
                        }, 600000); // 10 minutes
                    }
                }
            }, 1500); // Wait 1.5 seconds to allow for quick reconnects
        });
    });
}

module.exports = initializeSocketHandlers;

