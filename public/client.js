const $ = (id) => document.getElementById(id);
const screens = { home: $('home-screen'), lobby: $('lobby-screen'), game: $('game-screen') };
const modals = { locations: $('locations-modal'), voting: $('voting-modal'), spyGuess: $('spy-guess-modal'), waitingForSpy: $('waiting-for-spy-modal'), endRound: $('end-round-modal'), bountyHunt: $('bounty-hunt-modal'), waitingForBounty: $('waiting-for-bounty-modal') };
const playerNameInput = $('player-name-input'), nameError = $('name-error'), createRoomBtn = $('create-room-btn'), roomCodeInput = $('room-code-input'), joinRoomBtn = $('join-room-btn');
const lobbyRoomCode = $('lobby-room-code'), copyCodeBtn = $('copy-code-btn'), playerList = $('player-list'), startGameBtn = $('start-game-btn'), gameSettings = $('game-settings'), timerSelect = $('timer-select'), roundsSelect = $('rounds-select'), themeCheckboxes = $('theme-checkboxes'), lobbyMessage = $('lobby-message'), voteTimerSelect = $('vote-timer-select'), bountyHuntCheckbox = $('bounty-hunt-checkbox');
const timerDisplay = $('timer'), locationDisplay = $('location-display'), roleDisplay = $('role-display'), roleDescDisplay = $('role-desc-display'), ingameActions = $('ingame-actions'), showLocationsBtn = $('show-locations-btn'), currentRoundSpan = $('current-round'), totalRoundsSpan = $('total-rounds'), inGameScoreboard = $('in-game-scoreboard'), hostEndRoundBtn = $('host-end-round-btn'), roleLabel = $('role-label'), gameRoomCode = $('game-room-code');
const locationsList = $('locations-list'), closeLocationsBtn = $('close-locations-btn'), voteReason = $('vote-reason'), voteTimerDisplay = $('vote-timer'), votePlayerButtons = $('vote-player-buttons'), abstainVoteBtn = $('abstain-vote-btn'), voteProgressCount = $('vote-progress-count'), voteProgressTotal = $('vote-progress-total'), voterStatusList = $('voter-status-list');
const spyLocationGuess = $('spy-location-guess'), confirmSpyGuessBtn = $('confirm-spy-guess-btn'), waitingSpyName = $('waiting-spy-name'), waitingTaunt = $('waiting-taunt'), spyGuessTaunt = $('spy-guess-taunt'), spyGuessTimer = $('spy-guess-timer');
const endModalTitle = $('end-modal-title'), endLocation = $('end-location'), endSpy = $('end-spy'), roundResultText = $('round-result-text'), nextRoundBtn = $('next-round-btn'), backToLobbyBtn = $('back-to-lobby-btn');
const bountyHuntBtn = $('bounty-hunt-btn'), spyTargetDisplay = $('spy-target-display'), spyTargetName = $('spy-target-name');
const bountyHuntTimer = $('bounty-hunt-timer'), bountyLocationGuess = $('bounty-location-guess'), bountyRoleGuess = $('bounty-role-guess'), bountyTargetName = $('bounty-target-name'), confirmBountyGuessBtn = $('confirm-bounty-guess-btn'), waitingBountySpyName = $('waiting-bounty-spy-name');

let isHost = false, voteTimerInterval = null, playerToken = null, specialTimerInterval = null, currentRoundRoles = null, wakeLock = null;
const socket = io();

const requestWakeLock = async () => { if ('wakeLock' in navigator) try { wakeLock = await navigator.wakeLock.request('screen'); } catch (err) { console.error(`${err.name}, ${err.message}`); } };
const releaseWakeLock = async () => { if (wakeLock) { await wakeLock.release(); wakeLock = null; } };
document.addEventListener('visibilitychange', async () => { if (wakeLock && document.visibilityState === 'visible') await requestWakeLock(); });

function showScreen(screenName) { Object.values(screens).forEach(s => s.classList.add('hidden')); screens[screenName].classList.remove('hidden'); }
function showModal(modalName) { if(specialTimerInterval) clearInterval(specialTimerInterval); if(voteTimerInterval) clearInterval(voteTimerInterval); Object.values(modals).forEach(m => m.classList.add('hidden')); if(modalName) modals[modalName].classList.remove('hidden'); }

function updateScoreboard(players, container, allPlayerRoles = null) {
    container.innerHTML = '';
    const self = players.find(p => p.token === playerToken);
    const activePlayers = players.filter(p => !p.isSpectator).sort((a, b) => b.score - a.score);
    const spectators = players.filter(p => p.isSpectator).sort((a, b) => b.score - a.score);
    const createPlayerRow = (player) => {
        const playerDiv = document.createElement('div');
        playerDiv.className = 'flex justify-between items-center bg-gray-100 p-2 rounded';
        if (player.disconnected) playerDiv.classList.add('player-disconnected');
        if (self && player.id === self.id) playerDiv.classList.add('bg-indigo-100', 'border', 'border-indigo-300');
        const leftDiv = document.createElement('div');
        leftDiv.className = 'flex-grow flex items-center space-x-2';
        const nameSpan = document.createElement('span');
        let prefix = player.isHost ? '👑 ' : (player.isSpectator ? '🔎 ' : '🎮 ');
        nameSpan.innerHTML = `${prefix}${player.name}<span class="text-gray-500">${container === playerList && player.isSpectator === 'waiting' ? ' (รอเล่นรอบถัดไป)' : ''}</span>`;
        leftDiv.appendChild(nameSpan);
        if (allPlayerRoles) {
            const roleData = allPlayerRoles.find(r => r.id === player.id);
            if (roleData) { const roleSpan = document.createElement('span'); roleSpan.className = 'text-sm'; if(roleData.role === 'สายลับ') roleSpan.classList.add('spectator-spy-role'); roleSpan.innerHTML = `- <span class="font-semibold">${roleData.role}</span>`; leftDiv.appendChild(roleSpan); }
        }
        const rightDiv = document.createElement('div');
        rightDiv.className = 'flex items-center space-x-2';
        const scoreSpan = document.createElement('span');
        scoreSpan.textContent = `${player.score} คะแนน`;
        rightDiv.appendChild(scoreSpan);
        if (container === playerList && self && player.id === self.id && !player.isHost) { const btn = document.createElement('button'); btn.textContent = player.isSpectator ? 'สลับเป็นผู้เล่น' : 'สลับเป็นผู้ชม'; btn.className = 'btn btn-secondary btn-sm'; btn.onclick = () => socket.emit('toggleSpectatorMode'); rightDiv.appendChild(btn); }
        if (container === playerList && self && self.isHost && player.id !== self.id) { const btn = document.createElement('button'); btn.textContent = 'เตะ'; btn.className = 'btn bg-red-500 hover:bg-red-600 text-white btn-sm'; btn.onclick = () => socket.emit('kickPlayer', player.id); rightDiv.appendChild(btn); }
        playerDiv.appendChild(leftDiv); playerDiv.appendChild(rightDiv);
        return playerDiv;
    };
    if(activePlayers.length > 0 && container === playerList) { const div = document.createElement('div'); div.className = 'text-center text-gray-500 text-sm py-1 font-semibold'; div.textContent = '--- ผู้เล่น ---'; container.appendChild(div); }
    activePlayers.forEach(p => container.appendChild(createPlayerRow(p)));
    if (spectators.length > 0 && container === playerList) { const div = document.createElement('div'); div.className = 'text-center text-gray-500 text-sm py-1 font-semibold'; div.textContent = '--- ผู้ชม ---'; container.appendChild(div); }
    spectators.forEach(p => container.appendChild(createPlayerRow(p)));
}
function generateToken() { return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)); }

createRoomBtn.addEventListener('click', () => { const n = playerNameInput.value.trim(); if (!n) { nameError.classList.remove('hidden'); return; } nameError.classList.add('hidden'); if (!playerToken) { playerToken = generateToken(); sessionStorage.setItem('playerToken', playerToken); } sessionStorage.setItem('playerName', n); socket.emit('createRoom', { playerName: n, playerToken }); });
joinRoomBtn.addEventListener('click', () => { const n = playerNameInput.value.trim(); const c = roomCodeInput.value.trim().toUpperCase(); if (!n) { nameError.classList.remove('hidden'); return; } nameError.classList.add('hidden'); if (!c) return; if (!playerToken) { playerToken = generateToken(); sessionStorage.setItem('playerToken', playerToken); } sessionStorage.setItem('playerName', n); socket.emit('joinRoom', { playerName: n, roomCode: c, playerToken }); });
copyCodeBtn.addEventListener('click', () => navigator.clipboard.writeText(lobbyRoomCode.textContent).then(() => { copyCodeBtn.textContent = 'คัดลอกแล้ว!'; setTimeout(() => copyCodeBtn.textContent = 'คัดลอก', 2000); }));
startGameBtn.addEventListener('click', () => { const themes = Array.from(themeCheckboxes.querySelectorAll('input:checked')).map(cb => cb.dataset.theme); if(themes.length === 0) { alert("กรุณาเลือกโหมดอย่างน้อย 1 โหมด"); return; } socket.emit('startGame', { time: timerSelect.value, rounds: roundsSelect.value, themes, voteTime: voteTimerSelect.value, bountyHuntEnabled: bountyHuntCheckbox.checked }); });
hostEndRoundBtn.addEventListener('click', () => socket.emit('hostEndRound'));
abstainVoteBtn.addEventListener('click', () => { socket.emit('submitVote', null); votePlayerButtons.querySelectorAll('button').forEach(btn => btn.disabled = true); abstainVoteBtn.disabled = true; });
nextRoundBtn.addEventListener('click', () => { socket.emit('requestNextRound'); showModal(null); });
backToLobbyBtn.addEventListener('click', () => socket.emit('resetGame'));
showLocationsBtn.addEventListener('click', () => showModal('locations'));
closeLocationsBtn.addEventListener('click', () => showModal(null));
confirmSpyGuessBtn.addEventListener('click', () => { socket.emit('spyGuessLocation', spyLocationGuess.value); showModal(null); });
bountyHuntBtn.addEventListener('click', () => socket.emit('spyDeclareBounty'));
confirmBountyGuessBtn.addEventListener('click', () => { socket.emit('submitBountyGuess', { location: bountyLocationGuess.value, role: bountyRoleGuess.value }); showModal(null); });
bountyLocationGuess.addEventListener('change', () => { const locName = bountyLocationGuess.value; bountyRoleGuess.innerHTML = '<option value="">เลือกบทบาท...</option>'; if (!locName) { bountyRoleGuess.disabled = true; return; } const locData = getAvailableLocations(game.settings.themes).find(l => l.name === locName); if (locData) { locData.roles.forEach(r => { const rName = r.split('(')[0].trim(); if (rName !== 'สายลับ') { const o = document.createElement('option'); o.value = rName; o.textContent = rName; bountyRoleGuess.appendChild(o); } }); bountyRoleGuess.disabled = false; } });
window.addEventListener('DOMContentLoaded', () => { playerNameInput.value = sessionStorage.getItem('playerName') || ''; playerToken = sessionStorage.getItem('playerToken'); if (!playerToken) { playerToken = generateToken(); sessionStorage.setItem('playerToken', playerToken); } });

socket.on('roomCreated', d => { showScreen('lobby'); lobbyRoomCode.textContent = d.roomCode; });
socket.on('joinSuccess', d => { showScreen('lobby'); lobbyRoomCode.textContent = d.roomCode; });
socket.on('error', m => alert(m));
socket.on('updatePlayerList', ({players, settings}) => {
    const self = players.find(p => p.token === playerToken);
    isHost = self ? self.isHost : false;
    updateScoreboard(players, playerList);
    if (settings) {
        timerSelect.value = settings.time; roundsSelect.value = settings.rounds; voteTimerSelect.value = settings.voteTime;
        bountyHuntCheckbox.checked = settings.bountyHuntEnabled;
        themeCheckboxes.querySelectorAll('input').forEach(cb => cb.checked = settings.themes?.includes(cb.dataset.theme));
    }
    gameSettings.classList.remove('hidden');
    gameSettings.querySelectorAll('select, input').forEach(input => input.disabled = !isHost);
    const activePlayers = players.filter(p => !p.disconnected && !p.isSpectator).length;
    startGameBtn.disabled = activePlayers < 3;
    if (isHost) {
        startGameBtn.classList.remove('hidden');
        lobbyMessage.textContent = activePlayers < 3 ? 'ต้องมีผู้เล่นอย่างน้อย 3 คน' : 'คุณคือหัวหน้าห้อง กดเริ่มเกมได้เลย!';
    } else {
        startGameBtn.classList.add('hidden');
        lobbyMessage.textContent = self?.isSpectator ? 'คุณอยู่ในโหมดผู้ชม รอหัวหน้าห้องเริ่มเกม' : 'กำลังรอหัวหน้าห้องเริ่มเกม...';
    }
});
socket.on('settingsUpdated', (settings) => { if (!isHost && settings) { timerSelect.value = settings.time; roundsSelect.value = settings.rounds; voteTimerSelect.value = settings.voteTime; bountyHuntCheckbox.checked = settings.bountyHuntEnabled; themeCheckboxes.querySelectorAll('input').forEach(cb => cb.checked = settings.themes?.includes(cb.dataset.theme)); }});
socket.on('gameStarted', (data) => {
    showScreen('game'); showModal(null); requestWakeLock();
    currentRoundRoles = data.allPlayerRoles || null;
    const self = data.players.find(p => p.token === playerToken);
    isHost = self ? self.isHost : false;
    currentRoundSpan.textContent = data.round; totalRoundsSpan.textContent = data.totalRounds; gameRoomCode.textContent = lobbyRoomCode.textContent;
    hostEndRoundBtn.classList.toggle('hidden', !isHost || self?.isSpectator);
    ingameActions.classList.toggle('hidden', !!self?.isSpectator);
    locationDisplay.textContent = data.location; roleDisplay.textContent = data.role;
    bountyHuntBtn.classList.add('hidden'); spyTargetDisplay.classList.add('hidden');
    if (self?.isSpectator) { roleLabel.textContent = "สถานะ:"; updateScoreboard(data.players, inGameScoreboard, currentRoundRoles); }
    else {
        roleLabel.textContent = "บทบาท:";
        if (data.roleDesc) { roleDescDisplay.textContent = `"${data.roleDesc}"`; roleDescDisplay.classList.remove('hidden'); } else roleDescDisplay.classList.add('hidden');
        if (data.role === 'สายลับ' && data.bountyTargetName) {
            spyTargetName.textContent = data.bountyTargetName; spyTargetDisplay.classList.remove('hidden'); bountyHuntBtn.classList.remove('hidden');
        }
        updateScoreboard(data.players, inGameScoreboard);
    }
    locationsList.innerHTML = '';
    (data.allLocations || []).forEach(locName => { const div = document.createElement('div'); div.textContent = locName; div.className = 'p-2 bg-gray-100 rounded location-item font-bold'; div.onclick = () => div.classList.toggle('eliminated'); locationsList.appendChild(div); });
});
socket.on('timerUpdate', ({ timeLeft, players }) => { timerDisplay.textContent = `${String(Math.floor(timeLeft/60)).padStart(2,'0')}:${String(timeLeft%60).padStart(2,'0')}`; if (screens.game.offsetParent) { const self = players.find(p => p.token === playerToken); updateScoreboard(players, inGameScoreboard, self?.isSpectator ? currentRoundRoles : null); }});
socket.on('startVote', ({ players, reason, voteTime }) => {
    showModal('voting');
    voteReason.textContent = reason;
    const self = players.find(p => p.token === playerToken);
    voterStatusList.innerHTML = '';
    players.forEach(p => { const div = document.createElement('div'); div.id = `voter-status-${p.id}`; div.textContent = `${p.name}: ⏳ กำลังตัดสินใจ...`; voterStatusList.appendChild(div); });
    if (self?.isSpectator) { votePlayerButtons.innerHTML = '<p class="text-gray-500 italic">กำลังรอผู้เล่นอื่นโหวต...</p>'; abstainVoteBtn.classList.add('hidden'); }
    else {
        votePlayerButtons.innerHTML = '';
        players.forEach(p => { if (p.token !== playerToken) { const btn = document.createElement('button'); btn.textContent = p.name; btn.className = 'btn btn-primary vote-btn w-full mb-2'; btn.onclick = () => { socket.emit('submitVote', p.id); votePlayerButtons.querySelectorAll('button').forEach(b => b.disabled = true); abstainVoteBtn.disabled = true; }; votePlayerButtons.appendChild(btn); } });
        abstainVoteBtn.disabled = false; abstainVoteBtn.classList.remove('hidden');
    }
    let timeLeft = voteTime; if (voteTimerInterval) clearInterval(voteTimerInterval); voteTimerDisplay.textContent = timeLeft;
    voteTimerInterval = setInterval(() => { if(--timeLeft >= 0) voteTimerDisplay.textContent = timeLeft; else clearInterval(voteTimerInterval); }, 1000);
});
socket.on('voteUpdate', ({ voters, totalVoters }) => { voteProgressCount.textContent = voters.length; voteProgressTotal.textContent = totalVoters; voterStatusList.querySelectorAll('div').forEach(div => { const id = div.id.replace('voter-status-', ''); if(voters.includes(id)) { div.textContent = `${div.textContent.split(':')[0]}: ✅ โหวตแล้ว`; } }); });
socket.on('spyGuessPhase', ({ locations, taunt, duration }) => { showModal('spyGuess'); spyLocationGuess.innerHTML = ''; locations.forEach(loc => { const o=document.createElement('option'); o.value=loc; o.textContent=loc; spyLocationGuess.appendChild(o); }); spyGuessTaunt.textContent = taunt || ""; let timeLeft = duration; if(specialTimerInterval) clearInterval(specialTimerInterval); spyGuessTimer.textContent = timeLeft; specialTimerInterval = setInterval(() => { if(--timeLeft >= 0) spyGuessTimer.textContent = timeLeft; else clearInterval(specialTimerInterval); }, 1000); });
socket.on('spyIsGuessing', ({ spyName, taunt }) => { showModal('waitingForSpy'); waitingSpyName.textContent = spyName; waitingTaunt.textContent = taunt || ""; });
socket.on('bountyHuntPhase', ({ locations, targetName, duration }) => { showModal('bountyHunt'); bountyLocationGuess.innerHTML = '<option value="">เลือกสถานที่...</option>'; locations.forEach(loc => { const o=document.createElement('option'); o.value=loc; o.textContent=loc; bountyLocationGuess.appendChild(o); }); bountyRoleGuess.innerHTML = '<option value="">กรุณาเลือกสถานที่ก่อน</option>'; bountyRoleGuess.disabled = true; bountyTargetName.textContent = targetName; let timeLeft = duration; if(specialTimerInterval) clearInterval(specialTimerInterval); bountyHuntTimer.textContent = timeLeft; specialTimerInterval = setInterval(() => { if(--timeLeft >= 0) bountyHuntTimer.textContent = timeLeft; else clearInterval(specialTimerInterval); }, 1000); });
socket.on('waitingForBountyHunt', ({spyName}) => { showModal('waitingForBounty'); waitingBountySpyName.textContent = spyName; });
socket.on('roundOver', ({ location, spyName, resultText, isFinalRound, players }) => {
    showModal('endRound');
    endLocation.textContent = location; endSpy.textContent = spyName;
    const self = players.find(p => p.token === playerToken);
    if (isFinalRound) {
        releaseWakeLock();
        endModalTitle.textContent = "จบเกม!";
        const winner = [...players].filter(p=>!p.isSpectator).sort((a,b)=>b.score - a.score)[0];
        resultText += winner ? `\n\n🏆 ผู้ชนะคือ ${winner.name} ด้วยคะแนน ${winner.score} คะแนน!` : `\n\nจบเกมแล้ว!`;
        nextRoundBtn.classList.add('hidden');
        backToLobbyBtn.classList.toggle('hidden', !(self && self.isHost));
    } else {
        endModalTitle.textContent = "จบรอบ";
        nextRoundBtn.classList.toggle('hidden', !(self && self.isHost));
        backToLobbyBtn.classList.add('hidden');
    }
    roundResultText.textContent = resultText;
});
socket.on('returnToLobby', () => { showScreen('lobby'); showModal(null); releaseWakeLock(); });
socket.on('kicked', () => { alert('คุณถูกเตะออกจากห้อง'); releaseWakeLock(); sessionStorage.clear(); window.location.reload(); });
socket.on('playerDisconnected', name => lobbyMessage.textContent = `${name} หลุดออกจากเกม...`);
socket.on('playerReconnected', name => lobbyMessage.textContent = `${name} กลับเข้าสู่เกม!`);
socket.on('newHost', name => lobbyMessage.textContent = `${name} ได้เป็นหัวหน้าห้องคนใหม่`);

