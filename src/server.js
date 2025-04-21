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
const ROOM_CLEANUP_DELAY_SHORT = 60 * 1000; // 1 minute in ms
const ROOM_CLEANUP_DELAY_LONG = 24 * 60 * 60 * 1000; // 24 hours in ms

// ==========================================================================
// In-Memory State Management
// ==========================================================================
// Stores the state for each active draft room.
// Key: roomCode (string), Value: draftState (object)
const draftRooms = new Map();

// ==========================================================================
// Utility Functions
// ==========================================================================

/**
 * Generates a unique room code consisting of uppercase letters and numbers.
 * @param {number} [length=5] - The desired length of the room code.
 * @returns {string} A unique room code.
 */
function generateRoomCode(length = 5) {
    const characters = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789';
    let result = '';
    do {
        result = ''; // Reset in case of collision
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
    } while (draftRooms.has(result)); // Ensure uniqueness against active rooms
    return result;
}

/**
 * Calculates the next team to pick and the pick direction based on the current state.
 * @param {object} currentState - The current state object for the draft room.
 * @returns {{nextTableToPick: number, currentPickDirection: number}} - The index of the next team and the direction.
 */
function calculateNextTurn(currentState) {
    // Validate essential settings
    if (!currentState?.settings?.numTables || currentState.settings.numTables <= 0 || !currentState.settings.playersPerPos) {
        console.warn("[calculateNextTurn] Invalid state/settings provided. Defaulting turn.", currentState?.settings);
        return { nextTableToPick: 0, currentPickDirection: 1 }; // Default to first team, forward direction
    }

    const { numTables, playersPerPos, isSerpentineOrder } = currentState.settings;
    const currentPicks = currentState.picks || [];
    let currentPickDirection = currentState.currentPickDirection ?? 1; // Default to forward if missing

    // If no picks made yet, it's the first team's turn
    if (currentPicks.length === 0) {
        return { nextTableToPick: 0, currentPickDirection: 1 };
    }

    const lastPick = currentPicks[currentPicks.length - 1];
    const lastActiveTableIndex = lastPick.teamId;

    // Calculate total slots to determine draft completion
    const totalSlotsPerTable = Object.values(playersPerPos).reduce((sum, count) => sum + (count || 0), 0);
    const totalSlots = numTables * totalSlotsPerTable;

    // Check if draft is complete
    if (totalSlots > 0 && currentPicks.length >= totalSlots) {
        return { nextTableToPick: -1, currentPickDirection }; // Indicate draft completion
    }

    // Determine if the direction should reverse in serpentine drafts
    const isEndOfForwardRound = (currentPickDirection === 1 && lastActiveTableIndex === numTables - 1);
    const isEndOfBackwardRound = (currentPickDirection === -1 && lastActiveTableIndex === 0);
    const shouldReverseDirection = isSerpentineOrder && (isEndOfForwardRound || isEndOfBackwardRound);

    let nextTableToPick;
    if (shouldReverseDirection) {
        currentPickDirection *= -1; // Reverse direction
        nextTableToPick = lastActiveTableIndex; // Same team picks again at the turn
    } else {
        // Move to the next table in the current direction, wrapping if necessary
        nextTableToPick = (lastActiveTableIndex + currentPickDirection + numTables) % numTables;
    }

    return { nextTableToPick, currentPickDirection };
}

/**
 * Prepares the room state for sending over Socket.IO (converts Sets to Arrays).
 * @param {object} roomState - The internal room state object.
 * @returns {object} A sanitized state object suitable for emission.
 */
function prepareStateForEmit(roomState) {
    if (!roomState) return null;
    return {
        ...roomState,
        selectedPlayerIds: Array.from(roomState.selectedPlayerIds || new Set()),
        participants: Array.from(roomState.participants || new Set())
    };
}

/**
 * Schedules the removal of an empty draft room after a specified delay.
 * @param {string} roomCode - The code of the room to potentially remove.
 * @param {number} delay - The delay in milliseconds before removal.
 */
function scheduleEmptyRoomRemoval(roomCode, delay) {
    setTimeout(() => {
        const room = draftRooms.get(roomCode);
        // Double-check if the room still exists and is still empty before deleting
        if (room?.participants.size === 0) {
            draftRooms.delete(roomCode);
            console.log(`[Cleanup] Room ${roomCode} was empty and has been removed after delay.`);
        } else {
            console.log(`[Cleanup] Room ${roomCode} removal cancelled (no longer empty or deleted).`);
        }
    }, delay);
}


// ==========================================================================
// Express Middleware & Routing
// ==========================================================================

const publicDirPath = path.join(__dirname, 'public');
//const indexHtmlPath = path.join(publicDirPath, 'index.html');

// Serve static files (HTML, CSS, client-side JS)
app.use(express.static(publicDirPath));
  

// ==========================================================================
// Socket.IO Connection Handling
// ==========================================================================
io.on('connection', (socket) => {
    console.log(`[Connect] User connected: ${socket.id}`);

    // --- Draft Lifecycle Events ---

    socket.on('start_draft', (settings) => {
        console.log(`[${socket.id}] Event: start_draft`, settings);

        // --- Settings Validation ---
        let validationError = null;
        if (!settings || typeof settings !== 'object') {
            validationError = "Invalid settings object provided.";
        } else if (typeof settings.numTables !== 'number' || settings.numTables < 1) {
            validationError = "Invalid number of teams provided.";
        } else if (!settings.playersPerPos || typeof settings.playersPerPos !== 'object') {
            validationError = "Invalid player position settings provided.";
        } else if (typeof settings.maxSalary !== 'number' || settings.maxSalary < 0) {
            validationError = "Invalid maximum salary provided.";
        } else if (!settings.tableNames || typeof settings.tableNames !== 'object') {
            validationError = "Invalid table names data provided.";
        }

        if (!validationError) {
            const positions = ['F', 'D', 'G'];
            for (const pos of positions) {
                if (typeof settings.playersPerPos[pos] !== 'number' || settings.playersPerPos[pos] < 0) {
                    validationError = `Invalid player count for position ${pos}.`;
                    break;
                }
            }
            if (!validationError && positions.reduce((sum, pos) => sum + (settings.playersPerPos[pos] || 0), 0) === 0) {
                validationError = "Total players per team cannot be zero.";
            }
        }

        if (validationError) {
            console.error(`[${socket.id}] Start draft validation failed: ${validationError}`);
            socket.emit('error', { message: validationError });
            return;
        }
        // --- End Validation ---

        const roomCode = generateRoomCode();
        console.log(`[${socket.id}] Generated room code: ${roomCode}`);

        const newRoomState = {
            settings: settings,
            picks: [],
            selectedPlayerIds: new Set(),
            nextTableToPick: 0, // First team starts
            currentPickDirection: 1, // Initial direction is forward
            isSerpentineOrder: !!settings.isSerpentineOrder, // Ensure boolean
            roomCode: roomCode,
            participants: new Set([socket.id]) // Add creator as first participant
        };

        draftRooms.set(roomCode, newRoomState);
        socket.join(roomCode);
        console.log(`[${socket.id}] Created and joined room ${roomCode}`);

        // Emit 'draft_started' only to the creator with the initial state
        const stateToSend = prepareStateForEmit(newRoomState);
        socket.emit('draft_started', { roomCode: roomCode, draftState: stateToSend });
    });

    socket.on('join_draft', ({ roomCode }) => {
        const upperRoomCode = roomCode?.trim().toUpperCase();
        console.log(`[${socket.id}] Event: join_draft attempt for room ${upperRoomCode}`);

        if (!upperRoomCode) {
             console.warn(`[${socket.id}] Join failed: Invalid room code provided.`);
             socket.emit('join_error', { message: `Invalid room code provided.` });
             return;
        }

        const roomState = draftRooms.get(upperRoomCode);

        if (roomState) {
            socket.join(upperRoomCode);
            roomState.participants.add(socket.id); // Add new participant
            console.log(`[${socket.id}] Successfully joined room ${upperRoomCode}. Participants: ${roomState.participants.size}`);

            // Send the full current state ONLY to the newly joined user
            const fullStateToSend = prepareStateForEmit(roomState);
            socket.emit('draft_state_update', { roomCode: upperRoomCode, draftState: fullStateToSend });
            console.log(`[${socket.id}] Emitted full state (draft_state_update) to joiner.`);

            // Send an update with just the new participant list to OTHERS already in the room
            const participantUpdatePayload = {
                roomCode: upperRoomCode,
                participants: Array.from(roomState.participants) // Send only the updated list
            };
            socket.to(upperRoomCode).emit('participant_update', participantUpdatePayload);
            console.log(`[${socket.id}] Emitted participant_update to others in room ${upperRoomCode}.`);

        } else {
            console.warn(`[${socket.id}] Join failed: Room ${upperRoomCode} not found.`);
            socket.emit('join_error', { message: `Draft room "${upperRoomCode}" not found.` });
        }
    });

    // --- In-Draft Actions ---

    socket.on('make_pick', ({ roomCode, pickData }) => {
        console.log(`[${socket.id}] Event: make_pick for room ${roomCode}:`, pickData?.playerId);
        const roomState = draftRooms.get(roomCode);

        // --- Pick Validation ---
        let validationError = null;
        if (!roomState) {
            validationError = "Draft room not found.";
        } else if (!pickData || typeof pickData !== 'object') {
            validationError = "Invalid pick data format.";
        } else if (typeof pickData.playerId !== 'number' || typeof pickData.teamId !== 'number' ||
                   typeof pickData.playerName !== 'string' || typeof pickData.salary !== 'number' ||
                   typeof pickData.position !== 'string' || typeof pickData.team_url !== 'string') {
            validationError = "Incomplete pick data received.";
        } else if (pickData.teamId !== roomState.nextTableToPick) {
            validationError = `It's not Team ${pickData.teamId + 1}'s turn.`;
        } else if (roomState.selectedPlayerIds.has(pickData.playerId)) {
            validationError = "Player already selected.";
        } else {
            const { position, teamId } = pickData;
            const { playersPerPos, tableNames } = roomState.settings;

            if (!['F', 'D', 'G'].includes(position) || !playersPerPos || playersPerPos[position] === undefined) {
                validationError = `Invalid player position specified ('${position}').`;
            } else {
                const requiredCountForPos = playersPerPos[position];
                const currentCountForPos = roomState.picks.filter(p => p.teamId === teamId && p.position === position).length;

                if (currentCountForPos >= requiredCountForPos) {
                    const teamName = tableNames[teamId] || `Team ${teamId + 1}`;
                    validationError = `All ${position} slots are already filled for ${teamName}.`;
                }
            }
        }

        if (validationError) {
            console.warn(`[Pick Error] Room ${roomCode}, User ${socket.id}: ${validationError}`);
            socket.emit('pick_error', { message: validationError });
            return;
        }
        // --- End Validation ---

        // Process Pick
        const pickToStore = { // Ensure we only store expected fields
            playerId: pickData.playerId,
            playerName: pickData.playerName,
            salary: pickData.salary,
            position: pickData.position,
            teamId: pickData.teamId,
            team_url: pickData.team_url,
            city: pickData.city || '' // Include city, default to empty string
        };
        roomState.picks.push(pickToStore); // Add to picks array
        roomState.selectedPlayerIds.add(pickData.playerId); // Add to set for quick lookup

        // Calculate next turn
        const { nextTableToPick, currentPickDirection } = calculateNextTurn(roomState);
        roomState.nextTableToPick = nextTableToPick;
        roomState.currentPickDirection = currentPickDirection;

        console.log(`[${roomCode}] Pick successful. Next turn: Team ${nextTableToPick}, Dir: ${currentPickDirection}`);

        // Broadcast updated state to the entire room
        const stateToSend = prepareStateForEmit(roomState);
        io.to(roomCode).emit('draft_state_update', { roomCode: roomCode, draftState: stateToSend });
    });

    socket.on('undo_pick', ({ roomCode }) => {
        console.log(`[${socket.id}] Event: undo_pick for room ${roomCode}`);
        const roomState = draftRooms.get(roomCode);

        if (!roomState) {
            console.warn(`[Undo Error] Room ${roomCode} not found.`);
            return socket.emit('error', { message: "Draft room not found." });
        }
        if (roomState.picks.length === 0) {
            console.warn(`[Undo Error] Room ${roomCode}: No picks to undo.`);
            return socket.emit('error', { message: "No picks to undo." });
        }

        // Process Undo
        const lastPick = roomState.picks.pop(); // Remove last pick from array
        if (lastPick) {
            roomState.selectedPlayerIds.delete(lastPick.playerId); // Remove from selected set
            console.log(`[${roomCode}] Undid pick for Player ID ${lastPick.playerId}`);

            // Recalculate whose turn it is now
            const { nextTableToPick, currentPickDirection } = calculateNextTurn(roomState);
            roomState.nextTableToPick = nextTableToPick;
            roomState.currentPickDirection = currentPickDirection;
            console.log(`[${roomCode}] State after undo: Next turn Team ${nextTableToPick}`);

            // Broadcast updated state
            const stateToSend = prepareStateForEmit(roomState);
            io.to(roomCode).emit('draft_state_update', { roomCode: roomCode, draftState: stateToSend });

        } else {
             // Should not happen if picks.length > 0 check passed, but good to log
             console.error(`[${roomCode}] Undo failed unexpectedly: Popped pick was undefined.`);
             socket.emit('error', { message: "Undo failed unexpectedly." });
        }
   });

    socket.on('update_table_name', ({ roomCode, teamId, newName }) => {
        console.log(`[${socket.id}] Event: update_table_name for room ${roomCode}: Team ${teamId} -> "${newName}"`);
        const roomState = draftRooms.get(roomCode);

        // Validation
        if (!roomState?.settings?.tableNames) {
            console.warn(`[Name Update Error] Room ${roomCode} or settings not found.`);
            return socket.emit('error', { message: "Draft room or settings not found." });
        }
        if (typeof teamId !== 'number' || teamId < 0 || teamId >= roomState.settings.numTables || typeof newName !== 'string') {
            console.warn(`[Name Update Error] Invalid data: teamId=${teamId}, newName type=${typeof newName}`);
            return socket.emit('error', { message: "Invalid table name update request data." });
        }

        // Process Update
        const finalName = newName.trim() || `Team ${teamId + 1}`; // Use default if empty/whitespace
        roomState.settings.tableNames[teamId] = finalName;
        console.log(`[${roomCode}] Team ${teamId} name updated to "${finalName}"`);

        // Broadcast the full state update (simplest approach)
        const stateToSend = prepareStateForEmit(roomState);
        io.to(roomCode).emit('draft_state_update', { roomCode: roomCode, draftState: stateToSend });
    });

    // --- Disconnection & Leaving ---

    /** Handles cleanup when a socket disconnects or explicitly leaves a room. */
    function handleLeaveOrDisconnect(leavingSocketId, roomCode) {
        const roomState = draftRooms.get(roomCode);
        if (!roomState || !roomState.participants.has(leavingSocketId)) {
            // Socket wasn't in this room's participant list, nothing to do for this room
            return;
        }

        // Remove participant
        roomState.participants.delete(leavingSocketId);
        console.log(`[${leavingSocketId}] Removed from participants list for room ${roomCode}. Remaining: ${roomState.participants.size}`);

        // Check if room is now empty
        if (roomState.participants.size === 0) {
            console.log(`[Cleanup] Room ${roomCode} is now empty.`);
            // Schedule removal after a delay (longer delay for explicit leave vs disconnect)
            const delay = (leavingSocketId === socket.id) ? ROOM_CLEANUP_DELAY_LONG : ROOM_CLEANUP_DELAY_SHORT;
            scheduleEmptyRoomRemoval(roomCode, delay);
        } else {
            // Notify remaining participants about the change
            const participantUpdatePayload = {
                roomCode: roomCode,
                participants: Array.from(roomState.participants)
            };
            // Use io.to() because the leaving socket might already be disconnected
            io.to(roomCode).emit('participant_update', participantUpdatePayload);
            console.log(`[${leavingSocketId}] Emitted participant_update to remaining users in room ${roomCode}.`);
        }
    }

    socket.on('disconnect', (reason) => {
        console.log(`[Disconnect] User disconnected: ${socket.id}, Reason: ${reason}`);
        // Iterate through all rooms the user might have been in
        draftRooms.forEach((roomState, roomCode) => {
            handleLeaveOrDisconnect(socket.id, roomCode);
        });
    });

    socket.on('leave_draft', ({ roomCode }) => {
        const upperRoomCode = roomCode?.trim().toUpperCase();
        console.log(`[${socket.id}] Event: leave_draft request for room ${upperRoomCode}`);

        if (!upperRoomCode) {
            console.warn(`[${socket.id}] Invalid room code provided for leave_draft.`);
            return; // No error emit needed, just ignore invalid request
        }

        const roomState = draftRooms.get(upperRoomCode);

        if (roomState && roomState.participants.has(socket.id)) {
            // Leave the Socket.IO room first
            socket.leave(upperRoomCode);
            console.log(`[${socket.id}] Left Socket.IO room ${upperRoomCode}.`);
            // Then handle participant list update and potential cleanup
            handleLeaveOrDisconnect(socket.id, upperRoomCode);
        } else {
            console.warn(`[${socket.id}] Tried to leave room ${upperRoomCode}, but was not found or not a participant.`);
            // Attempt to leave the Socket.IO room anyway, in case of inconsistent state
            socket.leave(upperRoomCode);
        }
    });
});

// ==========================================================================
// Start Server
// ==========================================================================
server.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});
