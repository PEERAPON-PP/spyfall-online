// --- DOM Elements ---
const $ = (id) => document.getElementById(id);
const screens = { home: $('home-screen'), lobby: $('lobby-screen'), game: $('game-screen') };
const modals = { locations: $('locations-modal'), voting: $('voting-modal'), spyGuess: $('spy-guess-modal'), waitingForSpy: $('waiting-for-spy-modal'), endRound: $('end-round-modal'), rejoinAs: $('rejoin-as-modal') };
const playerNameInput = $('player-name-input'), nameError = $('name-error'), createRoomBtn = $('create-room-btn'), roomCodeInput = $('room-code-input'), joinRoomBtn = $('join-room-btn');
const lobbyRoomCode = $('lobby-room-code'), copyCodeBtn = $('copy-code-btn'), playerList = $('player-list'), startGameBtn = $('start-game-btn'), gameSettings = $('game-settings'), timerSelect = $('timer-select'), roundsSelect = $('rounds-select'), themeSelect = $('theme-select'), lobbyMessage = $('lobby-message'), voteTimerSelect = $('vote-timer-select');
const timerDisplay = $('timer'), locationDisplay = $('location-display'), roleDisplay = $('role-display'), ingameActions = $('ingame-actions'), showLocationsBtn = $('show-locations-btn'), currentRoundSpan = $('current-round'), totalRoundsSpan = $('total-rounds'), inGameScoreboard = $('in-game-scoreboard'), hostEndRoundBtn = $('host-end-round-btn'), roleLabel = $('role-label'), gameHeader = $('game-header');
const locationsList = $('locations-list'), closeLocationsBtn = $('close-locations-btn'), voteReason = $('vote-reason'), voteTimerDisplay = $('vote-timer'), votePlayerButtons = $('vote-player-buttons'), abstainVoteBtn = $('abstain-vote-btn');
const spyLocationGuess = $('spy-location-guess'), confirmSpyGuessBtn = $('confirm-spy-guess-btn'), waitingSpyName = $('waiting-spy-name'), spyGuessTaunt = $('spy-guess-taunt'), waitingTaunt = $('waiting-taunt');
const endModalTitle = $('end-modal-title'), endLocation = $('end-location'), endSpy = $('end-spy'), roundResultText = $('round-result-text'), nextRoundBtn = $('next-round-btn'), backToLobbyBtn = $('back-to-lobby-btn');
const rejoinAsModal = $('rejoin-as-modal'), rejoinPlayerList = $('rejoin-player-list'), joinAsSpectatorBtn = $('join-as-spectator-btn');

let isHost = false, voteTimerInterval = null, playerToken = null;
const socket = io();

// --- Utility Functions ---
function showScreen(screenName) { Object.values(screens).forEach(s => s.classList.add('hidden')); screens[screenName].classList.remove('hidden'); }
function showModal(modalName) { Object.values(modals).forEach(m => m.classList.add('hidden')); if(modalName) modals[modalName].classList.remove('hidden'); }

function updateScoreboard(players, container, allPlayerRoles = null) {
    container.innerHTML = '';

    const self = players.find(p => p.socketId === socket.id);
    const currentClientIsHost = self ? self.isHost : false;
    
    const activePlayers = players.filter(p => !p.isSpectator).sort((a, b) => b.score - a.score);
    const spectators = players.filter(p => p.isSpectator).sort((a, b) => b.score - a.score);

    const createPlayerRow = (player) => {
        const playerDiv = document.createElement('div');
        playerDiv.className = 'flex justify-between items-center bg-gray-100 p-2 rounded';
        
        if (player.disconnected) playerDiv.classList.add('player-disconnected');

        if (self && player.id === self.id) {
            playerDiv.classList.remove('bg-gray-100');
            playerDiv.classList.add('bg-indigo-100', 'border', 'border-indigo-300');
        }

        const leftDiv = document.createElement('div');
        leftDiv.className = 'flex-grow flex items-center space-x-2';

        const nameSpan = document.createElement('span');
        const prefix = player.isHost ? '👑 ' : (player.isSpectator ? '👁️ ' : '');
        let statusText = '';
        if (container === playerList && self && player.id === self.id && self.isSpectator === 'waiting') {
            statusText = ' (รอเล่นรอบถัดไป)';
        }
        nameSpan.innerHTML = `${prefix}${player.name}<span class="text-gray-500">${statusText}</span>`;
        leftDiv.appendChild(nameSpan);

        if (allPlayerRoles) {
            const roleSpan = document.createElement('span');
            roleSpan.className = 'text-sm';
            const playerRole = allPlayerRoles.find(r => r.id === player.id)?.role;
            if (playerRole) {
               roleSpan.innerHTML = `- <span class="font-semibold text-indigo-600">${playerRole}</span>`;
               leftDiv.appendChild(roleSpan);
            }
        }

        const rightDiv = document.createElement('div');
        rightDiv.className = 'flex items-center space-x-2';

        const scoreSpan = document.createElement('span');
        scoreSpan.className = 'font-semibold';
        scoreSpan.textContent = `${player.score} คะแนน`;
        rightDiv.appendChild(scoreSpan);
        
        if (container === playerList) {
            if (self && player.id === self.id && !player.isHost) {
                const toggleBtn = document.createElement('button');
                toggleBtn.textContent = player.isSpectator ? 'สลับเป็นผู้เล่น' : 'สลับเป็นผู้ชม';
                toggleBtn.className = 'btn btn-secondary btn-sm';
                toggleBtn.onclick = () => socket.emit('toggleSpectatorMode');
                rightDiv.appendChild(toggleBtn);
            }
            if (currentClientIsHost && self && player.id !== self.id) {
                 const kickButton = document.createElement('button');
                 kickButton.textContent = 'เตะ';
                 kickButton.className = 'btn bg-red-500 hover:bg-red-600 text-white btn-sm';
                 kickButton.onclick = () => socket.emit('kickPlayer', player.id);
                 rightDiv.appendChild(kickButton);
            }
        }
        
        playerDiv.appendChild(leftDiv);
        playerDiv.appendChild(rightDiv);
        return playerDiv;
    };
    
    if(activePlayers.length > 0){
        if(container === playerList){
            const p_divider = document.createElement('div');
            p_divider.className = 'text-center text-gray-500 text-sm py-1 font-semibold';
            p_divider.textContent = '--- ผู้เล่น ---';
            container.appendChild(p_divider);
        }
        activePlayers.forEach(player => container.appendChild(createPlayerRow(player)));
    }


    if (spectators.length > 0 && container === playerList) {
        const s_divider = document.createElement('div');
        s_divider.className = 'text-center text-gray-500 text-sm py-1 font-semibold';
        s_divider.textContent = '--- ผู้ชม ---';
        container.appendChild(s_divider);
        spectators.forEach(player => container.appendChild(createPlayerRow(player)));
    }
}
function generateToken() { return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)); }

function submitVote(playerId) {
    socket.emit('submitVote', playerId);
    votePlayerButtons.querySelectorAll('button').forEach(btn => btn.disabled = true);
    abstainVoteBtn.disabled = true;
    // Timer will now continue to run based on server time
}

function setGameTheme(role) {
    screens.game.classList.remove('theme-spy', 'theme-player');
    if (role === 'สายลับ') {
        screens.game.classList.add('theme-spy');
    } else {
        screens.game.classList.add('theme-player');
    }
}

// --- Event Listeners ---
function handleSettingChange(event) {
    if (isHost) {
        const setting = event.target.dataset.setting;
        const value = event.target.value;
        socket.emit('settingChanged', { setting, value });
    }
}
timerSelect.addEventListener('change', handleSettingChange);
roundsSelect.addEventListener('change', handleSettingChange);
voteTimerSelect.addEventListener('change', handleSettingChange);
themeSelect.addEventListener('change', handleSettingChange);

createRoomBtn.addEventListener('click', () => {
    const n = playerNameInput.value.trim();
    if (!n) { nameError.classList.remove('hidden'); return; }
    nameError.classList.add('hidden');
    if (!playerToken) { playerToken = generateToken(); localStorage.setItem('playerToken', playerToken); }
    socket.emit('createRoom', { playerName: n, playerToken });
});

joinRoomBtn.addEventListener('click', () => {
    const n = playerNameInput.value.trim();
    const c = roomCodeInput.value.trim().toUpperCase();
    if (!n) { nameError.classList.remove('hidden'); return; }
    nameError.classList.add('hidden');
    if (!c) return;
    if (!playerToken) { playerToken = generateToken(); localStorage.setItem('playerToken', playerToken); }
    socket.emit('joinRoom', { playerName: n, roomCode: c, playerToken });
});

joinAsSpectatorBtn.addEventListener('click', () => {
    const n = playerNameInput.value.trim();
    const c = roomCodeInput.value.trim().toUpperCase();
    if (!n || !c) return;
    if (!playerToken) { playerToken = generateToken(); localStorage.setItem('playerToken', playerToken); }
    socket.emit('joinAsSpectator', { roomCode: c, playerName: n, playerToken });
    showModal(null);
});

copyCodeBtn.addEventListener('click', () => { navigator.clipboard.writeText(lobbyRoomCode.textContent).then(() => { copyCodeBtn.textContent = 'คัดลอกแล้ว!'; setTimeout(() => copyCodeBtn.textContent = 'คัดลอก', 2000); }); });
startGameBtn.addEventListener('click', () => socket.emit('startGame', { time: timerSelect.value, rounds: roundsSelect.value, theme: themeSelect.value, voteTime: voteTimerSelect.value }));
hostEndRoundBtn.addEventListener('click', () => socket.emit('hostEndRound'));
abstainVoteBtn.addEventListener('click', () => submitVote(null));
nextRoundBtn.addEventListener('click', () => { socket.emit('requestNextRound'); showModal(null); });
backToLobbyBtn.addEventListener('click', () => socket.emit('resetGame'));
showLocationsBtn.addEventListener('click', () => showModal('locations'));
closeLocationsBtn.addEventListener('click', () => showModal(null));
confirmSpyGuessBtn.addEventListener('click', () => { socket.emit('spyGuessLocation', spyLocationGuess.value); showModal(null); });

// --- Socket.IO Handlers ---
socket.on('connect', () => {
    playerToken = localStorage.getItem('playerToken');
    if (!playerToken) {
        playerToken = generateToken();
        localStorage.setItem('playerToken', playerToken);
    }
});

socket.on('roomCreated', d => { showScreen('lobby'); lobbyRoomCode.textContent = d.roomCode; localStorage.setItem('lastRoomCode', d.roomCode); });
socket.on('joinSuccess', d => { showScreen('lobby'); lobbyRoomCode.textContent = d.roomCode; localStorage.setItem('lastRoomCode', d.roomCode); });

socket.on('rejoinSuccess', ({ game, roomCode, self }) => {
    socket.playerData = self;
    lobbyRoomCode.textContent = roomCode;
    localStorage.setItem('lastRoomCode', roomCode);
    showScreen(game.state === 'lobby' ? 'lobby' : 'game');
    if (game.state !== 'lobby') {
        setGameTheme(self.role);
    }
});
socket.on('error', m => alert(m));

socket.on('updatePlayerList', ({players, settings}) => {
    const self = players.find(p => p.socketId === socket.id);
    const currentClientIsHost = self ? self.isHost : false;
    
    isHost = currentClientIsHost;
    if (self) socket.playerData = self;

    updateScoreboard(players, playerList);
    
    if (settings) {
        timerSelect.value = settings.time;
        roundsSelect.value = settings.rounds;
        voteTimerSelect.value = settings.voteTime;
        themeSelect.value = settings.theme;
    }

    gameSettings.classList.remove('hidden');
    const settingInputs = gameSettings.querySelectorAll('select');
    settingInputs.forEach(input => input.disabled = !currentClientIsHost);
    
    if (currentClientIsHost) {
        const activePlayers = players.filter(p => !p.disconnected && !p.isSpectator).length;
        const canStart = activePlayers >= 1;
        startGameBtn.classList.remove('hidden');
        startGameBtn.disabled = !canStart;
        lobbyMessage.textContent = 'คุณคือหัวหน้าห้อง กดเริ่มเกมได้เลย!';
    } else {
        startGameBtn.classList.add('hidden');
        if (self && self.isSpectator) {
             lobbyMessage.textContent = 'คุณอยู่ในโหมดผู้ชม รอหัวหน้าห้องเริ่มเกม';
        } else {
            lobbyMessage.textContent = 'กำลังรอหัวหน้าห้องเริ่มเกม...';
        }
    }
});

socket.on('settingsUpdated', (settings) => {
     if (settings && !isHost) {
        timerSelect.value = settings.time;
        roundsSelect.value = settings.rounds;
        voteTimerSelect.value = settings.voteTime;
        themeSelect.value = settings.theme;
    }
});

socket.on('promptRejoinOrSpectate', ({ disconnectedPlayers, roomCode }) => {
    rejoinPlayerList.innerHTML = '';
    if (disconnectedPlayers.length > 0) {
        disconnectedPlayers.forEach(player => {
            const button = document.createElement('button');
            button.textContent = `เข้าร่วมในชื่อ: ${player.name}`;
            button.className = 'btn btn-primary w-full mb-2';
            button.onclick = () => {
                if (!playerToken) {
                     playerToken = generateToken();
                     localStorage.setItem('playerToken', playerToken);
                }
                socket.emit('rejoinAsPlayer', { roomCode, playerId: player.id, playerToken });
                showModal(null);
            };
            rejoinPlayerList.appendChild(button);
        });
    } else {
        rejoinPlayerList.innerHTML = '<p class="text-center text-gray-500">ไม่พบผู้เล่นที่หลุดการเชื่อมต่อ</p>';
    }
    showModal('rejoinAs');
});

socket.on('joinSuccessAsSpectator', ({ roomCode }) => {
    showScreen('lobby');
    lobbyRoomCode.textContent = roomCode;
    localStorage.setItem('lastRoomCode', roomCode);
});

socket.on('gameStarted', (data) => {
    showScreen('game');
    showModal(null);
    
    const self = data.players.find(p => p.socketId === socket.id);
    const currentClientIsHost = self ? self.isHost : false;
    isHost = currentClientIsHost;
    
    currentRoundSpan.textContent = data.round;
    totalRoundsSpan.textContent = data.totalRounds;
    hostEndRoundBtn.classList.toggle('hidden', !currentClientIsHost || (self && self.isSpectator));
    setGameTheme(data.role); // Set theme based on role

    if (self && self.isSpectator) {
        locationDisplay.textContent = data.location;
        roleLabel.textContent = "สถานะ:"
        roleDisplay.textContent = "คุณเป็นผู้ชม";
        ingameActions.classList.add('hidden');
        updateScoreboard(data.players, inGameScoreboard, data.allPlayerRoles);
    } else {
        locationDisplay.textContent = data.location;
        roleLabel.textContent = "บทบาท:"
        roleDisplay.textContent = data.role;
        ingameActions.classList.remove('hidden');
        updateScoreboard(data.players, inGameScoreboard);
        if (data.allLocations) {
            locationsList.innerHTML = '';
            data.allLocations.forEach(loc => {
                const div = document.createElement('div');
                div.textContent = loc;
                div.className = 'p-2 bg-gray-100 rounded location-item font-bold';
                div.onclick = () => div.classList.toggle('eliminated');
                locationsList.appendChild(div);
            });
        }
    }
});

socket.on('timerUpdate', ({ timeLeft, players }) => {
    timerDisplay.textContent = `${String(Math.floor(timeLeft/60)).padStart(2,'0')}:${String(timeLeft%60).padStart(2,'0')}`;
    if (screens.game.offsetParent !== null) {
        const self = players.find(p => p.socketId === socket.id);
        if (self && self.isSpectator) {
            // Spectator role updates would require sending allPlayerRoles with timerUpdate.
            // For now, it just updates scores.
        }
        updateScoreboard(players, inGameScoreboard);
    }
});

socket.on('startVote', ({ players, reason, voteTime }) => {
    showModal('voting');
    voteReason.textContent = reason;
    votePlayerButtons.innerHTML = '';
    
    players.forEach(player => {
        const button = document.createElement('button');
        button.textContent = player.name;
        button.className = 'btn btn-primary vote-btn w-full mb-2';
        button.onclick = () => submitVote(player.id);
        votePlayerButtons.appendChild(button);
    });

    abstainVoteBtn.disabled = false;

    let voteTimeLeft = voteTime || 120;
    if (voteTimerInterval) clearInterval(voteTimerInterval);
    voteTimerDisplay.textContent = voteTimeLeft;
    voteTimerInterval = setInterval(() => {
        voteTimeLeft--;
        if (voteTimeLeft >= 0) {
            voteTimerDisplay.textContent = voteTimeLeft;
        } else {
            clearInterval(voteTimerInterval);
        }
    }, 1000);
});

socket.on('spyGuessPhase', ({ locations, taunt }) => {
    spyLocationGuess.innerHTML = '';
    locations.forEach(loc => { const o = document.createElement('option'); o.value = loc; o.textContent = loc; spyLocationGuess.appendChild(o); });
    spyGuessTaunt.textContent = taunt || "";
    showModal('spyGuess');
});

socket.on('spyIsGuessing', ({ spyName, taunt }) => {
    waitingSpyName.textContent = spyName;
    waitingTaunt.textContent = taunt || "";
    showModal('waitingForSpy');
});

socket.on('roundOver', ({ location, spyName, resultText, isFinalRound, players }) => {
    showModal('endRound'); endLocation.textContent = location; endSpy.textContent = spyName;
    let resultMessage = resultText;

    const self = players.find(p => p.socketId === socket.id);
    const currentClientIsHost = self ? self.isHost : false;
    
    if (isFinalRound) {
        endModalTitle.textContent = "จบเกม!";
        const winner = [...players].filter(p=>!p.isSpectator).sort((a,b) => b.score - a.score)[0];
        if(winner){
            resultMessage += `\n\n🏆 ผู้ชนะคือ ${winner.name} ด้วยคะแนน ${winner.score} คะแนน!`;
        } else {
            resultMessage += `\n\nจบเกมแล้ว!`;
        }
        nextRoundBtn.classList.add('hidden');
        backToLobbyBtn.classList.toggle('hidden', !currentClientIsHost);
        localStorage.removeItem('lastRoomCode');
    } else {
        endModalTitle.textContent = "จบรอบ";
        nextRoundBtn.classList.toggle('hidden', !currentClientIsHost || (self && self.isSpectator));
        backToLobbyBtn.classList.add('hidden');
    }
    roundResultText.textContent = resultMessage;
    updateScoreboard(players, playerList);
});

socket.on('returnToLobby', () => { showScreen('lobby'); showModal(null); localStorage.removeItem('lastRoomCode'); });
socket.on('kicked', () => { alert('คุณถูกเตะออกจากห้อง'); localStorage.removeItem('lastRoomCode'); window.location.reload(); });
socket.on('playerDisconnected', name => { lobbyMessage.textContent = `${name} หลุดออกจากเกม...`; });
socket.on('playerReconnected', name => { lobbyMessage.textContent = `${name} กลับเข้าสู่เกม!`; });
socket.on('newHost', name => { lobbyMessage.textContent = `${name} ได้เป็นหัวหน้าห้องคนใหม่`; });
