// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io"); // Import Server class from socket.io
const path = require('path');

const app = express();
const server = http.createServer(app); // Create HTTP server using Express app
const io = new Server(server); // Attach Socket.IO to the HTTP server

const PORT = process.env.PORT || 3000; // Use environment variable or default port

// --- Central Draft State (Server-Side) ---
let draftState = {
    settings: null, // Will hold { numTables, tableNames, maxSalary, playersPerPos, etc. }
    picks: [], // Array to store pick history { playerId, tableId, playerName, salary, etc. }
    selectedPlayerIds: new Set(),
    nextTableToPick: 0,
    currentPickDirection: 1,
    isSerpentineOrder: false,
};

// --- Server-Side Turn Calculation Logic ---
// Moved outside the 'connection' handler so it's defined only once
function calculateNextTurn(currentState) {
    if (!currentState.settings || currentState.settings.numTables <= 0) {
        return { // Return default state if settings are invalid
            nextTableToPick: 0,
            currentPickDirection: 1
        };
    }

    const { numTables, playersPerPos, isSerpentineOrder } = currentState.settings;
    const currentPicks = currentState.picks || [];
    let currentPickDirection = currentState.currentPickDirection;
    let lastActiveTableIndex = -1; // Determine the table that just picked

    if (currentPicks.length > 0) {
        lastActiveTableIndex = currentPicks[currentPicks.length - 1].tableId;
    } else {
        // Should not happen if called after the first pick, but handle defensively.
        return { nextTableToPick: 0, currentPickDirection: 1 };
    }

    // Calculate total slots to check for draft completion
    // Ensure playersPerPos exists and is an object before reducing
    const validPlayersPerPos = playersPerPos || {};
    const totalSlotsPerTable = Object.keys(validPlayersPerPos).reduce((sum, pos) => sum + (validPlayersPerPos[pos] || 0), 0);
    const totalSlots = numTables * totalSlotsPerTable;

    // Check if the pick just made completed the draft
    if (totalSlots > 0 && currentPicks.length >= totalSlots) {
        return { // Draft complete state
            nextTableToPick: -1, // Indicate no next pick
            currentPickDirection: currentPickDirection // Keep last direction
        };
    }

    // Determine if direction reverses (serpentine)
    const isEndOfRound = (currentPickDirection === 1 && lastActiveTableIndex === numTables - 1) ||
                         (currentPickDirection === -1 && lastActiveTableIndex === 0);

    let nextTableToPick;

    if (isSerpentineOrder && isEndOfRound) {
        // Reverse direction and the same table picks again at the turn
        currentPickDirection *= -1;
        nextTableToPick = lastActiveTableIndex;
    } else {
        // Move to the next table in the current direction
        nextTableToPick = (lastActiveTableIndex + currentPickDirection + numTables) % numTables;
    }

    return {
        nextTableToPick: nextTableToPick,
        currentPickDirection: currentPickDirection
    };
}


// --- Serve Static Files ---
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Handle Root Route ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Send the current draft state to the newly connected user
  // Convert Set to Array before sending initial state
  const initialStateToSend = {
      ...draftState,
      selectedPlayerIds: Array.from(draftState.selectedPlayerIds)
  };
  socket.emit('draft_state_update', initialStateToSend);

  // --- Handle Client Actions ---

  socket.on('start_draft', (settings) => {
    console.log('Draft started with settings:', settings);
    // Basic validation (expand as needed)
    if (!settings || typeof settings.numTables !== 'number' || settings.numTables < 1) {
        socket.emit('error', { message: "Invalid draft settings provided." });
        return;
    }

    // Reset state for a new draft
    draftState.settings = settings;
    draftState.picks = [];
    draftState.selectedPlayerIds.clear();
    draftState.nextTableToPick = 0; // Start with the first table
    draftState.currentPickDirection = 1; // Start going forward
    draftState.isSerpentineOrder = !!settings.isSerpentineOrder; // Ensure boolean

    // Broadcast the updated state to ALL connected clients
    // Convert Set to Array for JSON serialization
    const stateToSend = {
        ...draftState,
        selectedPlayerIds: Array.from(draftState.selectedPlayerIds)
    };
    io.emit('draft_state_update', stateToSend);
  });

  socket.on('make_pick', (pickData) => {
    console.log(`Pick received from ${socket.id}:`, pickData);

    // --- Server-Side Validation ---
    let isValidPick = true;
    let errorMessage = "";

    if (!draftState.settings) {
        isValidPick = false;
        errorMessage = "Draft has not started.";
    } else if (pickData.tableId !== draftState.nextTableToPick) {
        isValidPick = false;
        errorMessage = `It's not Table ${pickData.tableId + 1}'s turn (Expected: ${draftState.nextTableToPick + 1}).`;
    } else if (!pickData || typeof pickData.playerId !== 'number') {
         isValidPick = false;
         errorMessage = "Invalid player data received.";
    } else if (draftState.selectedPlayerIds.has(pickData.playerId)) {
        isValidPick = false;
        errorMessage = "Player already selected.";
    }
    // TODO: Add more validation

    // --- Process Pick if Valid ---
    if (isValidPick) {
        // 1. Create a *new* picks array
        const newPicks = [...draftState.picks, pickData];
        // 2. Add player ID to the Set
        draftState.selectedPlayerIds.add(pickData.playerId); // Modifying the Set directly is okay

        // 3. Create a temporary state object for calculation
        const stateForCalc = {
            ...draftState, // Copy existing state
            picks: newPicks // Use the new picks array
        };

        // 4. Calculate the next turn based on the temporary state
        const { nextTableToPick, currentPickDirection } = calculateNextTurn(stateForCalc);

        // 5. Update the main draftState object
        draftState.picks = newPicks; // Assign the new picks array
        draftState.nextTableToPick = nextTableToPick;
        draftState.currentPickDirection = currentPickDirection;

        console.log(`Next turn calculated: Table ${draftState.nextTableToPick}, Direction: ${draftState.currentPickDirection}`);

        // 6. Prepare state to send (convert Set to Array)
        const stateToSend = {
            settings: draftState.settings,
            picks: draftState.picks,
            selectedPlayerIds: Array.from(draftState.selectedPlayerIds), // Convert Set here
            nextTableToPick: draftState.nextTableToPick,
            currentPickDirection: draftState.currentPickDirection,
            isSerpentineOrder: draftState.isSerpentineOrder
        };

        console.log("Broadcasting state:", JSON.stringify(stateToSend, null, 2));

        // 7. Broadcast the explicitly constructed state
        io.emit('draft_state_update', stateToSend);

    } else {
        // Send error back
        console.log("Invalid pick attempted:", pickData, "Reason:", errorMessage);
        socket.emit('pick_error', { message: errorMessage || "Invalid pick." });
    }
  });

  socket.on('undo_pick', () => {
     console.log(`Undo request received from ${socket.id}`);
     // Basic validation: Can only undo if there are picks
     if (draftState.picks.length > 0) {
        const lastPick = draftState.picks.pop(); // Remove the last pick

        if (lastPick) {
            draftState.selectedPlayerIds.delete(lastPick.playerId); // Remove player from selected set
            console.log(`Undid pick: Player ID ${lastPick.playerId}`);

            // --- Recalculate the turn state to what it was BEFORE the undone pick ---
            // This is simpler than storing previous state: just recalculate based on the new 'picks' array
            const { nextTableToPick, currentPickDirection } = calculateNextTurn(draftState);
            draftState.nextTableToPick = nextTableToPick;
            draftState.currentPickDirection = currentPickDirection;
            // --- End Recalculate turn state ---

             console.log(`State after undo: Next turn Table ${draftState.nextTableToPick}, Direction: ${draftState.currentPickDirection}`);

            // Broadcast the updated state
            const stateToSend = {
                ...draftState,
                selectedPlayerIds: Array.from(draftState.selectedPlayerIds)
            };
            io.emit('draft_state_update', stateToSend);

        } else {
             console.error("Undo failed: Popped pick was undefined.");
             // Optionally emit an error back
             socket.emit('error', { message: "Undo failed unexpectedly." });
        }
     } else {
         console.log("Undo requested but no picks to undo.");
         // Optionally emit an error back
         socket.emit('error', { message: "No picks to undo." });
     }
  });

  // Handle table name updates
  socket.on('update_table_name', ({ tableId, newName }) => {
      console.log(`Table name update request: Table ${tableId}, New Name: ${newName}`);
      if (draftState.settings &&
          draftState.settings.tableNames &&
          typeof tableId === 'number' &&
          tableId >= 0 && tableId < draftState.settings.numTables &&
          typeof newName === 'string')
      {
          draftState.settings.tableNames[tableId] = newName.trim(); // Update name in state

          // Broadcast the change
          const stateToSend = {
              ...draftState,
              selectedPlayerIds: Array.from(draftState.selectedPlayerIds)
          };
          io.emit('draft_state_update', stateToSend);
          // socket.emit('table_name_updated', { tableId, newName }); // Optional confirmation to sender
      } else {
          console.error("Invalid table name update request received.");
          socket.emit('error', { message: "Invalid table name update request." });
      }
  });


  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Optional: Add logic if you need to track active users, etc.
  });
});

// --- Start the Server ---
server.listen(PORT, () => {
  console.log(`Server listening on *:${PORT}`);
});
