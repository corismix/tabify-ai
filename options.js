// --- Standard Settings Elements ---
const form = document.getElementById('options-form');
const statusDiv = document.getElementById('status');
const aiProviderSelect = document.getElementById('aiProvider');
const modelNameContainer = document.getElementById('modelNameContainer');
const modelNameSelect = document.getElementById('modelName'); // Changed to select
const sensitivityInput = document.getElementById('groupingSensitivity');
const exclusionPatternsTextarea = document.getElementById('exclusionPatterns'); // <<< Changed from excludeInput
const disableNotificationsCheckbox = document.getElementById('disableNotifications');

// --- Developer Options Elements ---
const groupingPromptTextarea = document.getElementById('groupingPrompt');
const savePromptButton = document.getElementById('savePromptButton');
const promptStatusDiv = document.getElementById('promptStatus');

const debugModeCheckbox = document.getElementById('debugMode'); // <<< Add debug mode checkbox

// Default prompt is now fetched from background script if needed.

// Helper for debug logging in options page
function logDebug(...args) {
   // For options page, we can just log to console directly
   console.log("[AI Tab Grouper Options Debug]", ...args);
}

// --- Functions ---

// Function to handle visibility of the model name input and fetch models
async function updateModelNameVisibility(initialModelId = null) { // Added initialModelId parameter
    const selectedProvider = aiProviderSelect.value;
    if (selectedProvider === 'Gemini' || selectedProvider === 'OpenRouter') {
        modelNameContainer.style.display = 'block';
        await fetchAndPopulateModels(selectedProvider, initialModelId); // Pass initialModelId
    } else {
        modelNameContainer.style.display = 'none';
        // Clear options if no provider or unsupported provider is selected
        modelNameSelect.innerHTML = '<option value="">-- Select Model --</option>';
    }
}

// Function to fetch models from background script and populate the dropdown
async function fetchAndPopulateModels(provider, selectedModelId = null) { // Added selectedModelId parameter
    modelNameSelect.innerHTML = '<option value="">Loading Models...</option>'; // Show loading state
    modelNameSelect.disabled = true; // Disable during loading

    try {
        logDebug(`Sending message to background to fetch models for provider: ${provider}`);
        const response = await browser.runtime.sendMessage({
            action: "fetchModels", // Changed 'type' to 'action'
            payload: { provider: provider }
        });
        logDebug("Received response from background script:", response);

        if (response && response.models) {
            modelNameSelect.innerHTML = '<option value="">-- Select Model --</option>'; // Clear loading state
            response.models.forEach(model => {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.name;
                modelNameSelect.appendChild(option);
            });
            // Set the previously selected model if available
            if (selectedModelId) {
                modelNameSelect.value = selectedModelId;
            }
        } else if (response && response.error) {
            modelNameSelect.innerHTML = `<option value="">Error: ${response.error}</option>`;
            console.error("Error fetching models:", response.error);
        } else {
            modelNameSelect.innerHTML = '<option value="">No Models Found</option>';
        }
    } catch (error) {
        modelNameSelect.innerHTML = `<option value="">Error: ${error.message}</option>`;
        console.error("Error communicating with background script to fetch models:", error);
    } finally {
        modelNameSelect.disabled = false; // Re-enable after loading/error
    }
}

// Load saved settings when the options page opens
async function loadOptions() { // Make function async
    // Use browser.storage.sync for browser extensions
    try {
        const result = await browser.storage.sync.get([
            'apiKey',
            'aiProvider',
            'modelName', // Now we need to load this to pass to updateModelNameVisibility
            'groupingPrompt', // Load the grouping prompt
            'debugMode', // <<< Load debug mode setting
            'groupingSensitivity', // <<< Load sensitivity
            'exclusionPatterns', // <<< Load new regex patterns setting
            'disableNotifications'
        ]);

        document.getElementById('apiKey').value = result.apiKey || '';
        aiProviderSelect.value = result.aiProvider || '';
        // After models are fetched and populated, set the saved model
        // This will be handled by updateModelNameVisibility which is now called after loading
        // modelNameSelect.value = result.modelName || ''; // This line is no longer needed here

        // Set the grouping prompt textarea
        if (result.groupingPrompt) {
            groupingPromptTextarea.value = result.groupingPrompt;
        } else {
            // Prompt not found in storage, request default from background
            console.log("No custom prompt found, requesting default from background...");
            try {
                const response = await browser.runtime.sendMessage({ action: "getDefaultPrompt" });
                if (response && typeof response.prompt === 'string') { // More specific check for string type
                    groupingPromptTextarea.value = response.prompt;
                    console.log("Default prompt loaded from background script.");
                } else {
                    // Log the type and value of response for better debugging
                    console.error(`Received invalid response when fetching default prompt. Type: ${typeof response}, Value:`, response);
                    promptStatusDiv.textContent = 'Error loading default prompt (invalid response).';
                    // Optionally set a fallback or leave it empty
                    // groupingPromptTextarea.value = "Error: Could not load default prompt.";
                }
            } catch (error) {
                console.error("Error requesting default prompt from background script:", error);
                promptStatusDiv.textContent = `Error loading default prompt: ${error.message}`;
                // Optionally set a fallback or leave it empty
                // groupingPromptTextarea.value = "Error: Could not load default prompt.";
            }
        }

        // Set the debug mode checkbox state
        debugModeCheckbox.checked = !!result.debugMode; // <<< Set checkbox state (default false if undefined)
        // Set sensitivity and exclude domains, providing defaults
        sensitivityInput.value = result.groupingSensitivity ?? 5;
        // Load exclusion patterns into textarea, joining with newline
        exclusionPatternsTextarea.value = (result.exclusionPatterns || []).join('\n'); // <<< Load patterns
        // Set notification checkbox state
        disableNotificationsCheckbox.checked = !!result.disableNotifications;

        // Normalize modelName before passing to updateModelNameVisibility
        let normalizedLoadedModelName = result.modelName;
        const loadedProvider = aiProviderSelect.value; // This is already set from result.aiProvider

        if (normalizedLoadedModelName) {
            if (normalizedLoadedModelName.startsWith("models/models/")) {
                normalizedLoadedModelName = normalizedLoadedModelName.substring("models/".length);
                console.log(`[AI Tab Grouper Options Debug] Normalized loaded modelName (stripped double 'models/'): ${normalizedLoadedModelName}`);
            }
            if (loadedProvider === 'Gemini' && !normalizedLoadedModelName.startsWith("models/")) {
                normalizedLoadedModelName = `models/${normalizedLoadedModelName}`;
                console.log(`[AI Tab Grouper Options Debug] Normalized loaded modelName (added 'models/' for Gemini): ${normalizedLoadedModelName}`);
            }
        }
        // Update visibility based on loaded provider and fetch models, using the normalized model name
        await updateModelNameVisibility(normalizedLoadedModelName); // Pass normalized model name

    } catch (error) {
        console.error("Error loading options:", error);
        statusDiv.textContent = 'Error loading settings.';
        promptStatusDiv.textContent = 'Error loading prompt.'; // Also indicate prompt loading error
    }
}

// Save general settings when the main form is submitted
form.addEventListener('submit', (event) => {
    event.preventDefault();
    const apiKey = document.getElementById('apiKey').value;
    const aiProvider = aiProviderSelect.value; // This will be providerToSave
    let modelToSave = modelNameSelect.value; // Get value from select, will be normalized
    const providerToSave = aiProvider; // Use the already fetched aiProvider value

    if (modelToSave) {
        if (modelToSave.startsWith("models/models/")) {
            modelToSave = modelToSave.substring("models/".length);
            console.log(`[AI Tab Grouper Options Debug] Normalizing modelName for save (stripped double 'models/'): ${modelToSave}`);
        }
        if (providerToSave === 'Gemini' && !modelToSave.startsWith("models/")) {
            modelToSave = `models/${modelToSave}`;
            console.log(`[AI Tab Grouper Options Debug] Normalizing modelName for save (added 'models/' for Gemini): ${modelToSave}`);
        }
    }

    const isDebugEnabled = debugModeCheckbox.checked; // <<< Get debug mode state
    // Get and clamp sensitivity value
    let sensitivity = parseInt(sensitivityInput.value, 10);
    if (isNaN(sensitivity) || sensitivity < 1) {
        sensitivity = 1; // Clamp to min
    } else if (sensitivity > 10) {
        sensitivity = 10; // Clamp to max
    }
    // Update the input field to show the clamped value
    sensitivityInput.value = sensitivity;

    // Get exclusion patterns: split by newline, trim, filter empty, validate regex
    const patternLines = exclusionPatternsTextarea.value
                                        .split('\n')
                                        .map(line => line.trim())
                                        .filter(line => line.length > 0);

    let invalidPatternFound = false;
    const validPatterns = [];
    for (const line of patternLines) {
        try {
            new RegExp(line); // Try to compile the regex
            validPatterns.push(line); // If valid, add to the list
        } catch (e) {
            console.error(`Invalid Regex Pattern: "${line}" - Error: ${e.message}`);
            invalidPatternFound = true;
            break; // Stop validation on first error
        }
    }

    if (invalidPatternFound) {
        statusDiv.textContent = 'Error: Invalid Regular Expression pattern detected. Please correct and save again.';
        statusDiv.style.color = 'red';
        setTimeout(() => { statusDiv.textContent = ''; statusDiv.style.color = ''; }, 5000);
        return; // Prevent saving if any pattern is invalid
    }

    // Get notification state.
    const areNotificationsDisabled = disableNotificationsCheckbox.checked;

    // Use browser.storage.sync
    console.log(`[AI Tab Grouper Options Debug] Saving modelName: '${modelToSave}'`); // Log potentially normalized modelName before saving
    browser.storage.sync.set({
        apiKey: apiKey,
        aiProvider: aiProvider,
        modelName: modelToSave, // Use the normalized value
        debugMode: isDebugEnabled, // <<< Save debug mode state
        groupingSensitivity: sensitivity, // <<< Save sensitivity
        // excludeDomains: excludeDomains, // <<< Removed old setting
        exclusionPatterns: validPatterns, // <<< Save validated regex patterns array
        disableNotifications: areNotificationsDisabled
    }).then(() => {
        // Update textarea with potentially cleaned/validated patterns (though validation stops saving on error now)
        exclusionPatternsTextarea.value = validPatterns.join('\n');
        statusDiv.textContent = 'Settings saved successfully!';
        setTimeout(() => { statusDiv.textContent = ''; }, 3000);
    }).catch(error => {
        console.error("Error saving options:", error);
        statusDiv.textContent = 'Error saving settings.';
    });
});

// Save the grouping prompt when the dedicated button is clicked
savePromptButton.addEventListener('click', () => {
    const newPrompt = groupingPromptTextarea.value;
    if (!newPrompt.trim()) {
        promptStatusDiv.textContent = 'Error: Prompt cannot be empty.';
        promptStatusDiv.style.color = 'red';
        setTimeout(() => { promptStatusDiv.textContent = ''; promptStatusDiv.style.color = ''; }, 3000);
        return;
    }

    // Use browser.storage.sync
    browser.storage.sync.set({
        groupingPrompt: newPrompt
    }).then(() => {
        promptStatusDiv.textContent = 'Prompt saved successfully!';
        promptStatusDiv.style.color = 'green'; // Indicate success
        setTimeout(() => { promptStatusDiv.textContent = ''; promptStatusDiv.style.color = ''; }, 3000);
    }).catch(error => {
        console.error("Error saving prompt:", error);
        promptStatusDiv.textContent = 'Error saving prompt.';
        promptStatusDiv.style.color = 'red'; // Indicate error
        setTimeout(() => { promptStatusDiv.textContent = ''; promptStatusDiv.style.color = ''; }, 3000);
    });
});


// --- Event Listeners & Initial Load ---

// Add event listener for AI Provider dropdown change
aiProviderSelect.addEventListener('change', updateModelNameVisibility);

// Initial load of all options
document.addEventListener('DOMContentLoaded', loadOptions);
