const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const initializeSocketHandlers = require('./socketHandlers');

// --- การตั้งค่าพื้นฐาน ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    pingTimeout: 60000,
});

// บอกให้ Express เสิร์ฟไฟล์จากโฟลเดอร์ 'public'
app.use(express.static('public'));

// --- เริ่มต้นการจัดการ Socket.IO ---
initializeSocketHandlers(io);

// --- เริ่มการทำงานของเซิร์ฟเวอร์ ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

