// --- Server Setup ---
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // Allow connections from any origin
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Serve the frontend file
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- Game Data ---
const locations = [
    // Original Locations
    { name: "ชายหาด", roles: ["นักท่องเที่ยว", "คนขายไอศกรีม", "ไลฟ์การ์ด", "เด็กเล่นทราย", "คนเล่นเซิร์ฟ", "คนทาครีมกันแดด"] },
    { name: "สถานีอวกาศ", roles: ["นักบินอวกาศ", "นักวิทยาศาสตร์", "หุ่นยนต์ซ่อมบำรุง", "นักท่องเที่ยวอวกาศ", "ผู้ควบคุมภารกิจ", "เอเลี่ยนแฝงตัว"] },
    { name: "โรงพยาบาล", roles: ["แพทย์", "พยาบาล", "คนไข้", "ศัลยแพทย์", "เภสัชกร", "ญาติผู้ป่วย"] },
    { name: "โรงเรียน", roles: ["ครู", "นักเรียน", "ภารโรง", "ผอ.โรงเรียน", "บรรณารักษ์", "นักเรียนแลกเปลี่ยน"] },
    { name: "ร้านอาหารหรู", roles: ["เชฟ", "บริกร", "ลูกค้า", "นักวิจารณ์อาหาร", "ผู้จัดการร้าน", "คนล้างจาน"] },
    { name: "กองถ่ายภาพยนตร์", roles: ["ผู้กำกับ", "นักแสดง", "ตากล้อง", "คนเขียนบท", "ช่างแต่งหน้า", "ตัวประกอบ"] },
    { name: "คณะละครสัตว์", roles: ["ตัวตลก", "นักกายกรรม", "ผู้ฝึกสัตว์", "คนขายป๊อปคอร์น", "โฆษก", "ผู้ชมแถวหน้า"] },
    { name: "สถานีตำรวจ", roles: ["สารวัตร", "สายสืบ", "ผู้ต้องหา", "ตำรวจจราจร", "ทนายความ", "พยาน"] },
    { name: "คาสิโน", roles: ["เจ้ามือ", "นักพนัน", "พนักงานเสิร์ฟ", "เจ้าของคาสิโน", "รปภ.", "คนนับไพ่"] },
    { name: "ซูเปอร์มาร์เก็ต", roles: ["แคชเชียร์", "ลูกค้า", "พนักงานจัดของ", "คนชิมอาหารฟรี", "ผู้จัดการสาขา", "พนักงานเข็นรถ"] },
    { name: "เครื่องบิน", roles: ["นักบิน", "แอร์โฮสเตส", "ผู้โดยสาร", "วิศวกรเครื่องบิน", "ผู้โดยสารชั้นธุรกิจ", "เด็กทารก"] },
    { name: "เรือดำน้ำ", roles: ["กัปตัน", "วิศวกร", "ต้นหน", "พ่อครัว", "ทหารเรือ", "ผู้เชี่ยวชาญโซนาร์"] },
    { name: "มหาวิทยาลัย", roles: ["ศาสตราจารย์", "นักศึกษา", "นักวิจัย", "เจ้าหน้าที่หอสมุด", "อธิการบดี", "นักกีฬา"] },
    { name: "ปาร์ตี้ริมสระ", roles: ["เจ้าของบ้าน", "ดีเจ", "คนเล่นน้ำ", "บาร์เทนเดอร์", "คนทำบาร์บีคิว", "แขกไม่ได้รับเชิญ"] },
    { name: "ธนาคาร", roles: ["พนักงาน", "ลูกค้า", "ผู้จัดการ", "ยาม", "โจรปล้นธนาคาร", "ที่ปรึกษาการเงิน"] },
    // New Locations
    { name: "พิพิธภัณฑ์", roles: ["ภัณฑารักษ์", "ยาม", "นักท่องเที่ยว", "นักเรียนทัศนศึกษา", "นักประวัติศาสตร์", "คนทำความสะอาด"] },
    { name: "สวนสัตว์", roles: ["ผู้ดูแลสัตว์", "สัตวแพทย์", "คนขายตั๋ว", "ครอบครัวมาเที่ยว", "ช่างภาพสัตว์", "เด็กทำลูกโป่งหาย"] },
    { name: "ห้องสมุด", roles: ["บรรณารักษ์", "คนอ่านหนังสือ", "นักศึกษา", "คนหาหนังสือ", "เจ้าหน้าที่", "คนแอบหลับ"] },
    { name: "คอนเสิร์ต", roles: ["นักร้อง", "มือกีตาร์", "แฟนคลับ", "ทีมงาน", "ซาวด์เอนจิเนียร์", "คนขายของที่ระลึก"] },
    { name: "ฟาร์ม", roles: ["ชาวนา", "คนเลี้ยงวัว", "คนขับรถไถ", "สัตวแพทย์", "คนมาซื้อผลผลิต", "เด็กฝึกงาน"] },
    { name: "งานแต่งงาน", roles: ["เจ้าบ่าว", "เจ้าสาว", "เพื่อนเจ้าสาว", "นายพิธี", "ช่างภาพ", "แขก"] },
    { name: "ศาล", roles: ["ผู้พิพากษา", "อัยการ", "ทนาย", "จำเลย", "พยาน", "คณะลูกขุน"] },
    { name: "อู่ซ่อมรถ", roles: ["ช่างยนต์", "ลูกค้า", "เจ้าของอู่", "พนักงานขายอะไหล่", "เด็กฝึกงาน", "คนล้างรถ"] },
    { name: "ร้านตัดผม", roles: ["ช่างตัดผม", "ลูกค้า", "คนรอคิว", "คนกวาดพื้น", "เจ้าของร้าน", "เด็กมาตัดผมครั้งแรก"] },
    { name: "ยอดเขาสูง", roles: ["นักปีนเขา", "ไกด์", "นักวิทยาศาสตร์", "นักท่องเที่ยว", "คนถ่ายสารคดี", "เชอร์ปา"] },
    { name: "โรงงานช็อกโกแลต", roles: ["คนงาน", "ผู้จัดการ", "นักชิม", "วิศวกร", "เด็กทัศนศึกษา", "เจ้าของโรงงาน"] },
    { name: "คณะสำรวจขั้วโลก", roles: ["นักวิจัย", "แพทย์", "วิศวกร", "นักสำรวจ", "พ่อครัว", "คนขับรถตักหิมะ"] },
    { name: "ตลาดน้ำ", roles: ["พ่อค้า", "แม่ค้า", "นักท่องเที่ยว", "คนพายเรือ", "คนทำอาหาร", "คนขายของที่ระลึก"] },
    { name: "ไซต์ก่อสร้าง", roles: ["วิศวกร", "โฟร์แมน", "กรรมกร", "คนขับเครน", "สถาปนิก", "เจ้าหน้าที่ความปลอดภัย"] },
    { name: "สถานีดับเพลิง", roles: ["นักดับเพลิง", "หัวหน้าสถานี", "พนักงานรับแจ้งเหตุ", "ช่างซ่อมรถ", "อาสาสมัคร", "แมวประจำสถานี"] },
    { name: "พระราชฐานชั้นใน", roles: ["พระมเหสี", "นางกำนัล", "หัวหน้าขันที", "พระอาจารย์", "หมอหลวง", "แขกบ้านแขกเมือง"] }
];


// --- Game State Management ---
let games = {}; // Stores all active game rooms

// --- Helper Functions ---
function generateRoomCode() {
    let code = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 4; i++) {
        code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return code;
}

// --- Socket.IO Connection Logic ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('createRoom', ({ name, timerMinutes }) => {
        const roomCode = generateRoomCode();
        games[roomCode] = {
            players: [{ id: socket.id, name: name }],
            hostId: socket.id,
            state: 'lobby',
            timerSetting: parseInt(timerMinutes) * 60,
            timerInterval: null,
            spy: null,
            location: null,
            roles: {}
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode });
        io.to(roomCode).emit('updateLobby', games[roomCode].players);
    });

    socket.on('joinRoom', ({ roomCode, name }) => {
        if (games[roomCode] && games[roomCode].state === 'lobby') {
            games[roomCode].players.push({ id: socket.id, name: name });
            socket.join(roomCode);
            socket.emit('joinSuccess', { roomCode });
            io.to(roomCode).emit('updateLobby', games[roomCode].players);
        } else {
            socket.emit('joinError', 'ไม่พบห้องหรือเกมเริ่มไปแล้ว');
        }
    });

    socket.on('startGame', ({ roomCode }) => {
        const game = games[roomCode];
        if (game && game.hostId === socket.id && game.players.length >= 1) {
            game.state = 'playing';

            // Assign spy and location
            const randomLocationIndex = Math.floor(Math.random() * locations.length);
            game.location = locations[randomLocationIndex];
            const randomSpyIndex = Math.floor(Math.random() * game.players.length);
            game.spy = game.players[randomSpyIndex].id;

            // Assign roles
            const availableRoles = [...game.location.roles];
            game.players.forEach(player => {
                if (player.id !== game.spy) {
                    const roleIndex = Math.floor(Math.random() * availableRoles.length);
                    game.roles[player.id] = availableRoles.splice(roleIndex, 1)[0];
                    if (availableRoles.length === 0) availableRoles.push(...game.location.roles);
                }
            });

            // Send roles to each player individually
            game.players.forEach(player => {
                const isSpy = player.id === game.spy;
                io.to(player.id).emit('gameStarted', {
                    isSpy: isSpy,
                    location: isSpy ? null : game.location.name,
                    role: isSpy ? null : game.roles[player.id],
                    players: game.players.map(p => p.name),
                    allLocations: locations.map(l => l.name)
                });
            });

            // Start timer
            let duration = game.timerSetting;
            game.timerInterval = setInterval(() => {
                io.to(roomCode).emit('timerUpdate', duration);
                if (--duration < 0) {
                    clearInterval(game.timerInterval);
                    io.to(roomCode).emit('gameEnded', { 
                        spyName: game.players.find(p => p.id === game.spy).name,
                        locationName: game.location.name
                    });
                }
            }, 1000);
        }
    });
    
    socket.on('endGame', ({ roomCode }) => {
        const game = games[roomCode];
        if (game && game.hostId === socket.id) {
            clearInterval(game.timerInterval);
            io.to(roomCode).emit('gameEnded', { 
                spyName: game.players.find(p => p.id === game.spy).name,
                locationName: game.location.name
            });
        }
    });

    socket.on('playAgain', ({ roomCode }) => {
        const game = games[roomCode];
        if (game && game.hostId === socket.id) {
            // Reset game state but keep players
            game.state = 'lobby';
            game.spy = null;
            game.location = null;
            game.roles = {};
            clearInterval(game.timerInterval);
            
            // Send everyone back to the lobby
            io.to(roomCode).emit('returnToLobby');
            io.to(roomCode).emit('updateLobby', game.players);
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // Find which room the player was in and remove them
        for (const roomCode in games) {
            const game = games[roomCode];
            const playerIndex = game.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                game.players.splice(playerIndex, 1);
                if (game.players.length === 0) {
                    // If room is empty, delete it
                    clearInterval(game.timerInterval);
                    delete games[roomCode];
                } else {
                    // If host disconnected, assign a new host
                    if (game.hostId === socket.id) {
                        game.hostId = game.players[0].id;
                    }
                    // Update remaining players
                    io.to(roomCode).emit('updateLobby', game.players);
                }
                break;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

