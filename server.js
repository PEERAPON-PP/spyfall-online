const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const initializeSocketHandlers = require('./socketHandlers');

// --- การตั้งค่าพื้นฐาน ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    pingInterval: 25000,
    pingTimeout: 60000,
});

// บอกให้ Express เสิร์ฟไฟล์จากโฟลเดอร์ 'public'
app.use(express.static('public'));

// --- BUG FIX: Keep-Alive Endpoint ---
// เพิ่ม Endpoint นี้เพื่อให้ Client สามารถส่ง Request มาเพื่อป้องกันไม่ให้ Server "หลับ"
app.get('/keep-alive', (req, res) => {
    res.status(200).send('Server is awake.');
});

// --- เริ่มต้นการจัดการ Socket.IO ---
initializeSocketHandlers(io);

// --- เริ่มการทำงานของเซิร์ฟเวอร์ ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

