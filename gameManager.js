const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const botManager = require('./botManager');

let genAI;
if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
} else {
    console.warn("GEMINI_API_KEY not found. Gemini features will be disabled.");
}

let allLocations = [];
try {
    const locationsDir = path.join(__dirname, 'locations');
    const locationFiles = fs.readdirSync(locationsDir).filter(file => file.endsWith('.json'));
    for (const file of locationFiles) {
        const filePath = path.join(locationsDir, file);
        allLocations = allLocations.concat(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    }
} catch (error) { console.error("Could not load location files:", error); }

const TAUNTS = ["ว้าย! โหวตผิดเพราะไม่สวยอะดิ", "เอิ้ก ๆ ๆ ๆ", "ชัดขนาดนี้!", "มองยังไงเนี่ย?", "ไปพักผ่อนบ้างนะ"];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getSpyListFromGemini(correctLocation, allPossibleLocations, count) {
    if (!genAI) return null;
    let retries = 3;
    while (retries > 0) {
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const prompt = `You are a game master for Spyfall. Your task is to select a list of ${count} locations for the spy. The correct location is "${correctLocation}". The full list is: ${JSON.stringify(allPossibleLocations)}. Please select ${count - 1} other locations from the list that are as different from "${correctLocation}" and each other as possible. The final list must contain exactly ${count} unique locations, including "${correctLocation}". Return ONLY a JSON object with a single key "locations" which is an array of strings. Example: {"locations": ["Location A", "Location B"]}`;
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const jsonString = response.text().replace(/```json|```/g, '').trim();
            const parsed = JSON.parse(jsonString);
            if (parsed.locations?.length === count) return parsed.locations;
        } catch (error) {
            if (error.status === 429 && retries > 0) {
                console.warn(`Gemini API rate limit hit. Retrying in 60 seconds... (${retries} retries left)`);
                await sleep(60000);
                retries--;
            } else {
                console.error("Error calling Gemini API:", error);
                return null;
            }
        }
    }
    return null;
}

function shuffleArray(array) { for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[array[i], array[j]] = [array[j], array[i]]; } }
function parseRole(roleString) { return roleString.match(/^(.*?)\s*\((.*?)\)$/) ? { name: RegExp.$1.trim(), description: RegExp.$2.trim() } : { name: roleString, description: null }; }
function getAvailableLocations(themes) { return allLocations.filter(loc => themes?.includes(loc.category)); }

function createBalancedDeck(themes) {
    if (!themes || themes.length === 0) return [];
    const locationsByCategory = {};
    themes.forEach(theme => { locationsByCategory[theme] = allLocations.filter(loc => loc.category === theme); shuffleArray(locationsByCategory[theme]); });
    const deck = [];
    if (themes.length > 1) {
        let minSize = Math.min(...Object.values(locationsByCategory).map(arr => arr.length));
        themes.forEach(theme => { deck.push(...locationsByCategory[theme].slice(0, minSize)); });
    } else {
        deck.push(...locationsByCategory[themes[0]]);
    }
    shuffleArray(deck);
    return deck;
}

function generateRoomCode(games) { let code; do { code = Math.random().toString(36).substring(2, 6).toUpperCase(); } while (games[code]); return code; }
function clearTimers(game) { clearTimeout(game.timer); clearTimeout(game.voteTimer); clearTimeout(game.specialTimer); game.timer = null; game.voteTimer = null; game.specialTimer = null; }

function startGame(roomCode, settings, games, io) {
    const game = games[roomCode];
    if (!game || game.players.filter(p => !p.disconnected && !p.isSpectator).length < 1) return;
    game.settings = {
        time: parseInt(settings.time) || 300,
        rounds: parseInt(settings.rounds) || 5,
        themes: settings.themes || ['default'],
        voteTime: parseInt(settings.voteTime) || 30,
        bountyHuntEnabled: settings.bountyHuntEnabled || false,
        useGemini: !!genAI && game.isBotGame
    };
    game.locationDeck = createBalancedDeck(game.settings.themes);
    game.currentRound = 0;
    startNewRound(roomCode, games, io);
}

function gameLoop(roomCode, games, io) {
    const game = games[roomCode];
    if (!game || game.state !== 'playing') return;
    game.timeLeft--;
    io.to(roomCode).emit('timerUpdate', { timeLeft: Math.max(0, game.timeLeft), players: game.players });
    if (game.timeLeft <= 0) endRound(roomCode, "timer_end", games, io);
    else game.timer = setTimeout(() => gameLoop(roomCode, games, io), 1000);
}

async function startNewRound(roomCode, games, io) {
    const game = games[roomCode];
    if (!game || (game.currentRound >= game.settings.rounds && game.state === 'post-round')) return;
    clearTimers(game);
    game.state = 'playing';
    game.currentRound++;
    game.votes = {}; game.spy = null; game.spyLocationList = []; game.bountyTarget = null;
    game.players.forEach(p => { if (p.isSpectator === 'waiting') p.isSpectator = false; delete p.role; });
    if (!game.locationDeck?.length) game.locationDeck = createBalancedDeck(game.settings.themes);
    if (!game.locationDeck?.length) { io.to(roomCode).emit('error', 'ไม่พบสถานที่สำหรับโหมดที่เลือก'); return; }
    const location = game.locationDeck.pop();
    if (!location) { io.to(roomCode).emit('error', 'เกิดข้อผิดพลาด: ไม่สามารถเลือกสถานที่ได้'); return; }
    game.currentLocation = location.name;
    const activePlayers = game.players.filter(p => !p.disconnected && !p.isSpectator);
    if (!activePlayers.length) return;
    shuffleArray(activePlayers);
    const spyIndex = Math.floor(Math.random() * activePlayers.length);
    let roles = [...location.roles]; shuffleArray(roles);
    activePlayers.forEach((player, index) => { player.role = (index === spyIndex) ? 'สายลับ' : (roles.pop() || "พลเมืองดี"); if (player.role === 'สายลับ') game.spy = player; });
    if (game.settings.bountyHuntEnabled && game.spy && activePlayers.length > 1) { const targets = activePlayers.filter(p=>p.id !== game.spy.id); if(targets.length > 0) game.bountyTarget = targets[Math.floor(Math.random() * targets.length)]; }
    const allPlayerRoles = activePlayers.map(p => ({ id: p.id, role: parseRole(p.role).name }));
    const themeCount = game.settings.themes.length;
    let spyListSize = themeCount >= 3 ? 22 : (themeCount === 2 ? 18 : (game.settings.themes.includes('default') ? 14 : 12));
    const allThemeLocations = getAvailableLocations(game.settings.themes);
    const allThemeLocationNames = allThemeLocations.map(l => l.name);
    if (spyListSize > allThemeLocationNames.length) spyListSize = allThemeLocationNames.length;
    let spyList = game.settings.useGemini ? await getSpyListFromGemini(game.currentLocation, allThemeLocationNames, spyListSize) : null;
    if (!spyList) { let otherLocations = allThemeLocationNames.filter(name => name !== game.currentLocation); shuffleArray(otherLocations); spyList = otherLocations.slice(0, spyListSize - 1); spyList.push(game.currentLocation); }
    spyList.sort((a, b) => a.localeCompare(b, 'th'));
    game.spyLocationList = spyList;
    game.players.forEach(player => {
        const socket = io.sockets.sockets.get(player.socketId);
        if (socket) {
            const payload = { round: game.currentRound, totalRounds: game.settings.rounds, players: game.players, isSpectator: player.isSpectator, allPlayerRoles, allLocations: game.spyLocationList, allLocationsData: allThemeLocations, canBountyHunt: game.settings.bountyHuntEnabled };
            if (player.isSpectator) { payload.location = game.currentLocation; payload.role = "ผู้ชม"; }
            else if (player.role) { const { name: roleName, description: roleDesc } = parseRole(player.role); payload.role = roleName; payload.roleDesc = roleDesc; payload.location = roleName === 'สายลับ' ? 'ไม่ทราบ' : game.currentLocation; if(roleName === 'สายลับ' && game.bountyTarget) payload.bountyTargetName = game.bountyTarget.name; }
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
    if (!game || game.state !== 'voting') return;
    const player = game.players.find(p => p.socketId === socketId);
    if (player && !player.isSpectator && !game.votes[player.id]) {
        game.votes[player.id] = votedPlayerId;
        const playersWhoCanVote = game.players.filter(p => !p.disconnected && !p.isSpectator);
        const voterIds = Object.keys(game.votes);
        io.to(roomCode).emit('voteUpdate', { voters: voterIds, totalVoters: playersWhoCanVote.length });
        if (voterIds.length >= playersWhoCanVote.length) {
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
    const activePlayers = game.players.filter(p => !p.disconnected && !p.isSpectator);
    io.to(roomCode).emit('startVote', { players: activePlayers, reason: reason === 'timer_end' ? 'หมดเวลา! โหวตหาตัวสายลับ' : 'หัวหน้าห้องสั่งจบรอบ!', voteTime: game.settings.voteTime, isBotGame: game.isBotGame || false });
    game.voteTimer = setTimeout(() => calculateVoteResults(roomCode, games, io), game.settings.voteTime * 1000);
    if (game.isBotGame) botManager.runBotVote(roomCode, io, games, submitVote);
}

function calculateVoteResults(roomCode, games, io) {
    const game = games[roomCode];
    if (!game || game.state !== 'voting' || game.resultsCalculated) return;
    clearTimeout(game.voteTimer);
    game.resultsCalculated = true;
    const spyId = game.spy.id;
    const voteCounts = {};
    Object.values(game.votes).forEach(votedId => { if (votedId) voteCounts[votedId] = (voteCounts[votedId] || 0) + 1; });
    let maxVotes = 0, mostVotedIds = [];
    for (const id in voteCounts) { if (voteCounts[id] > maxVotes) { maxVotes = voteCounts[id]; mostVotedIds = [id]; } else if (voteCounts[id] === maxVotes) mostVotedIds.push(id); }
    if (mostVotedIds.length === 1 && mostVotedIds[0] === spyId) {
        let votersOfSpy = [];
        for (const voterId in game.votes) { if (game.votes[voterId] === spyId) { const voter = game.players.find(p => p.id === voterId); if (voter) { voter.score++; votersOfSpy.push(voter.name); } } }
        let resultText = `จับสายลับได้สำเร็จ!\n` + (votersOfSpy.length ? `ผู้เล่นที่โหวตถูก: ${votersOfSpy.join(', ')} ได้รับ 1 คะแนน` : `ไม่มีใครโหวตสายลับ แต่สายลับก็ถูกเปิดโปง`);
        endGamePhase(roomCode, resultText, games, io);
    } else {
        initiateSpyEscape(roomCode, mostVotedIds.length === 0 ? "ไม่มีใครถูกโหวตเลย!" : "โหวตผิดคน!", games, io);
    }
}

function initiateSpyEscape(roomCode, reason, games, io) {
    const game = games[roomCode];
    if (!game || !game.spy) return endGamePhase(roomCode, "เกิดข้อผิดพลาด: ไม่พบสายลับ", games, io);
    game.spy.score++;
    game.state = 'spy-guessing';
    const spySocket = io.sockets.sockets.get(game.spy.socketId);
    if(spySocket) spySocket.emit('spyGuessPhase', { locations: game.spyLocationList, taunt: `${reason} ${TAUNTS[Math.floor(Math.random() * TAUNTS.length)]}`, duration: 60 });
    game.players.forEach(p => { if (p.id !== game.spy.id && !p.isBot) { const socket = io.sockets.sockets.get(p.socketId); if(socket) socket.emit('spyIsGuessing', { spyName: game.spy.name }); }});
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
    clearTimers(game);
    let resultText = guessedLocation === game.currentLocation ? (game.spy.score++, `สายลับหนีรอด และตอบสถานที่ถูกต้อง!\nสายลับได้รับเพิ่มอีก 1 คะแนน! (รวมเป็น 2)`) : `สายลับหนีรอด! แต่ตอบสถานที่ผิด\nสายลับได้รับ 1 คะแนน`;
    endGamePhase(roomCode, resultText, games, io);
}

function initiateBountyHunt(roomCode, games, io) {
    const game = games[roomCode];
    if (!game || game.state !== 'playing' || !game.spy || !game.bountyTarget) return;

    clearTimers(game);
    game.state = 'bounty-hunting';
    const duration = 60;

    const spySocket = io.sockets.sockets.get(game.spy.socketId);
    if (spySocket) {
        spySocket.emit('bountyHuntPhase', {
            targetName: game.bountyTarget.name,
            duration: duration
        });
    }

    game.players.forEach(p => {
        if (p.id !== game.spy.id) {
            const socket = io.sockets.sockets.get(p.socketId);
            if (socket) socket.emit('waitingForBountyHunt', { spyName: game.spy.name });
        }
    });

    game.specialTimer = setTimeout(() => {
        if (games[roomCode]?.state === 'bounty-hunting') {
            resolveBountyHunt(roomCode, { location: null, role: null }, games, io);
        }
    }, duration * 1000);
}

function resolveBountyHunt(roomCode, guess, games, io) {
    const game = games[roomCode];
    if (!game || game.state !== 'bounty-hunting') return;

    clearTimers(game);

    const correctLocation = game.currentLocation;
    const correctRole = parseRole(game.bountyTarget.role).name;
    const isLocationCorrect = guess.location === correctLocation;
    const isRoleCorrect = guess.role === correctRole;

    let resultText;
    if (isLocationCorrect && isRoleCorrect) {
        game.spy.score += 4;
        resultText = `ล่าค่าหัวสำเร็จ!\n${game.spy.name} ทายสถานที่ (${correctLocation}) และบทบาทของ ${game.bountyTarget.name} (${correctRole}) ถูกต้องทั้งหมด!\nสายลับได้รับ 4 คะแนนและชนะรอบนี้!`;
    } else {
        game.players.forEach(p => {
            if (!p.isSpectator && p.id !== game.spy.id) p.score += 2;
        });
        resultText = `ล่าค่าหัวล้มเหลว!\n${game.spy.name} ทายผิดพลาด\n- ทายสถานที่: ${isLocationCorrect ? 'ถูกต้อง' : 'ผิด'}\n- ทายบทบาท: ${isRoleCorrect ? 'ถูกต้อง' : 'ผิด'}\nผู้เล่นทุกคน (ยกเว้นสายลับ) ได้รับ 2 คะแนน!`;
    }
    endGamePhase(roomCode, resultText, games, io);
}


module.exports = { generateRoomCode, startGame, startNewRound, endRound, submitVote, spyGuessLocation, getAvailableLocations, clearTimers, initiateBountyHunt, resolveBountyHunt };

