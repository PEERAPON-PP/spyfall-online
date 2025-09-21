const { v4: uuidv4 } = require('uuid');
const gameManager = require('./gameManager');
const botManager = require('./botManager');

const games = {};
const playerSessions = {};

function parseRole(roleString) { return roleString.match(/^(.*?)\s*\((.*?)\)$/) ? { name: RegExp.$1.trim(), description: RegExp.$2.trim() } : { name: roleString, description: null }; }

function initializeSocketHandlers(io) {
    io.on('connection', (socket) => {
        let isStartingNextRound = false;
        const getCurrentState = () => { const roomCode = socket.roomCode; if (!roomCode || !games[roomCode]) return { game: null, player: null }; return { game: games[roomCode], player: games[roomCode].players.find(p => p.socketId === socket.id) }; };

        socket.on('createRoom', ({ playerName, playerToken }) => {
            const roomCode = gameManager.generateRoomCode(games);
            socket.roomCode = roomCode;
            games[roomCode] = { players: [], state: 'lobby', settings: { time: 300, rounds: 5, themes: ['default'], voteTime: 30, bountyHuntEnabled: false }, currentRound: 0, locationDeck: [] };
            const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: true, score: 0, token: playerToken, isSpectator: false, disconnected: false };
            games[roomCode].players.push(player);
            playerSessions[playerToken] = { roomCode, playerId: player.id };
            socket.join(roomCode);
            socket.emit('roomCreated', { roomCode });
            io.to(roomCode).emit('updatePlayerList', {players: games[roomCode].players, settings: games[roomCode].settings});
        });

        socket.on('joinRoom', ({ playerName, roomCode, playerToken }) => {
            const roomCodeUpper = roomCode.toUpperCase();
            if (roomCodeUpper === 'BOT1') { socket.playerName = playerName; socket.playerToken = playerToken; botManager.createBotGame(socket, io, games); return; }
            const game = games[roomCodeUpper];
            if (!game) return socket.emit('error', 'ไม่พบห้องนี้');
            const session = playerSessions[playerToken];
            if (session?.roomCode === roomCodeUpper) {
                const existingPlayer = game.players.find(p => p.id === session.playerId);
                if (existingPlayer) {
                    if (!existingPlayer.disconnected) return socket.emit('error', 'คุณได้เชื่อมต่ออยู่ในแท็บอื่นแล้ว');
                    existingPlayer.socketId = socket.id; existingPlayer.disconnected = false; socket.roomCode = roomCodeUpper; socket.join(roomCodeUpper);
                    if (game.state === 'lobby') { socket.emit('joinSuccess', { roomCode: roomCodeUpper }); }
                    else {
                        const payload = { round: game.currentRound, totalRounds: game.settings.rounds, players: game.players, isSpectator: existingPlayer.isSpectator, allPlayerRoles: game.players.filter(p=>!p.isSpectator).map(p=>({id:p.id, role:parseRole(p.role).name})), allLocations: game.spyLocationList, canBountyHunt: game.settings.bountyHuntEnabled };
                        if(existingPlayer.isSpectator){ payload.location = game.currentLocation; payload.role = "ผู้ชม"; }
                        else { const {name:roleName, description:roleDesc} = parseRole(existingPlayer.role); payload.role=roleName; payload.roleDesc=roleDesc; payload.location=roleName==='สายลับ'?'ไม่ทราบ':game.currentLocation; if(roleName==='สายลับ'&&game.bountyTarget)payload.bountyTargetName=game.bountyTarget.name;}
                        socket.emit('gameStarted', payload);
                    }
                    io.to(roomCodeUpper).emit('updatePlayerList', {players: game.players, settings: game.settings});
                    io.to(roomCodeUpper).emit('playerReconnected', existingPlayer.name);
                    return;
                }
            }
            if (game.state !== 'lobby') {
                const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: false, score: 0, token: playerToken, isSpectator: 'waiting', disconnected: false };
                game.players.push(player); playerSessions[playerToken] = { roomCode: roomCodeUpper, playerId: player.id }; socket.join(roomCodeUpper);
                const payload = { round: game.currentRound, totalRounds: game.settings.rounds, players: game.players, isSpectator: true, allPlayerRoles: game.players.filter(p=>!p.isSpectator).map(p=>({id:p.id, role:parseRole(p.role).name})), allLocations: game.spyLocationList, location: game.currentLocation, role: "ผู้ชม" };
                socket.emit('gameStarted', payload);
                io.to(roomCodeUpper).emit('updatePlayerList', {players: game.players, settings: game.settings});
                return;
            }
            const player = { id: uuidv4(), socketId: socket.id, name: playerName, isHost: false, score: 0, token: playerToken, isSpectator: false, disconnected: false };
            game.players.push(player); playerSessions[playerToken] = { roomCode: roomCodeUpper, playerId: player.id }; socket.join(roomCodeUpper);
            socket.emit('joinSuccess', { roomCode: roomCodeUpper });
            io.to(roomCodeUpper).emit('updatePlayerList', {players: game.players, settings: game.settings});
        });
        
        socket.on('startGame', (settings) => { const { game, player } = getCurrentState(); if (game && player?.isHost) gameManager.startGame(socket.roomCode, settings, games, io); });
        socket.on('settingChanged', ({ setting, value }) => { const { game, player } = getCurrentState(); if (game && player?.isHost && game.state === 'lobby') { if(setting === 'themes' && !value.length) value.push('default'); game.settings[setting] = value; io.to(socket.roomCode).emit('settingsUpdated', game.settings); } });
        socket.on('toggleSpectatorMode', () => { const { game, player } = getCurrentState(); if (game && player && !player.isHost) { player.isSpectator = !player.isSpectator; io.to(socket.roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings}); } });
        socket.on('hostEndRound', () => { const { game, player } = getCurrentState(); if (game && player?.isHost && game.state === 'playing') gameManager.endRound(socket.roomCode, "host_ended", games, io); });
        socket.on('submitVote', (votedPlayerId) => { if (socket.roomCode) gameManager.submitVote(socket.roomCode, socket.id, votedPlayerId, games, io); });
        socket.on('spyGuessLocation', (guessedLocation) => { if (socket.roomCode) gameManager.spyGuessLocation(socket.roomCode, socket.id, guessedLocation, games, io); });
        socket.on('spyDeclareBounty', () => { const { game, player } = getCurrentState(); if (game && player && parseRole(player.role).name === 'สายลับ' && game.state === 'playing') gameManager.initiateBountyHunt(socket.roomCode, games, io); });
        socket.on('submitBountyGuess', (guess) => { const { game, player } = getCurrentState(); if (game && player && parseRole(player.role).name === 'สายลับ' && game.state === 'bounty-hunting') gameManager.resolveBountyHunt(socket.roomCode, guess, games, io); });
        socket.on('requestNextRound', async () => { if (isStartingNextRound) return; const { game, player } = getCurrentState(); if (game && player?.isHost && game.currentRound < game.settings.rounds) { isStartingNextRound = true; try { await gameManager.startNewRound(socket.roomCode, games, io); } finally { isStartingNextRound = false; } } });
        socket.on('resetGame', () => { const { game, player } = getCurrentState(); if (game && player?.isHost) { game.state = 'lobby'; game.currentRound = 0; game.locationDeck = []; game.players.forEach(p => p.score = 0); gameManager.clearTimers(game); io.to(socket.roomCode).emit('returnToLobby'); io.to(socket.roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings}); } });
        socket.on('kickPlayer', (playerIdToKick) => { const { game, player } = getCurrentState(); if (game && player?.isHost) { const pIndex = game.players.findIndex(p => p.id === playerIdToKick); if (pIndex > -1) { const kicked = game.players[pIndex]; const kSocket = io.sockets.sockets.get(kicked.socketId); if (kSocket) { kSocket.leave(socket.roomCode); kSocket.emit('kicked'); } delete playerSessions[kicked.token]; game.players.splice(pIndex, 1); io.to(socket.roomCode).emit('updatePlayerList', {players: game.players, settings: game.settings}); } } });
        socket.on('disconnect', () => { setTimeout(() => { const { game, player } = getCurrentState(); if (player && game) { player.disconnected = true; io.to(game.roomCode).emit('playerDisconnected', player.name); io.to(game.roomCode).emit('updatePlayerList', { players: game.players, settings: game.settings }); if (player.isHost) { const newHost = game.players.find(p => !p.disconnected && !p.isSpectator); if (newHost) { newHost.isHost = true; player.isHost = false; io.to(game.roomCode).emit('newHost', newHost.name); io.to(game.roomCode).emit('updatePlayerList', { players: game.players, settings: game.settings }); } } if (game.players.every(p => p.disconnected)) { setTimeout(() => { if (games[game.roomCode]?.players.every(p => p.disconnected)) { gameManager.clearTimers(games[game.roomCode]); games[game.roomCode].players.forEach(p => delete playerSessions[p.token]); delete games[game.roomCode]; } }, 600000); } } }, 1500); });
    });
}

module.exports = initializeSocketHandlers;

