// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// allow CORS for dev; change in production
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- static frontend ---
const PUBLIC = path.join(__dirname, 'public');
app.use(express.static(PUBLIC));

// --- uploads config (multer) ---
const UPLOADS = path.join(__dirname, 'uploads');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// upload endpoint - client posts FormData with key 'file'
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const fileUrl = `/uploads/${req.file.filename}`;
  return res.json({ success: true, filename: req.file.filename, url: fileUrl });
});

// serve uploaded files
app.use('/uploads', express.static(UPLOADS));

// ---------------- Socket.IO signaling ----------------
/*
  Simple room-based signaling:
  - Clients join a room via 'join-room'
  - Server keeps an in-memory list of participants per room (rooms object)
  - Caller sends 'call-user' -> server forwards to target
  - Callee answers with 'answer-call' -> forwarded back
  - ICE candidates are forwarded by 'ice-candidate'
  - Accept/reject via events
*/
const rooms = {}; // roomId -> [socketIds]

io.on('connection', (socket) => {
  console.log('socket connected:', socket.id);

  socket.on('join-room', (roomId, userMeta) => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = [];
    rooms[roomId].push(socket.id);

    // send existing participants to the joining client
    const others = rooms[roomId].filter(id => id !== socket.id);
    socket.emit('room-participants', others);

    // notify others
    socket.to(roomId).emit('user-joined', { socketId: socket.id, userMeta });
  });

  socket.on('leave-room', (roomId) => {
    socket.leave(roomId);
    if (rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter(id => id !== socket.id);
      socket.to(roomId).emit('user-left', socket.id);
    }
  });

  socket.on('call-user', ({ toSocketId, offer, fromMeta }) => {
    io.to(toSocketId).emit('incoming-call', { from: socket.id, offer, fromMeta });
  });

  socket.on('answer-call', ({ toSocketId, answer }) => {
    io.to(toSocketId).emit('call-accepted', { from: socket.id, answer });
  });

  socket.on('reject-call', ({ toSocketId }) => {
    io.to(toSocketId).emit('call-rejected', { from: socket.id });
  });

  socket.on('ice-candidate', ({ toSocketId, candidate }) => {
    io.to(toSocketId).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected:', socket.id);
    // remove from rooms
    Object.keys(rooms).forEach(roomId => {
      rooms[roomId] = rooms[roomId].filter(id => id !== socket.id);
      socket.to(roomId).emit('user-left', socket.id);
    });
  });
});

// start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
