// script.js
import { playersIndex as playersIndexData, searchPlayers, getTeamLogoPath } from "./PlayerIndex_2024-25.mjs";

document.addEventListener("DOMContentLoaded", () => {

    // ==========================================================================
    // State Variables
    // ==========================================================================
    let tempDraftSettings = {};
    let currentServerState = null; // Holds the full state received from the server for the current room
    let currentRoomCode = null;    // The code of the room the client is currently in
    let attemptingRejoin = false;  // Flag to manage the rejoin process on page load/refresh
    const playersIndex = playersIndexData; // Local copy of all player data

    // ==========================================================================
    // Socket.IO Connection
    // ==========================================================================
    const socket = io(); // Initialize Socket.IO connection

    // ==========================================================================
    // DOM Element References
    // ==========================================================================
    // --- Screens & Containers ---
    const startContainerElement = document.getElementById('start-screen');
    const draftArea = document.getElementById("draft-area");
    const tablesContainer = document.getElementById("tables-container");
    const loadingIndicatorElement = document.getElementById('loading-indicator');
    // --- Buttons ---
    const startDraftButton = document.getElementById("start-draft-button");
    const joinDraftButton = document.getElementById("join-draft-button");
    const settingsButton = document.getElementById("settings-button");
    const closeSettingsButton = document.getElementById("close-settings-button");
    const exitDraftButton = document.getElementById("exit-draft-button");
    const undoButton = document.getElementById("undo-button");
    const confirmTableNamesButton = document.getElementById("confirm-table-names-button");
    const cancelTableNamesButton = document.getElementById("cancel-table-names-button");
    const copyRoomCodeButton = document.getElementById('copy-room-code-button');
    const confirmExitButton = document.getElementById('confirm-exit-button');
    const cancelExitButton = document.getElementById('cancel-exit-button');
    // --- Inputs & Displays ---
    const tableCountInput = document.getElementById("tableCount");
    const numForwardsInput = document.getElementById("numForwards");
    const numDefendersInput = document.getElementById("numDefenders");
    const numGoaltendersInput = document.getElementById("numGoaltenders");
    const serpentineOrderCheckbox = document.getElementById("serpentineOrder");
    const maxSalaryCapInput = document.getElementById("maxSalaryCap");
    const roomCodeInput = document.getElementById("roomCodeInput");
    const turnCounterElement = document.getElementById("turn-counter");
    const settingsRoomCodeContainer = document.getElementById('settings-room-code-container');
    const settingsRoomCodeText = document.getElementById('settings-room-code-text');
    const tooltipElement = document.getElementById('player-tooltip');
    // --- Overlays ---
    const settingsOverlay = document.getElementById("settings-overlay");
    const tableNamesOverlay = document.getElementById("table-names-overlay");
    const tableNamesInputContainer = document.getElementById("table-names-input-container");
    const exitConfirmOverlay = document.getElementById('exit-confirm-overlay');
    // --- Padlock Icon URLs (PNGs) ---
    const PNG_PADLOCK_UNLOCKED = `https://img.icons8.com/?size=100&id=2EpwWHoO8HUY&format=png&color=FFFFFF`;
    const PNG_PADLOCK_LOCKED = `https://img.icons8.com/?size=100&id=NIcB9abivYMw&format=png&color=FFFFFF`;

    // ==========================================================================
    // Initial Setup & Rejoin Logic
    // ==========================================================================

    // --- Check session storage for potential rejoin ---
    const initialStoredRoomCode = sessionStorage.getItem('currentRoomCode');
    const wasViewingDraft = sessionStorage.getItem('viewingDraft') === 'true';

    if (initialStoredRoomCode && wasViewingDraft) {
        document.body.classList.add('is-rejoining');
    } else {
        // Ensure loader is hidden if not rejoining
        if (loadingIndicatorElement) loadingIndicatorElement.style.display = 'none';
    }

    /** Attempts to rejoin a draft room if a code is found in session storage. */
    function attemptRejoinOnLoad() {
        const storedCode = sessionStorage.getItem('currentRoomCode'); // Re-check in case it was cleared
        if (storedCode && !currentRoomCode) { // Prevent re-emitting if already joined
            attemptingRejoin = true;
            socket.emit('join_draft', { roomCode: storedCode });
        } else if (!storedCode && !currentRoomCode) {
            showStartScreen();
        } else {
        }
    }

    // Basic check for essential elements
    if (!startContainerElement || !draftArea || !socket) {
        console.error("Essential UI elements or Socket.IO not found. Application cannot start.");
        // Display a user-friendly message on the page itself
        document.body.innerHTML = '<p style="color: red; padding: 20px;">Error initializing the application. Please refresh the page.</p>'; // Corrected HTML
        return; // Stop script execution
    }

    // ==========================================================================
    // Helper Functions
    // ==========================================================================

    /** Formats a number as USD currency without cents. */
    function formatCurrency(value) {
        const number = parseInt(value, 10); // Always specify radix
        if (isNaN(number)) {
            return '$0'; // Consistent default
        }
        return number.toLocaleString('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        });
    }

    /** Calculates total player slots per table based on settings. */
    function getTotalSlotsPerTable(state) {
        const playersPerPos = state?.settings?.playersPerPos;
        if (!playersPerPos) return 0;
        return Object.values(playersPerPos).reduce((sum, count) => sum + (count || 0), 0);
    }

    /** Calculates the current draft round number. */
    function getCurrentRound(state) {
        const numTables = state?.settings?.numTables;
        if (!numTables || numTables <= 0) return 1;
        const totalSlotsPerTable = getTotalSlotsPerTable(state);
        if (totalSlotsPerTable === 0) return 1;
        const picksMade = state.picks?.length || 0;
        return Math.floor(picksMade / numTables) + 1;
    }

    /** Filters local playersIndex for available players by position, excluding selected ones. */
    function getAvailablePlayers(position) {
        if (!Array.isArray(playersIndex)) {
            console.error("playersIndex is not loaded or not an array.");
            return [];
        }
        return playersIndex.filter(player =>
            player.position === position
        );
    }

    /** Maps server picks array to a nested object structure: { teamId: { slotIndex: pickData } }. */
    function mapPicksToSlots(picks, settings) {
        const mappedPicks = {};
        if (!picks || !settings?.numTables || !settings?.playersPerPos) {
            console.error("[mapPicksToSlots] Invalid input provided.", { picks, settings });
            return mappedPicks;
        }

        // Pre-initialize map structure for all tables
        for (let i = 0; i < settings.numTables; i++) {
            mappedPicks[i] = {};
        }

        // Group picks by teamId first for easier processing
        const picksByTable = picks.reduce((acc, pick) => {
            if (pick.teamId !== undefined && pick.teamId !== null) {
                if (!acc[pick.teamId]) {
                    acc[pick.teamId] = [];
                }
                acc[pick.teamId].push(pick);
            } else {
                console.warn("[mapPicksToSlots] Pick found with invalid teamId:", pick);
            }
            return acc;
        }, {});

        // Assign picks to slots based on their order within each table's pick list
        // This assumes the server sends picks in the order they were made for each team.
        for (let teamId = 0; teamId < settings.numTables; teamId++) {
            const tablePicks = picksByTable[teamId] || [];
            tablePicks.forEach((pick, index) => {
                mappedPicks[teamId][index] = pick; // Assign pick to its slot index
            });
        }
        return mappedPicks;
    }

    // ==========================================================================
    // Column Width Uniformity Function
    // ==========================================================================
    /**
     * Ensures that all columns in all draft tables have the same width,
     * based on the maximum width required for each column index.
     */
    function uniformizeColumnWidths() {
        const tablesContainerElem = document.getElementById('tables-container');
        if (!tablesContainerElem) return; // Ensure the container exists

        const tables = tablesContainerElem.querySelectorAll('table');
        if (!tables.length) return;

        // Determine the number of columns from the colgroup of the first table
        const firstTableColGroup = tables[0].querySelector('colgroup');
        if (!firstTableColGroup) {
            // console.warn("[uniformizeColumnWidths] The first table does not have a <colgroup>.");
            return;
        }
        const colElementsInFirstTable = firstTableColGroup.querySelectorAll('col');
        if (!colElementsInFirstTable.length) {
            // console.warn("[uniformizeColumnWidths] The <colgroup> of the first table has no <col> elements.");
            return;
        }
        const nbCols = colElementsInFirstTable.length;
        const maxWidths = Array(nbCols).fill(0);

        // 1) Measure the effective width of each <col> for visible tables.
        tables.forEach(table => {
            if (table.offsetParent === null) { // Check if the table is visible
                // console.log("[uniformizeColumnWidths] Table not visible, ignored for measurement:", table);
                return; // Ignore non-visible tables
            }
            const cols = table.querySelectorAll('colgroup col');
            // Iterate up to nbCols and ensure the column exists
            for (let i = 0; i < nbCols; i++) {
                if (cols[i]) {
                    const w = cols[i].getBoundingClientRect().width;
                    if (w > maxWidths[i]) {
                        maxWidths[i] = w;
                    }
                }
            }
        });

        // 2) Apply the maximum width to all <col> elements in each table.
        tables.forEach(table => {
            const cols = table.querySelectorAll('colgroup col');
            for (let i = 0; i < nbCols; i++) {
                if (cols[i] && maxWidths[i] > 0) { // Apply only if a positive max width was found
                    cols[i].style.width = `${maxWidths[i]}px`;
                }
            }
        });
        // console.log("[uniformizeColumnWidths] Maximum widths applied:", maxWidths);
    }

    // ==========================================================================
    // Tooltip Functions
    // ==========================================================================

    /** Displays player details tooltip on hover. */
    function showPlayerTooltip(event) {
        if (!tooltipElement) return;

        const targetElement = event.currentTarget; // The div.search-result-item
        const playerId = parseInt(targetElement.dataset.playerId, 10);
        if (isNaN(playerId)) return;

        // Find related elements
        const inputElement = targetElement.closest('.player-name-cell')?.querySelector('.player-search-input');
        const searchResultsContainer = inputElement?.nextElementSibling;
        const player = playersIndex.find(p => p.id === playerId);

        if (!player || !searchResultsContainer) {
            hidePlayerTooltip(); // Hide if data or container is missing
            return;
        }

        // Build tooltip content
        const capHitFormatted = formatCurrency(player.cap_hit);
        const playerAge = player.age ?? 'N/A';
        const playerPosition = player.position;

        let statsHtml = '';
        if (playerPosition === 'G') {
            statsHtml = `
                <br><br><strong>Stats (2024-25)</strong><br>
                GP: ${player.st_gp ?? 0}<br>
                W-L: ${player.st_w ?? 0}-${player.st_l ?? 0}<br>
                Sv%: ${typeof player.st_svp === 'number' ? player.st_svp.toFixed(3) : 'N/A'}<br>
                GAA: ${typeof player.st_gaa === 'number' ? player.st_gaa.toFixed(2) : 'N/A'}<br>
                SO: ${player.st_so ?? 0}
            `;
        } else { // Skater
            statsHtml = `
                <br><br><strong>Stats (2024-25)</strong><br>
                GP: ${player.st_gp ?? 0}<br>
                G: ${player.st_g ?? 0}<br>
                A: ${player.st_a ?? 0}<br>
                P: ${player.st_p ?? 0}<br>
            `;
        }

        tooltipElement.innerHTML = `
            <strong>${player.name}</strong><br>
            Age: ${playerAge}<br>
            Cap Hit: ${capHitFormatted}
            ${statsHtml}
        `;

        // Position and display tooltip
        tooltipElement.style.display = 'block'; // Make block before measuring
        tooltipElement.classList.add('visible');

        const containerRect = searchResultsContainer.getBoundingClientRect();
        const itemRect = targetElement.getBoundingClientRect();
        const tooltipRect = tooltipElement.getBoundingClientRect();
        const scrollX = window.scrollX || window.pageXOffset;
        const scrollY = window.scrollY || window.pageYOffset;

        // Calculate position (prefer right, fallback left, adjust vertically)
        let top = itemRect.top;
        let left = containerRect.right + 5; // Default: right of results

        if (left + tooltipRect.width > window.innerWidth) { // Off-screen right?
            left = containerRect.left - tooltipRect.width - 10; // Try left
            if (left < 0) { // Still off-screen left?
                left = window.innerWidth - tooltipRect.width - 10; // Fallback: align right edge
            }
        } else if (left < 0) { // Default position is somehow off-screen left?
            left = 10; // Push right
        }

        if (top + tooltipRect.height > window.innerHeight) { // Off-screen bottom?
            top = itemRect.bottom - tooltipRect.height; // Align bottom
            if (top < 0) { // Still off-screen top?
                 top = window.innerHeight - tooltipRect.height - 10; // Fallback: align bottom edge
            }
        }
        if (top < 0) { // Off-screen top?
            top = 10; // Align top edge
        }

        tooltipElement.style.left = `${left + scrollX}px`;
        tooltipElement.style.top = `${top + scrollY}px`;
    }

    /** Hides the player details tooltip. */
    function hidePlayerTooltip() {
        if (!tooltipElement) return;
        tooltipElement.classList.remove('visible');
        tooltipElement.style.display = 'none'; // Ensure it's hidden
    }

    // ==========================================================================
    // UI Rendering Functions
    // ==========================================================================

    /** Renders the entire draft UI based on the received server state. */
    function renderUIFromServerState(roomState) {
        console.log(`Rendering UI for room ${currentRoomCode}:`, roomState);

        if (!roomState || !roomState.settings) {
            console.warn("[Render] Invalid state received, showing start screen.");
            document.documentElement.style.removeProperty('--vertical-label-row-multiplier');
            document.documentElement.style.removeProperty('--second-vertical-label-row-multiplier');
            showStartScreen(); // Revert to start if state is invalid
            return;
        }
        currentServerState = roomState; // Update the global state reference

        // Update CSS variable for vertical label height multiplier
        if (currentServerState.settings.playersPerPos) {
            const { F: numForwards, D: numDefenders, G: numGoaltenders } = currentServerState.settings.playersPerPos;

            // Handle Forwards multiplier
            if (typeof numForwards === 'number' && numForwards >= 0) {
                document.documentElement.style.setProperty('--vertical-label-row-multiplier', numForwards);
            } else {
                document.documentElement.style.removeProperty('--vertical-label-row-multiplier');
            }

            // Handle Defenders multiplier
            if (typeof numDefenders === 'number' && numDefenders >= 0) {
                document.documentElement.style.setProperty('--second-vertical-label-row-multiplier', numDefenders);
            } else {
                document.documentElement.style.removeProperty('--second-vertical-label-row-multiplier');
            }

            // Handle Goaltenders multiplier
            if (typeof numGoaltenders === 'number' && numGoaltenders >= 0) {
                document.documentElement.style.setProperty('--third-vertical-label-row-multiplier', numGoaltenders);
            } else {
                document.documentElement.style.removeProperty('--third-vertical-label-row-multiplier');
            }
        } else {
            // If playersPerPos itself isn't available, remove both properties.
            document.documentElement.style.removeProperty('--vertical-label-row-multiplier');
            document.documentElement.style.removeProperty('--second-vertical-label-row-multiplier');
            document.documentElement.style.removeProperty('--third-vertical-label-row-multiplier');
        }

        // --- Clear Rejoin State & Update UI Visibility ---
        document.body.classList.remove('is-rejoining');
        if (loadingIndicatorElement) loadingIndicatorElement.style.display = 'none';
        sessionStorage.setItem('viewingDraft', 'true'); // Mark that user is viewing the draft
        startContainerElement.style.display = 'none';
        draftArea.classList.remove('hidden');

        // --- Update Header & Controls ---
        updateTurnDisplayFromServerState(currentServerState);
        if (maxSalaryCapInput) { // Update initial settings display if needed
             maxSalaryCapInput.value = currentServerState.settings.maxSalary;
        }
        if (undoButton) {
            undoButton.disabled = !currentServerState.picks || currentServerState.picks.length === 0;
        }

        // --- Regenerate Draft Tables & Enable Inputs ---
        generateTablesFromServerState(currentServerState);
        
        // --- Control visibility of vertical labels AFTER they are created ---
        if (tablesContainer && currentServerState.settings.playersPerPos) {
            const { F: numForwards, D: numDefenders, G: numGoaltenders } = currentServerState.settings.playersPerPos;

            tablesContainer.querySelectorAll('.vertical-table-label').forEach(label => {
                label.style.display = (typeof numForwards === 'number' && numForwards > 0) ? 'flex' : 'none';
            });
            tablesContainer.querySelectorAll('.vertical-table-label-second').forEach(label => {
                label.style.display = (typeof numDefenders === 'number' && numDefenders > 0) ? 'flex' : 'none';
            });
            tablesContainer.querySelectorAll('.vertical-table-label-third').forEach(label => {
                label.style.display = (typeof numGoaltenders === 'number' && numGoaltenders > 0) ? 'flex' : 'none';
            });
        } else if (tablesContainer) { // If playersPerPos is missing or no tablesContainer, hide all
            tablesContainer.querySelectorAll(
                '.vertical-table-label, .vertical-table-label-second, .vertical-table-label-third'
            ).forEach(label => {
                label.style.display = 'none';
            });
        }

        enableInputsFromServerState(currentServerState); // Enable inputs AFTER tables are generated
    }

    /** Generates all draft tables based on room state. */
    function generateTablesFromServerState(roomState) {
        if (!tablesContainer || !roomState.settings) return;

        tablesContainer.innerHTML = ""; // Clear previous tables

        const { numTables, tableNames, playersPerPos, maxSalary } = roomState.settings;
        const validPlayersPerPos = playersPerPos || {};
        const activePositions = Object.keys(validPlayersPerPos).filter(pos => validPlayersPerPos[pos] > 0);
        const picksForState = roomState.picks || [];

        if (numTables < 1 || activePositions.length === 0) {
            console.error("[Generate Tables] Invalid settings (numTables or playersPerPos).");
            return;
        }

        // --- Fixed column widths ---
        const colWidths = [
            '60px',  // Col 1 (Pos)
            '250px', // Col 2 (Name)
            '140px'  // Col 3 (Salary)
        ];

        for (let i = 0; i < numTables; i++) {
            const tableWrapper = document.createElement("div");
            tableWrapper.classList.add("table-wrapper");

            const table = document.createElement("table");
            table.dataset.teamId = i;
            const currentTableName = tableNames[i] || `Team ${i + 1}`;

            // --- 1. Add Caption for Team Name ---
            const caption = table.createCaption();
            caption.classList.add('table-caption');
            caption.contentEditable = "true";
            caption.spellcheck = false;
            caption.textContent = currentTableName;
            // Add listener for table name editing
            caption.addEventListener('blur', handleTableNameEdit);
            caption.addEventListener('keydown', handleTableNameKeydown);

            const verticalLabel = document.createElement("div");
            verticalLabel.classList.add("vertical-table-label-base", "vertical-table-label");
            verticalLabel.textContent = "Forwards";
            table.appendChild(verticalLabel);

            // Create and add the second vertical label
            const verticalLabelSecond = document.createElement("div");
            verticalLabelSecond.classList.add("vertical-table-label-base", "vertical-table-label-second");
            verticalLabelSecond.textContent = "Defense";
            table.appendChild(verticalLabelSecond);

            // Create and add the third vertical label
            const verticalLabelThird = document.createElement("div");
            verticalLabelThird.classList.add("vertical-table-label-base", "vertical-table-label-third");
            verticalLabelThird.textContent = "Goalies";
            table.appendChild(verticalLabelThird);

            // --- 2. Add Colgroup ---
            const colgroup = document.createElement('colgroup');
            colWidths.forEach(width => {
                const col = document.createElement('col');
                col.style.width = width;
                colgroup.appendChild(col);
            });
            table.appendChild(colgroup);

            // --- 3. Build Thead ---
            const thead = document.createElement('thead');

            // Header row (Column Titles)
            const headerRow = document.createElement('tr');
            const th1 = document.createElement('th');
            th1.textContent = 'Pos';
            const th2 = document.createElement('th');
            th2.textContent = 'Player Name';
            const th3 = document.createElement('th');
            th3.textContent = 'Salary';
            headerRow.appendChild(th1);
            headerRow.appendChild(th2);
            headerRow.appendChild(th3);
            thead.appendChild(headerRow);

            table.appendChild(thead); // Add the complete thead

            // --- 4. Create Tbody ---
            const tbody = document.createElement('tbody');
            table.appendChild(tbody); // Add the empty tbody

            // --- 5. Populate Tbody Rows ---
            const picksForThisTable = picksForState.filter(p => p.teamId === i);
            activePositions.forEach(pos => {
                const countForPos = validPlayersPerPos[pos] || 0;
                for (let j = 0; j < countForPos; j++) {
                    const pickForThisSlot = picksForThisTable.filter(p => p.position === pos)[j];
                    // Create a player row for each slot
                    const row = createPlayerRow(pos, i, j, pickForThisSlot);
                    tbody.appendChild(row); // Append row to tbody
                }
            });

            // --- 6. Add Total Row to Tbody ---
            const totalRow = document.createElement("tr");
            totalRow.classList.add("total-row");
            const totalLabelCell = document.createElement('td');
            totalLabelCell.colSpan = colWidths.length - 1; // Span first N-1 columns
            totalLabelCell.textContent = 'Total';
            const totalSalaryCell = document.createElement('td');
            totalSalaryCell.classList.add('total-salary-cell');
            totalSalaryCell.textContent = '$0'; // Initial value
            totalRow.appendChild(totalLabelCell);
            totalRow.appendChild(totalSalaryCell);
            tbody.appendChild(totalRow); // Append total row to tbody

            // --- 7. Final Assembly ---
            tableWrapper.appendChild(table);

            // Add padlock icon (initially hidden by CSS, shown when table-wrapper.active-table)
            const padlockIcon = document.createElement('img');
            padlockIcon.classList.add('padlock-icon');
            padlockIcon.src = PNG_PADLOCK_UNLOCKED; // Initial state: Unlocked padlock
            padlockIcon.dataset.locked = "false";
            padlockIcon.alt = "Padlock status";
            tableWrapper.appendChild(padlockIcon);
            padlockIcon.addEventListener('click', handlePadlockClick);

            tablesContainer.appendChild(tableWrapper);

            // Calculate and display total salary for the newly created table
            recalculateTotalSalary(table, maxSalary, picksForState);
        }
        uniformizeColumnWidths();
    }


    /** Creates a single player row element (TR) for the draft table. */
    function createPlayerRow(pos, teamId, slotIndex, playerPick = null) {
        const row = document.createElement("tr");
        row.classList.add(pos, 'player-slot');
        row.dataset.position = pos;
        row.dataset.teamId = teamId;
        row.dataset.slotIndex = slotIndex;

        // --- Position Cell (1st TD) ---
        const positionCell = document.createElement("td");
        // positionCell.classList.add("position-abbreviation-cell"); // For specific styling if needed
        // positionCell.textContent = pos; // Display 'F', 'D', or 'G'
        row.appendChild(positionCell);

        // --- Player Name Cell (Always the 2nd TD) ---
        const nameCell = document.createElement("td");
        nameCell.classList.add("player-name-cell");
        nameCell.style.position = 'relative';

        // --- Salary Cell (Always the 3rd TD) ---
        const salaryCell = document.createElement("td");
        salaryCell.classList.add("salary-cell");

        // --- Populate Name and Salary cells ---
        if (playerPick) {
            // FILLED SLOT
            row.classList.add('filled-slot');
            salaryCell.textContent = formatCurrency(playerPick.salary);

            const logoPath = getTeamLogoPath(playerPick.team_url);
            const logoImg = document.createElement('img');
            logoImg.src = logoPath;
            logoImg.alt = `${playerPick.city || 'Team'} Logo`;
            logoImg.classList.add('team-logo');

            const playerNameSpan = document.createElement('span');
            playerNameSpan.textContent = playerPick.playerName || 'Unknown Player';
            playerNameSpan.classList.add('picked-player-name');

            nameCell.appendChild(logoImg);
            nameCell.appendChild(playerNameSpan);

            const hiddenInput = document.createElement("input");
            hiddenInput.type = "hidden";
            hiddenInput.value = playerPick.playerName || '';
            hiddenInput.dataset.playerId = playerPick.playerId;
            nameCell.appendChild(hiddenInput);
        } else {
            // EMPTY SLOT
            row.classList.add('empty-slot');
            salaryCell.textContent = formatCurrency(0);

            const playerSearchInput = document.createElement("input");
            playerSearchInput.type = "text";
            playerSearchInput.classList.add("player-search-input");
            playerSearchInput.placeholder = "Search player...";
            playerSearchInput.dataset.teamId = teamId;
            playerSearchInput.dataset.position = pos;
            playerSearchInput.dataset.slotIndex = slotIndex;
            playerSearchInput.disabled = true;
            playerSearchInput.autocomplete = 'off';
            playerSearchInput.spellcheck = false;
            playerSearchInput.dataset.playerId = "";

            const searchResultsContainer = document.createElement("div");
            searchResultsContainer.classList.add("search-results-container");

            nameCell.appendChild(playerSearchInput);
            nameCell.appendChild(searchResultsContainer);

            playerSearchInput.addEventListener("input", handlePlayerSearchInput);
            playerSearchInput.addEventListener('blur', handlePlayerSearchBlur);
            playerSearchInput.addEventListener('keydown', handlePlayerSearchKeydown);
        }

        // Append Name and Salary cells
        row.appendChild(nameCell);
        row.appendChild(salaryCell);

        return row;
    }

    /** Updates the turn counter display based on the current state. */
    function updateTurnDisplayFromServerState(roomState) {
        if (!turnCounterElement || !roomState?.settings) {
             if(turnCounterElement) turnCounterElement.textContent = ""; // Clear if no state
             return;
        }

        turnCounterElement.classList.remove('waiting', 'full'); // Reset status classes

        const { numTables, tableNames } = roomState.settings;
        const { nextTableToPick } = roomState;
        const totalSlots = numTables * getTotalSlotsPerTable(roomState);
        const picksMade = roomState.picks?.length || 0;

        if (totalSlots > 0 && picksMade >= totalSlots) { // Check totalSlots > 0 before declaring complete
            turnCounterElement.textContent = "Draft Complete";
            turnCounterElement.classList.add('full');
        } else if (nextTableToPick >= 0 && nextTableToPick < numTables) {
            const currentRound = getCurrentRound(roomState);
            const currentTeamName = tableNames[nextTableToPick] || `Team ${nextTableToPick + 1}`;
            turnCounterElement.textContent = `Round ${currentRound} • Pick: ${currentTeamName}`;
        } else {
            // Draft not complete, but nextTableToPick is invalid (e.g., -1 before completion)
            console.warn(`[Turn Display] Invalid state: Draft ongoing but nextTableToPick=${nextTableToPick}.`);
            turnCounterElement.textContent = "Waiting..."; // Indicate an issue or intermediate state
            turnCounterElement.classList.add('waiting');
        }
    }

    /** Recalculates and updates the total salary display for a specific table element. */
     function recalculateTotalSalary(tableElement, maxSalary, allPicks) {
        const teamId = parseInt(tableElement.dataset.teamId, 10);
        if (isNaN(teamId) || !allPicks) return;

        let currentTotalSalary = 0;
        allPicks.forEach(pick => {
            if (pick.teamId === teamId && pick.salary != null) {
                currentTotalSalary += (parseInt(pick.salary, 10) || 0);
            }
        });

        const totalSalaryCell = tableElement.querySelector(".total-salary-cell");
        if (totalSalaryCell) {
            totalSalaryCell.textContent = formatCurrency(currentTotalSalary);
            const exceedsCap = maxSalary > 0 && currentTotalSalary > maxSalary;
            totalSalaryCell.classList.toggle('is-over-cap', exceedsCap);
        }
     }

    /** Enables the correct player input fields based on whose turn it is and available slots. */
    function enableInputsFromServerState(roomState) {

        if (!tablesContainer || !roomState?.settings || !roomState?.picks) {
            console.warn("[Enable Inputs] Missing required elements or state.");
            // Disable everything if state is incomplete
            tablesContainer.querySelectorAll(".player-search-input").forEach(input => input.disabled = true);
            tablesContainer.querySelectorAll(".player-slot").forEach(row => row.classList.remove('clickable-slot'));
            return;
        }

        // 1. Reset: Disable ALL inputs and remove clickable class first
        tablesContainer.querySelectorAll(".player-search-input").forEach(input => input.disabled = true);
        tablesContainer.querySelectorAll(".player-slot").forEach(row => row.classList.remove('clickable-slot'));

        const { numTables, playersPerPos } = roomState.settings;
        const { nextTableToPick } = roomState;
        const totalSlotsPerTable = getTotalSlotsPerTable(roomState);
        const picksMade = roomState.picks.length;
        const totalSlotsOverall = numTables * totalSlotsPerTable;

        // 2. Enable only if draft is ongoing and turn is valid
        if (totalSlotsOverall > 0 && picksMade < totalSlotsOverall && nextTableToPick >= 0 && nextTableToPick < numTables) {
            const activeTeamId = nextTableToPick;

            // Count existing picks for the active team by position
            const picksForActiveTable = roomState.picks.filter(p => p.teamId === activeTeamId);
            const currentCounts = { F: 0, D: 0, G: 0 };
            picksForActiveTable.forEach(p => {
                if (currentCounts[p.position] !== undefined) {
                    currentCounts[p.position]++;
                }
            });

            const neededCounts = playersPerPos || { F: 0, D: 0, G: 0 };
            let foundClickable = false;

            // Iterate through positions to find the next needed slot
            Object.keys(neededCounts).forEach(pos => {
                const needed = neededCounts[pos] || 0;
                const current = currentCounts[pos] || 0;

                if (current < needed) {
                    // Find the next empty slot for this position (index = current count)
                    const nextSlotIndex = current;
                    const targetRow = tablesContainer.querySelector(
                        `tr.player-slot[data-team-id="${activeTeamId}"][data-position="${pos}"][data-slot-index="${nextSlotIndex}"]`
                    );
                    const targetInput = targetRow?.querySelector('.player-search-input');

                    if (targetRow && targetInput) {
                        targetInput.disabled = false;
                        targetRow.classList.add('clickable-slot'); // Highlight the row
                        foundClickable = true;
                        // Auto-focus the first enabled input
                        if (!document.querySelector('.player-search-input:not(:disabled)')) {
                           targetInput.focus();
                        }
                    } else {
                        console.warn(`[Enable Inputs] Could not find row/input for Team ${activeTeamId}, Pos ${pos}, Slot ${nextSlotIndex}`);
                    }
                }
            });

            if (!foundClickable) {
                 console.warn(`[Enable Inputs] No clickable slots found for active team ${activeTeamId}. Table might be full or state mismatch.`);
            }
        } else {
        }
        // Note: updateTurnDisplayFromServerState is called within renderUIFromServerState after this function runs.
    }

    /** Resets the UI to the initial start/join screen state. */
    function showStartScreen() {

        // --- Clear Rejoin State & Session Storage ---
        document.body.classList.remove('is-rejoining');
        if (loadingIndicatorElement) loadingIndicatorElement.style.display = 'none';
        sessionStorage.removeItem('currentRoomCode');
        sessionStorage.removeItem('viewingDraft');

        document.documentElement.style.removeProperty('--vertical-label-row-multiplier');
        document.documentElement.style.removeProperty('--second-vertical-label-row-multiplier');

        // --- Reset Global State ---
        currentServerState = null;
        currentRoomCode = null;
        tempDraftSettings = {};
        attemptingRejoin = false;

        // --- Update UI Visibility ---
        settingsOverlay?.classList.remove('visible');
        tableNamesOverlay?.classList.remove('visible');
        exitConfirmOverlay?.classList.remove('visible'); // Ensure confirm exit is hidden too
        draftArea?.classList.add('hidden');
        startContainerElement.style.display = 'flex'; // Use flex for centering

        // --- Clear Dynamic Content ---
        if (tablesContainer) tablesContainer.innerHTML = "";
        if (turnCounterElement) turnCounterElement.textContent = "";
        if (settingsRoomCodeText) settingsRoomCodeText.textContent = '';
        if (tableNamesInputContainer) tableNamesInputContainer.innerHTML = ''; // Clear table name inputs

        // --- Reset Form Inputs ---
        if (roomCodeInput) roomCodeInput.value = '';
        // Consider resetting other start settings inputs (tableCount, player counts, etc.) if desired
        // e.g., if (tableCountInput) tableCountInput.value = '10';

        // --- Reset Button States ---
        if (undoButton) undoButton.disabled = true;
        if (copyRoomCodeButton) copyRoomCodeButton.disabled = true;
    }

    // ==========================================================================
    // Socket.IO Event Listeners (Server -> Client)
    // ==========================================================================

    socket.on('connect', () => {
        console.log(`Socket connected: ${socket.id}`);
        attemptRejoinOnLoad(); // Attempt rejoin ONLY after connection is confirmed
    });

    socket.on('draft_started', ({ roomCode, draftState }) => {
        currentRoomCode = roomCode;
        sessionStorage.setItem('currentRoomCode', roomCode); // Store code

        // Ensure selectedPlayerIds is a Set
        draftState.selectedPlayerIds = new Set(draftState.selectedPlayerIds || []);
        renderUIFromServerState(draftState);
    });

    socket.on('join_error', (error) => {
        console.error("Join Error:", error.message);
        alert(`Failed to join draft: ${error.message}`);
        if (roomCodeInput) roomCodeInput.value = ''; // Clear input on error

        if (attemptingRejoin) {
            attemptingRejoin = false; // Reset flag
            showStartScreen(); // Show start screen after failed rejoin
        } else {
            // Ensure start screen is visible for regular join errors if not already
             if (startContainerElement.style.display !== 'flex') {
                 showStartScreen();
             }
        }
    });

    socket.on('draft_state_update', ({ roomCode, draftState }) => {

        // Basic validation
        if (!draftState || !draftState.roomCode || roomCode !== draftState.roomCode) {
            console.warn(`Ignoring invalid draft_state_update.`, { roomCode, draftState });
            return;
        }

        // Case 1: Handling the state received right after a successful join/rejoin request
        if ((currentRoomCode === null || attemptingRejoin) && draftState.roomCode === roomCode) {
            attemptingRejoin = false; // Mark rejoin attempt as complete (success)
            currentRoomCode = draftState.roomCode;
            sessionStorage.setItem('currentRoomCode', currentRoomCode); // Ensure session storage is set

            draftState.selectedPlayerIds = new Set(draftState.selectedPlayerIds || []);
            renderUIFromServerState(draftState);

        // Case 2: Handling a regular update for the room the client is already in
        } else if (roomCode === currentRoomCode && currentRoomCode !== null && !attemptingRejoin) {
            // Assume full state update, replace local state
            draftState.selectedPlayerIds = new Set(draftState.selectedPlayerIds || []);
            renderUIFromServerState(draftState);

        // Case 3: Ignoring updates for other rooms or irrelevant states
        } else {
        }
    });

    socket.on('participant_update', ({ roomCode, participants }) => {
        // Update participant list if the update is for the current room and state exists
        if (roomCode === currentRoomCode && currentServerState) {
            currentServerState.participants = participants || []; // Update local state
            renderUIFromServerState(currentServerState);
        } else {
        }
    });

    socket.on('pick_error', (error) => {
        console.error("Pick Error:", error.message);
        alert(`Error making pick: ${error.message}`);
        // Re-render based on the last valid state to potentially reset input fields
        if (currentServerState) {
            renderUIFromServerState(currentServerState);
        }
    });

    socket.on('error', (error) => { // Generic server-side error
        console.error("Server Error:", error.message);
        alert(`An error occurred: ${error.message}`);
        // Consider if specific errors should trigger showStartScreen()
    });

    socket.on("connect_error", (err) => {
        console.error(`Socket Connection Error: ${err.message}`);
        alert("Failed to connect to the draft server. Please check your connection and refresh.");
        showStartScreen(); // Revert to start on connection failure
    });

    socket.on("disconnect", (reason) => {
        console.warn(`Socket disconnected: ${reason}`);
        // Avoid alert if disconnect was intentional (e.g., user closed tab/navigated away)
        if (reason !== 'io client disconnect') {
            alert("Lost connection to the draft server. Please refresh the page.");
        }
        // Revert to start screen on disconnect
        showStartScreen();
    });

    // ==========================================================================
    // Event Handlers (User Actions -> Emit to Server)
    // ==========================================================================

    /** Handles clicking the "Join Draft" button. */
    function handleJoinDraftClick() {
        const code = roomCodeInput?.value.trim().toUpperCase();
        if (!code) {
            alert("Please enter a room code.");
            roomCodeInput?.focus();
            return;
        }
        socket.emit('join_draft', { roomCode: code });
    }

    /** Handles clicking the "Start New Draft" button, validates settings, shows table name overlay. */
    function handleStartDraftClick() {
        // Read and Validate Start Settings
        const numTables = parseInt(tableCountInput.value, 10);
        const numF = parseInt(numForwardsInput.value, 10);
        const numD = parseInt(numDefendersInput.value, 10);
        const numG = parseInt(numGoaltendersInput.value, 10);
        const isSerpentine = serpentineOrderCheckbox.checked;
        const maxSalary = parseInt(maxSalaryCapInput.value, 10);

        let errorMessage = "";
        if (isNaN(numTables) || numTables < 1) errorMessage = "Number of teams must be at least 1.";
        else if (isNaN(numF) || numF < 0 || isNaN(numD) || numD < 0 || isNaN(numG) || numG < 0) errorMessage = "Player counts per position must be 0 or greater.";
        else if (numF + numD + numG === 0) errorMessage = "Total players per team cannot be zero.";
        else if (isNaN(maxSalary) || maxSalary < 0) errorMessage = "Salary Cap must be 0 or greater.";

        if (errorMessage) {
            alert(`Invalid Settings: ${errorMessage}`);
            return;
        }

        // Store settings temporarily before collecting names
        tempDraftSettings = { numTables, numF, numD, numG, isSerpentine, maxSalary };

        // Prepare and Show Table Names Overlay
        if (!tableNamesOverlay || !tableNamesInputContainer) return;

        tableNamesInputContainer.innerHTML = ''; // Clear previous inputs
        for (let i = 0; i < numTables; i++) {
            const id = `teamNameInput-${i}`;
            const placeholder = `Team ${i + 1}`;
            const group = document.createElement('div');
            group.className = 'settings-input-group';
            // Use template literal for cleaner HTML generation
            group.innerHTML = `
                <label for="${id}">Name for ${placeholder}:</label>
                <input type="text" id="${id}" data-table-index="${i}" placeholder="${placeholder}">
            `;
            tableNamesInputContainer.appendChild(group);
        }

        tableNamesOverlay.classList.add('visible');
        tableNamesInputContainer.querySelector('input')?.focus(); // Focus first name input
    }

    /** Handles confirming table names and emitting 'start_draft'. */
    function handleConfirmTableNamesClick() {
        if (!tableNamesOverlay || !tableNamesInputContainer || !tempDraftSettings) return;

        const collectedTableNames = {};
        const inputs = tableNamesInputContainer.querySelectorAll('input[type="text"]');
        inputs.forEach(input => {
            const index = parseInt(input.dataset.tableIndex, 10);
            if (!isNaN(index)) {
                 // Use placeholder as default if input is empty or only whitespace
                 collectedTableNames[index] = input.value.trim() || input.placeholder;
            }
        });

        // Prepare final settings object for the server
        const settings = {
            numTables: tempDraftSettings.numTables,
            tableNames: collectedTableNames,
            playersPerPos: {
                F: tempDraftSettings.numF,
                D: tempDraftSettings.numD,
                G: tempDraftSettings.numG
            },
            isSerpentineOrder: tempDraftSettings.isSerpentine,
            maxSalary: tempDraftSettings.maxSalary
        };

        socket.emit('start_draft', settings);

        tempDraftSettings = {}; // Clear temporary settings
        tableNamesOverlay.classList.remove('visible');
    }

    /** Handles input changes in player search fields, triggers search and displays results. */
    function handlePlayerSearchInput(event) {
        const inputElement = event.target;
        const searchTerm = inputElement.value;
        const position = inputElement.dataset.position;
        const searchResultsContainer = inputElement.nextElementSibling;
        const teamIdStr = inputElement.dataset.teamId;

        if (!searchResultsContainer) return;

        searchResultsContainer.innerHTML = ""; // Clear previous results
        searchResultsContainer.style.display = 'none'; // Hide initially

        // --- Salary Cap Check Prep ---
        let currentTeamId = -1;
        if (teamIdStr) {
            currentTeamId = parseInt(teamIdStr, 10);
        }
        const maxSalary = currentServerState?.settings?.maxSalary;
        let currentTeamSalary = 0;

        if (currentServerState?.picks && !isNaN(currentTeamId) && maxSalary > 0) {
            currentServerState.picks.forEach(pick => {
                if (pick.teamId === currentTeamId && pick.salary != null) {
                    currentTeamSalary += (parseInt(pick.salary, 10) || 0);
                }
            });
        }

        if (searchTerm.length < 2) { // Only search if term is long enough
            hidePlayerTooltip();
            return;
        }

        // Ensure currentServerState and selectedPlayerIds exist before filtering
        const selectedIds = currentServerState?.selectedPlayerIds instanceof Set
            ? currentServerState.selectedPlayerIds
            : new Set();
    
        const playersOfGivenPosition = getAvailablePlayers(position); // Get all players of that position
        const filteredPlayers = searchPlayers(searchTerm, playersOfGivenPosition); // Search within them

        if (filteredPlayers.length > 0) {
            searchResultsContainer.style.display = 'block'; // Show container
            filteredPlayers.slice(0, 10).forEach(player => { // Limit displayed results
                const item = document.createElement("div");
                item.classList.add("search-result-item");
                // Store all necessary data on the result item itself
                item.dataset.playerId = player.id;
                item.dataset.playerName = player.name;
                item.dataset.salary = player.cap_hit; // Use cap_hit for salary
                item.dataset.position = player.position;
                item.dataset.playerTeamUrl = player.team_url || '';
                item.dataset.city = player.city || '';
                item.dataset.age = player.age ?? '';

                const playerCapHit = parseInt(player.cap_hit, 10) || 0;
                const wouldBeOverCap = maxSalary > 0 && (currentTeamSalary + playerCapHit > maxSalary) && !isNaN(currentTeamId);

                const isPicked = selectedIds.has(player.id); // Check if this player is in the set of picked IDs
                if (isPicked) {
                    item.classList.add("search-result-item-picked"); // Add our new CSS class
                } else if (wouldBeOverCap) {
                    item.classList.add("search-result-item-over-cap");
                    item.title = `Picking this player would exceed the ${formatCurrency(maxSalary)} salary cap for this team. Current: ${formatCurrency(currentTeamSalary)}, Player: ${formatCurrency(playerCapHit)}`;
                }

                const logoPath = getTeamLogoPath(player.team_url);
                const logoImg = document.createElement('img');
                logoImg.src = logoPath;
                logoImg.alt = player.city || 'Team';
                logoImg.classList.add('search-result-logo');
                item.appendChild(logoImg);

                const nameSpan = document.createElement('span');
                nameSpan.textContent = player.name;
                item.appendChild(nameSpan);

                // Tooltip listeners for all items
                item.addEventListener("mouseenter", showPlayerTooltip);
                item.addEventListener("mouseleave", hidePlayerTooltip);

                // Selection listener only for unpicked items
                if (!isPicked && !wouldBeOverCap) { // Only add listener if not picked AND not over cap
                    item.addEventListener("mousedown", handlePlayerOptionMouseDown);
                }

                searchResultsContainer.appendChild(item);
            });
        } else {
             hidePlayerTooltip(); // Hide tooltip if no results found
        }
    }

    /** Hides search results when the input loses focus (with delay). */
    function handlePlayerSearchBlur(event) {
        const resultsContainer = event.target.nextElementSibling;
        // Delay hiding to allow click/mousedown on results to register
        setTimeout(() => {
            // Hide if focus is no longer in input or results container
            if (resultsContainer && document.activeElement !== event.target && !resultsContainer.contains(document.activeElement)) {
                resultsContainer.style.display = 'none';
                hidePlayerTooltip(); // Also hide tooltip
            }
        }, 150); // 150ms delay seems reasonable
    }

    /** Handles keyboard events (Enter, Escape) in player search input. */
    function handlePlayerSearchKeydown(event) {
        const resultsContainer = event.target.nextElementSibling;
        if (!resultsContainer) return;

        if (event.key === 'Enter') {
            event.preventDefault(); // Prevent form submission/newline
            const firstOption = resultsContainer.querySelector('.search-result-item'); // Use updated class
            if (firstOption) {
                // Simulate mousedown to trigger selection logic
                firstOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            }
        } else if (event.key === 'Escape') {
             resultsContainer.style.display = 'none'; // Hide results on Escape
             hidePlayerTooltip();
        }
    }

    /** Handles clicking (mousedown) on a player option in the search results. */
    function handlePlayerOptionMouseDown(event) {
        event.preventDefault(); // Prevent input blur from hiding results immediately
        if (!currentRoomCode) {
             console.error("Cannot make pick: Not in a room.");
             alert("Error: Not connected to a draft room.");
             return;
        }

        const playerOption = event.currentTarget; // The clicked div.search-result-item
        const resultsContainer = playerOption.parentElement;
        const inputElement = resultsContainer?.previousElementSibling; // The input field
        const parentRow = inputElement?.closest('tr.player-slot'); // Get the table row
        const parentTable = parentRow?.closest('table'); // Get the table

        if (!inputElement || !resultsContainer || !parentRow || !parentTable) {
            console.error("Could not find necessary parent elements for pick selection.");
            return;
        }

        const playerId = parseInt(playerOption.dataset.playerId, 10);
        const teamId = parseInt(parentTable.dataset.teamId, 10); // Get teamId from table
        const player = playersIndex.find(p => p.id === playerId); // Find full player data

        if (player && !isNaN(teamId)) {
            // Prepare data payload for the server
            const pickData = {
                playerId: player.id,
                playerName: player.name,
                salary: parseInt(player.cap_hit, 10) || 0, // Use cap_hit, ensure integer
                position: player.position,
                teamId: teamId, // Use teamId from the table context
                team_url: player.team_url || '', // Include player's NHL team URL
                city: player.city || '' // Include player's NHL team city
            };

            socket.emit('make_pick', { roomCode: currentRoomCode, pickData: pickData });

            // --- Optimistic UI Update / Feedback ---
            resultsContainer.style.display = "none"; // Hide results
            resultsContainer.innerHTML = "";        // Clear results
            inputElement.disabled = true;           // Disable input immediately
            inputElement.value = '';                // Clear search term
            inputElement.placeholder = "Processing..."; // Indicate action
            // The full row update will happen when 'draft_state_update' is received

        } else {
            console.error("Could not find player data or valid teamId for selection.", { playerId, teamId });
        }
    }

    /** Handles clicking the "Undo Last Pick" button. */
    function handleUndoClick() {
        if (!currentRoomCode) {
             console.error("Cannot undo: Not in a room.");
             return;
        }
        if (!currentServerState?.picks?.length) {
            console.warn("Undo clicked, but no picks exist in current state.");
            return; // Nothing to undo
        }
        socket.emit('undo_pick', { roomCode: currentRoomCode });
    }

    /** Handles finishing editing a table name (on blur). */
    function handleTableNameEdit(event) {
        if (!currentRoomCode || !currentServerState?.settings?.tableNames) {
             console.error("Cannot update table name: Not in a room or state invalid.");
             return;
        }

        const captionElement = event.target;
        const table = captionElement.closest('table');
        if (!table) return;

        const teamId = parseInt(table.dataset.teamId, 10);
        let newName = captionElement.textContent.trim(); // Get trimmed new name

        if (!isNaN(teamId)) {
            const defaultName = `Team ${teamId + 1}`;
            // If name is empty after trimming, revert to default
            if (newName === "") {
                newName = defaultName;
                captionElement.textContent = newName; // Update display locally immediately
            }

            // Get the name currently known by the server state
            const serverName = currentServerState.settings.tableNames[teamId] || defaultName;

            // Only emit if the name has actually changed
            if (newName !== serverName) {
                 socket.emit('update_table_name', { roomCode: currentRoomCode, teamId: teamId, newName: newName });
            }
            // The name will be officially updated via 'draft_state_update' from server
        }
    }

    /** Handles Enter key press within table name cell to trigger blur. */
    function handleTableNameKeydown(event) {
        if (event.target.tagName === 'CAPTION' && event.key === 'Enter') {
            event.preventDefault(); // Prevent newline in contenteditable
            event.target.blur(); // Trigger the blur event handler
        }
    }

    /** Handles clicking the main settings button (top right). */
    function handleSettingsButtonClick() {
        if (!settingsOverlay) return;

        // Update room code display within the overlay
        if (settingsRoomCodeText) {
            settingsRoomCodeText.textContent = currentRoomCode || ''; // Show code or empty string
        }
        if (copyRoomCodeButton) {
            copyRoomCodeButton.disabled = !currentRoomCode; // Enable copy only if in a room
        }

        // Update other settings displayed in the overlay if necessary
        // e.g., const overlayMaxSalaryInput = settingsOverlay.querySelector('#overlayMaxSalary');
        // if (overlayMaxSalaryInput && currentServerState?.settings) {
        //     overlayMaxSalaryInput.value = currentServerState.settings.maxSalary;
        // }

        settingsOverlay.classList.add('visible');
    }

    /** Handles clicking the "Copy" button for the room code. */
    function handleCopyRoomCodeClick() {
        if (!navigator.clipboard) {
            alert("Clipboard API not supported by this browser.");
            return;
        }
        if (!currentRoomCode) {
             return;
        }

        navigator.clipboard.writeText(currentRoomCode).then(() => {
            // Success feedback
            const originalContent = copyRoomCodeButton.innerHTML;
            copyRoomCodeButton.textContent = 'Copied!';
            copyRoomCodeButton.disabled = true;
            setTimeout(() => {
                copyRoomCodeButton.innerHTML = originalContent;
                copyRoomCodeButton.disabled = false;
            }, 1500); // Show feedback for 1.5 seconds
        }).catch(err => {
            console.error('Failed to copy room code:', err);
            alert("Could not copy room code automatically.\nPlease try copying manually.");
        });
    }

    /** Handles clicking the "Close" button in the settings overlay. */
    function handleCloseSettingsClick() {
        settingsOverlay?.classList.remove('visible');
    }

    /** Handles clicking the background of an overlay to close it. */
    function handleOverlayBackgroundClick(event) {
        // Close overlay if the click is directly on the overlay background itself
        if (event.target === settingsOverlay || event.target === tableNamesOverlay || event.target === exitConfirmOverlay) {
            event.target.classList.remove('visible');
            // If table name overlay is cancelled this way, clear temp settings
            if (event.target === tableNamesOverlay) {
                 tempDraftSettings = {};
            }
        }
    }

    /** Handles clicking "Cancel" in the table names overlay. */
    function handleCancelTableNamesClick() {
        tableNamesOverlay?.classList.remove('visible');
        tempDraftSettings = {}; // Clear temp settings
    }

    /** Handles clicking the "Exit Draft" button (shows confirmation). */
    function handleExitDraftClick() {
        if (exitConfirmOverlay) {
            exitConfirmOverlay.classList.add('visible');
        } else {
            // If confirmation doesn't exist, exit directly (fallback)
            handleConfirmExit();
        }
    }

    /** Handles clicking "Yes, Exit" in the confirmation overlay. */
    function handleConfirmExit() {
        exitConfirmOverlay?.classList.remove('visible'); // Hide confirmation

        // Notify server *before* changing local state/UI
        if (currentRoomCode && socket.connected) {
            socket.emit('leave_draft', { roomCode: currentRoomCode });
        }

        // Reset UI to start screen
        showStartScreen();
    }

    /** Handles clicking "Cancel" in the exit confirmation overlay. */
    function handleCancelExit() {
        exitConfirmOverlay?.classList.remove('visible'); // Just hide the modal
    }

    /** Handles clicking on a table to highlight it. */
    function handleTableClick(event) {
        const clickedTableWrapper = event.target.closest('.table-wrapper');

        if (!clickedTableWrapper || !tablesContainer) return; // Click was not inside a table wrapper or container doesn't exist

        // Iterate over all table wrappers
        tablesContainer.querySelectorAll('.table-wrapper').forEach(wrapper => {
            if (wrapper !== clickedTableWrapper) {
                // If this wrapper is not the one being clicked,
                // remove 'active-table' and reset its padlock
                if (wrapper.classList.contains('active-table')) {
                    wrapper.classList.remove('active-table');
                    const padlock = wrapper.querySelector('.padlock-icon');
                    if (padlock) {
                        padlock.src = PNG_PADLOCK_UNLOCKED; // Reset to unlocked
                        padlock.dataset.locked = "false";
                    }
                }
            }
        });

        // Activate the clicked table wrapper. Its padlock state is preserved.
        clickedTableWrapper.classList.add('active-table');

    }

    // ==========================================================================
    // Attaching Event Listeners
    // ==========================================================================
    /** Utility to safely attach event listeners. */
    function attachListener(element, event, handler, elementName) {
        if (element) {
            element.addEventListener(event, handler);
        } else {
            console.error(`Failed to attach listener: Element "${elementName}" not found.`);
        }
    }

    // --- Start/Join Screen ---
    attachListener(joinDraftButton, 'click', handleJoinDraftClick, 'Join Draft Button');
    attachListener(startDraftButton, 'click', handleStartDraftClick, 'Start Draft Button');

    // --- Draft Area Controls ---
    attachListener(undoButton, 'click', handleUndoClick, 'Undo Button');
    attachListener(settingsButton, 'click', handleSettingsButtonClick, 'Settings Button');

    // --- Settings Overlay ---
    attachListener(settingsOverlay, 'click', handleOverlayBackgroundClick, 'Settings Overlay Background');
    attachListener(closeSettingsButton, 'click', handleCloseSettingsClick, 'Close Settings Button');
    attachListener(copyRoomCodeButton, 'click', handleCopyRoomCodeClick, 'Copy Room Code Button');
    attachListener(exitDraftButton, 'click', handleExitDraftClick, 'Exit Draft Button (in Settings)');

    // --- Table Names Overlay ---
    attachListener(tableNamesOverlay, 'click', handleOverlayBackgroundClick, 'Table Names Overlay Background');
    attachListener(confirmTableNamesButton, 'click', handleConfirmTableNamesClick, 'Confirm Table Names Button');
    attachListener(cancelTableNamesButton, 'click', handleCancelTableNamesClick, 'Cancel Table Names Button');

    // --- Exit Confirmation Overlay ---
    attachListener(exitConfirmOverlay, 'click', handleOverlayBackgroundClick, 'Exit Confirm Overlay Background');
    attachListener(confirmExitButton, 'click', handleConfirmExit, 'Confirm Exit Button');
    attachListener(cancelExitButton, 'click', handleCancelExit, 'Cancel Exit Button');

    // --- Table Click Listener for Highlighting ---
    attachListener(tablesContainer, 'click', handleTableClick, 'Tables Container for Click Highlighting');

    // --- Handles clicking the padlock icon on a table. ---
    function handlePadlockClick(event) {
        const padlock = event.currentTarget;
        const isLocked = padlock.dataset.locked === "true";

        if (!isLocked) { // If currently unlocked
            padlock.src = PNG_PADLOCK_LOCKED; // Change to locked
            padlock.dataset.locked = "true";
        } else { // If currently locked
            padlock.src = PNG_PADLOCK_UNLOCKED; // Change to unlocked
            padlock.dataset.locked = "false";
        }
        event.stopPropagation(); // Prevent table click from firing if padlock is on top
    }

    // Note: Listeners for dynamic elements (table names, search inputs/results) are added in createPlayerRow and generateTablesFromServerState

    // --- Listener for window resize (with debounce) ---
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(uniformizeColumnWidths, 150);
    });

}); // End DOMContentLoaded
