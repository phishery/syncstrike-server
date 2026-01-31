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
            if (room.host === ws) {
                if (room.guest && room.guest.readyState === WebSocket.OPEN) {
                    // Game in progress - notify guest and delete room
                    room.guest.send(JSON.stringify({
                        type: 'opponent_left'
                    }));
                    rooms.delete(code);
                    console.log(`Room ${code} closed - host left during game`);
                } else {
                    // No guest yet - keep room alive for reconnection (60 second grace period)
                    room.host = null;
                    room.hostDisconnectedAt = Date.now();
                    console.log(`Room ${code} host disconnected - keeping room for 60s`);
                }
            } else if (room.guest === ws) {
                // Guest disconnected
                if (room.host && room.host.readyState === WebSocket.OPEN) {
                    room.host.send(JSON.stringify({
                        type: 'opponent_left'
                    }));
                }
                rooms.delete(code);
                console.log(`Room ${code} closed - guest left`);
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
            createRoom(ws, data.roomCode, data.version);
            break;

        case 'join':
            joinRoom(ws, data.roomCode, data.version);
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

function createRoom(ws, roomCode, version) {
    const existingRoom = rooms.get(roomCode);

    // Allow host to reclaim their room if they disconnected briefly
    if (existingRoom) {
        if (existingRoom.host === null && existingRoom.hostDisconnectedAt) {
            // Host is reconnecting - reclaim the room
            existingRoom.host = ws;
            existingRoom.hostDisconnectedAt = null;
            existingRoom.hostVersion = version || 'unknown';
            ws.send(JSON.stringify({ type: 'room_created', roomCode }));
            console.log(`Room ${roomCode} reclaimed by host (v${version})`);
            return;
        }
        ws.send(JSON.stringify({ type: 'error', message: 'Room already exists' }));
        return;
    }

    rooms.set(roomCode, {
        host: ws,
        guest: null,
        hostVersion: version || 'unknown',
        guestVersion: null,
        hostPlan: null,
        guestPlan: null,
        hostRematch: false,
        guestRematch: false,
        hostDisconnectedAt: null
    });

    ws.send(JSON.stringify({ type: 'room_created', roomCode }));
    console.log(`Room ${roomCode} created (v${version}). Total rooms:`, rooms.size);
}

function joinRoom(ws, roomCode, version) {
    const room = rooms.get(roomCode);

    if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
    }

    // Check if host is temporarily disconnected
    if (!room.host || room.host.readyState !== WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: 'Host is reconnecting, try again in a moment' }));
        return;
    }

    if (room.guest) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
        return;
    }

    // Check version match
    if (room.hostVersion !== version) {
        // Notify both players of version mismatch
        room.host.send(JSON.stringify({
            type: 'version_mismatch',
            otherVersion: version || 'unknown'
        }));
        ws.send(JSON.stringify({
            type: 'version_mismatch',
            otherVersion: room.hostVersion
        }));
        // Clean up the room
        rooms.delete(roomCode);
        console.log(`Room ${roomCode} closed due to version mismatch (host: ${room.hostVersion}, guest: ${version})`);
        return;
    }

    room.guest = ws;
    room.guestVersion = version;

    // Notify both players
    room.host.send(JSON.stringify({ type: 'player_joined' }));
    ws.send(JSON.stringify({ type: 'player_joined' }));

    console.log(`Player joined room ${roomCode} (v${version})`);
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

// Clean up stale rooms every 30 seconds
setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms.entries()) {
        // Clean up rooms where host disconnected more than 60 seconds ago
        if (room.hostDisconnectedAt && (now - room.hostDisconnectedAt > 60000)) {
            rooms.delete(code);
            console.log(`Cleaned up room ${code} - host didn't reconnect within 60s`);
            continue;
        }
        // Clean up fully stale rooms
        if ((!room.host || room.host.readyState !== WebSocket.OPEN) &&
            (!room.guest || room.guest.readyState !== WebSocket.OPEN) &&
            !room.hostDisconnectedAt) {
            rooms.delete(code);
            console.log(`Cleaned up stale room ${code}`);
        }
    }
}, 30000);

wss.on('close', () => {
    clearInterval(heartbeat);
});

// Start the server
server.listen(PORT, () => {
    console.log(`SYNC STRIKE Server running on port ${PORT}`);
});
