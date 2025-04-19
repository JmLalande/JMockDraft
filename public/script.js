// script.js
import { playersIndex as playersIndexData, searchPlayers } from "./PlayerIndex_2024-25.mjs";

document.addEventListener("DOMContentLoaded", () => {

    // --- Client-Side State ---
    // Store settings temporarily before sending to server
    let tempDraftSettings = {};
    // Store the latest state received from the server
    let currentServerState = null;
    // Keep the full player list locally for searching/display
    const playersIndex = playersIndexData;

    // --- DOM Elements ---
    const startContainerElement = document.querySelector('.initial-start-container');
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

    // --- Socket.IO Connection ---
    const socket = io(); // Connect to the Socket.IO server

    // --- Helper Functions (Client-Side Calculation/Filtering) ---

    /**
     * Calculates the total number of player slots per table based on server state.
     * @param {object} state - The server state object.
     * @returns {number} Total slots per table.
     */
    function getTotalSlotsPerTable(state) {
        if (!state?.settings?.playersPerPos) return 0;
        // Ensure playersPerPos is treated as an object
        const playersPerPos = state.settings.playersPerPos || {};
        const activePositions = Object.keys(playersPerPos).filter(pos => playersPerPos[pos] > 0);
        return activePositions.reduce((sum, pos) => sum + (playersPerPos[pos] || 0), 0);
    }

    /**
     * Calculates the current draft round number based on server state.
     * @param {object} state - The server state object.
     * @returns {number} The current round number (starting from 1).
     */
    function getCurrentRound(state) {
        if (!state?.settings?.numTables || state.settings.numTables <= 0) return 1;
        const totalSlotsPerTable = getTotalSlotsPerTable(state);
        if (totalSlotsPerTable === 0) return 1;
        const picksMade = state.picks?.length || 0;
        return Math.floor(picksMade / state.settings.numTables) + 1;
    }

    /**
     * Filters the local playersIndex to get available players based on server's selected list.
     * @param {string} position - The position ('A', 'D', 'G').
     * @param {Set<number>} serverSelectedPlayerIds - A Set of selected player IDs from server state.
     * @returns {Array} An array of available player objects.
     */
    function getAvailablePlayers(position, serverSelectedPlayerIds) {
        if (!Array.isArray(playersIndex)) {
            console.error("playersIndex is not loaded or not an array.");
            return [];
        }
        // Ensure serverSelectedPlayerIds is a Set for efficient lookup
        const selectedIds = serverSelectedPlayerIds instanceof Set ? serverSelectedPlayerIds : new Set(serverSelectedPlayerIds || []);
        return playersIndex.filter(player =>
            player.position === position && !selectedIds.has(player.id)
        );
    }

    /**
     * Maps picks from the server state to a structure useful for rendering tables.
     * @param {Array} picks - The picks array from server state.
     * @param {object} settings - The settings object from server state.
     * @returns {object} - An object like { tableId: { slotIndex: pickData } }
     */
    function mapPicksToSlots(picks, settings) {
        const mappedPicks = {};
        if (!picks || !settings || !settings.playersPerPos) return mappedPicks;

        const slotsPerTable = {}; // { tableId: currentSlotCount }

        // Determine the order of positions to match row generation
        const activePositions = Object.keys(settings.playersPerPos).filter(pos => settings.playersPerPos[pos] > 0);

        // Create a lookup for picks by table ID for easier access
        const picksByTable = {};
        picks.forEach(pick => {
            if (!picksByTable[pick.tableId]) {
                picksByTable[pick.tableId] = [];
            }
            picksByTable[pick.tableId].push(pick);
        });

        // Assign picks to slots based on the order they appear in the picks array for each table
        for (let tableId = 0; tableId < settings.numTables; tableId++) {
            if (!mappedPicks[tableId]) {
                mappedPicks[tableId] = {};
            }
            const tablePicks = picksByTable[tableId] || [];
            let currentSlotIndex = 0;
            tablePicks.forEach(pick => {
                 // Find the correct slot index based on position order and counts
                 // This assumes picks are stored chronologically per table
                 mappedPicks[tableId][currentSlotIndex] = pick;
                 currentSlotIndex++;
            });
        }
        return mappedPicks;
    }


    // --- Central UI Rendering Function ---

    /**
     * Renders the entire UI based on the state received from the server.
     * This is the main function called when 'draft_state_update' is received.
     * @param {object} serverState - The draft state object from the server.
     */
    function renderUIFromServerState(serverState) {
        console.log("Rendering UI from server state:", serverState);
        currentServerState = serverState; // Store the latest state

        // Ensure server state includes selectedPlayerIds as a Set
        if (currentServerState && !(currentServerState.selectedPlayerIds instanceof Set)) {
            // Check if it's an array before creating Set from it
            if (Array.isArray(currentServerState.selectedPlayerIds)) {
                currentServerState.selectedPlayerIds = new Set(currentServerState.selectedPlayerIds);
            } else {
                // If it's not an array (e.g., {}, null), initialize as an empty Set
                console.warn("Received non-array selectedPlayerIds from server, initializing as empty Set.");
                currentServerState.selectedPlayerIds = new Set();
            }
        } else if (currentServerState && !currentServerState.selectedPlayerIds) {
            // If selectedPlayerIds is null or undefined, initialize as empty Set
            currentServerState.selectedPlayerIds = new Set();
        }

        if (!currentServerState || !currentServerState.settings) {
            // Show start screen if draft hasn't started or state is invalid/reset
            showStartScreen();
            return;
        }

        // --- Update UI Elements ---
        // Show draft area, hide setup overlays
        if (startContainerElement) startContainerElement.style.display = 'none';
        if (draftArea) draftArea.classList.remove('hidden');
        if (settingsOverlay) settingsOverlay.classList.remove('visible');
        if (tableNamesOverlay) tableNamesOverlay.classList.remove('visible');

        // Update displayed settings (e.g., max salary cap in settings overlay)
        if (maxSalaryCapInput) maxSalaryCapInput.value = currentServerState.settings.maxSalary;

        // Regenerate Draft Tables
        generateTablesFromServerState(currentServerState);

        // Update Turn Counter Display
        updateTurnDisplayFromServerState(currentServerState);

        // Enable Input for the Correct Table/Slot
        enableInputsFromServerState(currentServerState);

        // Update Undo Button State
        if (undoButton) undoButton.disabled = !currentServerState.picks || currentServerState.picks.length === 0;
    }


    // --- UI Generation Functions (Called by renderUIFromServerState) ---

    /**
     * Generates all draft tables based *only* on server state.
     * @param {object} serverState - The draft state object from the server.
     */
    function generateTablesFromServerState(serverState) {
        if (!tablesContainer || !serverState.settings) return;

        tablesContainer.innerHTML = ""; // Clear previous tables

        const { numTables, tableNames, playersPerPos, maxSalary } = serverState.settings;
        // Ensure playersPerPos is an object
        const validPlayersPerPos = playersPerPos || {};
        const activePositions = Object.keys(validPlayersPerPos).filter(pos => validPlayersPerPos[pos] > 0);
        const picksByTableAndSlot = mapPicksToSlots(serverState.picks, serverState.settings);

        if (numTables < 1 || activePositions.length === 0) {
            console.error("generateTablesFromServerState called with invalid settings.");
            return;
        }

        // Generate each table
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

            // Add listener for table name editing
            const headerCell = table.querySelector("thead .table-header td[contenteditable='true']");
            if (headerCell) {
                 headerCell.addEventListener('blur', handleTableNameEdit);
                 headerCell.addEventListener('keydown', handleTableNameKeydown);
            }

            // Add rows for each position slot, pre-filling with picked players
            let slotIndex = 0; // Track overall slot index within this table
            activePositions.forEach(pos => {
                const countForPos = validPlayersPerPos[pos];
                if (countForPos > 0) {
                    for (let j = 0; j < countForPos; j++) {
                        const playerForSlot = picksByTableAndSlot[i]?.[slotIndex]; // Get player pick for this table/slot
                        const row = createPlayerRow(pos, i, j === 0 ? countForPos : 0, playerForSlot);
                        tbody.appendChild(row);
                        slotIndex++;
                    }
                }
            });

            // Add Total Row
            const totalRow = document.createElement("tr");
            totalRow.classList.add("total-row");
            totalRow.innerHTML = `<td colspan="2">Total</td><td class="total-salary-cell">$0</td>`;
            tbody.appendChild(totalRow);

            tableWrapper.appendChild(table);
            tablesContainer.appendChild(tableWrapper);

            // Recalculate and display total salary for this table
            recalculateTotalSalaryFromServerState(table, serverState.settings.maxSalary, serverState.picks);
        }
    }

    /**
     * Creates a single player row element, potentially pre-filled with player data.
     * @param {string} pos - The position ('A', 'D', 'G').
     * @param {number} tableId - The index of the table this row belongs to.
     * @param {number} posRowSpan - The rowspan for the vertical position cell (0 if not the first row).
     * @param {object | null} playerPick - Player pick data from server state for this slot, if any.
     * @returns {HTMLTableRowElement} The created table row element.
     */
    function createPlayerRow(pos, tableId, posRowSpan, playerPick = null) {
        const row = document.createElement("tr");
        row.classList.add(pos);
        row.dataset.position = pos;

        // Add vertical position header cell (only if posRowSpan > 0)
        if (posRowSpan > 0) {
            const verticalCell = document.createElement("td");
            verticalCell.rowSpan = posRowSpan;
            verticalCell.classList.add("vertical-text", `vertical-${pos}`);
            verticalCell.textContent = pos;
            row.appendChild(verticalCell);
        }

        // Player Name Cell (Input & Search Results Container)
        const nameCell = document.createElement("td");
        nameCell.classList.add("player-name-cell");
        nameCell.style.position = 'relative'; // Context for absolute positioned results

        const playerSearchInput = document.createElement("input");
        playerSearchInput.type = "text";
        playerSearchInput.classList.add("player-search-input");
        playerSearchInput.placeholder = "Search player...";
        playerSearchInput.dataset.tableId = tableId;
        playerSearchInput.dataset.position = pos;
        playerSearchInput.disabled = true; // Disabled by default; enabled by enableInputsFromServerState if it's this slot's turn
        playerSearchInput.autocomplete = 'off';
        playerSearchInput.spellcheck = false;

        const searchResultsContainer = document.createElement("div");
        searchResultsContainer.classList.add("search-results-container");
        searchResultsContainer.style.display = "none"; // Hidden initially

        // Salary Cell
        const salaryCell = document.createElement("td");
        salaryCell.classList.add("salary-cell");

        // Pre-fill input and salary if a player was picked for this slot
        if (playerPick) {
            playerSearchInput.value = playerPick.playerName || '';
            playerSearchInput.dataset.playerId = playerPick.playerId; // Store ID
            const salary = parseInt(playerPick.salary);
            salaryCell.textContent = !isNaN(salary)
                ? salary.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })
                : '$0';
        } else {
            playerSearchInput.dataset.playerId = ""; // Ensure it's empty if no pick
        }

        // Append elements to the row
        nameCell.appendChild(playerSearchInput);
        nameCell.appendChild(searchResultsContainer);
        row.appendChild(nameCell);
        row.appendChild(salaryCell);

        // Add Event Listeners for Search/Selection to the input
        playerSearchInput.addEventListener("input", handlePlayerSearchInput);
        playerSearchInput.addEventListener('blur', handlePlayerSearchBlur);
        playerSearchInput.addEventListener('keydown', handlePlayerSearchKeydown);

        return row;
    }

    /**
     * Updates the turn counter display based on server state.
     * @param {object} serverState - The draft state object from the server.
     */
    function updateTurnDisplayFromServerState(serverState) {
        if (!turnCounterElement || !serverState.settings) {
             if(turnCounterElement) turnCounterElement.textContent = ""; // Clear if no settings
             return;
        };

        turnCounterElement.classList.remove('waiting', 'full');

        const { numTables, tableNames } = serverState.settings;
        const totalSlots = numTables * getTotalSlotsPerTable(serverState);
        const picksMade = serverState.picks?.length || 0;
        const nextTableId = serverState.nextTableToPick; // Whose turn it is according to server

        if (picksMade >= totalSlots) {
            turnCounterElement.textContent = "Draft Complete";
            turnCounterElement.classList.add('full');
        } else if (nextTableId >= 0 && nextTableId < numTables) {
            const currentRound = getCurrentRound(serverState);
            const currentTableName = tableNames[nextTableId] || `Table ${nextTableId + 1}`; // Use server's table names
            turnCounterElement.textContent = `Round ${currentRound} • Turn: ${currentTableName}`;
        } else {
            // This might happen briefly or if server state is inconsistent
            turnCounterElement.textContent = "Waiting for server...";
            turnCounterElement.classList.add('waiting');
        }
    }

    /**
     * Recalculates and updates the total salary display for a table based on server picks.
     * @param {HTMLTableElement} tableElement - The table element to update.
     * @param {number} maxSalary - The maximum salary cap from server settings.
     * @param {Array} serverPicks - The full picks array from the server state.
     */
     function recalculateTotalSalaryFromServerState(tableElement, maxSalary, serverPicks) {
        const tableId = parseInt(tableElement.dataset.tableId);
        let currentTotalSalary = 0;

        if (!isNaN(tableId) && serverPicks) {
            // Sum salaries for picks belonging to this table
            serverPicks.forEach(pick => {
                if (pick.tableId === tableId && pick.salary != null) {
                    const salaryValue = parseInt(pick.salary);
                    if (!isNaN(salaryValue)) {
                        currentTotalSalary += salaryValue;
                    }
                }
            });
        }

        // Update the display in the table's total row
        const totalSalaryCell = tableElement.querySelector(".total-salary-cell");
        if (totalSalaryCell) {
            totalSalaryCell.textContent = currentTotalSalary.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
            const exceedsCap = maxSalary > 0 && currentTotalSalary > maxSalary;
            // Apply styling for exceeding cap
            totalSalaryCell.style.color = exceedsCap ? 'red' : '';
            totalSalaryCell.style.fontWeight = exceedsCap ? 'bold' : '';
        }
     }

    /**
     * Enables the correct player input field based on whose turn it is (from server state).
     * @param {object} serverState - The draft state object from the server.
     */
    function enableInputsFromServerState(serverState) {
        if (!tablesContainer || !serverState.settings) return;

        // Disable all inputs first
        tablesContainer.querySelectorAll(".player-search-input").forEach(input => input.disabled = true);

        const { numTables } = serverState.settings;
        const totalSlots = numTables * getTotalSlotsPerTable(serverState);
        const picksMade = serverState.picks?.length || 0;
        const nextTableId = serverState.nextTableToPick; // Server dictates the turn

        // Only enable if draft is ongoing and the turn is valid
        if (picksMade < totalSlots && nextTableId >= 0 && nextTableId < numTables) {
            const targetTable = tablesContainer.querySelector(`table[data-table-id="${nextTableId}"]`);
            if (targetTable) {
                // Find the *first* input slot in the target table that doesn't have a player ID yet
                // This relies on rows being generated in the correct order
                const nextEmptyInput = targetTable.querySelector(`.player-search-input[data-player-id=""]`);
                if (nextEmptyInput) {
                    nextEmptyInput.disabled = false;
                    // nextEmptyInput.focus(); // Optional: Auto-focus the input for the current user
                } else {
                     // This might happen if the table is full but the draft isn't - server logic should prevent this.
                     console.warn(`Table ${nextTableId} is next to pick, but no empty input slot found in UI.`);
                     if(turnCounterElement) turnCounterElement.classList.add('waiting');
                }
            }
        }
    }

    /**
     * Resets the UI to the initial start screen state.
     */
    function showStartScreen() {
        console.log("Showing start screen...");
        // Hide overlays and draft area
        if (settingsOverlay) settingsOverlay.classList.remove('visible');
        if (tableNamesOverlay) tableNamesOverlay.classList.remove('visible');
        if (draftArea) draftArea.classList.add('hidden');
        // Show start container
        if (startContainerElement) startContainerElement.style.display = 'flex';
        // Clear dynamic content
        if (tablesContainer) tablesContainer.innerHTML = "";
        if (turnCounterElement) turnCounterElement.textContent = "";
        // Reset buttons
        if (undoButton) undoButton.disabled = true;
        // Clear stored server state
        currentServerState = null;
    }


    // --- Socket.IO Event Listeners (Handling Server Communication) ---

    /**
     * Main listener for receiving draft state updates from the server.
     */
    socket.on('draft_state_update', (serverDraftState) => {
        // Convert selectedPlayerIds array back to Set if needed
        if (serverDraftState && serverDraftState.selectedPlayerIds && Array.isArray(serverDraftState.selectedPlayerIds)) {
             serverDraftState.selectedPlayerIds = new Set(serverDraftState.selectedPlayerIds);
        }
        renderUIFromServerState(serverDraftState);
    });

    /**
     * Listener for pick errors sent by the server.
     */
    socket.on('pick_error', (error) => {
        console.error("Pick Error from Server:", error.message);
        alert(`Error making pick: ${error.message}`);
        // Re-render UI based on the last known valid state to ensure consistency
        // This might re-enable the input if the server didn't accept the pick.
        if(currentServerState) {
            renderUIFromServerState(currentServerState);
        }
    });

    /**
     * Listener for server confirmation of table name update.
     * (Optional: Could just rely on draft_state_update)
     */
    // socket.on('table_name_updated', (updateData) => {
    //     console.log(`Server confirmed name update for table ${updateData.tableId}`);
    //     // Optionally update UI directly or wait for full state update
    // });

    /**
     * Handles connection errors to the Socket.IO server.
     */
    socket.on("connect_error", (err) => {
        console.error(`Connection Error: ${err.message}`);
        alert("Failed to connect to the draft server. Please refresh.");
        showStartScreen(); // Revert to start screen on connection failure
    });

    /**
     * Handles disconnection from the Socket.IO server.
     */
    socket.on("disconnect", (reason) => {
        console.warn(`Disconnected from server: ${reason}`);
        alert("Lost connection to the draft server. Please refresh.");
        showStartScreen(); // Revert to start screen on disconnect
    });


    // --- Event Handlers (User Actions -> Emit to Server) ---

    /**
     * Handles the click event on the Start Draft button.
     * Validates inputs locally and shows the table name entry overlay.
     */
    function handleStartDraftClick() {
        // 1. Read and Validate Start Settings (Local Validation)
        const initialTableCount = parseInt(tableCountInput.value);
        const initialForwards = parseInt(numForwardsInput.value);
        const initialDefenders = parseInt(numDefendersInput.value);
        const initialGoaltenders = parseInt(numGoaltendersInput.value);
        const initialSerpentine = serpentineOrderCheckbox.checked;
        const initialSalaryCap = parseInt(maxSalaryCapInput.value);

        let isValid = true;
        let errorMessage = "";

        // --- Input Validation ---
        if (isNaN(initialTableCount) || initialTableCount < 1) {
             errorMessage = "Please enter a valid number of tables (1 or more).";
             isValid = false;
        } else if (isNaN(initialForwards) || initialForwards < 0 ||
                   isNaN(initialDefenders) || initialDefenders < 0 ||
                   isNaN(initialGoaltenders) || initialGoaltenders < 0) {
             errorMessage = "Please enter valid numbers (0 or more) for player positions.";
             isValid = false;
        } else if (initialForwards + initialDefenders + initialGoaltenders === 0) {
             errorMessage = "Total number of players per table cannot be zero.";
             isValid = false;
        } else if (isNaN(initialSalaryCap) || initialSalaryCap < 0) {
             errorMessage = "Please enter a valid Maximum Salary Cap (0 or more).";
             isValid = false;
        }
        // --- End Validation ---

        if (!isValid) {
            alert(errorMessage);
            // Focus the first invalid input (optional enhancement)
            if (isNaN(initialTableCount) || initialTableCount < 1) tableCountInput?.focus();
            // ... add focusing logic for other inputs ...
            return; // Stop if validation fails
        }

        // 2. Store settings temporarily (needed after name confirmation)
        tempDraftSettings = {
            initialTableCount,
            initialForwards,
            initialDefenders,
            initialGoaltenders,
            initialSerpentine,
            initialSalaryCap
        };

        // 3. Prepare and Show Table Names Overlay
        if (!tableNamesOverlay || !tableNamesInputContainer) {
            console.error("Table names overlay elements not found!");
            return;
        }

        tableNamesInputContainer.innerHTML = ''; // Clear previous inputs
        for (let i = 0; i < initialTableCount; i++) {
            const inputGroup = document.createElement('div');
            inputGroup.classList.add('settings-input-group');

            const label = document.createElement('label');
            label.htmlFor = `tableNameInput-${i}`;
            label.textContent = `Name for Table ${i + 1}:`;

            const input = document.createElement('input');
            input.type = 'text';
            input.id = `tableNameInput-${i}`;
            input.dataset.tableIndex = i;
            input.placeholder = `Table ${i + 1}`; // Default placeholder
            // input.required = true; // HTML5 validation, but we handle empty strings below

            inputGroup.appendChild(label);
            inputGroup.appendChild(input);
            tableNamesInputContainer.appendChild(inputGroup);
        }

        tableNamesOverlay.classList.add('visible'); // Show the overlay
        tableNamesInputContainer.querySelector('input')?.focus(); // Focus the first name input
    }

    /**
     * Handles the click on the Confirm Table Names button.
     * Gathers settings and names, then emits 'start_draft' to the server.
     */
    function handleConfirmTableNamesClick() {
        if (!tableNamesOverlay || !tableNamesInputContainer || !tempDraftSettings) return;

        const collectedTableNames = {};
        const inputs = tableNamesInputContainer.querySelectorAll('input[type="text"]');

        // Collect table names, using default if empty
        inputs.forEach(input => {
            const index = parseInt(input.dataset.tableIndex);
            let name = input.value.trim();
            const defaultName = `Table ${index + 1}`;
            if (name === "") {
                console.log(`Using default name "${defaultName}" for Table ${index + 1}`);
                name = defaultName;
            }
            if (!isNaN(index)) { // Ensure index is valid
                 collectedTableNames[index] = name;
            }
        });

        // Prepare settings object to send to server
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

        // Emit 'start_draft' event to the server with the collected settings
        console.log("Emitting start_draft with settings:", settings);
        socket.emit('start_draft', settings);

        // Clear temporary settings storage
        tempDraftSettings = {};

        // Hide the table names overlay immediately for better UX
        // The main draft UI will appear when the server sends the first 'draft_state_update'
        tableNamesOverlay.classList.remove('visible');
    }

    /**
     * Handles input events on the player search input field.
     * Filters available players based on server state and displays results.
     * @param {Event} event - The input event object.
     */
    function handlePlayerSearchInput(event) {
        const currentInput = event.target;
        const searchTerm = currentInput.value.trim();
        const position = currentInput.dataset.position;
        const resultsContainer = currentInput.nextElementSibling; // Assumes results div is next sibling

        // Ensure necessary elements and server state are available
        if (!resultsContainer || !position || !currentServerState || !currentServerState.selectedPlayerIds) {
             if (resultsContainer) resultsContainer.style.display = "none"; // Hide if state is missing
             return;
        }

        resultsContainer.innerHTML = ""; // Clear previous results
        if (searchTerm.length < 1) {
            resultsContainer.style.display = "none";
            return;
        }

        // Get available players based on position and the server's list of selected IDs
        const availablePlayers = getAvailablePlayers(position, currentServerState.selectedPlayerIds);
        const matchingPlayers = searchPlayers(searchTerm, availablePlayers); // Use your existing search function

        // Display results or hide container if no matches
        resultsContainer.style.display = matchingPlayers.length > 0 ? "block" : "none";

        // Create and append options for matching players (limit results for performance)
        matchingPlayers.slice(0, 10).forEach(player => {
            const playerOption = document.createElement("div");
            playerOption.classList.add("player-option");
            playerOption.dataset.playerId = player.id;

            // Format salary for display
            const salary = parseInt(player.cap_hit);
            const salaryFormatted = !isNaN(salary)
                ? salary.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })
                : 'N/A';

            playerOption.textContent = `${player.name} (${salaryFormatted})`;
            // Add listener to handle selection
            playerOption.addEventListener('mousedown', handlePlayerOptionMouseDown);
            resultsContainer.appendChild(playerOption);
        });
    }

    /**
     * Handles the blur event on the player search input (hides results).
     * Uses a timeout to allow clicks on results to register first.
     * @param {Event} event - The blur event object.
     */
    function handlePlayerSearchBlur(event) {
        const resultsContainer = event.target.nextElementSibling;
        if (!resultsContainer) return;
        // Delay hiding to allow mousedown on results to register
        setTimeout(() => {
            // Check if focus has moved outside the input AND the results container
            if (resultsContainer && document.activeElement !== event.target && !resultsContainer.contains(document.activeElement)) {
                resultsContainer.style.display = 'none';
            }
        }, 150); // Adjust delay if needed
    }

    /**
     * Handles keydown events (Enter) in the player search input.
     * Selects the first result if available.
     * @param {Event} event - The keydown event object.
     */
    function handlePlayerSearchKeydown(event) {
        if (event.key === 'Enter') {
            event.preventDefault(); // Prevent default form submission behavior
            const resultsContainer = event.target.nextElementSibling;
            const firstOption = resultsContainer?.querySelector('.player-option');
            // If there's a result, simulate a click on it
            if (firstOption) {
                const clickEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window });
                firstOption.dispatchEvent(clickEvent);
            }
        }
    }

    /**
     * Handles the mousedown event on a player option in the search results.
     * Gathers pick data and emits 'make_pick' to the server.
     * @param {Event} event - The mousedown event object.
     */
    function handlePlayerOptionMouseDown(event) {
        event.preventDefault(); // Prevent input blur before processing
        const playerOption = event.currentTarget; // The div that was clicked
        const resultsContainer = playerOption.parentElement;
        const inputElement = resultsContainer?.previousElementSibling; // Assumes input is previous sibling

        if (!inputElement || !resultsContainer) return;

        const parentTable = inputElement.closest('table');
        const playerId = parseInt(playerOption.dataset.playerId);
        // Find player details from the local index
        const player = playersIndex.find(p => p.id === playerId);
        const tableId = parentTable ? parseInt(parentTable.dataset.tableId) : -1;

        // Basic validation before emitting
        if (parentTable && player && tableId !== -1) {
            // Prepare data object to send to the server
            const pickData = {
                playerId: player.id,
                playerName: player.name,
                salary: parseInt(player.cap_hit) || 0, // Ensure salary is a number
                position: player.position,
                tableId: tableId,
            };

            // Emit the 'make_pick' event to the server
            console.log("Emitting make_pick:", pickData);
            socket.emit('make_pick', pickData);

            // --- Client-Side Feedback (Immediate but Temporary) ---
            // Hide results immediately
            resultsContainer.style.display = "none";
            resultsContainer.innerHTML = "";
            // Optionally disable the input and show placeholder while waiting for server confirmation
            inputElement.disabled = true;
            inputElement.value = ''; // Clear search term
            inputElement.placeholder = "Processing pick...";

            // --- IMPORTANT: Do NOT update the main UI state here. ---
            // The UI will be updated when the server sends 'draft_state_update'.

        } else {
            console.error("Could not find necessary elements or player data for selection.");
            // Optionally provide brief user feedback about the error
        }
    }

    /**
     * Handles the click event on the Undo button.
     * Emits 'undo_pick' to the server.
     */
    function handleUndoClick() {
        // Check if undo is possible based on current state (optional client-side check)
        if (!currentServerState || !currentServerState.picks || currentServerState.picks.length === 0) {
            console.warn("Undo clicked, but no picks in current state.");
            return;
        }
        console.log("Emitting undo_pick request to server...");
        socket.emit('undo_pick');
        // The UI will update based on the subsequent 'draft_state_update' from the server.
    }

    /**
     * Handles the blur event when editing a table name.
     * Emits 'update_table_name' to the server.
     * @param {Event} event - The blur event object.
     */
    function handleTableNameEdit(event) {
        const headerCell = event.target;
        const table = headerCell.closest('table');
        if (!table) return;

        const tableId = parseInt(table.dataset.tableId);
        let newName = headerCell.textContent.trim();

        if (!isNaN(tableId)) {
            // If name is cleared, revert to default locally for immediate display feedback
            if (newName === "") {
                newName = `Table ${tableId + 1}`;
                headerCell.textContent = newName; // Update display immediately
            }

            // Check if the name actually changed from the server's perspective
            const serverName = currentServerState?.settings?.tableNames?.[tableId] || `Table ${tableId + 1}`;
            if (newName !== serverName) {
                 // Emit event to server only if the name is different
                 console.log(`Emitting update_table_name: Table ${tableId}, Name: ${newName}`);
                 socket.emit('update_table_name', { tableId: tableId, newName: newName });
            } else {
                 // If name hasn't changed from server state, ensure local display matches server
                 headerCell.textContent = serverName;
            }
            // The name will be officially updated for everyone when the server broadcasts 'draft_state_update'.
        }
    }

    /**
     * Handles keydown (Enter) event when editing a table name.
     * Prevents newline and triggers blur to save.
     * @param {Event} event - The keydown event object.
     */
    function handleTableNameKeydown(event) {
        if (event.key === 'Enter') {
            event.preventDefault(); // Stop Enter from creating newline
            event.target.blur();    // Trigger the blur event -> handleTableNameEdit -> emit
        }
    }

    /**
     * Handles click on the main settings button (opens overlay).
     * Updates the max salary input from the current server state.
     */
    function handleSettingsButtonClick() {
        if (!settingsOverlay || !maxSalaryCapInput) return;
        // Update maxSalaryCapInput value from current server state before showing
        if(currentServerState?.settings?.maxSalary != null) { // Check if not null/undefined
            maxSalaryCapInput.value = currentServerState.settings.maxSalary;
        }
        settingsOverlay.classList.add('visible');
    }

    /** Handles click on the overlay's close button. */
    function handleCloseSettingsClick() {
        if (!settingsOverlay) return;
        settingsOverlay.classList.remove('visible');
    }

    /** Handles clicks outside the settings overlay content to close it. */
    function handleOverlayBackgroundClick(event) {
        // Only close if the click is directly on the overlay background, not its children
        if (event.target === settingsOverlay) {
            handleCloseSettingsClick();
        }
    }

    /** Handles cancelling the table name entry overlay. */
    function handleCancelTableNamesClick() {
        if (tableNamesOverlay) {
            tableNamesOverlay.classList.remove('visible');
        }
        tempDraftSettings = {}; // Clear temporary settings
        console.log("Table name entry cancelled.");
    }

    /** Handles the Exit Draft button click in the settings overlay. */
    function handleExitDraftClick() {
        // Optionally notify the server the user is leaving the draft context
        // socket.emit('leave_draft'); // If tracking active users is important on the server

        // Revert UI to the start screen
        showStartScreen();
    }


    // --- Attaching Event Listeners ---

    // Start Screen
    if (startDraftButton) startDraftButton.addEventListener('click', handleStartDraftClick);
    else console.error("Start Draft button not found.");

    // Draft Area & Settings
    if (exitDraftButton) exitDraftButton.addEventListener('click', handleExitDraftClick);
    else console.error("Exit Draft button not found.");

    if (undoButton) undoButton.addEventListener('click', handleUndoClick);
    else console.error("Undo button not found.");

    if (settingsButton) settingsButton.addEventListener('click', handleSettingsButtonClick);
    else console.error("Settings button not found.");

    // Settings Overlay
    if (settingsOverlay) settingsOverlay.addEventListener('click', handleOverlayBackgroundClick);
    else console.error("Settings overlay not found.");

    if (closeSettingsButton) closeSettingsButton.addEventListener('click', handleCloseSettingsClick);
    else console.error("Close Settings button not found.");

    if (confirmTableNamesButton) confirmTableNamesButton.addEventListener('click', handleConfirmTableNamesClick);
    else console.error("Confirm Table Names button not found.");

    if (cancelTableNamesButton) cancelTableNamesButton.addEventListener('click', handleCancelTableNamesClick);
    else console.error("Cancel Table Names button not found.");

    // --- Initialization ---
    console.log("Draft application client initialized. Connecting to server...");
    // Show the start screen initially. The draft UI will be rendered
    // when the first 'draft_state_update' is received from the server.
    showStartScreen();
    // Set initial value in salary cap input from default (will be overwritten by server state if draft is in progress)
    if (maxSalaryCapInput) maxSalaryCapInput.value = 85000000; // Use the default from HTML or a constant

}); // End DOMContentLoaded
