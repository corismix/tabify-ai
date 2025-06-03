// background.js - AI Tab Grouper Background Script

// console.log("AI Tab Grouper background script loaded."); // Removed initial console.log

// --- Configuration ---
const NOTIFICATION_ICON_URL = "icons/icon-48.png"; // Path to extension icon
const TAB_CHUNK_SIZE = 75; // AC1: Default chunk size for API requests

// Default prompt for the AI grouping service
const DEFAULT_GROUPING_PROMPT = `SYSTEM INSTRUCTION: You are an extremely precise and reliable browser tab organization assistant. Your sole output must be a perfectly formatted JSON array according to the specified schema, with absolutely no deviations, extraneous text, or conversational remarks. Your priority is strict adherence to the output format.

PROMPT:
Analyze the following list of browser tabs, each with an ID, title, and URL. Group them based on common themes, tasks, or topics found by considering BOTH the title and the URL.

Strictly adhere to the following rules:
1.  **Grouping Logic**: Create meaningful groups for related tabs. ALL tabs provided in the input MUST be assigned to a group. If a tab does not fit into any other specific, cohesive group, it MUST be placed in a group named "Miscellaneous".
2.  **Group Naming**: Provide a concise, descriptive name for each group. The name MUST NOT exceed 5 words. The group for unclassified tabs MUST be named "Miscellaneous".
3.  **Output Format (JSON)**: The entire output MUST be a single, valid JSON array. If the model cannot directly output a root-level array, wrap it in an object with a single key "groups" (e.g., \`{"groups": [...]}\`). Do NOT include any text, newlines, or characters before or after the JSON.
4.  **Object Structure**: Each object within the JSON array MUST represent a group and contain EXACTLY two keys:
    *   \`\`"name"\`\`: A string containing the group name (e.g., "Development Tools", "Miscellaneous").
    *   \`\`"tabIds"\`\`: An array of the actual numeric \`\`id\`\` values (from the input). These values MUST be integers, NOT strings (e.g., \`\`[101, 102, 103]\`\`, not \`\`["101", "102"]\`\`).
5.  **Edge Cases**:
    *   If the input list of tabs is empty, the output MUST be an empty JSON array: [].
    *   If all tabs are placed into the "Miscellaneous" group, this is acceptable.

Example Input:
[
  { "id": 101, "title": "Google Search: 'best javascript frameworks'", "url": "https://google.com/search?q=best+javascript+frameworks" },
  { "id": 102, "title": "React Documentation", "url": "https://reactjs.org/docs/getting-started.html" },
  { "id": 103, "title": "Vue.js Guide", "url": "https://vuejs.org/v2/guide/" },
  { "id": 104, "title": "Gmail - Inbox", "url": "https://mail.google.com/" },
  { "id": 105, "title": "AngularJS", "url": "https://angularjs.org/" },
  { "id": 106, "title": "News Article: Latest Tech Trends", "url": "https://techcrunch.com/article/latest-trends" },
  { "id": 107, "title": "My Shopping List", "url": "https://amazon.com/wishlist" }
]

Example Output:
[
  { "name": "JS Framework Research", "tabIds": [101, 102, 103, 105] },
  { "name": "Email", "tabIds": [104] }
]

Tabs to group:
{tabs_placeholder}`;
// --- State ---
let lastGroupingState = null; // Stores info needed to undo the last grouping action

// --- Undo Functionality ---
/**
 * Reverts the last tab grouping action.
 */
async function undoGrouping() {
    logDebug("Attempting to undo last grouping action...");
    sendStatusUpdate("Undoing last grouping...");

    if (!lastGroupingState) {
        logDebug("No previous grouping state to undo.");
        sendStatusUpdate("No previous grouping to undo.");
        return;
    }

    try {
        // 1. Ungroup all tabs that were part of the last grouping
        const tabIdsToUngroup = lastGroupingState.originalTabStates.map(tab => tab.id);
        if (tabIdsToUngroup.length > 0) {
            logDebug("Ungrouping tabs:", tabIdsToUngroup);
            await browser.tabs.ungroup(tabIdsToUngroup);
        }

        // 2. Restore original group IDs and positions
        for (const tabState of lastGroupingState.originalTabStates) {
            try {
                // Check if tab still exists
                const tabExists = await browser.tabs.get(tabState.id).then(() => true).catch(() => false);
                if (!tabExists) {
                    logWarnDebug(`Tab ${tabState.id} no longer exists, skipping restore.`);
                    continue;
                }

                if (tabState.originalGroupId !== browser.tabs.TAB_ID_NONE) {
                    // If it was originally in a group, try to move it back
                    await browser.tabs.group({
                        groupId: tabState.originalGroupId,
                        tabIds: [tabState.id]
                    });
                }
                // Restore original index (best effort, as other tabs might have moved)
                await browser.tabs.move(tabState.id, { index: tabState.originalIndex });
            } catch (error) {
                logWarnDebug(`Error restoring tab ${tabState.id} to original state:`, error);
            }
        }

        // 3. Remove any newly created groups
        for (const groupId of lastGroupingState.createdGroupIds) {
            try {
                // Check if group still exists before removing
                await browser.tabGroups.get(groupId); // This will throw if group doesn't exist
                logDebug("Removing newly created group:", groupId);
                await browser.tabGroups.remove(groupId);
            } catch (error) {
                logWarnDebug(`Error removing newly created group ${groupId} (might have been removed manually):`, error);
            }
        }

        lastGroupingState = null; // Clear state after undo
        sendStatusUpdate("Last grouping undone successfully.");
        showNotification("AI Tab Grouper", "Last grouping undone.");
        logDebug("Undo complete.");

    } catch (error) {
        console.error("Error during undoGrouping:", error);
        sendStatusUpdate(`Error undoing grouping: ${error.message}`, true);
        showNotification("AI Tab Grouper: Undo Error", `Failed to undo grouping: ${error.message}`);
    }
}

// Add listener for undo action from popup
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (isDebugMode) console.log("[AI Tab Grouper Debug] Received message in background script (sync listener - undoGrouping): ", request);
  if (request.type === "undoGrouping") {
    if (isDebugMode) console.log("[AI Tab Grouper Debug] Handling undoGrouping (sync listener)");
    undoGrouping();
    // sendResponseWrapper is removed, use sendResponse directly if needed for this specific handler
    // For this specific synchronous handler that uses sendResponse, it MUST return true.
    sendResponse({ success: true });
    return true;
  }
  // For any other message type, explicitly return false to indicate that
  // this listener will not send a response and other listeners should be tried.
  // This is crucial for allowing the async listener to function correctly.
  if (isDebugMode) console.log("[AI Tab Grouper Debug] Message not 'undoGrouping', sync listener returning false.", request);
  return false;
});

// --- API Callers for Models ---
async function fetchGeminiModels(apiKey) {
    logDebug("Fetching Gemini models...");
    try {
        // The Gemini API provides a "list models" endpoint at https://generativelanguage.googleapis.com/v1beta/models.
        // We will fetch the available models dynamically.
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        const response = await fetch(url);

        if (!response.ok) {
            const errorDetail = await response.json();
            throw new Error(`Gemini API error: ${response.status} - ${errorDetail.error.message || response.statusText}`);
        }

        const data = await response.json();
        // Filter for models that can generate content and map to the expected format
        const modelsList = Array.isArray(data.models) ? data.models : [];
        return modelsList
            .filter(model => model.supportedGenerationMethods && model.supportedGenerationMethods.includes("generateContent"))
            .map(model => ({
                id: model.name, // Gemini uses 'name' field as the model ID (e.g., "models/gemini-pro")
                name: model.displayName || model.name.split('/')[1] || model.name // Use displayName, or extract from name, or use full name
            }));
    } catch (error) {
        console.error("Error fetching Gemini models:", error);
        throw new Error("Failed to fetch Gemini models: " + error.message);
    }
}

async function fetchOpenRouterModels(apiKey) {
    logDebug("Fetching OpenRouter models...");
    const url = "https://openrouter.ai/api/v1/models";
    try {
        const response = await fetch(url, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            }
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`OpenRouter API error: ${response.status} - ${errorData.message || response.statusText}`);
        }

        const data = await response.json();
        return data.data.map(model => ({
            id: model.id,
            name: model.name || model.id // Use name if available, otherwise id
        }));
    } catch (error) {
        console.error("Error fetching OpenRouter models:", error);
        throw new Error("Failed to fetch OpenRouter models: " + error.message);
    }
}

// --- Message Listener for Options Page ---
browser.runtime.onMessage.addListener(async (request, sender) => {
    logDebug("Received message in background script:", request);

    if (request.action === "fetchModels") {
      const provider = request.payload.provider;
      logDebug(`Received fetchModels request for provider: ${provider}`, request.payload);
      try {
        const settings = await browser.storage.sync.get(['apiKey']);
        const apiKey = settings.apiKey;

        if (!apiKey) {
          throw new Error("API Key is not set. Please configure in options.");
        }

        let models;
        if (provider === "Gemini") {
          models = await fetchGeminiModels(apiKey);
        } else if (provider === "OpenRouter") {
          models = await fetchOpenRouterModels(apiKey);
        } else {
          throw new Error("Unsupported AI provider selected.");
        }
        
        if (isDebugMode) console.log(`[AI Tab Grouper Debug] Returning fetchModels response: `, { models: models, error: null });
        return { models: models, error: null };
      } catch (error) {
        if (isDebugMode) console.error(`[AI Tab Grouper Debug] Error in fetchModels, returning error: ${error.message}`);
        return { models: null, error: error.message };
      }
    } else if (request.action === "getDefaultPrompt") {
      logDebug("Received getDefaultPrompt request.", request);
      if (isDebugMode) console.log(`[AI Tab Grouper Debug] Returning getDefaultPrompt response: `, { prompt: DEFAULT_GROUPING_PROMPT });
      return { prompt: DEFAULT_GROUPING_PROMPT };
    } else if (request.type === "getUndoState") {
      logDebug("Received getUndoState request.", request);
      const canUndo = !!lastGroupingState;
      if (isDebugMode) console.log(`[AI Tab Grouper Debug] Returning getUndoState response: `, { canUndo });
      return { canUndo };
    } else if (request.type === "triggerGroupingManually") {
      if (isDebugMode) console.log("[AI Tab Grouper Debug] Received triggerGroupingManually request.", request);
      try {
        await triggerGrouping(); // Call the existing main grouping function
        if (isDebugMode) console.log("[AI Tab Grouper Debug] triggerGrouping completed successfully for manual trigger.");
        return { success: true };
      } catch (error) {
        console.error("[AI Tab Grouper Error] Error during manual tab grouping:", error);
        if (isDebugMode) console.log(`[AI Tab Grouper Debug] Returning error for triggerGroupingManually: ${error.message}`);
        return { success: false, error: error.message };
      }
    }
    // Other message types can be handled here if needed
});

// --- Helper Functions ---

/**
 * Logs messages to the console only if debug mode is enabled.
 */
function logDebug(...args) {
    if (isDebugMode) {
        console.log("[AI Tab Grouper Debug]", ...args);
    }
}

/**
 * Logs warning messages to the console only if debug mode is enabled.
 */
function logWarnDebug(...args) {
    if (isDebugMode) {
        console.warn("[AI Tab Grouper Debug] WARN:", ...args);
    }
}

/**
 * Shows a browser notification.
 * @param {string} title - The notification title.
 * @param {string} message - The notification message body.
 * @param {string} [notificationId] - Optional ID for the notification.
 */
function showNotification(title, message, notificationId = `ai-group-notif-${Date.now()}`) {
    browser.notifications.create(notificationId, {
        type: "basic",
        iconUrl: NOTIFICATION_ICON_URL,
        title: title,
        message: message
    }).catch(error => {
        console.error("Error showing notification:", error); // Log error if notification fails
    });
}

/**
 * Sends a status update message to the popup script.
 * @param {string} statusText - The text message to display.
 * @param {boolean} [isError=false] - Indicates if the status is an error.
 */
function sendStatusUpdate(statusText, isError = false) {
    logDebug(`Sending status update: ${statusText} (Error: ${isError})`);
    browser.runtime.sendMessage({
        type: "statusUpdate",
        payload: { text: statusText, isError: isError }
    }).catch(error => {
        // Ignore errors if the popup isn't open
        if (error.message.includes("Could not establish connection") || error.message.includes("Receiving end does not exist")) {
           // logDebug("Popup not open, ignoring sendStatusUpdate error.");
        } else {
            console.error("Error sending status update to popup:", error);
        }
    });
}


// --- Core Grouping Logic ---

/**
 * Main function to initiate the tab grouping process.
 * Retrieves tabs, fetches settings (API key, provider, model), calls the AI service, and applies suggestions.
 */
async function triggerGrouping(manualTrigger = false, specificWindowId = null) {
  console.log(`[AI Tab Grouper Debug] triggerGrouping called. manualTrigger: ${manualTrigger}, specificWindowId: ${specificWindowId}. Current isDebugMode: ${isDebugMode}`);
    const requestTimestamp = new Date().toISOString();
    logDebug(`triggerGrouping called at: ${requestTimestamp}`);

    sendStatusUpdate("Starting grouping process..."); // Feedback
    logDebug("Starting grouping process...");

    // --- Fetch Settings First ---
    let settings = {}; // Declare settings object early
    try {

        logDebug("Fetching all settings from storage...");

        // Now fetch all other relevant settings
        settings = await browser.storage.sync.get([
            'apiKey',
            'aiProvider',
            'modelName',
            'groupingPrompt',
            'groupingSensitivity',
            'disableNotifications',
            'exclusionPatterns' // Load regex patterns
        ]);

        // --- Load and Assign Defaults ---
        // Default prompt is now defined globally as DEFAULT_GROUPING_PROMPT
        settings.groupingPrompt = settings.groupingPrompt || DEFAULT_GROUPING_PROMPT;
        settings.groupingSensitivity = settings.groupingSensitivity ?? 2;
        settings.disableNotifications = !!settings.disableNotifications;
        settings.exclusionPatterns = settings.exclusionPatterns || []; // Default to empty array

        // Log retrieved settings (after defaults applied)
        logDebug("Retrieved settings:", {
            apiKey: settings.apiKey ? `Present (length: ${settings.apiKey.length})` : 'Missing',
            aiProvider: settings.aiProvider || 'Not Set',
            modelName: settings.modelName || 'Not Set',
            groupingPrompt: settings.groupingPrompt === DEFAULT_GROUPING_PROMPT ? 'Default Prompt Loaded' : 'Custom Prompt Loaded',
            groupingSensitivity: settings.groupingSensitivity,
            disableNotifications: settings.disableNotifications,
            exclusionPatterns: settings.exclusionPatterns // Log loaded patterns
        });
        logDebug("Settings fetched and validated.");

        // --- Validate Essential Settings ---
        if (!settings.apiKey) {
            console.error("API Key not found in browser.storage.sync.");
            showNotification("AI Tab Grouper: Error", "API key not set. Please configure in options.");
            sendStatusUpdate("Error: API key not set.", true); // Feedback
            return; // Stop the process if API key is missing
        }
        if (!settings.aiProvider) {
            logWarnDebug("AI Provider not set in options. Grouping cannot proceed.");
            showNotification("AI Tab Grouper: Warning", "AI Provider not selected. Please configure in options.");
            sendStatusUpdate("Error: AI Provider not set.", true); // Feedback
            return; // Stop if provider isn't set
        }
        // Model name check happens later in callAIService

    } catch (error) {
        console.error("Error retrieving settings from storage:", error);
        logDebug("Critical error retrieving settings from storage:", error); // Also log if debug mode gets enabled
        showNotification("AI Tab Grouper: Error", "Failed to retrieve settings. Check console.");
        sendStatusUpdate("Error: Failed to retrieve settings.", true); // Feedback
        isDebugMode = false; // Ensure debug is off if settings fail
        return; // Stop the process if we can't access storage
    }

    // --- Start Grouping Process ---
    try { // Top-level try-catch for the main grouping logic
        logDebug("Attempting to trigger grouping process...");

        // Notification is now handled by sendStatusUpdate at the start

        // 2. Query ungrouped tabs
        logDebug("Querying tabs...");
        sendStatusUpdate("Fetching tabs..."); // Feedback
        let tabs;
        try {
            tabs = await browser.tabs.query({ currentWindow: true, pinned: false });
            logDebug("Tabs queried successfully.");
        } catch (error) {
            console.error("Error querying tabs:", error);
            logDebug("Error querying tabs:", error);
            showNotification("AI Tab Grouper: Error", "Failed to query tabs. Check console.");
            sendStatusUpdate("Error: Failed to query tabs.", true); // Feedback
            return;
        }

        let initialUngroupedTabs = tabs.filter(tab => !tab.groupId || tab.groupId === browser.tabs.TAB_ID_NONE);
        logDebug(`Found ${initialUngroupedTabs.length} initial ungrouped tabs.`);

        // Filter tabs based on exclusionPatterns (Regex) setting
        sendStatusUpdate("Filtering tabs based on exclusions..."); // Feedback
        let compiledRegexPatterns = [];
        try {
            compiledRegexPatterns = settings.exclusionPatterns.map(pattern => new RegExp(pattern, 'i')); // Compile regex, case-insensitive
        } catch (e) {
            console.error("Error compiling exclusion regex patterns:", e);
            logDebug("Error compiling exclusion regex patterns:", e);
            showNotification("AI Tab Grouper: Error", "Invalid exclusion regex pattern found. Check options.");
            sendStatusUpdate("Error: Invalid exclusion regex pattern.", true); // Feedback
            // Continue without regex filtering if patterns are invalid? Or stop? Stopping for safety.
            return;
        }

        const tabsToConsider = initialUngroupedTabs.filter(tab => {
            if (!tab.url) return true; // Keep tabs without URLs
            try {
                const urlString = tab.url;
                // Check against each compiled regex pattern
                for (const regex of compiledRegexPatterns) {
                    if (regex.test(urlString)) {
                        logDebug(`Excluding tab ${tab.id} (${tab.title}) due to regex match: ${regex.source}`);
                        return false; // Exclude if any pattern matches
                    }
                }
                return true; // Keep if no patterns match
            } catch (e) {
                logWarnDebug(`Error processing URL for exclusion check on tab ${tab.id} (${tab.title}): ${tab.url}. Keeping tab.`, e);
                return true; // Keep tabs if URL processing fails
            }
        });
        logDebug(`Found ${tabsToConsider.length} tabs after regex exclusion filtering.`);

        // Check against minimum tabs threshold (groupingSensitivity) - Feature Enhancement #4
        const minTabsThreshold = settings.groupingSensitivity;
        if (tabsToConsider.length < minTabsThreshold) {
            logDebug(`Not enough tabs (${tabsToConsider.length}) to meet the minimum threshold of ${minTabsThreshold}. Stopping.`);
            sendStatusUpdate(`Skipping: Only ${tabsToConsider.length} tabs found (min: ${minTabsThreshold}).`); // Feedback
            return;
        }

        // 3. Prepare data for AI Service (using filtered tabs)
        const tabDataMaster = tabsToConsider.map(tab => ({ id: tab.id, url: tab.url, title: tab.title }));
        logDebug(`Total tabs to process: ${tabDataMaster.length}`);

        // 4. Split tabs into chunks
        const tabChunks = [];
        for (let i = 0; i < tabDataMaster.length; i += TAB_CHUNK_SIZE) {
            tabChunks.push(tabDataMaster.slice(i, i + TAB_CHUNK_SIZE));
        }
        logDebug(`Split tabs into ${tabChunks.length} chunks of up to ${TAB_CHUNK_SIZE} tabs each.`);

        // 5. Call AI Service for each chunk and collect suggestions
        let allChunkSuggestions = [];
        let failedChunkCount = 0;
        let successfullyProcessedTabs = new Set(); // To track tabs in successful chunks

        for (let i = 0; i < tabChunks.length; i++) {
            const chunk = tabChunks[i];
            const chunkNumber = i + 1;
            logDebug(`Processing chunk ${chunkNumber} of ${tabChunks.length} with ${chunk.length} tabs.`);
            sendStatusUpdate(`Processing batch ${chunkNumber} of ${tabChunks.length} (${chunk.length} tabs)...`);

            try {
                logDebug(`Calling AI service for chunk ${chunkNumber}...`);
if (settings.aiProvider === "Gemini") {
                    console.log("[AI Tab Grouper Debug] Preparing to call AI service for chunk. Provider:", settings.aiProvider, "Model Name being passed:", settings.modelName);
                }
                const chunkSuggestions = await callAIService(chunk, settings.apiKey, settings.aiProvider, settings.modelName, settings.groupingPrompt);
                logDebug(`Received suggestions for chunk ${chunkNumber}:`, chunkSuggestions);
                if (chunkSuggestions && chunkSuggestions.length > 0) {
                    allChunkSuggestions.push(...chunkSuggestions); // Simple concatenation for now, merging later
                    chunk.forEach(tab => successfullyProcessedTabs.add(tab.id));
                    logDebug(`Chunk ${chunkNumber} processed successfully.`);
                } else {
                    logDebug(`No suggestions received for chunk ${chunkNumber}.`);
                }
            } catch (error) {
                console.error(`Error processing chunk ${chunkNumber}:`, error);
                logDebug(`Error processing chunk ${chunkNumber}:`, error);
                const chunkErrorMessage = error.message || `Failed to get suggestions for chunk ${chunkNumber}.`;
                // Don't show browser notification for each chunk, summarize at the end.
                // showNotification("AI Tab Grouper: Chunk Error", `Error in chunk ${chunkNumber}: ${chunkErrorMessage}`);
                sendStatusUpdate(`Error in batch ${chunkNumber}: ${chunkErrorMessage}`, true);
                failedChunkCount++;
                // Tabs from this failed chunk will be handled by the merging logic (e.g., go to "Failed to Process" or "Miscellaneous")
            }
        }
        logDebug("Finished processing all chunks.");

        if (failedChunkCount > 0) {
            const errorSummary = `Failed to process ${failedChunkCount} out of ${tabChunks.length} batches. Grouping will proceed with successful batches.`;
            logWarnDebug(errorSummary);
            showNotification("AI Tab Grouper: Batch Errors", errorSummary);
            sendStatusUpdate(errorSummary, true);
        }

        // TODO: Implement robust merging logic for allChunkSuggestions
        // For now, we'll pass the concatenated suggestions.
        // The merging logic needs to handle duplicate group names and ensure all tabs are assigned.
        logDebug("All chunks processed. Total suggestions collected (pre-merge):", allChunkSuggestions.length);
        sendStatusUpdate("Consolidating results...");

        // Placeholder for tabs from failed chunks - these need to be identified and handled
        const tabsFromFailedChunks = tabDataMaster.filter(tab => !successfullyProcessedTabs.has(tab.id));
        if (tabsFromFailedChunks.length > 0) {
            logWarnDebug(`${tabsFromFailedChunks.length} tabs were in failed chunks and will need special handling.`);
            // For now, these will likely end up in "Miscellaneous" by the AI if not explicitly handled,
            // or we can create a "Failed to Process" group in the merging logic.
        }

        // 6. Apply Grouping Suggestions (using potentially merged suggestions)
        let groupsApplied = false;
        if (allChunkSuggestions.length > 0 || tabsFromFailedChunks.length > 0) { // Proceed if there are any suggestions or failed tabs to handle
            // The `applyGroupingSuggestions` function will need to be aware of the merging strategy
            // or a new merging function will prepare the final suggestions list.
            // For now, we pass all collected suggestions and the original list of tabs considered.
            // The `tabsToConsider` (which became `tabDataMaster`) is important for `applyGroupingSuggestions`
            // to know the full set of tabs it might be operating on, especially for the undo state.

            // --- Merging Logic (Simplified for now, to be expanded) ---
            // This is a critical step. For now, let's assume a simple merge or pass-through.
            // A proper merge would consolidate groups with the same name, etc.
            const finalSuggestions = mergeChunkSuggestions(allChunkSuggestions, tabsFromFailedChunks);
            logDebug("Final suggestions after merging:", finalSuggestions);


            sendStatusUpdate("Applying final suggestions...");
if (isDebugMode) {
                console.log(`[AI Tab Grouper Debug] triggerGrouping - About to call applyGroupingSuggestions. isDebugMode to be passed: ${isDebugMode}`);
            }
            groupsApplied = await applyGroupingSuggestions(finalSuggestions, tabs, isDebugMode, tabsToConsider);
        } else {
            logDebug("No valid grouping suggestions received from any chunk.");
            sendStatusUpdate("No grouping suggestions received from AI after batch processing.");
        }

        logDebug("Grouping process finished.");
        // Conditionally show complete notification
        if (groupsApplied && !settings.disableNotifications) {
            showNotification("AI Tab Grouper", "Tab grouping complete.");
            sendStatusUpdate("Grouping complete."); // Feedback
        } else if (!groupsApplied) {
             logDebug("No new groups were created in this run.");
             sendStatusUpdate("No new groups created."); // Feedback
        }
    } catch (mainError) {
        console.error("An unexpected error occurred during the main grouping process:", mainError);
        logDebug("An unexpected error occurred during the main grouping process:", mainError);
        showNotification("AI Tab Grouper: Critical Error", "An unexpected error occurred. Check console.");
        sendStatusUpdate("Critical Error: " + mainError.message, true);
    }
}
/**
 * Validates the structure of the AI's grouping suggestions.
 * @param {Array<Object>} suggestions - The array of suggestions from the AI.
 * @returns {Array<Object>} The validated suggestions.
 * @throws {Error} If the suggestions do not conform to the expected schema.
 */
function validateGroupingSuggestions(suggestions) {
    if (!Array.isArray(suggestions)) {
        throw new Error("AI response is not a JSON array.");
    }
    for (const group of suggestions) {
        if (typeof group !== 'object' || group === null) {
            throw new Error("Each group must be a JSON object.");
        }
        if (typeof group.name !== 'string' || group.name.trim() === '') {
            throw new Error("Each group must have a non-empty 'name' string.");
        }
        if (!Array.isArray(group.tabIds)) {
            throw new Error("Each group must have a 'tabIds' array.");
        }
        for (const tabId of group.tabIds) {
            if (typeof tabId !== 'number' || !Number.isInteger(tabId)) {
                throw new Error("Each tabId must be an integer number.");
            }
        }
    }
    return suggestions; // Return validated suggestions
}

async function callAIService(tabs, apiKey, aiProvider, modelName, groupingPrompt) {
    logDebug(`Calling AI service for provider: ${aiProvider}, model: ${modelName}`);

    const tabData = tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url }));
    const promptContent = groupingPrompt.replace('{tabs_placeholder}', JSON.stringify(tabData, null, 2));

    let apiUrl;
    let headers;
    let body;
    let responseData;

    try {
        if (aiProvider === "Gemini") {
            let correctedModelName = modelName; // modelName is a parameter to callAIService
            if (typeof correctedModelName !== 'string') {
                console.error("[AI Tab Grouper Error] Gemini modelName is not a string:", correctedModelName);
                // Potentially throw an error or return a specific error object
                // For now, let it proceed and likely fail at URL construction, but the error is logged.
            } else {
                // Log initial state
                console.log(`[AI Tab Grouper Debug - FORCED LOG] callAIService - Initial Gemini modelName for URL: '${correctedModelName}'`);

                // First, handle potential "models/models/"
                if (correctedModelName.startsWith("models/models/")) {
                    if (self.isDebugMode) console.log(`[AI Tab Grouper Debug] Correcting "models/models/" prefix for: '${correctedModelName}'`);
                    correctedModelName = correctedModelName.substring("models/".length);
                    if (self.isDebugMode) console.log(`[AI Tab Grouper Debug] After "models/models/" correction: '${correctedModelName}'`);
                }
                // Then, ensure "models/" prefix if it's missing (e.g. if only "gemini-1.5-pro" was stored)
                // This case is less likely given current storage logic but adds robustness.
                if (!correctedModelName.startsWith("models/")) {
                     if (self.isDebugMode) console.log(`[AI Tab Grouper Debug] Adding "models/" prefix to: '${correctedModelName}'`);
                     correctedModelName = `models/${correctedModelName}`;
                     if (self.isDebugMode) console.log(`[AI Tab Grouper Debug] After adding "models/" prefix: '${correctedModelName}'`);
                }
            }
            // ... rest of the function, ensure apiUrl uses correctedModelName for Gemini ...
            if (aiProvider === "Gemini") {
              apiUrl = `https://generativelanguage.googleapis.com/v1beta/${correctedModelName}:generateContent?key=${apiKey}`;
            } // ... other providers
            headers = {
                'Content-Type': 'application/json'
            };
            body = JSON.stringify({
                contents: [{
                    parts: [{ text: promptContent }]
                }]
            });

            let response;
            try {
              response = await fetch(apiUrl, { // Existing fetch call
                  method: 'POST',
                  headers: headers,
                  body: body
              });
            } catch (fetchError) {
              console.error(`[AI Tab Grouper Debug] callAIService - fetch() call ITSELF threw an error for ${aiProvider} model ${correctedModelName}. Error:`, fetchError);
              // Re-throw or handle as appropriate for your error strategy,
              // for now, we'll throw a new error to ensure it's caught by the outer try/catch if not already.
              throw new Error(`Fetch call failed: ${fetchError.message}`);
            }

            if (isDebugMode) {
                console.log(`[AI Tab Grouper Debug] callAIService - Gemini API response status: ${response.status}, statusText: ${response.statusText}`);
            }

            if (!response.ok) {
                let errorBody = 'Could not read error body';
                try {
                    errorBody = await response.text();
                } catch (e) {
                    console.warn('[AI Tab Grouper Debug] callAIService - Could not read text from error response body for Gemini', e);
                }
                console.error(`[AI Tab Grouper Debug] callAIService - HTTP error ${response.status} for Gemini. Body:`, errorBody);
                throw new Error(`HTTP error ${response.status} (Gemini). Body: ${errorBody.substring(0, 500)}`);
            }

            const responseText = await response.text(); // Get raw text first
            let parsedResponseData;
            let suggestionsData;

            try {
                parsedResponseData = JSON.parse(responseText);

                if (!parsedResponseData.candidates || !parsedResponseData.candidates.length > 0 ||
                    !parsedResponseData.candidates[0].content || !parsedResponseData.candidates[0].content.parts ||
                    !parsedResponseData.candidates[0].content.parts.length > 0) {
                    console.error('[AI Tab Grouper Debug] callAIService - Invalid responseData structure from Gemini. Full parsedResponseData:', parsedResponseData, 'Raw responseText:', responseText);
                    throw new Error('AI Service returned invalid response structure from Gemini (missing candidates/content/parts)');
                }

                let aiResponseTextFromCandidates = parsedResponseData.candidates[0].content.parts[0].text;

                if (!aiResponseTextFromCandidates) {
                    console.error('[AI Tab Grouper Debug] callAIService - Gemini parsedResponseData.candidates did not contain expected text part. Full parsedResponseData:', parsedResponseData, 'Raw responseText:', responseText);
                    throw new Error("Gemini parsedResponseData.candidates did not contain expected text content.");
                }

                if (aiResponseTextFromCandidates.startsWith('```json') && aiResponseTextFromCandidates.endsWith('```')) {
                    aiResponseTextFromCandidates = aiResponseTextFromCandidates.substring(7, aiResponseTextFromCandidates.length - 3).trim();
                }

                suggestionsData = JSON.parse(aiResponseTextFromCandidates);
                return validateGroupingSuggestions(suggestionsData);

            } catch (e) {
                console.error(`[AI Tab Grouper Debug] callAIService - Error parsing JSON or invalid structure for Gemini. Error: ${e.message}. Raw responseText:`, responseText);
                throw new Error(`AI Service response error (Gemini): ${e.message}. Raw response: ${responseText.substring(0, 500)}`);
            }

        } else if (aiProvider === "OpenRouter") {
            apiUrl = "https://openrouter.ai/api/v1/chat/completions";
            headers = {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            };
            body = JSON.stringify({
                model: modelName,
                messages: [
                    { role: "user", content: promptContent }
                ]
            });

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: headers,
                body: body
            });

            if (!response.ok) {
                const errorDetail = await response.json();
                throw new Error(`OpenRouter API error: ${response.status} - ${errorDetail.message || response.statusText}`);
            }

            responseData = await response.json();
            let aiResponseText = responseData.choices[0]?.message?.content;
            if (!aiResponseText) {
                throw new Error("OpenRouter response did not contain expected text content.");
            }
            // Attempt to parse JSON, handling potential markdown code blocks
            if (aiResponseText.startsWith('```json') && aiResponseText.endsWith('```')) {
                aiResponseText = aiResponseText.substring(7, aiResponseText.length - 3).trim();
            }
            return validateGroupingSuggestions(JSON.parse(aiResponseText));

        } else {
            throw new Error("Unsupported AI provider.");
        }
    } catch (error) {
        console.error("Error in callAIService:", error);
        throw new Error("AI Service call failed: " + error.message);
    }
}

/**
 * Merges suggestions from multiple AI chunks, consolidating groups and handling ungrouped tabs.
 * @param {Array<Object>} allChunkSuggestions - Array of suggestions from all successful chunks.
 * @param {Array<Object>} tabsFromFailedChunks - Array of tab objects that were not processed by AI.
 * @returns {Array<Object>} Final merged and consolidated suggestions.
 */
function mergeChunkSuggestions(allChunkSuggestions, tabsFromFailedChunks) {
    logDebug("Merging chunk suggestions...");
    const mergedGroups = new Map(); // Map to store groups by name
    const allProcessedTabIds = new Set(); // To track all tab IDs that have been assigned to a group

    // Process suggestions from successful chunks
    allChunkSuggestions.forEach(group => {
        if (!group || typeof group.name !== 'string' || !Array.isArray(group.tabIds)) {
            logWarnDebug("Invalid group format encountered during merge:", group);
            return; // Skip invalid groups
        }

        const groupName = group.name.trim();
        if (mergedGroups.has(groupName)) {
            // If group name exists, merge tabIds
            const existingGroup = mergedGroups.get(groupName);
            group.tabIds.forEach(tabId => {
                if (typeof tabId === 'number' && !existingGroup.tabIds.includes(tabId)) {
                    existingGroup.tabIds.push(tabId);
                    allProcessedTabIds.add(tabId);
                }
            });
        } else {
            // If group name is new, add it
            const newTabIds = group.tabIds.filter(tabId => typeof tabId === 'number');
            if (newTabIds.length > 0) {
                mergedGroups.set(groupName, { name: groupName, tabIds: newTabIds });
                newTabIds.forEach(tabId => allProcessedTabIds.add(tabId));
            }
        }
    });

    // Handle tabs from failed chunks or those not assigned by AI
    // These tabs should be added to a "Miscellaneous" group if they haven't been processed
    if (tabsFromFailedChunks && tabsFromFailedChunks.length > 0) {
        let miscellaneousGroup = mergedGroups.get("Miscellaneous");
        if (!miscellaneousGroup) {
            miscellaneousGroup = { name: "Miscellaneous", tabIds: [] };
            mergedGroups.set("Miscellaneous", miscellaneousGroup);
        }
        tabsFromFailedChunks.forEach(tab => {
            if (!allProcessedTabIds.has(tab.id)) {
                miscellaneousGroup.tabIds.push(tab.id);
                allProcessedTabIds.add(tab.id);
            }
        });
    }

    // Convert map back to array
    const finalSuggestions = Array.from(mergedGroups.values());
    logDebug("Merged suggestions result:", finalSuggestions);
    return finalSuggestions;
}

/**
 * Applies the grouping suggestions by creating tab groups and moving tabs.
 * @param {Array<Object>} suggestions - Array of group suggestions (e.g., [{name: "Group Name", tabIds: [1,2,3]}]).
 * @param {Array<Object>} allOriginalTabs - All tabs that were considered for grouping (for undo context).
 * @param {boolean} isDebugModeFromCaller - The debug mode state passed from the caller.
 * @returns {boolean} True if groups were applied, false otherwise.
 */
async function applyGroupingSuggestions(suggestions, allTabsInWindow, isDebugModeValue, tabsThatWereProcessedByAI) {
  // UNCONDITIONAL LOGS FOR CRITICAL DIAGNOSTICS:
  console.log('[AI Tab Grouper Debug - UNCONDITIONAL] applyGroupingSuggestions CALLED.');
  console.log('[AI Tab Grouper Debug - UNCONDITIONAL] typeof browser.tabGroups:', typeof browser.tabGroups);
  if (typeof browser !== 'undefined' && browser.tabGroups) {
    console.log('[AI Tab Grouper Debug - UNCONDITIONAL] typeof browser.tabGroups.create:', typeof browser.tabGroups.create);
    console.log('[AI Tab Grouper Debug - UNCONDITIONAL] browser.tabGroups object:', browser.tabGroups);
  } else if (typeof browser === 'undefined') {
    console.log('[AI Tab Grouper Debug - UNCONDITIONAL] browser object itself is undefined.');
  } else {
    console.log('[AI Tab Grouper Debug - UNCONDITIONAL] browser.tabGroups is undefined/null.');
  }

  if (isDebugModeValue) {
    // These logs can remain conditional
    console.log('[AI Tab Grouper Debug] applyGroupingSuggestions (conditional log). isDebugModeValue:', isDebugModeValue);
    console.log('[AI Tab Grouper Debug] Suggestions received:', suggestions);
    console.log('[AI Tab Grouper Debug] All tabs in window (for lookup):', allTabsInWindow);
    console.log('[AI Tab Grouper Debug] Tabs processed by AI:', tabsThatWereProcessedByAI);
  }
    // The original logDebug calls will still respect isDebugModeValue via the logDebug function itself.
    // We are only moving the direct console.logs for unconditional output.
    logDebug("Applying grouping suggestions:", suggestions);
    sendStatusUpdate("Applying groups...");

    if (!suggestions || suggestions.length === 0) {
        logDebug("No suggestions to apply.");
        return false;
    }

    // Store current state for undo
    lastGroupingState = {
        originalTabStates: allTabsInWindow.map(tab => ({
            id: tab.id,
            originalGroupId: tab.groupId || browser.tabs.TAB_ID_NONE,
            originalIndex: tab.index // Store original index to restore order
        })),
        createdGroupIds: [] // To store IDs of newly created groups
    };

    let groupsCreatedCount = 0;
    for (const group of suggestions) {
        if (!group.name || !Array.isArray(group.tabIds) || group.tabIds.length === 0) {
            logWarnDebug("Skipping invalid group suggestion:", group);
            continue;
        }

        try {
            // Create a new tab group
            // The comprehensive debug logging is now at the start of the function.

            let windowIdForGroup;
            // Ensure group.tabIds exists and is not empty, and allTabsInWindow is available
            if (group.tabIds && group.tabIds.length > 0 && allTabsInWindow && allTabsInWindow.length > 0) {
                const firstTabIdInGroup = group.tabIds[0];
                const firstTabDetails = allTabsInWindow.find(tab => tab.id === firstTabIdInGroup);
                if (firstTabDetails && typeof firstTabDetails.windowId === 'number') {
                    windowIdForGroup = firstTabDetails.windowId;
                } else {
                    logWarnDebug(`Could not find windowId for tab ${firstTabIdInGroup} in allTabsInWindow, or windowId is invalid. Group will be created in default window.`);
                }
            } else {
                 logWarnDebug("group.tabIds is empty or allTabsInWindow is empty/undefined. Group will be created in default window.");
            }

            const validTabIds = group.tabIds.filter(id => typeof id === 'number' && Number.isInteger(id));
            if (validTabIds.length === 0) {
                logWarnDebug(`Skipping group "${group.name}" as it has no valid tab IDs after filtering.`);
                continue;
            }

            if (isDebugModeValue) { // Assuming isDebugModeValue is correctly passed and true
                console.log(`[AI Tab Grouper Debug] Attempting to create/group tabs for group: "${group.name}" with tabIds:`, validTabIds, "in windowId:", windowIdForGroup);
            }

            const newGroupId = await browser.tabs.group({
                tabIds: validTabIds, // Use the validated list of tab IDs
                createProperties: {
                    windowId: windowIdForGroup // Ensure windowIdForGroup is correctly defined in this scope
                }
            });

            // Add this new block to update the title
            if (group.name) {
                await browser.tabGroups.update(newGroupId, { title: group.name });
                if (isDebugModeValue) {
                    console.log(`[AI Tab Grouper Debug] Successfully updated title for group ID ${newGroupId} to "${group.name}".`);
                }
            }

            if (isDebugModeValue) {
                console.log(`[AI Tab Grouper Debug] Successfully grouped tabs for "${group.name}". New group ID (from tabs.group):`, newGroupId);
            }
            
            lastGroupingState.createdGroupIds.push(newGroupId); // Store the new group ID
            groupsCreatedCount++; // Ensure groupsCreatedCount is incremented
        } catch (error) {
            console.error(`Error creating group "${group.name}" or moving tabs:`, error);
            logDebug(`Error creating group "${group.name}" or moving tabs:`, error);
            sendStatusUpdate(`Error applying group "${group.name}": ${error.message}`, true);
            // Continue to next group even if one fails
        }
    }

    if (groupsCreatedCount > 0) {
        sendStatusUpdate(`Successfully created ${groupsCreatedCount} tab groups.`);
        return true;
    } else {
        sendStatusUpdate("No new tab groups were created.");
        return false;
    }
}

// --- Initialization ---
let isDebugMode = false; // Global state for debug mode, initialized here

async function initBackgroundScript() {
    console.log("[AI Tab Grouper Background] Initializing background script...");
    try {
        const debugResult = await browser.storage.sync.get('debugMode');
        isDebugMode = !!debugResult.debugMode;
        console.log("[AI Tab Grouper Background] Debug mode initialized to:", isDebugMode);
    } catch (error) {
        console.error("[AI Tab Grouper Background] Error initializing debug mode in background script:", error);
        isDebugMode = false; // Default to false on error
    }
}

initBackgroundScript();