const fs = require('fs');
const path = require('path');

// --- โหลดข้อมูลสถานที่ทั้งหมดจากโฟลเดอร์ locations ---
let allLocations = [];
try {
    const locationsDir = path.join(__dirname, 'locations');
    const locationFiles = fs.readdirSync(locationsDir).filter(file => file.endsWith('.json'));

    for (const file of locationFiles) {
        const filePath = path.join(locationsDir, file);
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const locations = JSON.parse(fileContent);
        allLocations = allLocations.concat(locations);
    }
    console.log(`Loaded ${allLocations.length} locations from ${locationFiles.length} files.`);
} catch (error) {
    console.error("Could not load location files:", error);
    allLocations = [];
}
// ---------------------------------------------------------

const TAUNTS = ["ว้าย! โหวตผิดเพราะไม่สวยอะดิ", "เอิ้ก ๆ ๆ ๆ", "ชัดขนาดนี้!", "มองยังไงเนี่ย?", "ไปพักผ่อนบ้างนะ"];

// --- Helper Functions ---
function shuffleArray(array) { for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [array[i], array[j]] = [array[j], array[i]]; } }
function parseRole(roleString) {
    const match = roleString.match(/^(.*?)\s*\((.*?)\)$/);
    if (match) {
        return { name: match[1].trim(), description: match[2].trim() };
    }
    return { name: roleString, description: null };
}
function getAvailableLocations(theme) {
    if (theme === 'all') return allLocations;
    return allLocations.filter(loc => loc.category === theme);
}

// --- Exported Functions ---

function generateRoomCode(games) {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 6).toUpperCase();
    } while (games[code]);
    return code;
}

function clearTimers(game) {
    if (game.timer) clearTimeout(game.timer);
    if (game.voteTimer) clearTimeout(game.voteTimer);
    game.timer = null;
    game.voteTimer = null;
}

function startGame(roomCode, settings, games, io) {
    const game = games[roomCode];
    if (!game) return;
    if (game.players.filter(p => !p.disconnected && !p.isSpectator).length < 1) return;
    
    const { time, rounds, theme, voteTime } = settings;
    game.settings = { time: parseInt(time), rounds: parseInt(rounds), theme, voteTime: parseInt(voteTime) || 120 };
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

function startNewRound(roomCode, games, io) {
    const game = games[roomCode];
    if (!game) return;
    clearTimers(game);
    game.state = 'playing';
    game.currentRound++;
    game.votes = {};
    game.revoteCandidates = [];
    
    game.players.forEach(p => {
        if (p.isSpectator === 'waiting') {
            p.isSpectator = false;
        }
    });

    const availableLocations = getAvailableLocations(game.settings.theme);
    if (!availableLocations || availableLocations.length === 0) {
        io.to(roomCode).emit('error', 'ไม่พบสถานที่สำหรับโหมดที่เลือก');
        return;
    }

    let locationPool = availableLocations.filter(loc => !game.usedLocations.includes(loc.name));
    if (locationPool.length === 0) {
        game.usedLocations = [];
        locationPool = availableLocations;
    }
    
    const location = locationPool[Math.floor(Math.random() * locationPool.length)];
    game.usedLocations.push(location.name);
    game.currentLocation = location.name;
    
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

    const allPlayerRoles = activePlayers.map(p => {
        const { name, description } = parseRole(p.role);
        return { id: p.id, role: name, description: description };
    });
    const allThemeLocationNames = availableLocations.map(l => l.name);

    game.players.forEach(player => {
        const socket = io.sockets.sockets.get(player.socketId);
        if (socket) {
            if (player.isSpectator) {
                socket.emit('gameStarted', {
                    location: game.currentLocation,
                    round: game.currentRound,
                    totalRounds: game.settings.rounds,
                    isHost: player.isHost,
                    players: game.players,
                    isSpectator: true,
                    allPlayerRoles
                });
            } else {
                let locationsForPlayer = allThemeLocationNames;
                if (parseRole(player.role).name === 'สายลับ') {
                    let shuffledLocations = [...allThemeLocationNames];
                    shuffleArray(shuffledLocations);
                    locationsForPlayer = shuffledLocations.slice(0, 20);
                }
                const { name: roleName, description: roleDesc } = parseRole(player.role);
                socket.emit('gameStarted', {
                    location: roleName === 'สายลับ' ? 'ไม่ทราบ' : game.currentLocation,
                    role: roleName,
                    roleDesc: roleDesc,
                    round: game.currentRound,
                    totalRounds: game.settings.rounds,
                    isHost: player.isHost,
                    players: game.players,
                    isSpectator: false,
                    allLocations: locationsForPlayer
                });
            }
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
        if (socket) {
            socket.emit('startVote', { players: voteOptions, reason: voteReason, voteTime });
        }
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
        if (socket) {
            socket.emit('startVote', { players: voteOptions, reason: voteReason, voteTime });
        }
    });
    
    game.voteTimer = setTimeout(() => calculateVoteResults(roomCode, games, io), voteTime * 1000);
}

function calculateVoteResults(roomCode, games, io) {
    const game = games[roomCode];
    if (!game || !['voting', 'revoting'].includes(game.state) || !game.spy) return;

    const spyId = game.spy.id;
    const voteCounts = {};
    
    Object.values(game.votes).forEach(votedId => {
        if (votedId) {
            voteCounts[votedId] = (voteCounts[votedId] || 0) + 1;
        }
    });

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

    if (mostVotedIds.length === 1) {
        const votedPlayerId = mostVotedIds[0];
        if (votedPlayerId === spyId) {
            const votersOfSpy = [];
            for (const socketId in game.votes) {
                if (game.votes[socketId] === spyId) {
                    const voter = game.players.find(p => p.socketId === socketId);
                    if (voter) {
                        voter.score++;
                        votersOfSpy.push(voter.name);
                    }
                }
            }
            let resultText = `จับสายลับได้สำเร็จ!\n`;
            if (votersOfSpy.length > 0) {
                resultText += `ผู้เล่นที่โหวตถูก: ${votersOfSpy.join(', ')} ได้รับ 1 คะแนน`;
            } else {
                resultText += `ไม่มีใครโหวตสายลับ แต่สายลับก็ถูกเปิดโปง`;
            }
            endGamePhase(roomCode, resultText, games, io);
        } else {
            spyEscapes(roomCode, "โหวตผิดคน!", games, io);
        }
    } else if (mostVotedIds.length > 1) {
        const spyIsInTie = mostVotedIds.includes(spyId);
        if (game.state === 'voting' && spyIsInTie) {
            startReVote(roomCode, mostVotedIds, games, io);
        } else {
            spyEscapes(roomCode, "โหวตไม่เป็นเอกฉันท์!", games, io);
        }
    } else {
        spyEscapes(roomCode, "ไม่มีใครถูกโหวตเลย!", games, io);
    }
}

function spyEscapes(roomCode, reason, games, io) {
    const game = games[roomCode];
    if (!game || !game.spy) return;
    game.spy.score++;
    game.state = 'spy-guessing';
    const taunt = TAUNTS[Math.floor(Math.random() * TAUNTS.length)];
    const allLocNames = getAvailableLocations(game.settings.theme).map(l => l.name);
    shuffleArray(allLocNames);
    const spyLocations = allLocNames.slice(0, 20); 
    const spySocket = io.sockets.sockets.get(game.spy.socketId);
    if (spySocket) {
        spySocket.emit('spyGuessPhase', { locations: spyLocations, taunt: `${reason} ${taunt}` });
    }
    game.players.forEach(p => {
        if (p.id !== game.spy.id) {
            const playerSocket = io.sockets.sockets.get(p.socketId);
            if (playerSocket) {
                playerSocket.emit('spyIsGuessing', { spyName: game.spy.name, taunt: `${reason} ${taunt}` });
            }
        }
    });
}

function endGamePhase(roomCode, resultText, games, io) {
    const game = games[roomCode];
    if (!game) return;
    clearTimers(game);
    game.state = 'post-round';
    io.to(roomCode).emit('roundOver', { location: game.currentLocation, spyName: game.spy ? parseRole(game.spy.role).name : 'ไม่มี', resultText, isFinalRound: game.currentRound >= game.settings.rounds, players: game.players });
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
    if (!game || game.state !== 'spy-guessing' || socketId !== game.spy.socketId) return;

    let resultText;
    if (guessedLocation === game.currentLocation) {
        game.spy.score++;
        resultText = `สายลับหนีรอด และตอบสถานที่ถูกต้อง!\nสายลับได้รับเพิ่มอีก 1 คะแนน! (รวมเป็น 2)`;
    } else {
        resultText = `สายลับหนีรอด! แต่ตอบสถานที่ผิด\nสายลับได้รับ 1 คะแนน`;
    }
    endGamePhase(roomCode, resultText, games, io);
}


module.exports = {
    generateRoomCode,
    startGame,
    startNewRound,
    endRound,
    submitVote,
    spyGuessLocation,
    clearTimers
};
