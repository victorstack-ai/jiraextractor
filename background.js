// Background service worker for handling downloads
const MAX_CHUNK_SIZE = 64 * 1024; // Keep streamed messages well under Chrome's message size limit

// Set up declarativeNetRequest rules to strip Authorization header from media domains
// This prevents CORS Preflight failures on S3 signed URLs which don't need auth but reject complex requests
chrome.runtime.onInstalled.addListener(() => {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1], // Clear any existing rule with this ID
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Authorization', operation: 'remove' }
          ]
        },
        condition: {
          urlFilter: 'media.atlassian.com', // Substring match to catch api.media.atlassian.com, etc.
          resourceTypes: ['xmlhttprequest', 'other']
        }
      }
    ]
  }, () => {
    if (chrome.runtime.lastError) {
      console.error('Failed to update dynamic rules:', chrome.runtime.lastError);
    } else {
      console.log('Dynamic rules updated: Authorization header will be stripped for *media.atlassian.com*');
    }
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Background received message:', request.action);

  // Handle API credential testing
  if (request.action === 'testApiCredentials') {
    fetch(request.url, {
      headers: {
        'Authorization': request.authHeader,
        'Accept': 'application/json'
      }
    })
      .then(response => {
        if (!response.ok) {
          return response.text().then(text => {
            throw new Error(`API returned ${response.status}: ${text.substring(0, 100)}`);
          });
        }
        return response.json();
      })
      .then(data => {
        sendResponse({ success: true, data: data });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'downloadFile') {
    chrome.downloads.download({
      url: request.url,
      filename: request.filename,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId: downloadId });
      }
    });
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'downloadFileAsBlob') {
    // For files we need to get as blob for ZIP, we'll fetch in background
    const fetchOptions = {
      mode: 'cors'
    };

    if (request.headers) {
      fetchOptions.headers = request.headers;
      console.log(`Downloading blob with custom headers from: ${request.url}`);
    } else {
      fetchOptions.credentials = 'include';
      console.log(`Downloading blob with session credentials from: ${request.url}`);
    }

    fetch(request.url, fetchOptions)
      .then(response => {
        if (!response.ok) {
          console.error(`Download failed: ${response.status} ${response.statusText}`);
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response.blob();
      })
      .then(blob => {
        console.log(`Download successful. Blob size: ${blob.size}, type: ${blob.type}`);
        // Convert blob to base64 to send back
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64data = reader.result.split(',')[1];
          sendResponse({
            success: true,
            blob: base64data,
            type: blob.type,
            size: blob.size
          });
        };
        reader.onerror = () => {
          sendResponse({ success: false, error: 'Failed to read blob' });
        };
        reader.readAsDataURL(blob);
      })
      .catch(error => {
        console.error('Download blob error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep the message channel open for async response
  }
});

// Stream large downloads back to the content script in chunks to avoid hitting Chrome's message size limit
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'downloadFileStream') return;

  port.onMessage.addListener(async (message) => {
    if (message.action !== 'downloadFileStream' || !message.url) {
      return;
    }

    const { url, requestId } = message;
    const controller = new AbortController();
    let disconnected = false;

    const disconnectHandler = () => {
      disconnected = true;
      controller.abort();
    };

    port.onDisconnect.addListener(disconnectHandler);

    try {
      // Use browser session cookies for downloads (most reliable for Jira)
      // Background script can handle cross-origin redirects better
      // Try with include credentials first
      let response = await fetch(url, {
        credentials: 'include', // Use browser session cookies
        mode: 'cors',
        redirect: 'follow', // Follow redirects (important for Jira media URLs)
        signal: controller.signal
      });

      // If that fails with CORS, try without credentials (some CDN endpoints allow this)
      if (!response.ok && (response.status === 403 || response.type === 'opaque')) {
        console.log('Retrying download without credentials');
        response = await fetch(url, {
          mode: 'cors',
          redirect: 'follow',
          signal: controller.signal
        });
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const reader = response.body?.getReader();

      if (!reader) {
        throw new Error('Readable stream not available for download');
      }

      while (!disconnected) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        const baseBuffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);

        if (baseBuffer.byteLength > MAX_CHUNK_SIZE) {
          for (let offset = 0; offset < baseBuffer.byteLength; offset += MAX_CHUNK_SIZE) {
            if (disconnected) break;
            const slice = baseBuffer.slice(offset, offset + MAX_CHUNK_SIZE);
            port.postMessage({ type: 'chunk', requestId, chunk: slice, done: false }, [slice]);
          }
        } else {
          port.postMessage({ type: 'chunk', requestId, chunk: baseBuffer, done: false }, [baseBuffer]);
        }
      }

      if (!disconnected) {
        port.postMessage({ type: 'complete', requestId, contentType });
      }
    } catch (error) {
      if (!disconnected) {
        port.postMessage({ type: 'error', requestId, error: error.message || 'Download failed' });
      }
    } finally {
      port.onDisconnect.removeListener(disconnectHandler);
    }
  });
});
