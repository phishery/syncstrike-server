/**
 * SYNC STRIKE - WebSocket Server for Online Multiplayer
 * ======================================================
 *
 * Deploy to Render.com as a Web Service
 *
 * SETUP ON RENDER:
 * 1. Create new Web Service
 * 2. Connect your GitHub repo (or upload these files)
 * 3. Build Command: npm install
 * 4. Start Command: npm start
 * 5. Copy your URL (e.g., syncstrike-server.onrender.com)
 * 6. Update WEBSOCKET_SERVER_URL in main.js
 */

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// Create HTTP server (required for Render)
const server = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SYNC STRIKE WebSocket Server\n\nConnect via WebSocket to play online.');
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ server });

// Room storage: { roomCode: { host: ws, guest: ws, hostPlan: [], guestPlan: [] } }
const rooms = new Map();

console.log('SYNC STRIKE Server starting...');

wss.on('connection', (ws) => {
    console.log('Client connected. Total clients:', wss.clients.size);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data);
        } catch (e) {
            console.error('Invalid message:', e);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        // Clean up rooms where this client was
        for (const [code, room] of rooms.entries()) {
            if (room.host === ws || room.guest === ws) {
                // Notify other player
                const other = room.host === ws ? room.guest : room.host;
                if (other && other.readyState === WebSocket.OPEN) {
                    other.send(JSON.stringify({
                        type: 'error',
                        message: 'Opponent disconnected'
                    }));
                }
                rooms.delete(code);
                console.log(`Room ${code} closed`);
            }
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });
});

function handleMessage(ws, data) {
    switch (data.type) {
        case 'create':
            createRoom(ws, data.roomCode);
            break;

        case 'join':
            joinRoom(ws, data.roomCode);
            break;

        case 'submit_plan':
            submitPlan(ws, data.roomCode, data.plan);
            break;

        case 'rematch_request':
            handleRematch(ws, data.roomCode);
            break;

        default:
            ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
    }
}

function createRoom(ws, roomCode) {
    if (rooms.has(roomCode)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room already exists' }));
        return;
    }

    rooms.set(roomCode, {
        host: ws,
        guest: null,
        hostPlan: null,
        guestPlan: null,
        hostRematch: false,
        guestRematch: false
    });

    ws.send(JSON.stringify({ type: 'room_created', roomCode }));
    console.log(`Room ${roomCode} created. Total rooms:`, rooms.size);
}

function joinRoom(ws, roomCode) {
    const room = rooms.get(roomCode);

    if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
    }

    if (room.guest) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
        return;
    }

    room.guest = ws;

    // Notify both players
    room.host.send(JSON.stringify({ type: 'player_joined' }));
    ws.send(JSON.stringify({ type: 'player_joined' }));

    console.log(`Player joined room ${roomCode}`);
}

function submitPlan(ws, roomCode, plan) {
    const room = rooms.get(roomCode);

    if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
    }

    // Determine if this is host or guest
    if (ws === room.host) {
        room.hostPlan = plan;
    } else if (ws === room.guest) {
        room.guestPlan = plan;
    }

    // Check if both plans are submitted
    if (room.hostPlan && room.guestPlan) {
        // Send plans to each other
        room.host.send(JSON.stringify({
            type: 'opponent_ready',
            plan: room.guestPlan
        }));

        room.guest.send(JSON.stringify({
            type: 'opponent_ready',
            plan: room.hostPlan
        }));

        // Reset for next round
        room.hostPlan = null;
        room.guestPlan = null;

        console.log(`Room ${roomCode}: Both plans submitted, starting resolution`);
    }
}

function handleRematch(ws, roomCode) {
    const room = rooms.get(roomCode);

    if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
    }

    // Mark this player as wanting rematch
    if (ws === room.host) {
        room.hostRematch = true;
    } else if (ws === room.guest) {
        room.guestRematch = true;
    }

    // Check if both want rematch
    if (room.hostRematch && room.guestRematch) {
        // Reset rematch flags for next round
        room.hostRematch = false;
        room.guestRematch = false;

        // Notify both players
        room.host.send(JSON.stringify({ type: 'rematch_ready' }));
        room.guest.send(JSON.stringify({ type: 'rematch_ready' }));

        console.log(`Room ${roomCode}: Both players ready for rematch`);
    } else {
        // Let this player know they're waiting
        ws.send(JSON.stringify({ type: 'rematch_waiting' }));
    }
}

// Heartbeat to keep connections alive and clean up dead connections
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// Clean up stale rooms every 5 minutes
setInterval(() => {
    for (const [code, room] of rooms.entries()) {
        if ((!room.host || room.host.readyState !== WebSocket.OPEN) &&
            (!room.guest || room.guest.readyState !== WebSocket.OPEN)) {
            rooms.delete(code);
            console.log(`Cleaned up stale room ${code}`);
        }
    }
}, 5 * 60 * 1000);

wss.on('close', () => {
    clearInterval(heartbeat);
});

// Start the server
server.listen(PORT, () => {
    console.log(`SYNC STRIKE Server running on port ${PORT}`);
});
