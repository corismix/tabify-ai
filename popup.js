// popup.js - Logic for the AI Tab Grouper browser action popup

document.addEventListener('DOMContentLoaded', () => {
    const triggerButton = document.getElementById('triggerGroupBtn');
    const undoButton = document.getElementById('undoGroupBtn'); // Get Undo button
    const statusArea = document.getElementById('statusArea');
    const optionsLink = document.getElementById('optionsLink');

    if (!triggerButton || !undoButton || !statusArea || !optionsLink) { // Check for undoButton too
        console.error("Popup elements not found!");
        if (statusArea) statusArea.textContent = "Error: Popup UI missing.";
        return;
    }

    // --- Event Listener for Grouping Button ---
    triggerButton.addEventListener('click', () => {
        console.log("Group Tabs Now button clicked.");
        statusArea.textContent = "Grouping requested..."; // Update status immediately
        triggerButton.disabled = true; // Disable button temporarily

        // Disable both buttons during grouping
        undoButton.disabled = true;

        browser.runtime.sendMessage({ type: "triggerGroupingManually" })
            .catch(error => {
                console.error("Error sending triggerGroupingManually message:", error);
                statusArea.textContent = `Error: ${error.message || "Could not send request."}`;
                statusArea.style.color = 'red'; // Indicate error
                // Re-enable trigger button on error sending message
                triggerButton.disabled = false;
                // Re-enable undo button based on actual state (will be handled by listener)
                requestUndoState();
            });
            // Note: Button re-enabling is now primarily handled by status updates/undo state changes
    });

    // --- Event Listener for Undo Button ---
    undoButton.addEventListener('click', () => {
        console.log("Undo button clicked.");
        statusArea.textContent = "Requesting undo...";
        statusArea.style.color = '#555'; // Reset color
        triggerButton.disabled = true; // Disable both buttons during undo
        undoButton.disabled = true;

        browser.runtime.sendMessage({ type: "undoGrouping" })
            .catch(error => {
                console.error("Error sending undoGrouping message:", error);
                statusArea.textContent = `Error: ${error.message || "Could not send undo request."}`;
                statusArea.style.color = 'red';
                // Re-enable buttons based on actual state after error
                requestUndoState(); // Check if undo is still possible
                triggerButton.disabled = false; // Re-enable trigger button
            });
    });

    // --- Event Listener for Options Link ---
    optionsLink.addEventListener('click', (event) => {
        event.preventDefault(); // Prevent default link navigation
        console.log("Options link clicked.");
        browser.runtime.openOptionsPage()
            .then(() => {
                console.log("Options page opening...");
                window.close(); // Close the popup after requesting options page
            })
            .catch(error => {
                console.error("Error opening options page:", error);
                statusArea.textContent = "Error opening options.";
            });
    });

    // --- Message Listener for Updates from Background ---
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log("Popup received message:", message);

        if (message.type === "statusUpdate") {
            const { text, isError } = message.payload;
            statusArea.textContent = text;
            statusArea.style.color = isError ? 'red' : '#555';

            // Re-enable trigger button when grouping is complete or failed definitively
            // (Assuming background sends specific messages like "Grouping complete.", "Error: ...", "Nothing to undo.")
            if (text.includes("complete") || text.includes("Error:") || text.includes("Nothing to undo") || text.includes("Skipping:") || text.includes("No new groups created")) {
                 triggerButton.disabled = false;
                 // Undo button state is handled by undoStateChanged
            } else {
                 triggerButton.disabled = true; // Keep disabled during intermediate steps
            }
        } else if (message.type === "undoStateChanged") {
            const { canUndo } = message.payload;
            undoButton.disabled = !canUndo;
            // If undo becomes possible, ensure trigger button is also enabled (unless grouping is actively in progress)
            if (canUndo && !statusArea.textContent.startsWith("Grouping") && !statusArea.textContent.startsWith("Applying")) {
                 triggerButton.disabled = false;
            }
        }
    });

    // --- Initial State Request ---
    function requestUndoState() {
        browser.runtime.sendMessage({ type: "getUndoState" })
            .then(response => {
                if (response && typeof response.canUndo === 'boolean') {
                    undoButton.disabled = !response.canUndo;
                    console.log("Initial undo state:", response.canUndo);
                } else {
                     console.warn("Did not receive valid initial undo state.");
                     undoButton.disabled = true; // Default to disabled
                }
            })
            .catch(error => {
                console.error("Error requesting initial undo state:", error);
                statusArea.textContent = "Error getting initial state.";
                statusArea.style.color = 'red';
                undoButton.disabled = true; // Default to disabled on error
            });
    }

    // Request the initial state when the popup loads
    requestUndoState();

    console.log("Popup script initialized with new listeners.");
});