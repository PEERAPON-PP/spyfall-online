const { v4: uuidv4 } = require('uuid');
const { GoogleGenerativeAI } = require("@google/generative-ai");

let genAI;
if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

const BOT_NAMES = ["Leo", "Mia", "Zoe", "Kai", "Eva"];

async function createBotGame(humanPlayerSocket, io, games) {
    if (!genAI) {
        humanPlayerSocket.emit('error', 'Gemini API key is not configured. Bot mode is unavailable.');
        return;
    }
    const roomCode = "BOT1";
    if (games[roomCode]) delete games[roomCode];
    const game = { players: [], state: 'lobby', settings: { time: 180, rounds: 3, themes: ['default', 'fairytale'], voteTime: 30, bountyHuntEnabled: false, useGemini: true }, currentRound: 0, locationDeck: [], isBotGame: true };
    games[roomCode] = game;
    const humanPlayerData = { id: uuidv4(), socketId: humanPlayerSocket.id, name: humanPlayerSocket.playerName, isHost: true, score: 0, token: humanPlayerSocket.playerToken, isSpectator: true, disconnected: false };
    game.players.push(humanPlayerData);
    humanPlayerSocket.join(roomCode);
    humanPlayerSocket.roomCode = roomCode;
    BOT_NAMES.forEach(name => {
        game.players.push({ id: uuidv4(), socketId: `bot_${name}`, name: `(Bot) ${name}`, isHost: false, score: 0, token: `bot_${uuidv4()}`, isSpectator: false, disconnected: false, isBot: true });
    });
    humanPlayerSocket.emit('joinSuccess', { roomCode });
    io.to(roomCode).emit('updatePlayerList', { players: game.players, settings: game.settings });
}

async function runBotVote(roomCode, io, games, submitVoteFn) {
    const game = games[roomCode];
    if (!game || !game.isBotGame || game.state !== 'voting') return;
    const bots = game.players.filter(p => p.isBot && !p.isSpectator);
    const potentialTargets = game.players.filter(p => !p.isSpectator && !p.disconnected);
    const spy = game.spy;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    for (const bot of bots) {
        const isSpy = bot.id === spy.id;
        const otherPlayers = potentialTargets.filter(p => p.id !== bot.id).map(p => p.name);
        const prompt = `You are an AI player named ${bot.name} in Spyfall. It's time to vote. The location is: "${isSpy ? "Unknown" : game.currentLocation}". Your role is: "${isSpy ? "Spy" : bot.role}". You can vote for: ${otherPlayers.join(', ')}. The actual spy is: "${spy.name}". If you are the Spy, vote for someone else. If you are not the Spy, you MUST vote for the actual Spy ("${spy.name}"). Return ONLY the full name of the player you are voting for.`;
        try {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const votedName = response.text().trim();
            const targetPlayer = potentialTargets.find(p => p.name === votedName);
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));
            submitVoteFn(roomCode, bot.socketId, targetPlayer ? targetPlayer.id : null, games, io);
        } catch (error) {
            console.error(`Error for ${bot.name}:`, error);
            submitVoteFn(roomCode, bot.socketId, null, games, io);
        }
    }
}

module.exports = { createBotGame, runBotVote };

