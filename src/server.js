// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');

// ==========================================================================
// Server Setup
// ==========================================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ==========================================================================
// In-Memory State Management
// ==========================================================================
const draftRooms = new Map(); // Map<roomCode, draftState>

// ==========================================================================
// Utility Functions
// ==========================================================================

/** Generates a unique room code */
function generateRoomCode(length = 5) {
    const characters = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789';
    let result = '';
    do {
        result = ''; // Reset in case of collision
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
    } while (draftRooms.has(result)); // Ensure uniqueness
    return result;
}

/** Calculates the next turn logic for a given room state */
function calculateNextTurn(currentState) {
    // Basic validation of input state
    if (!currentState?.settings?.numTables || currentState.settings.numTables <= 0 || !currentState.settings.playersPerPos) {
        console.warn("calculateNextTurn called with invalid state/settings.");
        return { nextTableToPick: 0, currentPickDirection: 1 }; // Default turn
    }

    const { numTables, playersPerPos, isSerpentineOrder } = currentState.settings;
    const currentPicks = currentState.picks || [];
    let currentPickDirection = currentState.currentPickDirection ?? 1; // Default direction if missing
    let lastActiveTableIndex = -1;

    if (currentPicks.length > 0) {
        lastActiveTableIndex = currentPicks[currentPicks.length - 1].tableId;
    } else {
        return { nextTableToPick: 0, currentPickDirection: 1 }; // First pick
    }

    // Calculate total slots
    const totalSlotsPerTable = Object.values(playersPerPos).reduce((sum, count) => sum + (count || 0), 0);
    const totalSlots = numTables * totalSlotsPerTable;

    // Check for draft completion
    if (totalSlots > 0 && currentPicks.length >= totalSlots) {
        return { nextTableToPick: -1, currentPickDirection }; // Draft complete
    }

    // Determine if direction reverses (serpentine)
    const isEndOfForwardRound = (currentPickDirection === 1 && lastActiveTableIndex === numTables - 1);
    const isEndOfBackwardRound = (currentPickDirection === -1 && lastActiveTableIndex === 0);
    const isTurn = isSerpentineOrder && (isEndOfForwardRound || isEndOfBackwardRound);

    let nextTableToPick;
    if (isTurn) {
        currentPickDirection *= -1; // Reverse direction
        nextTableToPick = lastActiveTableIndex; // Same table picks again
    } else {
        // Move to the next table in the current direction, wrapping around
        nextTableToPick = (lastActiveTableIndex + currentPickDirection + numTables) % numTables;
    }

    return { nextTableToPick, currentPickDirection };
}

// ==========================================================================
// Express Middleware & Routing
// ==========================================================================

// --- Calculate Paths ---
const publicDirPath = path.join(__dirname, 'public');
const indexHtmlPath = path.join(publicDirPath, 'index.html');

// --- Serve Static Files ---
app.use(express.static(publicDirPath));

// --- Handle Root Route ---
app.get('/', (req, res) => {
  if (fs.existsSync(indexHtmlPath)) {
      res.sendFile(indexHtmlPath);
  } else {
      console.error(`FATAL ERROR: index.html not found at ${indexHtmlPath}`);
      res.status(404).send(`Error: Main application file not found.`);
  }
});

// ==========================================================================
// Socket.IO Connection Handling
// ==========================================================================
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // --- Draft Lifecycle Events ---

    socket.on('start_draft', (settings) => {
        console.log(`[${socket.id}] Request to start draft:`, settings);

        // Enhanced Validation
        if (!settings || typeof settings.numTables !== 'number' || settings.numTables < 1 ||
            !settings.playersPerPos || typeof settings.playersPerPos !== 'object' ||
            typeof settings.maxSalary !== 'number' || settings.maxSalary < 0 ||
            !settings.tableNames || typeof settings.tableNames !== 'object')
        {
            console.error(`[${socket.id}] Invalid draft settings received.`);
            socket.emit('error', { message: "Invalid draft settings provided." });
            return;
        }
        // Ensure player counts are valid numbers >= 0
        const positions = ['A', 'D', 'G'];
        for (const pos of positions) {
            if (typeof settings.playersPerPos[pos] !== 'number' || settings.playersPerPos[pos] < 0) {
                 console.error(`[${socket.id}] Invalid player count for position ${pos}.`);
                 socket.emit('error', { message: `Invalid player count for position ${pos}.` });
                 return;
            }
        }
        if (positions.reduce((sum, pos) => sum + settings.playersPerPos[pos], 0) === 0) {
             console.error(`[${socket.id}] Total players per table cannot be zero.`);
             socket.emit('error', { message: "Total players per table cannot be zero." });
             return;
        }


        const roomCode = generateRoomCode();
        console.log(`[${socket.id}] Generated room code: ${roomCode}`);

        const newRoomState = {
            settings: settings, // Already validated somewhat
            picks: [],
            selectedPlayerIds: new Set(),
            nextTableToPick: 0,
            currentPickDirection: 1,
            isSerpentineOrder: !!settings.isSerpentineOrder,
            roomCode: roomCode, // Include code in state
            participants: new Set([socket.id]) // Track participants
        };

        draftRooms.set(roomCode, newRoomState);
        socket.join(roomCode);
        console.log(`[${socket.id}] Created and joined room ${roomCode}`);

        // Emit back to creator ONLY
        const stateToSend = {
            ...newRoomState,
            selectedPlayerIds: [], // Send empty array initially
            participants: Array.from(newRoomState.participants) // Send participants
        };
        socket.emit('draft_started', { roomCode: roomCode, draftState: stateToSend });
    });

    socket.on('join_draft', ({ roomCode }) => {
        const upperRoomCode = roomCode?.trim().toUpperCase();
        console.log(`[${socket.id}] Attempting to join room ${upperRoomCode}`);

        if (!upperRoomCode) {
             socket.emit('join_error', { message: `Invalid room code provided.` });
             return;
        }

        if (draftRooms.has(upperRoomCode)) {
            const roomState = draftRooms.get(upperRoomCode);

            socket.join(upperRoomCode);
            roomState.participants.add(socket.id); // Add participant
            console.log(`[${socket.id}] Successfully joined room ${upperRoomCode}`);

            // Send current state to the joining client
            const stateToSend = {
                ...roomState,
                selectedPlayerIds: Array.from(roomState.selectedPlayerIds), // Send current selections
                participants: Array.from(roomState.participants)
            };
            socket.emit('draft_state_update', { roomCode: upperRoomCode, draftState: stateToSend });

            // Notify others in the room (optional)
            const notificationData = { roomCode: upperRoomCode, draftState: { participants: Array.from(roomState.participants) } };
            socket.to(upperRoomCode).emit('draft_state_update', notificationData); // Send only participant update to others

        } else {
            console.log(`[${socket.id}] Join failed: Room ${upperRoomCode} not found.`);
            socket.emit('join_error', { message: `Draft room "${upperRoomCode}" not found.` });
        }
    });

    // --- In-Draft Actions ---

    socket.on('make_pick', ({ roomCode, pickData }) => {
        console.log(`[${socket.id}] Pick received for room ${roomCode}:`, pickData);
        const roomState = draftRooms.get(roomCode);

        // Validation
        if (!roomState) return socket.emit('pick_error', { message: "Draft room not found." });
        if (!pickData || typeof pickData.playerId !== 'number' || typeof pickData.tableId !== 'number') {
            return socket.emit('pick_error', { message: "Invalid pick data format." });
        }
        if (pickData.tableId !== roomState.nextTableToPick) {
            return socket.emit('pick_error', { message: `It's not Table ${pickData.tableId + 1}'s turn.` });
        }
        if (roomState.selectedPlayerIds.has(pickData.playerId)) {
            return socket.emit('pick_error', { message: "Player already selected." });
        }
        const { position, tableId } = pickData; // Get position and tableId from pickData
        const { playersPerPos } = roomState.settings; // Get position limits from settings

        if (!position || !playersPerPos || playersPerPos[position] === undefined) {
            console.error(`[Pick Error] Room ${roomCode}: Invalid position '${position}' in pickData or settings.`);
            return socket.emit('pick_error', { message: `Invalid player position specified.` });
        }

        const requiredCountForPos = playersPerPos[position];
        const currentPicksForTable = roomState.picks.filter(p => p.tableId === tableId && p.position === position);
        const currentCountForPos = currentPicksForTable.length;

        console.log(`[Pick Validation] Room ${roomCode}, Table ${tableId}, Pos ${position}: Current ${currentCountForPos}, Required ${requiredCountForPos}`);

        if (currentCountForPos >= requiredCountForPos) {
            console.warn(`[Pick Error] Room ${roomCode}: Table ${tableId} already has ${currentCountForPos}/${requiredCountForPos} players for position ${position}.`);
            return socket.emit('pick_error', { message: `All ${position} slots are already filled for ${roomState.settings.tableNames[tableId] || `Table ${tableId + 1}`}.` });
        }

        // Process Pick
        const newPicks = [...roomState.picks, pickData];
        roomState.selectedPlayerIds.add(pickData.playerId);
        roomState.picks = newPicks; // Update room state directly

        // Calculate next turn
        const { nextTableToPick, currentPickDirection } = calculateNextTurn(roomState);
        roomState.nextTableToPick = nextTableToPick;
        roomState.currentPickDirection = currentPickDirection;

        console.log(`[${roomCode}] Next turn: Table ${roomState.nextTableToPick}, Dir: ${roomState.currentPickDirection}`);

        // Prepare state to broadcast
        const stateToSend = {
            ...roomState, // Includes settings, picks, turn info, roomCode
            selectedPlayerIds: Array.from(roomState.selectedPlayerIds),
            participants: Array.from(roomState.participants)
        };

        // Broadcast update to the room
        io.to(roomCode).emit('draft_state_update', { roomCode: roomCode, draftState: stateToSend });
    });

    socket.on('undo_pick', ({ roomCode }) => {
        console.log(`[${socket.id}] Undo request for room ${roomCode}`);
        const roomState = draftRooms.get(roomCode);

        if (!roomState) return socket.emit('error', { message: "Draft room not found." });
        if (roomState.picks.length === 0) return socket.emit('error', { message: "No picks to undo." });

        // Process Undo
        const lastPick = roomState.picks.pop(); // Mutates the array
        if (lastPick) {
            roomState.selectedPlayerIds.delete(lastPick.playerId);
            console.log(`[${roomCode}] Undid pick: Player ID ${lastPick.playerId}`);

            // Recalculate turn state
            const { nextTableToPick, currentPickDirection } = calculateNextTurn(roomState);
            roomState.nextTableToPick = nextTableToPick;
            roomState.currentPickDirection = currentPickDirection;

            console.log(`[${roomCode}] State after undo: Next turn Table ${roomState.nextTableToPick}`);

            // Prepare and broadcast updated state
            const stateToSend = {
                ...roomState,
                selectedPlayerIds: Array.from(roomState.selectedPlayerIds),
                 participants: Array.from(roomState.participants)
            };
            io.to(roomCode).emit('draft_state_update', { roomCode: roomCode, draftState: stateToSend });

        } else {
             console.error(`[${roomCode}] Undo failed: Popped pick was undefined.`);
             socket.emit('error', { message: "Undo failed unexpectedly." });
        }
   });

  socket.on('update_table_name', ({ roomCode, tableId, newName }) => {
    console.log(`[${socket.id}] Table name update for room ${roomCode}: Table ${tableId} -> ${newName}`);
    const roomState = draftRooms.get(roomCode);

    // Validation
    if (!roomState?.settings?.tableNames) return socket.emit('error', { message: "Draft room or settings not found." });
    if (typeof tableId !== 'number' || tableId < 0 || tableId >= roomState.settings.numTables || typeof newName !== 'string') {
        return socket.emit('error', { message: "Invalid table name update request." });
    }

    // Process Update
    const finalName = newName.trim() || `Table ${tableId + 1}`; // Use default if empty
    roomState.settings.tableNames[tableId] = finalName;

    // Prepare and broadcast update (only need to send settings part if optimized)
    const stateToSend = {
        ...roomState,
        selectedPlayerIds: Array.from(roomState.selectedPlayerIds),
        participants: Array.from(roomState.participants)
    };
    io.to(roomCode).emit('draft_state_update', { roomCode: roomCode, draftState: stateToSend });
  });

    // --- Disconnection Handling ---

    socket.on('disconnect', (reason) => {
        console.log(`User disconnected: ${socket.id}, Reason: ${reason}`);
        // Basic Room Cleanup (Optional but recommended)
        draftRooms.forEach((roomState, roomCode) => {
            if (roomState.participants.has(socket.id)) {
                roomState.participants.delete(socket.id);
                console.log(`[${socket.id}] Removed from room ${roomCode}`);

                // If room is now empty, remove it after a delay (or immediately)
                if (roomState.participants.size === 0) {
                    // Delay removal slightly in case of quick reconnects? Or remove immediately.
                    setTimeout(() => {
                        // Double check size before deleting
                        if (draftRooms.get(roomCode)?.participants.size === 0) {
                            draftRooms.delete(roomCode);
                            console.log(`Room ${roomCode} is empty and has been removed.`);
                        }
                    }, 60000); // Remove after 1 minute of being empty
                } else {
                    // Notify remaining participants
                    const notificationData = { roomCode: roomCode, draftState: { participants: Array.from(roomState.participants) } };
                    io.to(roomCode).emit('draft_state_update', notificationData);
                }
            }
        });
    });
});

// ==========================================================================
// Start Server
// ==========================================================================
server.listen(PORT, () => {
  console.log(`Server listening on *:${PORT}`);
});
