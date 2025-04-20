// script.js
import { playersIndex as playersIndexData, searchPlayers } from "./PlayerIndex_2024-25.mjs";

document.addEventListener("DOMContentLoaded", () => {

    // ==========================================================================
    // State Variables
    // ==========================================================================
    let tempDraftSettings = {};
    let currentServerState = null; // Holds the state for the current room
    let currentRoomCode = null;
    const playersIndex = playersIndexData; // Local copy of all players


    // ==========================================================================
    // Socket.IO Connection
    // ==========================================================================
    const socket = io(); // Connect to the Socket.IO server

    // ==========================================================================
    // DOM Element Getters
    // ==========================================================================
    const startContainerElement = document.getElementById('start-screen');
    const startDraftButton = document.getElementById("start-draft-button");
    const draftArea = document.getElementById("draft-area");
    const settingsButton = document.getElementById("settings-button");
    const settingsOverlay = document.getElementById("settings-overlay");
    const closeSettingsButton = document.getElementById("close-settings-button");
    const exitDraftButton = document.getElementById("exit-draft-button");
    const undoButton = document.getElementById("undo-button");
    const turnCounterElement = document.getElementById("turn-counter");
    const tablesContainer = document.getElementById("tables-container");
    const tableNamesOverlay = document.getElementById("table-names-overlay");
    const tableNamesInputContainer = document.getElementById("table-names-input-container");
    const confirmTableNamesButton = document.getElementById("confirm-table-names-button");
    const tableCountInput = document.getElementById("tableCount");
    const numForwardsInput = document.getElementById("numForwards");
    const numDefendersInput = document.getElementById("numDefenders");
    const numGoaltendersInput = document.getElementById("numGoaltenders");
    const serpentineOrderCheckbox = document.getElementById("serpentineOrder");
    const maxSalaryCapInput = document.getElementById("maxSalaryCap");
    const cancelTableNamesButton = document.getElementById("cancel-table-names-button");
    const roomCodeInput = document.getElementById("roomCodeInput");
    const joinDraftButton = document.getElementById("join-draft-button");
    const settingsRoomCodeContainer = document.getElementById('settings-room-code-container');
    const settingsRoomCodeText = document.getElementById('settings-room-code-text');
    const copyRoomCodeButton = document.getElementById('copy-room-code-button');
    const exitConfirmOverlay = document.getElementById('exit-confirm-overlay');
    const confirmExitButton = document.getElementById('confirm-exit-button');
    const cancelExitButton = document.getElementById('cancel-exit-button');

    // ==========================================================================
    // Check for existing room on load
    // ==========================================================================
    const storedRoomCode = sessionStorage.getItem('currentRoomCode');
    let attemptingRejoin = false; // Flag to know if we are trying to rejoin

    if (storedRoomCode) {
        console.log(`Found stored room code: ${storedRoomCode}. Attempting to rejoin.`);
        attemptingRejoin = true;
        // Tell the server we want to join this room again
        socket.emit('join_draft', { roomCode: storedRoomCode });
    }

    // Basic check for essential elements
    if (!startContainerElement || !draftArea || !socket) {
        console.error("Essential UI elements or Socket.IO not found. Application cannot start.");
        alert("Error initializing the application. Please refresh.");
        return;
    }

    // ==========================================================================
    // Helper Functions
    // ==========================================================================

    /** Formats a number as USD currency without cents */
    function formatCurrency(value) {
        const number = parseInt(value);
        if (isNaN(number)) {
            return '$0';
        }
        return number.toLocaleString('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        });
    }

    /** Calculates total player slots per table */
    function getTotalSlotsPerTable(state) {
        if (!state?.settings?.playersPerPos) return 0;
        const playersPerPos = state.settings.playersPerPos || {};
        // Use Object.values for slightly cleaner sum
        return Object.values(playersPerPos).reduce((sum, count) => sum + (count || 0), 0);
    }

    /** Calculates the current draft round */
    function getCurrentRound(state) {
        if (!state?.settings?.numTables || state.settings.numTables <= 0) return 1;
        const totalSlotsPerTable = getTotalSlotsPerTable(state);
        if (totalSlotsPerTable === 0) return 1;
        const picksMade = state.picks?.length || 0;
        return Math.floor(picksMade / state.settings.numTables) + 1;
    }

    /** Filters local playersIndex for available players by position */
    function getAvailablePlayers(position, serverSelectedPlayerIds) {
        if (!Array.isArray(playersIndex)) {
            console.error("playersIndex is not loaded or not an array.");
            return [];
        }
        // Ensure serverSelectedPlayerIds is a Set
        const selectedIds = serverSelectedPlayerIds instanceof Set
            ? serverSelectedPlayerIds
            : new Set(serverSelectedPlayerIds || []);

        return playersIndex.filter(player =>
            player.position === position && !selectedIds.has(player.id)
        );
    }

    /** Maps server picks to a structure { tableId: { slotIndex: pickData } } */
    function mapPicksToSlots(picks, settings) {
        const mappedPicks = {};
        if (!picks || !settings?.numTables || !settings?.playersPerPos) return mappedPicks;

        // Pre-initialize map structure
        for (let i = 0; i < settings.numTables; i++) {
            mappedPicks[i] = {};
        }

        // Group picks by tableId first
        const picksByTable = picks.reduce((acc, pick) => {
            if (!acc[pick.tableId]) {
                acc[pick.tableId] = [];
            }
            acc[pick.tableId].push(pick);
            return acc;
        }, {});

        // Assign picks to slots based on their order within each table's pick list
        for (let tableId = 0; tableId < settings.numTables; tableId++) {
            const tablePicks = picksByTable[tableId] || [];
            tablePicks.forEach((pick, index) => {
                // Assuming the order in the picks array corresponds to the slot order
                mappedPicks[tableId][index] = pick;
            });
        }
        return mappedPicks;
    }

    // ==========================================================================
    // UI Rendering Functions
    // ==========================================================================

    /** Renders the entire UI based on the state for the current room */
    function renderUIFromServerState(roomState) {
        console.log(`Rendering UI for room ${currentRoomCode}:`, roomState);
        // currentServerState is set in the 'draft_state_update' listener

        if (!currentServerState || !currentServerState.settings) {
            console.warn("[Render] Invalid state, showing start screen.");
            showStartScreen(); // Revert if state is invalid
            return;
        }

        // --- Update UI Visibility ---
        startContainerElement.style.display = 'none';
        draftArea.classList.remove('hidden');
        settingsOverlay.classList.remove('visible');
        tableNamesOverlay.classList.remove('visible');

        // --- Update Header Elements ---
        updateTurnDisplayFromServerState(currentServerState);

        // --- Update Settings Display (Example) ---
        if (maxSalaryCapInput) { // Update the one in the initial settings too
             maxSalaryCapInput.value = currentServerState.settings.maxSalary;
        }
        // If there's a separate max salary display in the settings overlay, update it here

        // --- Regenerate Draft Tables ---
        console.log("[Render] Calling generateTablesFromServerState...");
        generateTablesFromServerState(currentServerState);

        // --- Enable Correct Input ---
        console.log("[Render] Calling enableInputsFromServerState...");
        enableInputsFromServerState(currentServerState);

        // --- Update Control Buttons ---
        if (undoButton) {
            undoButton.disabled = !currentServerState.picks || currentServerState.picks.length === 0;
        }
    }

    /** Generates all draft tables based on room state */
    function generateTablesFromServerState(roomState) {
        console.log(`%c[Generate Tables] Starting generation for ${roomState?.settings?.numTables} tables.`, 'color: orange;');
        
        if (!tablesContainer || !roomState.settings) return;

        tablesContainer.innerHTML = ""; // Clear previous tables

        const { numTables, tableNames, playersPerPos, maxSalary, picks } = roomState.settings;
        const validPlayersPerPos = playersPerPos || {};
        const activePositions = Object.keys(validPlayersPerPos).filter(pos => validPlayersPerPos[pos] > 0);
        const picksByTableAndSlot = mapPicksToSlots(roomState.picks, roomState.settings); // Use roomState.picks

        if (numTables < 1 || activePositions.length === 0) {
            console.error("generateTablesFromServerState called with invalid settings.");
            return;
        }

        for (let i = 0; i < numTables; i++) {
            const tableWrapper = document.createElement("div");
            tableWrapper.classList.add("table-wrapper");

            const table = document.createElement("table");
            table.dataset.tableId = i;
            const currentTableName = tableNames[i] || `Table ${i + 1}`;

            // Create table structure
            table.innerHTML = `
                <thead>
                    <tr class="table-header">
                        <td colspan="3" contenteditable="true" spellcheck="false">${currentTableName}</td>
                    </tr>
                    <tr>
                        <th>Pos.</th>
                        <th>Nom joueur</th>
                        <th>Salaire</th>
                    </tr>
                </thead>
                <tbody></tbody>
            `;
            const tbody = table.querySelector("tbody");

            const picksForThisTable = (roomState.picks || []).filter(p => p.tableId === i);
            const filledSlotsCount = { A: 0, D: 0, G: 0 }; // Count filled slots per position for THIS table

            activePositions.forEach(pos => {
                const countForPos = validPlayersPerPos[pos] || 0;
                for (let j = 0; j < countForPos; j++) {
                    // Find if *this specific slot* (pos, j) has a pick
                    const pickForThisSlot = picksForThisTable.filter(p => p.position === pos)[j]; // Get the j-th pick of this position for this table

                    // Pass 'j' as the slotIndex
                    const row = createPlayerRow(pos, i, j === 0 ? countForPos : 0, j, pickForThisSlot);
                    tbody.appendChild(row);

                    if (pickForThisSlot) {
                        filledSlotsCount[pos]++; // Increment count if filled
                    }
                }
            });

            // Add listener for table name editing
            const headerCell = table.querySelector("thead .table-header td[contenteditable='true']");
            if (headerCell) {
                 headerCell.addEventListener('blur', handleTableNameEdit);
                 headerCell.addEventListener('keydown', handleTableNameKeydown);
            }

            // Add Total Row
            const totalRow = document.createElement("tr");
            totalRow.classList.add("total-row");
            totalRow.innerHTML = `<td colspan="2">Total</td><td class="total-salary-cell">$0</td>`;
            tbody.appendChild(totalRow);

            tableWrapper.appendChild(table);
            tablesContainer.appendChild(tableWrapper);

            // Recalculate and display total salary
            recalculateTotalSalary(table, maxSalary, roomState.picks); // Pass roomState.picks
        }

        console.log(`%c[Generate Tables] Finished generating tables. Container innerHTML length: ${tablesContainer?.innerHTML?.length}`, 'color: orange;');
    }

    /** Creates a single player row element */
    function createPlayerRow(pos, tableId, posRowSpan, slotIndex, playerPick = null) {
        const row = document.createElement("tr");
        row.classList.add(pos);
        row.classList.add('player-slot');
        row.dataset.position = pos;
        row.dataset.tableId = tableId;
        row.dataset.slotIndex = slotIndex;

        if (posRowSpan > 0) {
            const verticalCell = document.createElement("td");
            verticalCell.rowSpan = posRowSpan;
            verticalCell.classList.add("vertical-text", `vertical-${pos}`);
            verticalCell.textContent = pos;
            row.appendChild(verticalCell);
        }

        const nameCell = document.createElement("td");
        nameCell.classList.add("player-name-cell");
        nameCell.style.position = 'relative';

        const playerSearchInput = document.createElement("input");
        playerSearchInput.type = "text";
        playerSearchInput.classList.add("player-search-input");
        playerSearchInput.placeholder = "Search player...";
        playerSearchInput.dataset.tableId = tableId;
        playerSearchInput.dataset.position = pos;
        playerSearchInput.dataset.slotIndex = slotIndex;
        playerSearchInput.disabled = true; // Enabled later if it's this slot's turn
        playerSearchInput.autocomplete = 'off';
        playerSearchInput.spellcheck = false;

        const searchResultsContainer = document.createElement("div");
        searchResultsContainer.classList.add("search-results-container");

        const salaryCell = document.createElement("td");
        salaryCell.classList.add("salary-cell");

        if (playerPick) {
            playerSearchInput.value = playerPick.playerName || '';
            playerSearchInput.dataset.playerId = playerPick.playerId;
            salaryCell.textContent = formatCurrency(playerPick.salary);
            playerSearchInput.disabled = true; // Ensure picked slots are disabled
            row.classList.add('filled-slot');
        } else {
            playerSearchInput.dataset.playerId = "";
            salaryCell.textContent = formatCurrency(0);
            row.classList.add('empty-slot');
        }

        nameCell.appendChild(playerSearchInput);
        nameCell.appendChild(searchResultsContainer);
        row.appendChild(nameCell);
        row.appendChild(salaryCell);

        playerSearchInput.addEventListener("input", handlePlayerSearchInput);
        playerSearchInput.addEventListener('blur', handlePlayerSearchBlur);
        playerSearchInput.addEventListener('keydown', handlePlayerSearchKeydown);

        return row;
    }

    /** Updates the turn counter display */
    function updateTurnDisplayFromServerState(roomState) {
        if (!turnCounterElement || !roomState.settings) {
             if(turnCounterElement) turnCounterElement.textContent = "";
             return;
        };

        turnCounterElement.classList.remove('waiting', 'full');

        const { numTables, tableNames, maxSalary /* Add other needed settings here */ } = roomState.settings;
        const { picks = [], nextTableToPick, selectedPlayerIds /* Add other needed root state here */ } = roomState;
        const totalSlots = numTables * getTotalSlotsPerTable(roomState);
        const picksMade = roomState.picks?.length || 0; // Use roomState.picks

        if (picksMade >= totalSlots && totalSlots > 0) { // Check totalSlots > 0
            turnCounterElement.textContent = "Draft Complete";
            turnCounterElement.classList.add('full');
        } else if (nextTableToPick >= 0 && nextTableToPick < numTables) {
            const currentRound = getCurrentRound(roomState);
            const currentTableName = tableNames[nextTableToPick] || `Table ${nextTableToPick + 1}`;
            turnCounterElement.textContent = `Round ${currentRound} • Turn: ${currentTableName}`;
        } else {
            // This case means draft isn't complete, but nextTableToPick is invalid.
            console.warn(`[Update Turn Display] Invalid state: Draft not complete (Picks: ${picksMade}/${totalSlots}), but nextTableToPick is invalid (${nextTableToPick}). Setting to 'Waiting...'`);
            turnCounterElement.textContent = "Waiting...";
            turnCounterElement.classList.add('waiting');
        }
    }

    /** Recalculates and updates the total salary display for a table */
     function recalculateTotalSalary(tableElement, maxSalary, currentPicks) {
        const tableId = parseInt(tableElement.dataset.tableId);
        let currentTotalSalary = 0;

        if (!isNaN(tableId) && currentPicks) {
            currentPicks.forEach(pick => {
                if (pick.tableId === tableId && pick.salary != null) {
                    currentTotalSalary += (parseInt(pick.salary) || 0);
                }
            });
        }

        const totalSalaryCell = tableElement.querySelector(".total-salary-cell");
        if (totalSalaryCell) {
            totalSalaryCell.textContent = formatCurrency(currentTotalSalary);
            const exceedsCap = maxSalary > 0 && currentTotalSalary > maxSalary;
            // Use classList.toggle for cleaner style application
            totalSalaryCell.classList.toggle('is-over-cap', exceedsCap);
        }
     }


    /** Enables the correct player input fields based on whose turn it is */
    function enableInputsFromServerState(roomState) {
        console.log(`%c[Enable Inputs] Running...`, 'color: purple; font-weight: bold;', roomState);

        if (!tablesContainer || !roomState?.settings || !roomState?.picks) {
            console.warn("[Enable Inputs] Missing tablesContainer, settings, or picks.");
            // Disable everything if state is bad
            tablesContainer.querySelectorAll(".player-search-input").forEach(input => input.disabled = true);
            tablesContainer.querySelectorAll(".player-slot").forEach(row => row.classList.remove('clickable-slot'));
            return;
        }

        // 1. Disable ALL inputs and remove clickable class first
        tablesContainer.querySelectorAll(".player-search-input").forEach(input => {
            input.disabled = true;
        });
        tablesContainer.querySelectorAll(".player-slot").forEach(row => {
            row.classList.remove('clickable-slot');
        });

        const { numTables, playersPerPos } = roomState.settings;
        const { nextTableToPick } = roomState;
        const totalSlotsPerTable = getTotalSlotsPerTable(roomState); // Use helper
        const picksMade = roomState.picks.length;
        const totalSlotsOverall = numTables * totalSlotsPerTable;

        console.log(`[Enable Inputs] State: picksMade=${picksMade}, totalSlotsOverall=${totalSlotsOverall}, nextTableToPick=${nextTableToPick}`);

        // Only enable if draft is ongoing and the turn is valid
        if (picksMade < totalSlotsOverall && nextTableToPick >= 0 && nextTableToPick < numTables) {
            const activeTableId = nextTableToPick;
            console.log(`[Enable Inputs] Active table ID: ${activeTableId}`);

            // Find how many players of each position this table ALREADY has
            const picksForActiveTable = roomState.picks.filter(p => p.tableId === activeTableId);
            const currentCounts = { A: 0, D: 0, G: 0 };
            picksForActiveTable.forEach(p => {
                if (currentCounts[p.position] !== undefined) {
                    currentCounts[p.position]++;
                }
            });
            console.log(`[Enable Inputs] Current counts for table ${activeTableId}:`, currentCounts);

            // Determine needed counts
            const neededCounts = playersPerPos || { A: 0, D: 0, G: 0 };

            // Find and enable the next available slot for EACH needed position
            let foundClickable = false;
            Object.keys(neededCounts).forEach(pos => {
                const needed = neededCounts[pos] || 0;
                const current = currentCounts[pos] || 0;

                if (current < needed) {
                    // This table still needs a player of this position 'pos'
                    // The next available slot index for this position is 'current' (0-based)
                    const nextSlotIndex = current;

                    console.log(`[Enable Inputs] Table ${activeTableId} needs a ${pos}. Looking for slot index ${nextSlotIndex}`);

                    // Find the specific row and input
                    const targetRow = tablesContainer.querySelector(
                        `tr.player-slot[data-table-id="${activeTableId}"][data-position="${pos}"][data-slot-index="${nextSlotIndex}"]`
                    );
                    const targetInput = targetRow?.querySelector('.player-search-input');

                    if (targetRow && targetInput) {
                        console.log(`%c[Enable Inputs] Enabling input for Table ${activeTableId}, Pos: ${pos}, Slot Index: ${nextSlotIndex}`, 'color: green; font-weight: bold;');
                        targetInput.disabled = false;
                        targetRow.classList.add('clickable-slot'); // Add class to the ROW
                        foundClickable = true;
                        // Optional: Focus the first clickable input found (e.g., the Forward)
                        // if (pos === 'A' || !document.activeElement || document.activeElement.disabled) {
                        //    targetInput.focus();
                        // }
                    } else {
                        console.warn(`%c[Enable Inputs] Could not find row/input for Table ${activeTableId}, Pos: ${pos}, Slot Index: ${nextSlotIndex}`, 'color: orange;');
                    }
                }
            });

            if (!foundClickable) {
                 console.warn(`%c[Enable Inputs] FAILED: No clickable slots found for active table ${activeTableId}. This might indicate a state mismatch or filled table.`, 'color: red; font-weight: bold;');
                 if(turnCounterElement) turnCounterElement.classList.add('waiting');
            }

        } else {
            console.log(`[Enable Inputs] Condition not met: Draft complete or invalid nextTableToPick. No inputs enabled.`);
        }

        // Update the turn display AFTER attempting to enable inputs
        updateTurnDisplayFromServerState(roomState);
    } 


    /** Resets the UI to the initial start screen state */
    function showStartScreen() {
        console.log("Showing start screen...");

        // Reset state
        currentServerState = null;
        currentRoomCode = null;
        tempDraftSettings = {};

        // Update UI visibility
        settingsOverlay?.classList.remove('visible');
        tableNamesOverlay?.classList.remove('visible');
        draftArea?.classList.add('hidden');
        startContainerElement.style.display = 'flex';


        // Clear dynamic content
        if (tablesContainer) tablesContainer.innerHTML = "";
        if (turnCounterElement) turnCounterElement.textContent = "";
        if (settingsRoomCodeText) settingsRoomCodeText.textContent = '';

        // Reset form inputs
        if (roomCodeInput) roomCodeInput.value = '';
        // Consider resetting other start settings inputs if desired

        // Reset button states
        if (undoButton) undoButton.disabled = true;
    }

    // ==========================================================================
    // Socket.IO Event Listeners
    // ==========================================================================

    socket.on('draft_started', ({ roomCode, draftState }) => {
        console.log(`%c[Socket Event: draft_started] Received for room: ${roomCode}`, 'color: blue; font-weight: bold;', draftState);
        console.log(`Draft started in room: ${roomCode}`);
        currentRoomCode = roomCode;

        sessionStorage.setItem('currentRoomCode', roomCode); // Store the room code

        // Ensure selectedPlayerIds is a Set
        if (draftState && draftState.selectedPlayerIds && Array.isArray(draftState.selectedPlayerIds)) {
            draftState.selectedPlayerIds = new Set(draftState.selectedPlayerIds);
        } else {
            draftState.selectedPlayerIds = new Set(); // Ensure it exists
        }
        currentServerState = draftState; // Set initial state

        renderUIFromServerState(draftState); // Render the UI
    });

    socket.on('join_error', (error) => {
        console.error("Join Error:", error.message);
        alert(`Failed to join draft: ${error.message}`);
        if(roomCodeInput) roomCodeInput.value = '';

        // If we failed during an auto-rejoin attempt...
        if (attemptingRejoin) {
            console.log("Rejoin attempt failed, clearing stored code.");
            sessionStorage.removeItem('currentRoomCode'); // Clear the bad code
            attemptingRejoin = false; // Reset the flag
            showStartScreen(); // Show the normal start screen
        }
    });

    socket.on('draft_state_update', ({ roomCode, draftState }) => {
        // Only render if the update is for the room this client is in
        if (roomCode === currentRoomCode) {
            console.log(`Received state update for current room ${roomCode}`);

            // Ensure selectedPlayerIds is a Set
            if (draftState && draftState.selectedPlayerIds && Array.isArray(draftState.selectedPlayerIds)) {
                 draftState.selectedPlayerIds = new Set(draftState.selectedPlayerIds);
            } else if (draftState) { // Ensure it exists even if empty/null from server
                 draftState.selectedPlayerIds = new Set();
            }

            currentServerState = draftState; // Update local state reference
            renderUIFromServerState(draftState); // Re-render

        } else if (currentRoomCode === null && draftState?.roomCode) {
             // Handle initial state after joining
             console.log(`Joined room ${draftState.roomCode}, processing initial state.`);
             currentRoomCode = draftState.roomCode;

             sessionStorage.setItem('currentRoomCode', currentRoomCode);

             if (draftState.selectedPlayerIds && Array.isArray(draftState.selectedPlayerIds)) {
                 draftState.selectedPlayerIds = new Set(draftState.selectedPlayerIds);
             } else {
                 draftState.selectedPlayerIds = new Set();
             }
             currentServerState = draftState;
             renderUIFromServerState(draftState);

        }
        // Ignore updates for other rooms
    });

    socket.on('pick_error', (error) => {
        console.error("Pick Error:", error.message);
        alert(`Error making pick: ${error.message}`);
        // Re-render based on the last valid state to correct UI
        if(currentServerState) {
            renderUIFromServerState(currentServerState);
        }
    });

    // Generic error handler
    socket.on('error', (error) => {
        console.error("Server Error:", error.message);
        alert(`An error occurred: ${error.message}`);
    });


    socket.on("connect_error", (err) => {
        console.error(`Connection Error: ${err.message}`);
        alert("Failed to connect to the draft server. Please check your connection and refresh.");
        showStartScreen();
    });

    socket.on("disconnect", (reason) => {
        console.warn(`Disconnected from server: ${reason}`);
        // Avoid alert if disconnect was intentional (e.g., user closed tab)
        if (reason !== 'io client disconnect') {
            alert("Lost connection to the draft server. Please refresh.");
        }
        showStartScreen();
    });

    // ==========================================================================
    // Event Handlers (User Actions -> Emit to Server)
    // ==========================================================================

    function handleJoinDraftClick() {
        const code = roomCodeInput?.value.trim().toUpperCase();
        if (!code) {
            alert("Please enter a room code.");
            roomCodeInput?.focus();
            return;
        }
        console.log(`Attempting to join room: ${code}`);
        socket.emit('join_draft', { roomCode: code });
    }

    function handleStartDraftClick() {
        // Read and Validate Start Settings
        const initialTableCount = parseInt(tableCountInput.value);
        const initialForwards = parseInt(numForwardsInput.value);
        const initialDefenders = parseInt(numDefendersInput.value);
        const initialGoaltenders = parseInt(numGoaltendersInput.value);
        const initialSerpentine = serpentineOrderCheckbox.checked;
        const initialSalaryCap = parseInt(maxSalaryCapInput.value);

        // --- Simple Validation ---
        let errorMessage = "";
        if (isNaN(initialTableCount) || initialTableCount < 1) errorMessage = "Valid number of tables required (>= 1).";
        else if (isNaN(initialForwards) || initialForwards < 0 || isNaN(initialDefenders) || initialDefenders < 0 || isNaN(initialGoaltenders) || initialGoaltenders < 0) errorMessage = "Valid player counts required (>= 0).";
        else if (initialForwards + initialDefenders + initialGoaltenders === 0) errorMessage = "Total players per table cannot be zero.";
        else if (isNaN(initialSalaryCap) || initialSalaryCap < 0) errorMessage = "Valid Salary Cap required (>= 0).";

        if (errorMessage) {
            alert(`Invalid Settings: ${errorMessage}`);
            return;
        }

        // Store settings temporarily
        tempDraftSettings = {
            initialTableCount, initialForwards, initialDefenders, initialGoaltenders,
            initialSerpentine, initialSalaryCap
        };

        // Prepare and Show Table Names Overlay
        if (!tableNamesOverlay || !tableNamesInputContainer) return; // Guard

        tableNamesInputContainer.innerHTML = ''; // Clear previous
        for (let i = 0; i < initialTableCount; i++) {
            const id = `tableNameInput-${i}`;
            const placeholder = `Table ${i + 1}`;
            const group = document.createElement('div');
            group.className = 'settings-input-group';
            group.innerHTML = `
                <label for="${id}">Name for ${placeholder}:</label>
                <input type="text" id="${id}" data-table-index="${i}" placeholder="${placeholder}">
            `;
            tableNamesInputContainer.appendChild(group);
        }

        tableNamesOverlay.classList.add('visible');
        tableNamesInputContainer.querySelector('input')?.focus();
    }

    function handleConfirmTableNamesClick() {
        if (!tableNamesOverlay || !tableNamesInputContainer || !tempDraftSettings) return;

        const collectedTableNames = {};
        const inputs = tableNamesInputContainer.querySelectorAll('input[type="text"]');
        inputs.forEach(input => {
            const index = parseInt(input.dataset.tableIndex);
            if (!isNaN(index)) {
                 collectedTableNames[index] = input.value.trim() || input.placeholder; // Use placeholder if empty
            }
        });

        // Prepare final settings object
        const settings = {
            numTables: tempDraftSettings.initialTableCount,
            tableNames: collectedTableNames,
            playersPerPos: {
                A: tempDraftSettings.initialForwards,
                D: tempDraftSettings.initialDefenders,
                G: tempDraftSettings.initialGoaltenders
            },
            isSerpentineOrder: tempDraftSettings.initialSerpentine,
            maxSalary: tempDraftSettings.initialSalaryCap
        };

        console.log("Emitting start_draft with settings:", settings);
        socket.emit('start_draft', settings); // Server handles room creation

        tempDraftSettings = {}; // Clear temp settings
        tableNamesOverlay.classList.remove('visible');
    }

    function handlePlayerSearchInput(event) {
        const input = event.target;
        const searchTerm = input.value.trim();
        const position = input.dataset.position;
        const resultsContainer = input.nextElementSibling;

        if (!resultsContainer || !position || !currentServerState?.selectedPlayerIds) {
             if (resultsContainer) resultsContainer.style.display = "none";
             return;
        }

        resultsContainer.innerHTML = "";
        resultsContainer.style.display = "none"; // Hide initially

        if (searchTerm.length < 1) return; // Min search length

        const availablePlayers = getAvailablePlayers(position, currentServerState.selectedPlayerIds);
        const matchingPlayers = searchPlayers(searchTerm, availablePlayers).slice(0, 10); // Limit results

        if (matchingPlayers.length > 0) {
            matchingPlayers.forEach(player => {
                const option = document.createElement("div");
                option.className = "player-option";
                option.dataset.playerId = player.id;
                option.textContent = `${player.name} (${formatCurrency(player.cap_hit)})`;
                option.addEventListener('mousedown', handlePlayerOptionMouseDown); // Use mousedown
                resultsContainer.appendChild(option);
            });
            resultsContainer.style.display = "block"; // Show if results exist
        }
    }

    function handlePlayerSearchBlur(event) {
        const resultsContainer = event.target.nextElementSibling;
        // Delay hiding to allow mousedown on results to register
        setTimeout(() => {
            if (resultsContainer && document.activeElement !== event.target && !resultsContainer.contains(document.activeElement)) {
                resultsContainer.style.display = 'none';
            }
        }, 150);
    }

    function handlePlayerSearchKeydown(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            const firstOption = event.target.nextElementSibling?.querySelector('.player-option');
            if (firstOption) {
                // Simulate mousedown to trigger selection logic
                firstOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            }
        } else if (event.key === 'Escape') {
             event.target.nextElementSibling.style.display = 'none'; // Hide on Escape
        }
    }

    function handlePlayerOptionMouseDown(event) {
        event.preventDefault(); // Prevent input blur
        if (!currentRoomCode) {
             console.error("Cannot make pick: Not in a room.");
             alert("Error: Not connected to a draft room.");
             return;
        }

        const playerOption = event.currentTarget;
        const resultsContainer = playerOption.parentElement;
        const inputElement = resultsContainer?.previousElementSibling;
        if (!inputElement || !resultsContainer) return;

        const parentTable = inputElement.closest('table');
        const playerId = parseInt(playerOption.dataset.playerId);
        const player = playersIndex.find(p => p.id === playerId);
        const tableId = parentTable ? parseInt(parentTable.dataset.tableId) : -1;

        if (player && tableId !== -1) {
            const pickData = {
                playerId: player.id,
                playerName: player.name,
                salary: parseInt(player.cap_hit) || 0,
                position: player.position,
                tableId: tableId,
            };

            console.log(`Emitting make_pick for room ${currentRoomCode}:`, pickData);
            socket.emit('make_pick', { roomCode: currentRoomCode, pickData: pickData });

            // --- Client-Side Feedback ---
            resultsContainer.style.display = "none";
            resultsContainer.innerHTML = "";
            inputElement.disabled = true; // Disable input temporarily
            inputElement.value = '';
            inputElement.placeholder = "Processing..."; // Indicate processing

        } else {
            console.error("Could not find necessary elements or player data for selection.");
        }
    }

    function handleUndoClick() {
        if (!currentRoomCode) {
             console.error("Cannot undo: Not in a room.");
             alert("Error: Not connected to a draft room.");
             return;
        }
        if (!currentServerState?.picks?.length) {
            console.warn("Undo clicked, but no picks exist.");
            return; // No picks to undo
        }
        console.log(`Emitting undo_pick for room ${currentRoomCode}`);
        socket.emit('undo_pick', { roomCode: currentRoomCode });
    }

    function handleTableNameEdit(event) {
        if (!currentRoomCode) {
             console.error("Cannot update table name: Not in a room.");
             // Optionally revert local change if desired
             // event.target.textContent = currentServerState?.settings?.tableNames?.[tableId] || `Table ${tableId + 1}`;
             return;
        }

        const headerCell = event.target;
        const table = headerCell.closest('table');
        if (!table) return;

        const tableId = parseInt(table.dataset.tableId);
        let newName = headerCell.textContent.trim();

        if (!isNaN(tableId)) {
            const defaultName = `Table ${tableId + 1}`;
            if (newName === "") {
                newName = defaultName;
                headerCell.textContent = newName; // Revert display locally
            }

            const serverName = currentServerState?.settings?.tableNames?.[tableId] || defaultName;

            if (newName !== serverName) {
                 console.log(`Emitting update_table_name for room ${currentRoomCode}: Table ${tableId}, Name: ${newName}`);
                 socket.emit('update_table_name', { roomCode: currentRoomCode, tableId: tableId, newName: newName });
            }
            // Server state update will confirm the name
        }
    }

    function handleTableNameKeydown(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            event.target.blur(); // Trigger blur -> handleTableNameEdit
        }
    }

    function handleSettingsButtonClick() {
        if (!settingsOverlay) return;

        // Update the room code display inside the settings menu
        if (settingsRoomCodeText && currentRoomCode) {
            // Display only the code in the text span
            settingsRoomCodeText.textContent = currentRoomCode;
        } else if (settingsRoomCodeText) {
            settingsRoomCodeText.textContent = ''; // Clear if no room code
        }

        // Enable/disable copy button based on whether there's a code
        if (copyRoomCodeButton) {
            copyRoomCodeButton.disabled = !currentRoomCode;
        }

        // Update any settings displayed in the overlay from currentServerState if needed
        // Example: if maxSalaryCapInput was also in the overlay
        // if(currentServerState?.settings?.maxSalary != null) {
        //     const overlayMaxSalaryInput = settingsOverlay.querySelector('#someOverlayMaxSalaryInput');
        //     if(overlayMaxSalaryInput) overlayMaxSalaryInput.value = currentServerState.settings.maxSalary;
        // }
        settingsOverlay.classList.add('visible');
    }

    // Handles the click on the copy room code button
    function handleCopyRoomCodeClick() {
        console.log("Copy button clicked."); // Log 1: Verify click handler runs

        // Check if clipboard API is supported at all
        if (!navigator.clipboard) {
            console.warn("Clipboard API not supported by this browser.");
            alert("Sorry, copying to clipboard is not supported by your browser.");
            return;
        }
        // Check if we have a room code
        if (!currentRoomCode) {
             console.warn("Cannot copy room code: No code available.");
             return;
        }

        // Log 2: Verify the room code value just before copying
        console.log('Attempting to copy:', currentRoomCode);

        navigator.clipboard.writeText(currentRoomCode).then(() => {
            // Log 3: Check if the success part (.then) is reached
            console.log('Clipboard write promise resolved successfully.');

            // Success feedback
            const originalContent = copyRoomCodeButton.innerHTML;
            const wasSVG = copyRoomCodeButton.querySelector('svg');

            copyRoomCodeButton.textContent = 'Copied!';
            copyRoomCodeButton.disabled = true;

            setTimeout(() => {
                if (wasSVG) {
                    copyRoomCodeButton.innerHTML = originalContent;
                } else {
                    copyRoomCodeButton.textContent = originalContent;
                }
                copyRoomCodeButton.disabled = false;
            }, 1500);

        }).catch(err => {
            // Log 4: Check if the error part (.catch) is reached, even if no error shows
            console.error('Clipboard write promise rejected:', err);

            // Error feedback
            alert("Could not copy room code automatically.\nThis feature requires a secure connection (HTTPS) or localhost.\nPlease try copying manually.");
        });

        // Log 5: Check if the function completes execution
        console.log("handleCopyRoomCodeClick finished.");
    }


    function handleCloseSettingsClick() {
        settingsOverlay?.classList.remove('visible');
    }

    function handleOverlayBackgroundClick(event) {
        // Close overlay if click is directly on the background
        if (event.target === settingsOverlay || event.target === tableNamesOverlay) {
            event.target.classList.remove('visible');
            if (event.target === tableNamesOverlay) {
                 tempDraftSettings = {}; // Clear temp settings if table name overlay is cancelled this way
            }
        }
    }

    function handleCancelTableNamesClick() {
        tableNamesOverlay?.classList.remove('visible');
        tempDraftSettings = {}; // Clear temp settings
    }

    function handleExitDraftClick() {
        if (exitConfirmOverlay) {
            exitConfirmOverlay.classList.add('visible');
        } else {
            console.error("Exit confirmation overlay not found!");
        }
    }

    // Handles the click on the "Yes, Exit" button in the custom modal
    function handleConfirmExit() {
        if (exitConfirmOverlay) {
            exitConfirmOverlay.classList.remove('visible'); // Hide the modal
        }
        // Perform the actual exit actions
        sessionStorage.removeItem('currentRoomCode');
        showStartScreen(); // Revert UI
    }

    // Handles the click on the "Cancel" button in the custom modal
    function handleCancelExit() {
        if (exitConfirmOverlay) {
            exitConfirmOverlay.classList.remove('visible'); // Just hide the modal
        }
    }

    // ==========================================================================
    // Attaching Event Listeners
    // ==========================================================================
    function attachListener(element, event, handler, elementName) {
        if (elementName === 'Copy Room Code Button') {
            console.log(`Attempting to attach listener for: ${elementName}`);
            if (element) {
                console.log(`   Element found:`, element);
            } else {
                console.error(`   ERROR: Element NOT found for ${elementName}!`);
            }
        }
    
        if (element) {
            element.addEventListener(event, handler);
        } else {
            if (elementName !== 'Copy Room Code Button') {
                 console.error(`${elementName} button/element not found.`);
            }
        }
    }

    attachListener(joinDraftButton, 'click', handleJoinDraftClick, 'Join Draft');
    attachListener(startDraftButton, 'click', handleStartDraftClick, 'Start Draft');
    attachListener(exitDraftButton, 'click', handleExitDraftClick, 'Exit Draft');
    attachListener(undoButton, 'click', handleUndoClick, 'Undo');
    attachListener(settingsButton, 'click', handleSettingsButtonClick, 'Settings');
    attachListener(settingsOverlay, 'click', handleOverlayBackgroundClick, 'Settings Overlay');
    attachListener(closeSettingsButton, 'click', handleCloseSettingsClick, 'Close Settings');
    attachListener(confirmTableNamesButton, 'click', handleConfirmTableNamesClick, 'Confirm Table Names');
    attachListener(cancelTableNamesButton, 'click', handleCancelTableNamesClick, 'Cancel Table Names');
    attachListener(tableNamesOverlay, 'click', handleOverlayBackgroundClick, 'Table Names Overlay');
    attachListener(confirmExitButton, 'click', handleConfirmExit, 'Confirm Exit Button');
    attachListener(cancelExitButton, 'click', handleCancelExit, 'Cancel Exit Button');
    attachListener(exitConfirmOverlay, 'click', (event) => {
        if (event.target === exitConfirmOverlay) {
            handleCancelExit(); // Close if background is clicked
        }
    }, 'Exit Confirm Overlay Background');
    attachListener(copyRoomCodeButton, 'click', handleCopyRoomCodeClick, 'Copy Room Code Button');


    // ==========================================================================
    // Initialization
    // ==========================================================================
    console.log("Draft application client initialized.");
    
    // Only show start screen immediately if NOT attempting to rejoin
    if (!attemptingRejoin) {
        showStartScreen(); // Show the start screen by default
    }

}); // End DOMContentLoaded

