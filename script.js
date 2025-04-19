// script.js
import { playersIndex as playersIndexData, searchPlayers } from "./PlayerIndex_2024-25.mjs";

document.addEventListener("DOMContentLoaded", () => {

    // --- State Variables ---
    let selectedPlayers = new Set();
    let numTables = 0;
    let tableNames = {}; // Stores custom names { tableIndex: name }
    let lastActiveTableIndex = -1; // Index of the table that made the last pick
    let currentMaxSalary = 83500000; // Default, updated from inputs
    let currentPlayersPerPos = {}; // { A: count, D: count, G: count }
    let currentActivePositions = []; // Array of positions with count > 0 (e.g., ['A', 'D', 'G'])
    let isSerpentineOrder = false;
    let nextTableToPick = 0; // Index of the table whose turn it is
    let currentPickDirection = 1; // 1 for forward, -1 for backward (serpentine)
    let pickHistory = [];
    let tempDraftSettings = {};

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

    // Start Screen Inputs
    const tableCountInput = document.getElementById("tableCount");
    const numForwardsInput = document.getElementById("numForwards");
    const numDefendersInput = document.getElementById("numDefenders");
    const numGoaltendersInput = document.getElementById("numGoaltenders");
    const serpentineOrderCheckbox = document.getElementById("serpentineOrder");

    // Settings Overlay Input
    const maxSalaryCapInput = document.getElementById("maxSalaryCap");


    // --- Helper Functions ---

    /**
     * Calculates the total number of player slots per table based on current settings.
     * @returns {number} Total slots per table.
     */
    function getTotalSlotsPerTable() {
        if (!currentPlayersPerPos || Object.keys(currentPlayersPerPos).length === 0) return 0;
        return currentActivePositions.reduce((sum, pos) => sum + (currentPlayersPerPos[pos] || 0), 0);
    }

    /**
     * Calculates the current draft round number.
     * @param {number} [picks=selectedPlayers.size] - The number of picks made so far.
     * @returns {number} The current round number (starting from 1).
     */
    function getCurrentRound(picks = selectedPlayers.size) {
        if (numTables <= 0) return 1;
        const totalSlotsPerTable = getTotalSlotsPerTable();
        if (totalSlotsPerTable === 0) return 1;
        return Math.floor(picks / numTables) + 1;
    }

    /**
     * Filters the main playersIndex to get available players for a specific position.
     * @param {string} position - The position ('A', 'D', 'G').
     * @returns {Array} An array of available player objects.
     */
    function getAvailablePlayers(position) {
        if (!Array.isArray(playersIndex)) {
            console.error("playersIndex is not loaded or not an array.");
            return [];
        }
        return playersIndex.filter(player =>
            player.position === position && !selectedPlayers.has(player.id)
        );
    }


    // --- UI Update Functions ---

    /**
     * Updates the turn counter display (Round X, Turn: Table Y).
     */
    function updateTurnDisplay() {
        if (!turnCounterElement) return;
        turnCounterElement.classList.remove('waiting', 'full');

        // Clear display if draft isn't active or configured
        if (numTables <= 0 || getTotalSlotsPerTable() === 0 || (draftArea && draftArea.classList.contains('hidden'))) {
            turnCounterElement.textContent = "";
            return;
        }

        const totalSlots = numTables * getTotalSlotsPerTable();
        const picksMade = selectedPlayers.size;

        if (picksMade >= totalSlots) {
            turnCounterElement.textContent = "Draft Complete";
            turnCounterElement.classList.add('full');
        } else {
            const currentRound = getCurrentRound();
            const currentTableName = (nextTableToPick >= 0 && tableNames[nextTableToPick])
                                     ? tableNames[nextTableToPick]
                                     : `Table ${nextTableToPick + 1}`; // Fallback name
            turnCounterElement.textContent = `Round ${currentRound} • Turn: ${currentTableName}`;

            // Indicate waiting if the next input isn't enabled (shouldn't normally happen)
            const enabledInput = tablesContainer?.querySelector('.player-search-input:not([disabled])');
             if (!enabledInput && picksMade < totalSlots) {
                 turnCounterElement.classList.add('waiting');
             }
        }
    }

    /**
     * Recalculates and updates the total salary display for a given table.
     * @param {HTMLTableElement} tableElement - The table element to update.
     * @param {number} maxSalary - The current maximum salary cap.
     */
    function recalculateTotalSalary(tableElement, maxSalary) {
        let currentTotalSalary = 0;
        tableElement.querySelectorAll("tbody .player-search-input[data-player-id]:not([data-player-id=''])").forEach(input => {
            const playerId = input.dataset.playerId;
            if (!Array.isArray(playersIndex)) return;

            const parsedPlayerId = parseInt(playerId);
            if (isNaN(parsedPlayerId)) return; // Skip if ID is not a number

            const player = playersIndex.find(p => p.id === parsedPlayerId);
            if (player?.cap_hit != null) {
                const salaryValue = parseInt(player.cap_hit);
                if (!isNaN(salaryValue)) {
                    currentTotalSalary += salaryValue;
                }
            }
        });

        const totalSalaryCell = tableElement.querySelector(".total-salary-cell");
        if (totalSalaryCell) {
            totalSalaryCell.textContent = currentTotalSalary.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
            const exceedsCap = maxSalary > 0 && currentTotalSalary > maxSalary;
            // Use CSS class for styling instead of direct style manipulation for better separation
            totalSalaryCell.style.color = exceedsCap ? 'red' : ''; // Keep direct style for simplicity here
            totalSalaryCell.style.fontWeight = exceedsCap ? 'bold' : '';
        }
    }

    /**
     * Updates a table row with the selected player's data or clears it.
     * @param {HTMLTableRowElement} row - The table row element to update.
     * @param {object | null} newPlayer - The player object to add, or null/undefined to clear.
     */
    function updatePlayerRow(row, newPlayer) {
        const playerSearchInput = row.querySelector(".player-search-input");
        const salaryCell = row.querySelector(".salary-cell");
        if (!playerSearchInput || !salaryCell) return;

        const oldPlayerIdStr = playerSearchInput.dataset.playerId;

        // Remove old player from selected set if one existed
        if (oldPlayerIdStr) {
            const oldPlayerId = parseInt(oldPlayerIdStr);
            if (!isNaN(oldPlayerId)) {
                selectedPlayers.delete(oldPlayerId);
            }
        }

        // Add new player or clear the row
        if (newPlayer && typeof newPlayer.id === 'number') {
             selectedPlayers.add(newPlayer.id);
             playerSearchInput.value = newPlayer.name || '';
             playerSearchInput.dataset.playerId = newPlayer.id;

             const salary = parseInt(newPlayer.cap_hit);
             salaryCell.textContent = !isNaN(salary)
                 ? salary.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })
                 : '$0'; // Default display for missing/invalid salary
        } else {
            // Clear the row
            playerSearchInput.value = '';
            playerSearchInput.dataset.playerId = "";
            salaryCell.textContent = "";
            // Old player ID already removed above
        }
    }


    // --- Core Draft Logic ---

    /**
     * Enables the correct player input field for the current turn.
     */
    function enableCurrentTableInputs() {
        if (!tablesContainer) return;

        // Disable all inputs first
        tablesContainer.querySelectorAll(".player-search-input").forEach(input => input.disabled = true);

        // Check if draft is valid and ongoing
        if (numTables <= 0 || getTotalSlotsPerTable() === 0 || selectedPlayers.size >= (numTables * getTotalSlotsPerTable())) {
            updateTurnDisplay(); // Update display (might show "Complete" or be blank)
            return;
        }

        // Ensure nextTableToPick is a valid index
        if (nextTableToPick < 0 || nextTableToPick >= numTables) {
             console.error(`State Error: nextTableToPick (${nextTableToPick}) is out of bounds [0-${numTables-1}].`);
             updateTurnDisplay(); // Update display (likely shows waiting)
             turnCounterElement?.classList.add('waiting');
             return;
        }

        const targetTable = tablesContainer.querySelector(`table[data-table-id="${nextTableToPick}"]`);
        let nextEmptyInput = null;

        if (targetTable) {
            // Find the *first* empty input slot in the target table
            nextEmptyInput = targetTable.querySelector(`.player-search-input[data-player-id=""]`);
        }

        if (nextEmptyInput) {
            // const currentTableName = tableNames[nextTableToPick] || `Table ${nextTableToPick + 1}`;
            // console.log(`Enabling input in ${currentTableName}`);
            nextEmptyInput.disabled = false;
            // nextEmptyInput.focus(); // Optional: Auto-focus the input
            lastActiveTableIndex = nextTableToPick; // Track the table that *will* make the pick
            updateTurnDisplay();
        } else {
            // This indicates the current table is full, but the draft isn't - turn logic error?
            const expectedTableName = tableNames[nextTableToPick] || `Table ${nextTableToPick + 1}`;
            console.error(`Logic Error: Table ${expectedTableName} (Index ${nextTableToPick}) has no empty slots, but draft is not complete.`);
            updateTurnDisplay();
            turnCounterElement?.classList.add('waiting');
            // Consider attempting auto-advance: goToNextTurn(); // Use with caution
        }
    }

    /**
     * Calculates the next table to pick and enables its input.
     */
    function goToNextTurn() {
        if (numTables <= 0) return; // Draft not configured

        const totalSlots = numTables * getTotalSlotsPerTable();
        const picksMade = selectedPlayers.size; // Picks *after* the one just made

        // Check if the pick just made completed the draft
        if (picksMade >= totalSlots) {
            nextTableToPick = -1; // Indicate no next pick
            enableCurrentTableInputs(); // Disables all inputs and updates display
            return;
        }

        // Determine if direction reverses (serpentine)
        const isEndOfRound = (currentPickDirection === 1 && lastActiveTableIndex === numTables - 1) ||
                             (currentPickDirection === -1 && lastActiveTableIndex === 0);

        if (isSerpentineOrder && isEndOfRound) {
            currentPickDirection *= -1; // Reverse direction
            // The same table picks again at the turn
            nextTableToPick = lastActiveTableIndex;
        } else {
            // Move to the next table in the current direction
            // Handles initial state (lastActiveTableIndex = -1) implicitly
            nextTableToPick = (lastActiveTableIndex + currentPickDirection + numTables) % numTables;
        }

        // const nextTableName = tableNames[nextTableToPick] || `Table ${nextTableToPick + 1}`;
        // console.log(`Next pick: ${nextTableName} (Index ${nextTableToPick}), Direction: ${currentPickDirection > 0 ? 'Forward' : 'Backward'}`);
        enableCurrentTableInputs(); // Enable the input for the calculated next table
    }


    // --- UI Generation & Manipulation ---

    /**
     * Generates the draft tables based on current state settings.
     */
    function generateTables() {
        if (!tablesContainer) {
             console.error("generateTables: tablesContainer not found.");
             return;
        }

        // Clear previous UI and non-settings state
        tablesContainer.innerHTML = "";
        selectedPlayers.clear();
        // tableNames = {}; // <<< REMOVE: tableNames is now set *before* calling this
        pickHistory = [];

        // Get settings from current state
        const currentTableCount = numTables; // numTables is already set
        const { maxSalary, playersPerPos, activePositions } = {
            maxSalary: currentMaxSalary,
            playersPerPos: currentPlayersPerPos,
            activePositions: currentActivePositions
        };

        // Validation
        if (currentTableCount < 1 || activePositions.length === 0 || getTotalSlotsPerTable() === 0) {
            console.error("generateTables called with invalid state.");
            exitToStartScreen();
            alert("Invalid draft settings detected. Please configure again.");
            return;
        }

        // Generate each table
        for (let i = 0; i < currentTableCount; i++) {
            const tableWrapper = document.createElement("div");
            tableWrapper.classList.add("table-wrapper");

            const table = document.createElement("table");
            table.dataset.tableId = i;
            // const defaultTableName = `Table ${i + 1}`; // <<< REMOVE
            // tableNames[i] = defaultTableName; // <<< REMOVE

            // <<< MODIFIED: Use tableNames[i] directly >>>
            const currentTableName = tableNames[i] || `Table ${i + 1}`; // Fallback just in case

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

            // Add event listener for table name editing (this still works for later edits)
            const headerCell = table.querySelector("thead .table-header td[contenteditable='true']");
            if (headerCell) {
                 headerCell.addEventListener('blur', handleTableNameEdit);
                 headerCell.addEventListener('keydown', handleTableNameKeydown);
            }

            // ... (rest of table generation logic remains the same) ...
             // Add rows for each position slot
            activePositions.forEach(pos => {
                const countForPos = playersPerPos[pos];
                if (countForPos > 0) {
                    for (let j = 0; j < countForPos; j++) {
                        const row = createPlayerRow(pos, i, j === 0 ? countForPos : 0); // Pass rowspan only for first row
                        tbody.appendChild(row);
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
        } // End loop for generating tables

        // Reset Turn State for a fresh draft
        lastActiveTableIndex = -1;
        currentPickDirection = 1;
        nextTableToPick = 0;

        // Disable undo button initially
        if (undoButton) undoButton.disabled = true;

        // Enable the first input slot
        enableCurrentTableInputs();
    }

    /**
     * Creates a single player row element for the table.
     * @param {string} pos - The position ('A', 'D', 'G').
     * @param {number} tableId - The index of the table this row belongs to.
     * @param {number} posRowSpan - The rowspan for the vertical position cell (0 if not the first row).
     * @returns {HTMLTableRowElement} The created table row element.
     */
    function createPlayerRow(pos, tableId, posRowSpan) {
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
        playerSearchInput.dataset.playerId = "";
        playerSearchInput.dataset.tableId = tableId;
        playerSearchInput.dataset.position = pos;
        playerSearchInput.disabled = true; // Initially disabled
        playerSearchInput.autocomplete = 'off';
        playerSearchInput.spellcheck = false;

        const searchResultsContainer = document.createElement("div");
        searchResultsContainer.classList.add("search-results-container");
        searchResultsContainer.style.display = "none"; // Hidden initially

        nameCell.appendChild(playerSearchInput);
        nameCell.appendChild(searchResultsContainer);
        row.appendChild(nameCell);

        // Salary Cell
        const salaryCell = document.createElement("td");
        salaryCell.classList.add("salary-cell");
        row.appendChild(salaryCell);

        // Add Event Listeners for Search/Selection to the input
        playerSearchInput.addEventListener("input", handlePlayerSearchInput);
        playerSearchInput.addEventListener('blur', handlePlayerSearchBlur);
        playerSearchInput.addEventListener('keydown', handlePlayerSearchKeydown);

        return row;
    }

    /**
     * Hides the draft area, shows the start screen, and resets draft state.
     */
     function exitToStartScreen() {
        console.log("Exiting draft, returning to start screen...");

        if (settingsOverlay) settingsOverlay.classList.remove('visible');

        // Toggle UI Visibility
        if (draftArea) draftArea.classList.add('hidden');
        if (startContainerElement) startContainerElement.style.display = 'flex'; // Show start

        // Clear Dynamic Content
        if (tablesContainer) tablesContainer.innerHTML = "";
        if (turnCounterElement) turnCounterElement.textContent = "";

        // Reset Draft State Variables
        selectedPlayers.clear();
        numTables = 0;
        tableNames = {};
        lastActiveTableIndex = -1;
        // currentMaxSalary remains as set in the overlay input
        currentPlayersPerPos = {};
        currentActivePositions = [];
        isSerpentineOrder = false;
        nextTableToPick = 0;
        currentPickDirection = 1;
        pickHistory = [];

        console.log("Draft exited. State reset.");
    }


    // --- Event Handlers ---

    /**
     * Handles the click event on the Start Draft button.
     * Validates inputs and shows the table name entry overlay.
     */
    function handleStartDraftClick() {
        // 1. Read and Validate Start Settings
        const initialTableCount = parseInt(tableCountInput.value);
        const initialForwards = parseInt(numForwardsInput.value);
        const initialDefenders = parseInt(numDefendersInput.value);
        const initialGoaltenders = parseInt(numGoaltendersInput.value);
        const initialSerpentine = serpentineOrderCheckbox.checked;
        const initialSalaryCap = parseInt(maxSalaryCapInput.value);

        let isValid = true;
        let errorMessage = "";

        if (isNaN(initialTableCount) || initialTableCount < 1) {
             errorMessage = "Please enter a valid number of tables (1 or more).";
             tableCountInput?.focus();
             isValid = false;
        } else if (isNaN(initialForwards) || initialForwards < 0 ||
                   isNaN(initialDefenders) || initialDefenders < 0 ||
                   isNaN(initialGoaltenders) || initialGoaltenders < 0) {
             errorMessage = "Please enter valid numbers (0 or more) for player positions.";
             if (isNaN(initialForwards) || initialForwards < 0) numForwardsInput?.focus();
             else if (isNaN(initialDefenders) || initialDefenders < 0) numDefendersInput?.focus();
             else numGoaltendersInput?.focus();
             isValid = false;
        } else if (initialForwards + initialDefenders + initialGoaltenders === 0) {
             errorMessage = "Total number of players per table cannot be zero.";
             numForwardsInput?.focus();
             isValid = false;
        } else if (isNaN(initialSalaryCap) || initialSalaryCap < 0) {
             errorMessage = "Please enter a valid Maximum Salary Cap (0 or more).";
             maxSalaryCapInput?.focus();
             isValid = false;
        }

        if (!isValid) {
            alert(errorMessage);
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
            input.dataset.tableIndex = i; // Store index for later retrieval
            input.placeholder = `Table ${i + 1}`; // Default placeholder
            input.required = true; // Optional: mark as required

            inputGroup.appendChild(label);
            inputGroup.appendChild(input);
            tableNamesInputContainer.appendChild(inputGroup);
        }

        tableNamesOverlay.classList.add('visible'); // Show the overlay
        // Focus the first input
        tableNamesInputContainer.querySelector('input')?.focus();

    }

    /**
     * <<< Handles the click on the Confirm Table Names button. >>>
     * Reads names, finalizes setup, and starts the draft UI.
     */
    function handleConfirmTableNamesClick() {
        if (!tableNamesOverlay || !tableNamesInputContainer || !tempDraftSettings) return;

        const collectedTableNames = {};
        const inputs = tableNamesInputContainer.querySelectorAll('input[type="text"]');
        let allNamesValid = true;

        inputs.forEach(input => {
            const index = parseInt(input.dataset.tableIndex);
            let name = input.value.trim();
            const defaultName = `Table ${index + 1}`;

            if (name === "") {
                console.log(`Using default name "${defaultName}" for Table ${index + 1}`);
                name = defaultName;
            }
            collectedTableNames[index] = name;
        });

        // --- Finalize Draft Setup ---
        // 1. Update State from temp settings and collected names
        numTables = tempDraftSettings.initialTableCount;
        tableNames = collectedTableNames;
        currentPlayersPerPos = {
            A: tempDraftSettings.initialForwards,
            D: tempDraftSettings.initialDefenders,
            G: tempDraftSettings.initialGoaltenders
        };
        currentActivePositions = Object.keys(currentPlayersPerPos).filter(pos => currentPlayersPerPos[pos] > 0);
        isSerpentineOrder = tempDraftSettings.initialSerpentine;
        currentMaxSalary = tempDraftSettings.initialSalaryCap;
        maxSalaryCapInput.value = currentMaxSalary; // Ensure start screen input matches state

        // 2. Update UI
        tableNamesOverlay.classList.remove('visible'); // Hide the names overlay
        if (startContainerElement) startContainerElement.style.display = 'none'; // Hide start screen
        if (draftArea) draftArea.classList.remove('hidden'); // Show draft area

        // 3. Generate Tables
        try {
             generateTables(); // This will now use the populated tableNames
        } catch (error) {
            console.error("Error during table generation:", error);
            alert("An error occurred generating the draft tables. Returning to setup.");
            exitToStartScreen();
        }

        // Clear temporary settings
        tempDraftSettings = {};
    }

    /** Handles clicks outside the table names overlay */
    function handleTableNamesOverlayBackgroundClick(event) {
        if (event.target === tableNamesOverlay) {
             console.log("Clicked table names overlay background.");
        }
    }

    /**
     * Handles input events on the player search input field.
     * @param {Event} event - The input event object.
     */
    function handlePlayerSearchInput(event) {
        const currentInput = event.target;
        const searchTerm = currentInput.value.trim();
        const position = currentInput.dataset.position;
        const resultsContainer = currentInput.nextElementSibling; // Assumes results div is next sibling
        if (!resultsContainer || !position) return;

        resultsContainer.innerHTML = ""; // Clear previous results
        if (searchTerm.length < 1) {
            resultsContainer.style.display = "none";
            return;
        }

        const availablePlayers = getAvailablePlayers(position);
        const matchingPlayers = searchPlayers(searchTerm, availablePlayers);

        resultsContainer.style.display = matchingPlayers.length > 0 ? "block" : "none";

        matchingPlayers.slice(0, 10).forEach(player => { // Limit displayed results
            const playerOption = document.createElement("div");
            playerOption.classList.add("player-option");
            playerOption.dataset.playerId = player.id;

            const salary = parseInt(player.cap_hit);
            const salaryFormatted = !isNaN(salary)
                ? salary.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })
                : 'N/A';

            playerOption.textContent = `${player.name} (${salaryFormatted})`;
            // Use mousedown to select before blur hides the container
            playerOption.addEventListener('mousedown', handlePlayerOptionMouseDown);
            resultsContainer.appendChild(playerOption);
        });
    }

    /**
     * Handles the blur event on the player search input (hides results).
     * @param {Event} event - The blur event object.
     */
    function handlePlayerSearchBlur(event) {
        const resultsContainer = event.target.nextElementSibling;
        if (!resultsContainer) return;
        // Delay hiding to allow mousedown on results to register
        setTimeout(() => {
            // Check if focus moved *outside* the results container
            if (resultsContainer && !resultsContainer.contains(document.activeElement)) {
                resultsContainer.style.display = 'none';
            }
        }, 150); // Adjust delay if needed
    }

    /**
     * Handles keydown events (Enter) in the player search input.
     * @param {Event} event - The keydown event object.
     */
    function handlePlayerSearchKeydown(event) {
        if (event.key === 'Enter') {
            event.preventDefault(); // Prevent potential form submission
            const resultsContainer = event.target.nextElementSibling;
            const firstOption = resultsContainer?.querySelector('.player-option');
            if (firstOption) {
                // Simulate mousedown on the first option
                const clickEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window });
                firstOption.dispatchEvent(clickEvent);
            }
        }
    }

    /**
     * Handles the mousedown event on a player option in the search results.
     * @param {Event} event - The mousedown event object.
     */
    function handlePlayerOptionMouseDown(event) {
        event.preventDefault(); // Prevent input blur before processing
        const playerOption = event.currentTarget; // The div that was clicked
        const resultsContainer = playerOption.parentElement;
        const inputElement = resultsContainer?.previousElementSibling; // Assumes input is previous sibling
        if (!inputElement || !resultsContainer) return;

        const clickedRow = inputElement.closest('tr');
        const parentTable = inputElement.closest('table');
        const playerId = parseInt(playerOption.dataset.playerId);
        const player = playersIndex.find(p => p.id === playerId);
        const tableId = parentTable ? parseInt(parentTable.dataset.tableId) : -1;

        if (clickedRow && parentTable && player && tableId !== -1) {
            // Record state before making the pick
            const stateBeforePick = {
                nextTableToPick: nextTableToPick,
                currentPickDirection: currentPickDirection,
                lastActiveTableIndex: lastActiveTableIndex
            };
            // Push details onto history
            pickHistory.push({
                playerId: player.id,
                tableId: tableId, // Use the retrieved tableId
                rowElement: clickedRow,
                stateBeforePick: stateBeforePick
            });

            resultsContainer.style.display = "none"; // Hide results
            resultsContainer.innerHTML = "";         // Clear results
            updatePlayerRow(clickedRow, player);     // Update the row
            recalculateTotalSalary(parentTable, currentMaxSalary); // Update table total
            
            if (undoButton) undoButton.disabled = false;
            
            goToNextTurn();                          // Advance the draft
        } else {
            console.error("Could not find necessary elements or player data for selection.");
        }
    }

    /** Handles the click event on the Undo button. */
    function handleUndoClick() {
        if (pickHistory.length === 0) {
            console.warn("Undo clicked, but no pick history.");
            return; // Nothing to undo
        }

        const lastPick = pickHistory.pop(); // Get the last pick details
        const { playerId, tableId, rowElement, stateBeforePick } = lastPick;

        console.log(`Undoing pick: Player ID ${playerId} from Table ${tableId}`);

        // Find the table element again (rowElement might be detached if tables were regenerated, though unlikely here)
        const targetTable = tablesContainer?.querySelector(`table[data-table-id="${tableId}"]`);

        if (!rowElement || !targetTable) {
            console.error("Undo failed: Could not find the row or table element for the last pick.");
            // Attempt to put the pick back? Or just log error.
            pickHistory.push(lastPick); // Put it back if we failed
            return;
        }

        // 1. Clear the player from the row (this also removes from selectedPlayers set)
        updatePlayerRow(rowElement, null);

        // 2. Recalculate the salary for the affected table
        recalculateTotalSalary(targetTable, currentMaxSalary);

        // 3. Restore the draft state to *before* the undone pick was made
        nextTableToPick = stateBeforePick.nextTableToPick;
        currentPickDirection = stateBeforePick.currentPickDirection;
        lastActiveTableIndex = stateBeforePick.lastActiveTableIndex;

        // 4. Re-enable the input field for the now-empty slot and update turn display
        enableCurrentTableInputs(); // This will find the empty slot in the correct table and update display

        // 5. Disable undo button if history is now empty
        if (undoButton) undoButton.disabled = pickHistory.length === 0;
    }

    /**
     * Handles the blur event when editing a table name.
     * @param {Event} event - The blur event object.
     */
    function handleTableNameEdit(event) {
        const headerCell = event.target;
        const table = headerCell.closest('table');
        if (!table) return;

        const tableId = parseInt(table.dataset.tableId);
        const newName = headerCell.textContent.trim();

        if (!isNaN(tableId)) {
            if (newName) {
                tableNames[tableId] = newName; // Update name in state
            } else {
                // Revert to default if name is cleared
                const defaultName = `Table ${tableId + 1}`;
                tableNames[tableId] = defaultName;
                headerCell.textContent = defaultName; // Update display
            }
            // Update turn display if the current turn's table name changed
            if (tableId === nextTableToPick) {
                updateTurnDisplay();
            }
        }
    }

    /**
     * Handles keydown (Enter) event when editing a table name.
     * @param {Event} event - The keydown event object.
     */
    function handleTableNameKeydown(event) {
        if (event.key === 'Enter') {
            event.preventDefault(); // Stop Enter from creating newline
            event.target.blur();    // Trigger the blur event to save
        }
    }

    /** Handles click on the main settings button (opens overlay). */
    function handleSettingsButtonClick() {
        if (!settingsOverlay || !maxSalaryCapInput) return;
        settingsOverlay.classList.add('visible'); // Show overlay using class
    }

    /** Handles click on the overlay's close button. */
    function handleCloseSettingsClick() {
        if (!settingsOverlay) return;
        settingsOverlay.classList.remove('visible'); // Hide overlay using class
    }

    /** Handles clicks outside the settings overlay content to close it. */
    function handleOverlayBackgroundClick(event) {
        if (event.target === settingsOverlay) { // Check if click was on the background
            handleCloseSettingsClick();
        }
    }

    function handleCancelTableNamesClick() {
        if (tableNamesOverlay) {
            tableNamesOverlay.classList.remove('visible');
        }
        tempDraftSettings = {}; // Clear temp settings
        console.log("Table name entry cancelled.");
    }


    // --- Event Listeners ---

    // Start Screen
    if (startDraftButton) {
        startDraftButton.addEventListener('click', handleStartDraftClick);
    } else { console.error("Start Draft button not found."); }

    // Draft Area
    if (exitDraftButton) {
        exitDraftButton.addEventListener('click', exitToStartScreen);
    } else { console.error("Exit Draft button not found."); }

    if (undoButton) {
        undoButton.addEventListener('click', handleUndoClick);
    } else { console.error("Undo button not found."); }

    if (settingsButton) {
        settingsButton.addEventListener('click', handleSettingsButtonClick);
    } else { console.error("Settings button not found."); }

    // Settings Overlay
    if (settingsOverlay) {
        settingsOverlay.addEventListener('click', handleOverlayBackgroundClick);
    } else { console.error("Settings overlay not found."); }

    if (closeSettingsButton) {
        closeSettingsButton.addEventListener('click', handleCloseSettingsClick);
    } else { console.error("Close Settings button not found."); }

    if (tableNamesOverlay) {
        tableNamesOverlay.addEventListener('click', handleTableNamesOverlayBackgroundClick);
    } else { console.error("Table Names overlay not found."); }

    if (confirmTableNamesButton) {
        confirmTableNamesButton.addEventListener('click', handleConfirmTableNamesClick);
    } else { console.error("Confirm Table Names button not found."); }

    const cancelTableNamesButton = document.getElementById("cancel-table-names-button");
    if (cancelTableNamesButton) {
        cancelTableNamesButton.addEventListener('click', handleCancelTableNamesClick);
    } else { console.error("Cancel Table Names button not found."); }

    // --- Initialization ---
    console.log("Draft application initialized. Ready for setup.");
    // Ensure correct initial UI state (Start screen visible, draft hidden)
    if (startContainerElement) startContainerElement.style.display = 'flex';
    if (draftArea) draftArea.classList.add('hidden');
    // Set initial value in salary cap input from default state
    if (maxSalaryCapInput) maxSalaryCapInput.value = currentMaxSalary;
    // Ensure Undo button is disabled on initial load (redundant but safe)
    if (undoButton) undoButton.disabled = true;

}); // End DOMContentLoaded
