document.addEventListener('DOMContentLoaded', async () => {
  const extractBtn = document.getElementById('extractBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const testCredentialsBtn = document.getElementById('testCredentialsBtn');
  const cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
  const status = document.getElementById('status');
  const mainView = document.getElementById('mainView');
  const settingsView = document.getElementById('settingsView');
  const emailInput = document.getElementById('emailInput');
  const tokenInput = document.getElementById('tokenInput');
  const baseUrlInput = document.getElementById('baseUrlInput');
  const settingsStatus = document.getElementById('settingsStatus');

  // Debug: Check if all elements are found
  console.log('Elements found:', {
    settingsBtn: !!settingsBtn,
    settingsView: !!settingsView,
    mainView: !!mainView,
    settingsStatus: !!settingsStatus,
    baseUrlInput: !!baseUrlInput
  });

  // Load saved settings
  const loadSettings = async () => {
    const result = await chrome.storage.sync.get(['jiraEmail', 'jiraApiToken', 'jiraBaseUrl']);
    if (result.jiraEmail) {
      emailInput.value = result.jiraEmail;
    }
    if (result.jiraApiToken) {
      tokenInput.value = result.jiraApiToken;
    }
    if (result.jiraBaseUrl) {
      baseUrlInput.value = result.jiraBaseUrl;
    }
  };

  // Show settings view
  const showSettings = () => {
    console.log('showSettings called');
    if (!mainView || !settingsView) {
      console.error('mainView or settingsView not found');
      return;
    }
    mainView.style.display = 'none';
    settingsView.style.display = 'block';
    loadSettings();

    // Attempt to auto-detect Base URL from current tab if empty or just to be helpful
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.url && (tab.url.includes('atlassian.net') || tab.url.includes('jira.com'))) {
        try {
          const urlObj = new URL(tab.url);
          const detectedBaseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
          // Only auto-fill if empty or if it matches the domain logic
          if (!baseUrlInput.value) {
            baseUrlInput.value = detectedBaseUrl;
          }
        } catch (e) {
          console.error('Error auto-detecting URL:', e);
        }
      }
    });
  };

  // Show main view
  const showMain = () => {
    settingsView.style.display = 'none';
    mainView.style.display = 'block';
  };

  // Save settings
  const saveSettings = async () => {
    const email = emailInput.value.trim();
    const token = tokenInput.value.trim();
    const baseUrl = baseUrlInput.value.trim().replace(/\/$/, ''); // Remove trailing slash

    if (!email || !token || !baseUrl) {
      status.className = 'status error';
      status.textContent = 'Please enter email, API token, and Base URL';
      return;
    }

    try {
      await chrome.storage.sync.set({
        jiraEmail: email,
        jiraApiToken: token,
        jiraBaseUrl: baseUrl
      });
      status.className = 'status success';
      status.textContent = 'Settings saved successfully!';
      setTimeout(() => {
        showMain();
      }, 1000);
    } catch (error) {
      status.className = 'status error';
      status.textContent = 'Failed to save settings: ' + error.message;
    }
  };

  // Test credentials using background script to avoid CORS
  const testCredentials = () => {
    console.log('Test button clicked'); // Debug log
    const email = emailInput.value.trim();
    const token = tokenInput.value.trim();
    let baseUrl = baseUrlInput.value.trim().replace(/\/$/, '');

    // Use settingsStatus if in settings view, otherwise use main status
    const statusDiv = (settingsView && settingsView.style.display !== 'none' && settingsStatus) ? settingsStatus : status;

    if (!email || !token) {
      statusDiv.className = 'status error';
      if (!email || !token) {
        statusDiv.textContent = 'Please enter both email and API token';
      }
      statusDiv.style.display = 'block';
      return;
    }

    statusDiv.className = 'status info';
    statusDiv.textContent = 'Testing credentials...';
    statusDiv.style.display = 'block';

    // Helper to perform the actual test with a given Base URL
    const performTest = (urlToTest) => {
      // Test with a simple API call via background script
      const credentials = `${email}:${token}`;
      const authHeader = `Basic ${btoa(credentials)}`;

      // Try to fetch server info which is a lightweight endpoint
      const testEndpoint = `${urlToTest}/rest/api/3/myself`;

      // Use background script to make the API call (avoids CORS)
      console.log('Sending test message to background script', { testEndpoint, hasAuth: !!authHeader });
      chrome.runtime.sendMessage({
        action: 'testApiCredentials',
        url: testEndpoint,
        authHeader: authHeader
      }, (response) => {
        console.log('Received response from background:', response);
        if (chrome.runtime.lastError) {
          console.error('Chrome runtime error:', chrome.runtime.lastError);
          statusDiv.className = 'status error';
          statusDiv.textContent = `✗ Test failed: ${chrome.runtime.lastError.message}`;
          statusDiv.style.display = 'block';
          return;
        }

        if (!response) {
          statusDiv.className = 'status error';
          statusDiv.textContent = `✗ Test failed: No response from background script`;
          statusDiv.style.display = 'block';
          return;
        }

        if (response.error || !response.success) {
          console.error('Response error:', response.error);
          statusDiv.className = 'status error';
          statusDiv.textContent = `✗ Test failed: ${response.error || 'Check Base URL and Credentials'}`;
          statusDiv.style.display = 'block';
          return;
        }

        statusDiv.className = 'status success';
        statusDiv.style.display = 'block';
        if (response.data && response.data.displayName) {
          statusDiv.textContent = `✓ Credentials valid! Hello, ${response.data.displayName}`;
        } else {
          statusDiv.textContent = `✓ Credentials valid!`;
        }
      });
    };

    // If we have a Base URL input, use it
    if (baseUrl) {
      performTest(baseUrl);
      return;
    }

    // Fallback: Try to get it from current tab if input is empty
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      try {
        const tab = tabs[0];
        if (!tab || !tab.url || (!tab.url.includes('atlassian.net') && !tab.url.includes('jira.com'))) {
          statusDiv.className = 'status error';
          statusDiv.textContent = 'Please enter a Base URL or navigate to a Jira page';
          statusDiv.style.display = 'block';
          return;
        }

        // Extract base URL
        const urlObj = new URL(tab.url);
        const extractedBaseUrl = `${urlObj.protocol}//${urlObj.hostname}`;

        // Auto-fill input for convenience
        baseUrlInput.value = extractedBaseUrl;

        performTest(extractedBaseUrl);

      } catch (error) {
        console.error('Test credentials error:', error);
        statusDiv.className = 'status error';
        statusDiv.textContent = `✗ Process failed: ${error.message || 'Unknown error'}`;
        statusDiv.style.display = 'block';
      }
    });
  };

  // Event listeners
  if (settingsBtn) {
    settingsBtn.addEventListener('click', (e) => {
      console.log('Settings button clicked');
      e.preventDefault();
      showSettings();
    });
  } else {
    console.error('Settings button not found!');
  }

  if (cancelSettingsBtn) {
    cancelSettingsBtn.addEventListener('click', showMain);
  } else {
    console.error('Cancel button not found!');
  }

  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', saveSettings);
  } else {
    console.error('Save button not found!');
  }

  // Test button event listener with debug logging
  if (testCredentialsBtn) {
    console.log('Test button found, attaching event listener');
    testCredentialsBtn.addEventListener('click', (e) => {
      console.log('Test button clicked event fired');
      e.preventDefault();
      testCredentials();
    });
  } else {
    console.error('Test button not found!');
  }

  extractBtn.addEventListener('click', async () => {
    extractBtn.disabled = true;
    status.className = 'status info';
    status.textContent = 'Extracting ticket data...';

    try {
      // Get the active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // Check if we're on a Jira page
      if (!tab.url || (!tab.url.includes('atlassian.net') && !tab.url.includes('jira.com'))) {
        throw new Error('Please navigate to a Jira ticket page');
      }

      // Inject JSZip first, then extractor
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['jszip.min.js']
        });

        // Wait a moment for JSZip to load
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        throw new Error('Failed to load JSZip library');
      }

      // Inject and execute the extraction script
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['extractor.js']
      });

      const frameResults = results.map(r => r && r.result).filter(Boolean);
      const mainResult = frameResults.find(r => r.frameRole === 'main') || frameResults.find(r => r.success || r.error);
      const result = mainResult || frameResults[0];

      if (result) {

        if (result.error) {
          throw new Error(result.error);
        }

        status.className = 'status success';
        status.textContent = 'Ticket extracted successfully!';

        // Download will be triggered by the content script
        setTimeout(() => {
          window.close();
        }, 1500);
      } else {
        throw new Error('Failed to extract ticket data');
      }
    } catch (error) {
      status.className = 'status error';
      status.textContent = error.message || 'Failed to extract ticket';
      extractBtn.disabled = false;
    }
  });
});
