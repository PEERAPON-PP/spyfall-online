const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const botManager = require('./botManager');

let genAI;
if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    console.log("Gemini AI Initialized successfully.");
} else {
    console.warn("GEMINI_API_KEY not found. Gemini features will be disabled.");
}

let allLocations = [];
try {
    const locationsDir = path.join(__dirname, 'locations');
    const locationFiles = fs.readdirSync(locationsDir).filter(file => file.endsWith('.json'));
    for (const file of locationFiles) {
        const filePath = path.join(locationsDir, file);
        const fileContent = fs.readFileSync(filePath, 'utf8');
        allLocations = allLocations.concat(JSON.parse(fileContent));
    }
} catch (error) {
    console.error("Could not load location files:", error);
}

const TAUNTS = ["ว้าย! โหวตผิดเพราะไม่สวยอะดิ", "เอิ้ก ๆ ๆ ๆ", "ชัดขนาดนี้!", "มองยังไงเนี่ย?", "ไปพักผ่อนบ้างนะ"];

async function getSpyListFromGemini(correctLocation, allPossibleLocations, count) {
    if (!genAI) return null;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `You are a game master for Spyfall. Your task is to select a list of ${count} locations for the spy. The correct location is "${correctLocation}". The full list is: ${JSON.stringify(allPossibleLocations)}. Please select ${count - 1} other locations from the list that are as different from "${correctLocation}" and each other as possible. The final list must contain exactly ${count} unique locations, including "${correctLocation}". Return ONLY a JSON object with a single key "locations" which is an array of strings. Example: {"locations": ["Location A", "Location B"]}`;
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const jsonString = response.text().replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(jsonString);
        if (parsed.locations && Array.isArray(parsed.locations) && parsed.locations.length === count) {
            return parsed.locations;
        }
    } catch (error) { console.error("Error calling Gemini API:", error); }
    return null;
}

function shuffleArray(array) { for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[array[i], array[j]] = [array[j], array[i]]; } }
function parseRole(roleString) {
    if (!roleString) return { name: '', description: null };
    const match = roleString.match(/^(.*?)\s*\((.*?)\)$/);
    return match ? { name: match[1].trim(), description: match[2].trim() } : { name: roleString, description: null };
}
function getAvailableLocations(themes) {
    if (!themes || themes.length === 0) return allLocations.filter(loc => loc.category === 'default');
    return allLocations.filter(loc => themes.includes(loc.category));
}

function createBalancedDeck(themes) {
    if (!themes || themes.length === 0) return [];
    const locationsByCategory = {};
    themes.forEach(theme => {
        locationsByCategory[theme] = allLocations.filter(loc => loc.category === theme);
        shuffleArray(locationsByCategory[theme]);
    });
    const deck = [];
    if (themes.length > 1) {
        let minSize = Math.min(...Object.values(locationsByCategory).map(arr => arr.length));
        themes.forEach(theme => {
            deck.push(...locationsByCategory[theme].slice(0, minSize));
        });
    } else {
        deck.push(...locationsByCategory[themes[0]]);
    }
    shuffleArray(deck);
    return deck;
}

function generateRoomCode(games) {
    let code;
    do { code = Math.random().toString(36).substring(2, 6).toUpperCase(); } while (games[code]);
    return code;
}

function clearTimers(game) {
    if (game.timer) clearTimeout(game.timer);
    if (game.voteTimer) clearTimeout(game.voteTimer);
    if (game.specialTimer) clearTimeout(game.specialTimer);
    game.timer = null; game.voteTimer = null; game.specialTimer = null;
}

function startGame(roomCode, settings, games, io) {
    const game = games[roomCode];
    if (!game || game.players.filter(p => !p.disconnected && !p.isSpectator).length < 1) return;
    game.settings = { time: parseInt(settings.time), rounds: parseInt(settings.rounds), themes: settings.themes || ['default'], voteTime: parseInt(settings.voteTime) || 120, bountyHuntEnabled: settings.bountyHuntEnabled, useGemini: !!genAI };
    game.locationDeck = createBalancedDeck(game.settings.themes);
    game.currentRound = 0;
    startNewRound(roomCode, games, io);
}

function gameLoop(roomCode, games, io) {
    const game = games[roomCode];
    if (!game || game.state !== 'playing') return;
    game.timeLeft--;
    io.to(roomCode).emit('timerUpdate', { timeLeft: Math.max(0, game.timeLeft), players: game.players });
    if (game.timeLeft <= 0) {
        endRound(roomCode, "timer_end", games, io);
    } else {
        game.timer = setTimeout(() => gameLoop(roomCode, games, io), 1000);
    }
}

async function startNewRound(roomCode, games, io) {
    const game = games[roomCode];
    if (!game || (game.currentRound >= game.settings.rounds && game.state === 'post-round')) return;
    clearTimers(game);
    game.state = 'playing';
    game.currentRound++;
    game.votes = {};
    game.spy = null;
    game.spyLocationList = [];
    game.players.forEach(p => { if (p.isSpectator === 'waiting') p.isSpectator = false; delete p.role; });
    if (!game.locationDeck || game.locationDeck.length === 0) {
        game.locationDeck = createBalancedDeck(game.settings.themes);
        if(game.locationDeck.length === 0) { io.to(roomCode).emit('error', 'ไม่พบสถานที่สำหรับโหมดที่เลือก'); return; }
    }
    const location = game.locationDeck.pop();
    if (!location) { io.to(roomCode).emit('error', 'เกิดข้อผิดพลาด: ไม่สามารถเลือกสถานที่ได้'); return; }
    game.currentLocation = location.name;
    game.currentRoles = location.roles;
    const activePlayers = game.players.filter(p => !p.disconnected && !p.isSpectator);
    if (activePlayers.length === 0) return;
    shuffleArray(activePlayers);
    const spyIndex = Math.floor(Math.random() * activePlayers.length);
    let roles = [...location.roles];
    shuffleArray(roles);
    activePlayers.forEach((player, index) => {
        player.role = (index === spyIndex) ? 'สายลับ' : (roles.pop() || "พลเมืองดี");
        if (player.role === 'สายลับ') game.spy = player;
    });
    const allPlayerRoles = activePlayers.map(p => ({ id: p.id, role: parseRole(p.role).name }));
    let spyListSize;
    const themeCount = game.settings.themes.length;
    if (themeCount >= 3) spyListSize = 22;
    else if (themeCount === 2) spyListSize = 18;
    else spyListSize = game.settings.themes.includes('default') ? 14 : 12;
    const allThemeLocationNames = getAvailableLocations(game.settings.themes).map(l => l.name);
    if (spyListSize > allThemeLocationNames.length) spyListSize = allThemeLocationNames.length;
    let spyList = game.settings.useGemini ? await getSpyListFromGemini(game.currentLocation, allThemeLocationNames, spyListSize) : null;
    if (!spyList) {
        let otherLocations = allThemeLocationNames.filter(name => name !== game.currentLocation);
        shuffleArray(otherLocations);
        spyList = otherLocations.slice(0, spyListSize - 1);
        spyList.push(game.currentLocation);
    }
    spyList.sort((a, b) => a.localeCompare(b, 'th'));
    game.spyLocationList = spyList;
    game.players.forEach(player => {
        const socket = io.sockets.sockets.get(player.socketId);
        if (socket) {
            const payload = { round: game.currentRound, totalRounds: game.settings.rounds, isHost: player.isHost, players: game.players, isSpectator: player.isSpectator, allLocationsData: getAvailableLocations(game.settings.themes), allPlayerRoles, allLocations: game.spyLocationList };
            if (player.isSpectator) { payload.location = game.currentLocation; payload.role = "ผู้ชม"; }
            else if (player.role) { const { name: roleName, description: roleDesc } = parseRole(player.role); payload.role = roleName; payload.roleDesc = roleDesc; payload.location = roleName === 'สายลับ' ? 'ไม่ทราบ' : game.currentLocation; if(roleName==='สายลับ'&&game.bountyTarget)payload.bountyTargetName=game.bountyTarget.name; }
            else return;
            socket.emit('gameStarted', payload);
        }
    });
    game.timeLeft = game.settings.time;
    io.to(roomCode).emit('timerUpdate', { timeLeft: game.timeLeft, players: game.players });
    game.timer = setTimeout(() => gameLoop(roomCode, games, io), 1000);
}

function submitVote(roomCode, socketId, votedPlayerId, games, io) {
    const game = games[roomCode];
    if (!game || !['voting', 'revoting'].includes(game.state)) return;
    const player = game.players.find(p => p.socketId === socketId);
    if (player && !player.isSpectator) {
        game.votes[player.id] = votedPlayerId; // Use player.id as key
        const playersWhoCanVote = game.players.filter(p => !p.disconnected && !p.isSpectator);
        const voterIds = Object.keys(game.votes);
        io.to(roomCode).emit('voteUpdate', { voters: voterIds, totalVoters: playersWhoCanVote.length });
        if (voterIds.length >= playersWhoCanVote.length) {
            clearTimeout(game.voteTimer);
            calculateVoteResults(roomCode, games, io);
        }
    }
}

function endRound(roomCode, reason, games, io) {
    const game = games[roomCode];
    if (!game || game.state !== 'playing') return;
    clearTimers(game);
    game.state = 'voting';
    game.resultsCalculated = false;
    const voteReason = reason === 'timer_end' ? 'หมดเวลา! โหวตหาตัวสายลับ' : 'หัวหน้าห้องสั่งจบรอบ!';
    const activePlayers = game.players.filter(p => !p.disconnected && !p.isSpectator);
    const voteTime = game.settings.voteTime;
    io.to(roomCode).emit('startVote', { players: activePlayers, reason: voteReason, voteTime });
    game.voteTimer = setTimeout(() => calculateVoteResults(roomCode, games, io), voteTime * 1000);
    if (game.isBotGame) botManager.runBotVote(roomCode, io, games, submitVote);
}

function calculateVoteResults(roomCode, games, io) {
    const game = games[roomCode];
    if (!game || !['voting', 'revoting'].includes(game.state) || game.resultsCalculated) return;
    game.resultsCalculated = true;
    const spyId = game.spy.id;
    const voteCounts = {};
    Object.values(game.votes).forEach(votedId => { if (votedId) voteCounts[votedId] = (voteCounts[votedId] || 0) + 1; });
    let maxVotes = 0, mostVotedIds = [];
    for (const playerId in voteCounts) {
        if (voteCounts[playerId] > maxVotes) { maxVotes = voteCounts[playerId]; mostVotedIds = [playerId]; }
        else if (voteCounts[playerId] === maxVotes) mostVotedIds.push(playerId);
    }
    if (mostVotedIds.length === 1 && mostVotedIds[0] === spyId) {
        let votersOfSpy = [];
        for (const playerId in game.votes) {
            if (game.votes[playerId] === spyId) {
                const voter = game.players.find(p => p.id === playerId);
                if (voter) { voter.score++; votersOfSpy.push(voter.name); }
            }
        }
        let resultText = `จับสายลับได้สำเร็จ!\n` + (votersOfSpy.length > 0 ? `ผู้เล่นที่โหวตถูก: ${votersOfSpy.join(', ')} ได้รับ 1 คะแนน` : `ไม่มีใครโหวตสายลับ แต่สายลับก็ถูกเปิดโปง`);
        endGamePhase(roomCode, resultText, games, io);
    } else {
        const reason = mostVotedIds.length === 0 ? "ไม่มีใครถูกโหวตเลย!" : "โหวตผิดคน!";
        initiateSpyEscape(roomCode, reason, games, io);
    }
}

function initiateSpyEscape(roomCode, reason, games, io) {
    const game = games[roomCode];
    if (!game || !game.spy) return;
    game.spy.score++;
    game.state = 'spy-guessing';
    const taunt = TAUNTS[Math.floor(Math.random() * TAUNTS.length)];
    const spySocket = io.sockets.sockets.get(game.spy.socketId);
    if(spySocket) spySocket.emit('spyGuessPhase', { locations: game.spyLocationList, taunt: `${reason} ${taunt}`, duration: 60 });
    game.players.forEach(p => {
        if (p.id !== game.spy.id && !p.isBot) {
            const playerSocket = io.sockets.sockets.get(p.socketId);
            if(playerSocket) playerSocket.emit('spyIsGuessing', { spyName: game.spy.name, taunt: `${reason} ${taunt}` });
        }
    });
    game.specialTimer = setTimeout(() => { if(games[roomCode]?.state === 'spy-guessing') spyGuessLocation(roomCode, game.spy.socketId, null, games, io); }, 60 * 1000);
}

function endGamePhase(roomCode, resultText, games, io) {
    const game = games[roomCode];
    if (!game) return;
    clearTimers(game);
    game.state = 'post-round';
    io.to(roomCode).emit('roundOver', { location: game.currentLocation, spyName: game.spy ? game.spy.name : 'ไม่มี', resultText, isFinalRound: game.currentRound >= game.settings.rounds, players: game.players });
}

function spyGuessLocation(roomCode, socketId, guessedLocation, games, io) {
    const game = games[roomCode];
    if (!game || game.state !== 'spy-guessing' || !game.spy || socketId !== game.spy.socketId) return;
    let resultText = guessedLocation === game.currentLocation ? (game.spy.score++, `สายลับหนีรอด และตอบสถานที่ถูกต้อง!\nสายลับได้รับเพิ่มอีก 1 คะแนน! (รวมเป็น 2)`) : `สายลับหนีรอด! แต่ตอบสถานที่ผิด\nสายลับได้รับ 1 คะแนน`;
    endGamePhase(roomCode, resultText, games, io);
}

module.exports = { generateRoomCode, startGame, startNewRound, endRound, submitVote, spyGuessLocation, getAvailableLocations, clearTimers };

