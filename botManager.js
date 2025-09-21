const { v4: uuidv4 } = require('uuid');
const gameManager = require('./gameManager');
const { GoogleGenerativeAI } = require("@google/generative-ai");

let genAI;
if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

const BOT_NAMES = ["Leo", "Mia", "Zoe", "Kai", "Eva"];

/**
 * สร้างและเริ่มเกมสำหรับบอต
 * @param {object} humanPlayerSocket - Socket object ของผู้เล่นที่เป็นมนุษย์
 * @param {object} io - Socket.IO instance
 * @param {object} games - อ็อบเจกต์ที่เก็บข้อมูลเกมทั้งหมด
 */
async function createBotGame(humanPlayerSocket, io, games) {
    if (!genAI) {
        humanPlayerSocket.emit('error', 'Gemini API key is not configured on the server. Bot mode is unavailable.');
        return;
    }

    const roomCode = "BOT1";
    if (games[roomCode]) {
        delete games[roomCode];
    }

    console.log(`Creating a new bot game with room code: ${roomCode}`);

    const game = {
        players: [],
        state: 'lobby',
        settings: { time: 180, rounds: 3, themes: ['default', 'fairytale'], voteTime: 60, bountyHuntEnabled: true, useGemini: true },
        currentRound: 0,
        locationDeck: [],
        isBotGame: true,
    };
    games[roomCode] = game;

    // เพิ่มผู้เล่นที่เป็นมนุษย์ในฐานะผู้ชม
    const humanPlayerData = {
        id: uuidv4(),
        socketId: humanPlayerSocket.id,
        name: humanPlayerSocket.playerName,
        isHost: false,
        score: 0,
        token: humanPlayerSocket.playerToken,
        isSpectator: true,
        disconnected: false
    };
    game.players.push(humanPlayerData);
    humanPlayerSocket.join(roomCode);
    humanPlayerSocket.roomCode = roomCode;

    // เพิ่มผู้เล่นบอต
    BOT_NAMES.forEach(name => {
        game.players.push({
            id: uuidv4(),
            socketId: `bot_${name}`,
            name: `(Bot) ${name}`,
            isHost: false,
            score: 0,
            token: `bot_${uuidv4()}`,
            isSpectator: false,
            disconnected: false,
            isBot: true
        });
    });
    
    const firstBot = game.players.find(p => p.isBot);
    if(firstBot) firstBot.isHost = true;

    humanPlayerSocket.emit('joinSuccess', { roomCode });
    io.to(roomCode).emit('updatePlayerList', { players: game.players, settings: game.settings });
    
    // เริ่มเกมอัตโนมัติ
    setTimeout(() => {
        console.log(`Starting bot game ${roomCode}...`);
        gameManager.startGame(roomCode, game.settings, games, io);
    }, 3000);
}

/**
 * สั่งให้บอตทำการโหวตโดยใช้ Gemini
 * @param {string} roomCode - รหัสห้อง
 * @param {object} io - Socket.IO instance
 * @param {object} games - อ็อบเจกต์ที่เก็บข้อมูลเกมทั้งหมด
 */
async function runBotVote(roomCode, io, games) {
    const game = games[roomCode];
    if (!game || !game.isBotGame || game.state !== 'voting') return;

    console.log(`Running bot votes for room ${roomCode}`);
    const bots = game.players.filter(p => p.isBot && !p.isSpectator);
    const potentialTargets = game.players.filter(p => !p.isSpectator && !p.disconnected);
    const spy = game.spy;

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    for (const bot of bots) {
        const isSpy = bot.id === spy.id;
        const otherPlayers = potentialTargets.filter(p => p.id !== bot.id).map(p => p.name);

        const prompt = `You are an AI player named ${bot.name} in a game of Spyfall. It's time to vote.
        - The location is: "${isSpy ? "Unknown to you" : game.currentLocation}".
        - Your role is: "${isSpy ? "Spy" : bot.role}".
        - You can vote for: ${otherPlayers.join(', ')}.
        - The actual spy is: "${spy.name}".
        
        If you are the Spy, vote for someone else to deflect suspicion.
        If you are not the Spy, you MUST vote for the actual Spy ("${spy.name}").
        
        Return ONLY the full name of the player you are voting for. Example: (Bot) Kai`;

        try {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const votedName = response.text().trim();
            
            const targetPlayer = potentialTargets.find(p => p.name === votedName);
            if (targetPlayer) {
                console.log(`${bot.name} votes for ${targetPlayer.name}`);
                await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));
                gameManager.submitVote(roomCode, bot.socketId, targetPlayer.id, games, io);
            } else {
                 console.log(`${bot.name} made an invalid vote for "${votedName}", abstaining.`);
                 gameManager.submitVote(roomCode, bot.socketId, null, games, io);
            }

        } catch (error) {
            console.error(`Error getting vote from Gemini for ${bot.name}:`, error);
            gameManager.submitVote(roomCode, bot.socketId, null, games, io);
        }
    }
}

module.exports = { createBotGame, runBotVote };
