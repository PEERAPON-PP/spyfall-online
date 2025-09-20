const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- Gemini AI Setup ---
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
    console.log(`Loaded ${allLocations.length} locations from ${locationFiles.length} files.`);
} catch (error) {
    console.error("Could not load location files:", error);
    allLocations = [];
}

const TAUNTS = ["ว้าย! โหวตผิดเพราะไม่สวยอะดิ", "เอิ้ก ๆ ๆ ๆ", "ชัดขนาดนี้!", "มองยังไงเนี่ย?", "ไปพักผ่อนบ้างนะ"];

async function getSpyListFromGemini(correctLocation, allPossibleLocations, count) {
    if (!genAI) return null;

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `You are a game master for the game Spyfall. Your task is to select a list of ${count} locations for the spy.
    The correct location for this round is "${correctLocation}".
    Here is the full list of all possible locations: ${JSON.stringify(allPossibleLocations)}.
    
    Please select ${count - 1} other locations from the list that are as different and distinct from "${correctLocation}" and from each other as possible to ensure fair and fun gameplay. Avoid locations that are thematically too similar (e.g., 'Hospital' and 'Pandemic').
    The final list must contain exactly ${count} unique locations, including "${correctLocation}".
    
    Return your answer ONLY as a JSON object with a single key "locations" which is an array of the selected location strings. For example: {"locations": ["Location A", "Location B"]}`;

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        const jsonString = text.replace('```json', '').replace('```', '').trim();
        const parsed = JSON.parse(jsonString);
        if (parsed.locations && Array.isArray(parsed.locations) && parsed.locations.length === count) {
            console.log("Successfully generated spy list with Gemini.");
            return parsed.locations;
        }
    } catch (error) {
        console.error("Error calling Gemini API:", error);
    }
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

// New helper function to create a balanced location deck
function createBalancedDeck(themes) {
    const availableLocations = getAvailableLocations(themes);
    if (!themes || themes.length <= 1) {
        shuffleArray(availableLocations);
        return availableLocations;
    }

    const locationsByCategory = {};
    themes.forEach(theme => {
        locationsByCategory[theme] = [];
    });
    availableLocations.forEach(location => {
        if (locationsByCategory[location.category]) {
            locationsByCategory[location.category].push(location);
        }
    });

    Object.values(locationsByCategory).forEach(list => shuffleArray(list));

    const balancedDeck = [];
    const categoryLists = Object.values(locationsByCategory).filter(list => list.length > 0);
    let maxLength = 0;
    categoryLists.forEach(list => {
        if (list.length > maxLength) maxLength = list.length;
    });

    for (let i = 0; i < maxLength; i++) {
        for (const list of categoryLists) {
            if (i < list.length) {
                balancedDeck.push(list[i]);
            }
        }
    }
    return balancedDeck;
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
    game.timer = null;
    game.voteTimer = null;
    game.specialTimer = null;
}

function startGame(roomCode, settings, games, io) {
    const game = games[roomCode];
    if (!game) return;
    if (game.players.filter(p => !p.disconnected && !p.isSpectator).length < 1) return;
    
    const { time, rounds, themes, voteTime, bountyHuntEnabled } = settings;
    game.settings = { 
        time: parseInt(time), 
        rounds: parseInt(rounds), 
        themes: themes || ['default'], 
        voteTime: parseInt(voteTime) || 120, 
        bountyHuntEnabled: bountyHuntEnabled, 
        useGemini: !!genAI 
    };

    game.locationDeck = createBalancedDeck(game.settings.themes);
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
    if (!game) return;
    clearTimers(game);
    game.state = 'playing';
    game.currentRound++;
    game.votes = {};
    game.revoteCandidates = [];
    game.spy = null;
    game.bountyTarget = null;
    game.spyLocationList = [];
    
    game.players.forEach(p => { 
        if (p.isSpectator === 'waiting') p.isSpectator = false;
        delete p.role;
    });

    if (!game.locationDeck || game.locationDeck.length === 0) {
        console.log("Location deck is empty, creating a new balanced one...");
        game.locationDeck = createBalancedDeck(game.settings.themes);
        if(game.locationDeck.length === 0) {
             io.to(roomCode).emit('error', 'ไม่พบสถานที่สำหรับโหมดที่เลือก');
             return;
        }
    }

    const location = game.locationDeck.pop();
    if (!location) {
        io.to(roomCode).emit('error', 'เกิดข้อผิดพลาด: ไม่สามารถเลือกสถานที่ได้');
        // Potentially reset the lobby or handle the error state
        return;
    }
    game.currentLocation = location.name;
    game.currentRoles = location.roles;
    
    const activePlayers = game.players.filter(p => !p.disconnected && !p.isSpectator);
    if (activePlayers.length === 0) return;
    
    shuffleArray(activePlayers);
    const spyIndex = Math.floor(Math.random() * activePlayers.length);
    let roles = [...location.roles];
    shuffleArray(roles);
    
    activePlayers.forEach((player, index) => {
        const fullRoleString = (index === spyIndex) ? 'สายลับ' : (roles.pop() || "พลเมืองดี");
        player.role = fullRoleString;
        if (player.role === 'สายลับ') game.spy = player;
    });

    if (game.settings.bountyHuntEnabled && game.spy && activePlayers.length > 1) {
        const potentialTargets = activePlayers.filter(p => p.id !== game.spy.id);
        if (potentialTargets.length > 0) {
            game.bountyTarget = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
        }
    }

    const allPlayerRoles = activePlayers.map(p => {
        const { name } = parseRole(p.role);
        return { id: p.id, role: name };
    });
    
    let spyListSize;
    const selectedThemes = game.settings.themes;
    const themeCount = selectedThemes.length;

    if (themeCount >= 3) {
        spyListSize = 22;
    } else if (themeCount === 2) {
        spyListSize = 18;
    } else if (themeCount === 1) {
        if (selectedThemes.includes('default')) {
            spyListSize = 14;
        } else {
            spyListSize = 12;
        }
    } else {
        spyListSize = 20;
    }
    
    const availableLocationsForSpyList = getAvailableLocations(game.settings.themes);
    const allThemeLocationNames = availableLocationsForSpyList.map(l => l.name);

    if (spyListSize > allThemeLocationNames.length) {
        spyListSize = allThemeLocationNames.length;
    }

    let spyList;
    if (game.settings.useGemini) {
        console.log("Attempting to generate spy list with Gemini...");
        spyList = await getSpyListFromGemini(game.currentLocation, allThemeLocationNames, spyListSize);
    }

    if (!spyList) {
        console.log("Gemini failed or is disabled, falling back to random generation.");
        const sliceCount = spyListSize - 1;
        let otherLocations = allThemeLocationNames.filter(name => name !== game.currentLocation);
        shuffleArray(otherLocations);
        spyList = otherLocations.slice(0, sliceCount);
        spyList.push(game.currentLocation);
    }

    spyList.sort((a, b) => a.localeCompare(b, 'th'));
    game.spyLocationList = spyList;

    game.players.forEach(player => {
        const socket = io.sockets.sockets.get(player.socketId);
        if (socket) {
            const payload = {
                round: game.currentRound,
                totalRounds: game.settings.rounds,
                isHost: player.isHost,
                players: game.players,
                isSpectator: player.isSpectator,
                allLocationsData: availableLocationsForSpyList
            };

            if (player.isSpectator) {
                payload.location = game.currentLocation;
                payload.allPlayerRoles = allPlayerRoles;
                payload.role = "ผู้ชม";
                payload.allLocations = [];
            } else if (player.role) {
                const { name: roleName, description: roleDesc } = parseRole(player.role);
                const isSpy = roleName === 'สายลับ';
                
                payload.role = roleName;
                payload.roleDesc = roleDesc;
                payload.location = isSpy ? 'ไม่ทราบ' : game.currentLocation;
                payload.allLocations = isSpy ? game.spyLocationList : allThemeLocationNames;

                if (isSpy && game.bountyTarget) {
                    payload.bountyTargetName = game.bountyTarget.name;
                }
            } else {
                return;
            }
            socket.emit('gameStarted', payload);
        }
    });

    game.timeLeft = game.settings.time;
    io.to(roomCode).emit('timerUpdate', { timeLeft: game.timeLeft, players: game.players });
    game.timer = setTimeout(() => gameLoop(roomCode, games, io), 1000);
}

function endRound(roomCode, reason, games, io) {
    const game = games[roomCode];
    if (!game || game.state !== 'playing') return;
    clearTimers(game);
    game.state = 'voting';
    const voteReason = reason === 'timer_end' ? 'หมดเวลา! โหวตหาตัวสายลับ' : 'หัวหน้าห้องสั่งจบรอบ!';
    const activePlayers = game.players.filter(p => !p.disconnected && !p.isSpectator);
    const voteTime = game.settings.voteTime || 120;

    activePlayers.forEach(voter => {
        const voteOptions = activePlayers.filter(option => option.id !== voter.id);
        const socket = io.sockets.sockets.get(voter.socketId);
        if (socket) socket.emit('startVote', { players: voteOptions, reason: voteReason, voteTime });
    });
    game.voteTimer = setTimeout(() => calculateVoteResults(roomCode, games, io), voteTime * 1000);
}

function startReVote(roomCode, candidateIds, games, io) {
    const game = games[roomCode];
    if (!game) return;

    game.state = 'revoting';
    game.votes = {}; 
    game.revoteCandidates = game.players.filter(p => candidateIds.includes(p.id));

    const voteReason = "ผลโหวตเสมอ! โหวตอีกครั้งเฉพาะผู้ที่มีคะแนนสูงสุด";
    const activePlayers = game.players.filter(p => !p.disconnected && !p.isSpectator);
    const voteTime = game.settings.voteTime || 120;

    activePlayers.forEach(voter => {
        const voteOptions = game.revoteCandidates.filter(option => option.id !== voter.id);
        const socket = io.sockets.sockets.get(voter.socketId);
        if (socket) socket.emit('startVote', { players: voteOptions, reason: voteReason, voteTime });
    });
    
    game.voteTimer = setTimeout(() => calculateVoteResults(roomCode, games, io), voteTime * 1000);
}

function calculateVoteResults(roomCode, games, io) {
    const game = games[roomCode];
    if (!game || !['voting', 'revoting'].includes(game.state) || !game.spy) return;

    const spyId = game.spy.id;
    const voteCounts = {};
    
    Object.values(game.votes).forEach(votedId => { if (votedId) voteCounts[votedId] = (voteCounts[votedId] || 0) + 1; });

    let maxVotes = 0;
    let mostVotedIds = [];
    for (const playerId in voteCounts) {
        if (voteCounts[playerId] > maxVotes) {
            maxVotes = voteCounts[playerId];
            mostVotedIds = [playerId];
        } else if (voteCounts[playerId] === maxVotes) {
            mostVotedIds.push(playerId);
        }
    }

    if (mostVotedIds.length === 1 && mostVotedIds[0] === spyId) {
        const votersOfSpy = [];
        for (const socketId in game.votes) {
            if (game.votes[socketId] === spyId) {
                const voter = game.players.find(p => p.socketId === socketId);
                if (voter) { voter.score++; votersOfSpy.push(voter.name); }
            }
        }
        let resultText = `จับสายลับได้สำเร็จ!\n`;
        resultText += votersOfSpy.length > 0 ? `ผู้เล่นที่โหวตถูก: ${votersOfSpy.join(', ')} ได้รับ 1 คะแนน` : `ไม่มีใครโหวตสายลับ แต่สายลับก็ถูกเปิดโปง`;
        endGamePhase(roomCode, resultText, games, io);
    } else if (mostVotedIds.length > 1 && game.state === 'voting' && mostVotedIds.includes(spyId)) {
        startReVote(roomCode, mostVotedIds, games, io);
    } else {
        const reason = mostVotedIds.length === 0 ? "ไม่มีใครถูกโหวตเลย!" : (mostVotedIds.length > 1 ? "โหวตไม่เป็นเอกฉันท์!" : "โหวตผิดคน!");
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
        if (p.id !== game.spy.id) {
            const playerSocket = io.sockets.sockets.get(p.socketId);
            if(playerSocket) playerSocket.emit('spyIsGuessing', { spyName: game.spy.name, taunt: `${reason} ${taunt}` });
        }
    });

    game.specialTimer = setTimeout(() => {
        if(games[roomCode] && games[roomCode].state === 'spy-guessing'){
            spyGuessLocation(roomCode, game.spy.socketId, null, games, io);
        }
    }, 60 * 1000);
}

function endGamePhase(roomCode, resultText, games, io) {
    const game = games[roomCode];
    if (!game) return;
    clearTimers(game);
    game.state = 'post-round';
    io.to(roomCode).emit('roundOver', { 
        location: game.currentLocation, 
        spyName: game.spy ? game.spy.name : 'ไม่มี',
        resultText, 
        isFinalRound: game.currentRound >= game.settings.rounds, 
        players: game.players 
    });
}

function submitVote(roomCode, socketId, votedPlayerId, games, io) {
    const game = games[roomCode];
    if (!game || !['voting', 'revoting'].includes(game.state)) return;

    const player = game.players.find(p => p.socketId === socketId);
    if (player && !player.isSpectator) {
        game.votes[socketId] = votedPlayerId;
        const playersWhoCanVote = game.players.filter(p => !p.disconnected && !p.isSpectator);
        if (Object.keys(game.votes).length === playersWhoCanVote.length) {
            clearTimers(game);
            calculateVoteResults(roomCode, games, io);
        }
    }
}

function spyGuessLocation(roomCode, socketId, guessedLocation, games, io) {
    const game = games[roomCode];
    if (!game || game.state !== 'spy-guessing' || !game.spy || socketId !== game.spy.socketId) return;

    let resultText;
    if (guessedLocation === game.currentLocation) {
        game.spy.score++;
        resultText = `สายลับหนีรอด และตอบสถานที่ถูกต้อง!\nสายลับได้รับเพิ่มอีก 1 คะแนน! (รวมเป็น 2)`;
    } else {
        resultText = `สายลับหนีรอด! แต่ตอบสถานที่ผิด\nสายลับได้รับ 1 คะแนน`;
    }
    endGamePhase(roomCode, resultText, games, io);
}

function initiateBountyHunt(roomCode, games, io) {
    const game = games[roomCode];
    if (!game || !game.spy || !game.bountyTarget || game.state !== 'playing') return;

    clearTimers(game);
    game.state = 'bounty-hunting';

    const spySocket = io.sockets.sockets.get(game.spy.socketId);
    
    if (spySocket) {
        spySocket.emit('bountyHuntPhase', {
            locations: game.spyLocationList,
            targetName: game.bountyTarget.name,
            duration: 60
        });
    }

    game.players.forEach(p => {
        if (p.id !== game.spy.id) {
             const playerSocket = io.sockets.sockets.get(p.socketId);
             if (playerSocket) playerSocket.emit('waitingForBountyHunt', { spyName: game.spy.name });
        }
    });

    game.specialTimer = setTimeout(() => {
        if (games[roomCode] && games[roomCode].state === 'bounty-hunting') {
            resolveBountyHunt(roomCode, { location: null, role: null }, games, io);
        }
    }, 60 * 1000);
}

function resolveBountyHunt(roomCode, guess, games, io) {
    const game = games[roomCode];
    if (!game || game.state !== 'bounty-hunting' || !game.spy || !game.bountyTarget) return;

    clearTimers(game);

    const locationCorrect = guess.location === game.currentLocation;
    const targetRoleName = parseRole(game.bountyTarget.role).name;
    const roleCorrect = guess.role === targetRoleName;

    let score = 0;
    let resultText = "การล่าค่าหัวสิ้นสุด!\n\n";

    if (locationCorrect && roleCorrect) {
        score = 3;
        resultText += `สายลับทายถูกทั้งหมด! ได้รับ 3 คะแนน!`;
    } else if (locationCorrect || roleCorrect) {
        score = 1;
        resultText += `สายลับทายถูก 1 อย่าง! ได้รับ 1 คะแนน`;
        resultText += `\n- ทายสถานที่: ${locationCorrect ? 'ถูกต้อง' : 'ผิด'}`;
        resultText += `\n- ทายบทบาท (${game.bountyTarget.name}): ${roleCorrect ? 'ถูกต้อง' : 'ผิด'}`;
    } else {
        resultText += `สายลับทายผิดทั้งหมด! ผู้เล่นทุกคน (ยกเว้นสายลับ) ได้รับ 1 คะแนน`;
        game.players.forEach(p => {
            if (p.id !== game.spy.id && !p.isSpectator && !p.disconnected) {
                p.score++;
            }
        });
    }

    if (score > 0) {
        game.spy.score += score;
    }
    
    resultText += `\n\nบทบาทที่ถูกต้องของ ${game.bountyTarget.name} คือ "${targetRoleName}"`;

    endGamePhase(roomCode, resultText, games, io);
}

function sendGameStateToSpectator(game, player, io) {
    const socket = io.sockets.sockets.get(player.socketId);
    if (!socket) return;

    const activePlayers = game.players.filter(p => !p.disconnected && !p.isSpectator);
    const allPlayerRoles = activePlayers.map(p => {
        const { name } = parseRole(p.role);
        return { id: p.id, role: name };
    });

    socket.emit('gameStarted', {
        location: game.currentLocation,
        round: game.currentRound,
        totalRounds: game.settings.rounds,
        isHost: player.isHost,
        players: game.players,
        isSpectator: true,
        allPlayerRoles,
        allLocationsData: getAvailableLocations(game.settings.themes)
    });
}

module.exports = {
    generateRoomCode,
    startGame,
    startNewRound,
    endRound,
    submitVote,
    spyGuessLocation,
    initiateBountyHunt,
    resolveBountyHunt,
    sendGameStateToSpectator,
    clearTimers
};

