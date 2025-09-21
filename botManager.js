const { v4: uuidv4 } = require('uuid');

const BOT_NAMES = ["Leo", "Mia", "Zoe", "Kai", "Eva"];

async function createBotGame(humanPlayerSocket, io, games) {
    const roomCode = "BOT1";
    if (games[roomCode]) delete games[roomCode];
    const game = { players: [], state: 'lobby', settings: { time: 180, rounds: 3, themes: ['default', 'fairytale'], voteTime: 30, bountyHuntEnabled: false, useGemini: true }, currentRound: 0, locationDeck: [], isBotGame: true };
    games[roomCode] = game;
    const humanPlayerData = { id: uuidv4(), socketId: humanPlayerSocket.id, name: humanPlayerSocket.playerName, isHost: true, score: 0, token: humanPlayerSocket.playerToken, isSpectator: true, disconnected: false };
    game.players.push(humanPlayerData);
    humanPlayerSocket.join(roomCode);
    humanPlayerSocket.roomCode = roomCode;
    BOT_NAMES.forEach(name => game.players.push({ id: uuidv4(), socketId: `bot_${name}`, name: `(Bot) ${name}`, isHost: false, score: 0, token: `bot_${uuidv4()}`, isSpectator: false, disconnected: false, isBot: true }));
    humanPlayerSocket.emit('joinSuccess', { roomCode });
    io.to(roomCode).emit('updatePlayerList', { players: game.players, settings: game.settings });
}

async function runBotVote(roomCode, io, games, submitVoteFn) {
    const game = games[roomCode];
    if (!game || !game.isBotGame || game.state !== 'voting') return;
    const bots = game.players.filter(p => p.isBot && !p.isSpectator);
    const potentialTargets = game.players.filter(p => !p.isSpectator && !p.disconnected);
    const spy = game.spy;
    
    for (const bot of bots) {
        let targetPlayerId = null;
        if (bot.id === spy.id) {
            const nonSpies = potentialTargets.filter(p => p.id !== spy.id);
            if (nonSpies.length > 0) targetPlayerId = nonSpies[Math.floor(Math.random() * nonSpies.length)].id;
        } else {
            if (Math.random() < 0.9) {
                targetPlayerId = spy.id;
            } else {
                const innocentPlayers = potentialTargets.filter(p => p.id !== spy.id && p.id !== bot.id);
                targetPlayerId = innocentPlayers.length > 0 ? innocentPlayers[Math.floor(Math.random() * innocentPlayers.length)].id : spy.id;
            }
        }
        await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));
        submitVoteFn(roomCode, bot.socketId, targetPlayerId, games, io);
    }
}

module.exports = { createBotGame, runBotVote };

