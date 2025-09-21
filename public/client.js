// --- DOM Elements ---
const $ = (id) => document.getElementById(id);
const screens = { home: $('home-screen'), lobby: $('lobby-screen'), game: $('game-screen') };
const modals = { locations: $('locations-modal'), voting: $('voting-modal'), spyGuess: $('spy-guess-modal'), waitingForSpy: $('waiting-for-spy-modal'), endRound: $('end-round-modal'), bountyHunt: $('bounty-hunt-modal'), waitingForBounty: $('waiting-for-bounty-modal') };
const playerNameInput = $('player-name-input'), nameError = $('name-error'), createRoomBtn = $('create-room-btn'), roomCodeInput = $('room-code-input'), joinRoomBtn = $('join-room-btn');
const lobbyRoomCode = $('lobby-room-code'), copyCodeBtn = $('copy-code-btn'), playerList = $('player-list'), startGameBtn = $('start-game-btn'), gameSettings = $('game-settings'), timerSelect = $('timer-select'), roundsSelect = $('rounds-select'), themeCheckboxes = $('theme-checkboxes'), lobbyMessage = $('lobby-message'), voteTimerSelect = $('vote-timer-select'), bountyHuntCheckbox = $('bounty-hunt-checkbox');
const timerDisplay = $('timer'), locationDisplay = $('location-display'), roleDisplay = $('role-display'), roleDescDisplay = $('role-desc-display'), ingameActions = $('ingame-actions'), showLocationsBtn = $('show-locations-btn'), currentRoundSpan = $('current-round'), totalRoundsSpan = $('total-rounds'), inGameScoreboard = $('in-game-scoreboard'), hostEndRoundBtn = $('host-end-round-btn'), roleLabel = $('role-label'), gameHeader = $('game-header'), gameRoomCode = $('game-room-code');
const locationsList = $('locations-list'), closeLocationsBtn = $('close-locations-btn'), voteReason = $('vote-reason'), voteTimerDisplay = $('vote-timer'), votePlayerButtons = $('vote-player-buttons'), abstainVoteBtn = $('abstain-vote-btn');
const spyLocationGuess = $('spy-location-guess'), confirmSpyGuessBtn = $('confirm-spy-guess-btn'), waitingSpyName = $('waiting-spy-name'), spyGuessTaunt = $('spy-guess-taunt'), spyGuessTimer = $('spy-guess-timer');
const endModalTitle = $('end-modal-title'), endLocation = $('end-location'), endSpy = $('end-spy'), roundResultText = $('round-result-text'), nextRoundBtn = $('next-round-btn'), backToLobbyBtn = $('back-to-lobby-btn');
const bountyHuntBtn = $('bounty-hunt-btn'), spyTargetDisplay = $('spy-target-display'), spyTargetName = $('spy-target-name');
const bountyHuntTimer = $('bounty-hunt-timer'), bountyLocationGuess = $('bounty-location-guess'), bountyRoleGuess = $('bounty-role-guess'), bountyTargetName = $('bounty-target-name'), confirmBountyGuessBtn = $('confirm-bounty-guess-btn'), waitingBountySpyName = $('waiting-bounty-spy-name');

let isHost = false, voteTimerInterval = null, playerToken = null, specialTimerInterval = null;
let currentRoundLocationsData = []; // Store full location data for the round
let currentRoundRoles = null; // Store roles for spectator view
const socket = io();

// --- Utility Functions ---
function showScreen(screenName) { Object.values(screens).forEach(s => s.classList.add('hidden')); screens[screenName].classList.remove('hidden'); }
function showModal(modalName) { 
    if(specialTimerInterval) clearInterval(specialTimerInterval);
    if(voteTimerInterval) clearInterval(voteTimerInterval);
    Object.values(modals).forEach(m => m.classList.add('hidden')); 
    if(modalName) modals[modalName].classList.remove('hidden'); 
}

function updateScoreboard(players, container, allPlayerRoles = null) {
    container.innerHTML = '';
    const self = players.find(p => p.socketId === socket.id);
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
        
        // --- NEW ICON LOGIC ---
        let prefix = '';
        if (player.isHost) {
            prefix = '👑 ';
        } else if (player.isSpectator) {
            prefix = '🔎 ';
        } else {
            prefix = '🎮 ';
        }
        
        let statusText = '';
        if (container === playerList && player.isSpectator === 'waiting') {
            statusText = ' (รอเล่นรอบถัดไป)';
        }
        nameSpan.innerHTML = `${prefix}${player.name}<span class="text-gray-500">${statusText}</span>`;
        leftDiv.appendChild(nameSpan);

        if (allPlayerRoles) {
            const roleSpan = document.createElement('span');
            roleSpan.className = 'text-sm';
            const playerRoleData = allPlayerRoles.find(r => r.id === player.id);
            if (playerRoleData && playerRoleData.role !== 'สายลับ') { // Don't reveal spy role unless it's the end of round scoreboard
               roleSpan.innerHTML = `- <span class="font-semibold text-indigo-600">${playerRoleData.role}</span>`;
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
            if (self && self.isHost && player.id !== self.id) {
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
}
function setGameTheme(role) {
    screens.game.classList.remove('theme-spy', 'theme-player');
    if (role === 'สายลับ') screens.game.classList.add('theme-spy');
    else screens.game.classList.add('theme-player');
}

// --- Event Listeners ---
function handleSettingChange(event) {
    if (isHost) {
        const setting = event.target.dataset.setting;
        const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
        socket.emit('settingChanged', { setting, value });
    }
}
function handleThemeChange() {
    if(isHost) {
        const selectedThemes = Array.from(themeCheckboxes.querySelectorAll('input:checked')).map(cb => cb.dataset.theme);
        socket.emit('settingChanged', { setting: 'themes', value: selectedThemes });
    }
}
timerSelect.addEventListener('change', handleSettingChange);
roundsSelect.addEventListener('change', handleSettingChange);
voteTimerSelect.addEventListener('change', handleSettingChange);
themeCheckboxes.addEventListener('change', handleThemeChange);
bountyHuntCheckbox.addEventListener('change', handleSettingChange);

createRoomBtn.addEventListener('click', () => {
    const n = playerNameInput.value.trim();
    if (!n) { nameError.classList.remove('hidden'); return; }
    nameError.classList.add('hidden');
    if (!playerToken) { playerToken = generateToken(); localStorage.setItem('playerToken', playerToken); }
    localStorage.setItem('playerName', n); // Save player name
    socket.emit('createRoom', { playerName: n, playerToken });
});
joinRoomBtn.addEventListener('click', () => {
    const n = playerNameInput.value.trim();
    const c = roomCodeInput.value.trim().toUpperCase();
    if (!n) { nameError.classList.remove('hidden'); return; }
    nameError.classList.add('hidden');
    if (!c) return;
    if (!playerToken) { playerToken = generateToken(); localStorage.setItem('playerToken', playerToken); }
    localStorage.setItem('playerName', n); // Save player name
    socket.emit('joinRoom', { playerName: n, roomCode: c, playerToken });
});
copyCodeBtn.addEventListener('click', () => { navigator.clipboard.writeText(lobbyRoomCode.textContent).then(() => { copyCodeBtn.textContent = 'คัดลอกแล้ว!'; setTimeout(() => copyCodeBtn.textContent = 'คัดลอก', 2000); }); });
startGameBtn.addEventListener('click', () => {
    const selectedThemes = Array.from(themeCheckboxes.querySelectorAll('input:checked')).map(cb => cb.dataset.theme);
    if(selectedThemes.length === 0){
        alert("กรุณาเลือกโหมดอย่างน้อย 1 โหมด");
        return;
    }
    socket.emit('startGame', { time: timerSelect.value, rounds: roundsSelect.value, themes: selectedThemes, voteTime: voteTimerSelect.value, bountyHuntEnabled: bountyHuntCheckbox.checked });
});
hostEndRoundBtn.addEventListener('click', () => socket.emit('hostEndRound'));
abstainVoteBtn.addEventListener('click', () => submitVote(null));
nextRoundBtn.addEventListener('click', () => { socket.emit('requestNextRound'); showModal(null); });
backToLobbyBtn.addEventListener('click', () => socket.emit('resetGame'));
showLocationsBtn.addEventListener('click', () => showModal('locations'));
closeLocationsBtn.addEventListener('click', () => showModal(null));
confirmSpyGuessBtn.addEventListener('click', () => { socket.emit('spyGuessLocation', spyLocationGuess.value); showModal(null); });
bountyHuntBtn.addEventListener('click', () => socket.emit('spyDeclareBounty'));
confirmBountyGuessBtn.addEventListener('click', () => {
    const guess = { location: bountyLocationGuess.value, role: bountyRoleGuess.value };
    socket.emit('submitBountyGuess', guess);
    showModal(null);
});
bountyLocationGuess.addEventListener('change', () => {
    const selectedLocation = bountyLocationGuess.value;
    bountyRoleGuess.innerHTML = '<option value="">เลือกบทบาท...</option>';
    if (!selectedLocation || !currentRoundLocationsData) {
        bountyRoleGuess.disabled = true;
        return;
    }
    const locationData = currentRoundLocationsData.find(loc => loc.name === selectedLocation);
    if (locationData) {
        locationData.roles.forEach(roleString => {
            const roleName = roleString.split('(')[0].trim();
            if (roleName !== 'สายลับ') {
                const option = document.createElement('option');
                option.value = roleName;
                option.textContent = roleName;
                bountyRoleGuess.appendChild(option);
            }
        });
        bountyRoleGuess.disabled = false;
    }
});
// Auto-fill player name from localStorage
window.addEventListener('DOMContentLoaded', () => {
    const savedName = localStorage.getItem('playerName');
    if (savedName) {
        playerNameInput.value = savedName;
    }
});


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

socket.on('error', m => alert(m));

socket.on('updatePlayerList', ({players, settings}) => {
    const self = players.find(p => p.socketId === socket.id);
    isHost = self ? self.isHost : false;

    updateScoreboard(players, playerList);
    if (settings) {
        timerSelect.value = settings.time;
        roundsSelect.value = settings.rounds;
        voteTimerSelect.value = settings.voteTime;
        bountyHuntCheckbox.checked = settings.bountyHuntEnabled;
        const allThemeCheckboxes = themeCheckboxes.querySelectorAll('input[type="checkbox"]');
        allThemeCheckboxes.forEach(cb => { cb.checked = settings.themes && settings.themes.includes(cb.dataset.theme); });
    }
    gameSettings.classList.remove('hidden');
    const settingInputs = gameSettings.querySelectorAll('select, input[type="checkbox"]');
    settingInputs.forEach(input => input.disabled = !isHost);
    
    const activePlayers = players.filter(p => !p.disconnected && !p.isSpectator).length;
    startGameBtn.disabled = activePlayers < 3; // Minimum 3 players to start

    if (isHost) {
        startGameBtn.classList.remove('hidden');
        lobbyMessage.textContent = activePlayers < 3 ? 'ต้องมีผู้เล่นอย่างน้อย 3 คน' : 'คุณคือหัวหน้าห้อง กดเริ่มเกมได้เลย!';
    } else {
        startGameBtn.classList.add('hidden');
        if (self && self.isSpectator) lobbyMessage.textContent = 'คุณอยู่ในโหมดผู้ชม รอหัวหน้าห้องเริ่มเกม';
        else lobbyMessage.textContent = 'กำลังรอหัวหน้าห้องเริ่มเกม...';
    }
});
socket.on('settingsUpdated', (settings) => {
     if (settings && !isHost) {
        timerSelect.value = settings.time;
        roundsSelect.value = settings.rounds;
        voteTimerSelect.value = settings.voteTime;
        bountyHuntCheckbox.checked = settings.bountyHuntEnabled;
        const allThemeCheckboxes = themeCheckboxes.querySelectorAll('input[type="checkbox"]');
        allThemeCheckboxes.forEach(cb => { cb.checked = settings.themes && settings.themes.includes(cb.dataset.theme); });
    }
});

socket.on('gameStarted', (data) => {
    showScreen('game');
    showModal(null);
    currentRoundLocationsData = data.allLocationsData || [];
    currentRoundRoles = data.allPlayerRoles || null; // Store roles for spectator
    
    const self = data.players.find(p => p.socketId === socket.id);
    isHost = self ? self.isHost : false;
    
    currentRoundSpan.textContent = data.round;
    totalRoundsSpan.textContent = data.totalRounds;
    gameRoomCode.textContent = lobbyRoomCode.textContent; 
    hostEndRoundBtn.classList.toggle('hidden', !isHost || (self && self.isSpectator));
    setGameTheme(data.role);

    roleDescDisplay.classList.add('hidden');
    spyTargetDisplay.classList.add('hidden');
    bountyHuntBtn.classList.add('hidden');
    
    locationDisplay.textContent = data.location;
    roleDisplay.textContent = data.role;
    
    // Always show the locations button for non-spectators
    ingameActions.classList.toggle('hidden', !!(self && self.isSpectator));

    if (self && self.isSpectator) {
        roleLabel.textContent = "สถานะ:"
        updateScoreboard(data.players, inGameScoreboard, currentRoundRoles);
    } else {
        roleLabel.textContent = "บทบาท:"
        if (data.roleDesc) {
            roleDescDisplay.textContent = `"${data.roleDesc}"`;
            roleDescDisplay.classList.remove('hidden');
        }
        if (data.role === 'สายลับ' && data.bountyTargetName) {
            spyTargetName.textContent = data.bountyTargetName;
            spyTargetDisplay.classList.remove('hidden');
            bountyHuntBtn.classList.remove('hidden');
        }
        updateScoreboard(data.players, inGameScoreboard);
    }
    
    // Populate location list for everyone
    locationsList.innerHTML = '';
    (data.allLocations || []).forEach(locName => {
        const div = document.createElement('div');
        div.textContent = locName;
        div.className = 'p-2 bg-gray-100 rounded location-item font-bold';
        div.onclick = () => div.classList.toggle('eliminated');
        locationsList.appendChild(div);
    });
});

socket.on('timerUpdate', ({ timeLeft, players }) => {
    timerDisplay.textContent = `${String(Math.floor(timeLeft/60)).padStart(2,'0')}:${String(timeLeft%60).padStart(2,'0')}`;
    if (screens.game.offsetParent !== null) {
        const self = players.find(p => p.socketId === socket.id);
        const rolesToShow = (self && self.isSpectator) ? currentRoundRoles : null;
        updateScoreboard(players, inGameScoreboard, rolesToShow);
    }
});
socket.on('startVote', ({ players, reason, voteTime }) => {
    showModal('voting');
    voteReason.textContent = reason;
    votePlayerButtons.innerHTML = '';
    const self = players.find(p => p.socketId === socket.id);

    players.forEach(player => {
        if (player.socketId !== socket.id) { // Cannot vote for yourself
            const button = document.createElement('button');
            button.textContent = player.name;
            button.className = 'btn btn-primary vote-btn w-full mb-2';
            button.onclick = () => submitVote(player.id);
            votePlayerButtons.appendChild(button);
        }
    });
    abstainVoteBtn.disabled = false;
    let voteTimeLeft = voteTime || 120;
    if (voteTimerInterval) clearInterval(voteTimerInterval);
    voteTimerDisplay.textContent = voteTimeLeft;
    voteTimerInterval = setInterval(() => {
        voteTimeLeft--;
        if (voteTimeLeft >= 0) voteTimerDisplay.textContent = voteTimeLeft;
        else clearInterval(voteTimerInterval);
    }, 1000);
});
socket.on('spyGuessPhase', ({ locations, taunt, duration }) => {
    showModal('spyGuess');
    spyLocationGuess.innerHTML = '';
    locations.forEach(loc => { const o = document.createElement('option'); o.value = loc; o.textContent = loc; spyLocationGuess.appendChild(o); });
    spyGuessTaunt.textContent = taunt || "";
    let timeLeft = duration;
    if(specialTimerInterval) clearInterval(specialTimerInterval);
    spyGuessTimer.textContent = timeLeft;
    specialTimerInterval = setInterval(() => {
        timeLeft--;
        if(timeLeft >= 0) spyGuessTimer.textContent = timeLeft;
        else clearInterval(specialTimerInterval);
    }, 1000);
});
socket.on('spyIsGuessing', ({ spyName, taunt }) => {
    showModal('waitingForSpy');
    waitingSpyName.textContent = spyName;
    spyGuessTaunt.textContent = taunt || ""; // Use the same element for consistency
});
socket.on('bountyHuntPhase', ({ locations, targetName, duration }) => {
    showModal('bountyHunt');
    bountyLocationGuess.innerHTML = '<option value="">เลือกสถานที่...</option>';
    locations.forEach(loc => { const o = document.createElement('option'); o.value = loc; o.textContent = loc; bountyLocationGuess.appendChild(o); });
    bountyRoleGuess.innerHTML = '<option value="">กรุณาเลือกสถานที่ก่อน</option>';
    bountyRoleGuess.disabled = true;
    bountyTargetName.textContent = targetName;
    let timeLeft = duration;
    if(specialTimerInterval) clearInterval(specialTimerInterval);
    bountyHuntTimer.textContent = timeLeft;
    specialTimerInterval = setInterval(() => {
        timeLeft--;
        if(timeLeft >= 0) bountyHuntTimer.textContent = timeLeft;
        else clearInterval(specialTimerInterval);
    }, 1000);
});
socket.on('waitingForBountyHunt', ({spyName}) => {
    showModal('waitingForBounty');
    waitingBountySpyName.textContent = spyName;
});
socket.on('roundOver', ({ location, spyName, resultText, isFinalRound, players }) => {
    showModal('endRound'); 
    endLocation.textContent = location; 
    endSpy.textContent = spyName;
    let resultMessage = resultText;
    const self = players.find(p => p.socketId === socket.id);
    
    if (isFinalRound) {
        endModalTitle.textContent = "จบเกม!";
        const winner = [...players].filter(p=>!p.isSpectator).sort((a,b) => b.score - a.score)[0];
        if(winner) resultMessage += `\n\n🏆 ผู้ชนะคือ ${winner.name} ด้วยคะแนน ${winner.score} คะแนน!`;
        else resultMessage += `\n\nจบเกมแล้ว!`;
        nextRoundBtn.classList.add('hidden');
        backToLobbyBtn.classList.toggle('hidden', !(self && self.isHost));
        localStorage.removeItem('lastRoomCode');
    } else {
        endModalTitle.textContent = "จบรอบ";
        nextRoundBtn.classList.toggle('hidden', !(self && self.isHost) || (self && self.isSpectator));
        backToLobbyBtn.classList.add('hidden');
    }
    roundResultText.textContent = resultMessage;
    // No need to call updateScoreboard here, it's just showing results
});
socket.on('returnToLobby', () => { showScreen('lobby'); showModal(null); localStorage.removeItem('lastRoomCode'); });
socket.on('kicked', () => { alert('คุณถูกเตะออกจากห้อง'); localStorage.removeItem('lastRoomCode'); window.location.reload(); });
socket.on('playerDisconnected', name => { lobbyMessage.textContent = `${name} หลุดออกจากเกม...`; });
socket.on('playerReconnected', name => { lobbyMessage.textContent = `${name} กลับเข้าสู่เกม!`; });
socket.on('newHost', name => { lobbyMessage.textContent = `${name} ได้เป็นหัวหน้าห้องคนใหม่`; });

