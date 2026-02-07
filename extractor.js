// Main extraction logic
(async function () {
  'use strict';

  const isTopFrame = window.top === window;
  const isChecklistFrame = /issue-checklist/i.test(window.location.href);

  // Load JSZip library (only needed in the top frame)
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(src);
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // Utility function to clean HTML and extract text, preserving strikethrough
  function cleanHtml(html) {
    if (!html) return '';

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;

    // Remove script and style elements
    const scripts = tempDiv.querySelectorAll('script, style');
    scripts.forEach(el => el.remove());

    // Process strikethrough elements - wrap them with a special marker
    const strikethroughSelectors = [
      '[style*="line-through"]',
      '[style*="text-decoration: line-through"]',
      's',
      'strike',
      'del'
    ];

    strikethroughSelectors.forEach(selector => {
      const elements = tempDiv.querySelectorAll(selector);
      elements.forEach(el => {
        const text = el.textContent || el.innerText || '';
        if (text.trim()) {
          // Create a span with a data attribute to mark as strikethrough
          const marker = document.createElement('span');
          marker.setAttribute('data-strikethrough', 'true');
          marker.textContent = text.trim();
          el.replaceWith(marker);
        }
      });
    });

    // Now extract text, converting strikethrough markers to <s> tags
    function extractTextWithStrikethrough(node) {
      let result = '';

      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          result += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.getAttribute('data-strikethrough') === 'true') {
            result += `<s>${child.textContent}</s>`;
          } else {
            result += extractTextWithStrikethrough(child);
          }
        }
      }

      return result;
    }

    let text = extractTextWithStrikethrough(tempDiv);

    // Clean up whitespace but preserve <s> tags
    // Replace multiple spaces with single space, but keep <s> tags intact
    text = text.replace(/\s+/g, ' ').trim();

    return text;
  }

  // Extract text from Atlassian renderer
  function extractFromRenderer(element) {
    if (!element) return '';

    const renderer = element.querySelector('.ak-renderer-document, .ak-renderer-wrapper');
    if (renderer) {
      return cleanHtml(renderer.innerHTML);
    }

    return cleanHtml(element.innerHTML);
  }

  // Extract ticket title
  function extractTitle() {
    // Try multiple selectors for title
    const selectors = [
      'h1[data-testid="issue.views.issue-base.foundation.summary.heading"]',
      'h1',
      '[data-testid="issue.views.issue-base.foundation.summary.heading"]',
      '.issue-header-summary h1',
      'h1.issue-header-summary'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        const text = element.textContent || element.innerText || '';
        if (text.trim()) return text.trim();
      }
    }

    // Fallback: look for any h1
    const h1 = document.querySelector('h1');
    return h1 ? (h1.textContent || h1.innerText || '').trim() : 'Untitled';
  }

  // Extract description
  function extractDescription() {
    const selectors = [
      '[data-testid="issue.views.field.rich-text.description"]',
      '[data-editor-container-id="issue-description-editor"]',
      '.issue-body-content .description',
      '[data-testid="issue-description"]'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        return extractFromRenderer(element);
      }
    }

    return '';
  }

  // Find the label/heading associated with a rich text field
  function findFieldLabel(fieldKey, fieldElement) {
    const labelSelectors = [
      `[data-testid="issue.views.issue-base.common.${fieldKey}.label"]`,
      `[data-testid$="${fieldKey}.label"]`,
      `[data-testid*="${fieldKey}.label"]`
    ];

    for (const selector of labelSelectors) {
      const labelEl = document.querySelector(selector);
      if (labelEl) {
        const text = labelEl.textContent || labelEl.innerText || '';
        if (text.trim()) return text.trim();
      }
    }

    // Fallback: walk up the DOM and look for a nearby heading
    let current = fieldElement;
    let depth = 0;
    while (current && depth < 4) {
      const heading = current.querySelector?.('h2, h3');
      if (heading && heading.textContent?.trim()) {
        return heading.textContent.trim();
      }

      const prevHeading = current.previousElementSibling?.querySelector?.('h2, h3');
      if (prevHeading && prevHeading.textContent?.trim()) {
        return prevHeading.textContent.trim();
      }

      current = current.parentElement;
      depth++;
    }

    return null;
  }

  // Extract all rich text custom fields (e.g., QA Bugs, QA Requirements)
  function extractRichTextFields() {
    const fields = [];
    const seenKeys = new Set();

    const fieldElements = document.querySelectorAll('[data-testid^="issue.views.field.rich-text."]');

    fieldElements.forEach(element => {
      const testId = element.getAttribute('data-testid') || '';
      const match = testId.match(/issue\\.views\\.field\\.rich-text\\.(.+)/);
      if (!match || !match[1]) return;

      const fieldKey = match[1];

      // Skip description (already captured separately)
      if (fieldKey === 'description') return;

      if (seenKeys.has(fieldKey)) return;

      const value = extractFromRenderer(element).trim();
      if (!value || value.toLowerCase() === 'none') return;

      const label = findFieldLabel(fieldKey, element) || fieldKey;

      fields.push({
        key: fieldKey,
        label: label,
        value: value
      });

      seenKeys.add(fieldKey);
    });

    return fields;
  }

  // Extract checklists/todo lists
  async function waitForChecklistElements(maxWaitMs = 4000, root = document) {
    const selectors = [
      '.todo-list',
      'ul.item-details',
      'li[class*="todo-item"]',
      'iframe[src*="checklist"]',
      'iframe[id*="checklist"]',
      '[role="checkbox"]',
      'input[type="checkbox"]'
    ];

    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (selectors.some(selector => root.querySelector(selector))) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return false;
  }

  function extractChecklistsFromRoot(root) {
    const context = root || document;
    const queryAll = selector => context.querySelectorAll(selector);
    const query = selector => context.querySelector(selector);
    const checklists = [];

    // Try multiple approaches to find checklists
    // First, try to find by issue-panel class
    let checklistPanels = queryAll('.issue-panel');

    // If not found, try broader search
    if (checklistPanels.length === 0) {
      checklistPanels = queryAll('[class*="checklist"], [data-testid*="checklist"], .panel-position-left, .panel-position-right');
    }

    // Also try finding todo lists directly
    const todoLists = queryAll('.todo-list, ul.item-details, ul[class*="todo-list"], ul[class*="item-details"]');

    // If we found todo lists but no panels, create virtual panels
    if (todoLists.length > 0 && checklistPanels.length === 0) {
      checklistPanels = Array.from(todoLists).map((list, index) => ({ todoList: list, index: index }));
    }

    // If no panels found, try to find todo items directly anywhere on the page
    if (checklistPanels.length === 0 && todoLists.length === 0) {
      const directTodoItems = queryAll('li[class*="todo-item"], li[data-checklist-id], li[data-id][class*="item"]');
      if (directTodoItems.length > 0) {
        // Create a virtual checklist from direct items
        const items = [];
        directTodoItems.forEach((item, itemIndex) => {
          try {
            const itemId = item.getAttribute('data-id') || item.getAttribute('data-checklist-id') || `item-${itemIndex + 1}`;
            const checkbox = item.querySelector('input[type="checkbox"]');
            const isChecked = checkbox ? (checkbox.checked || checkbox.getAttribute('aria-checked') === 'true') : false;

            let itemText = '';
            const textElement = item.querySelector('.item-content, .todo-item-token-text, [class*="item-content"], [class*="token-text"]');
            if (textElement) {
              itemText = textElement.textContent?.trim();
            } else {
              const clone = item.cloneNode(true);
              clone.querySelectorAll('input, button, svg, [class*="action"], [class*="hover"]').forEach(el => el.remove());
              itemText = clone.textContent?.trim();
            }

            if (itemText) {
              items.push({
                id: itemId,
                text: itemText,
                checked: isChecked,
                checkedBy: null,
                checkedAt: null
              });
            }
          } catch (error) {
            console.warn('Error extracting direct todo item:', error);
          }
        });

        if (items.length > 0) {
          // Try to find progress badge anywhere
          const progressBadge = query('[data-testid="completion-badge"]');
          let progress = null;
          if (progressBadge) {
            const progressText = progressBadge.textContent?.trim() || '';
            const progressMatch = progressText.match(/(\d+)\s*\/\s*(\d+)/);
            if (progressMatch) {
              progress = {
                completed: parseInt(progressMatch[1], 10),
                total: parseInt(progressMatch[2], 10),
                percentage: Math.round((parseInt(progressMatch[1], 10) / parseInt(progressMatch[2], 10)) * 100)
              };
            }
          }

          checklists.push({
            id: 1,
            title: 'Checklist',
            progress: progress,
            items: items
          });
        }
        return checklists;
      }
    }

    // Final fallback: build checklist from any checkbox-like elements in the context
    if (checklists.length === 0) {
      const checkboxNodes = Array.from(queryAll('input[type="checkbox"], [role="checkbox"]'));
      const seen = new Set();
      const items = [];

      checkboxNodes.forEach((checkbox, idx) => {
        try {
          const container = checkbox.closest('li, tr, div, section') || checkbox.parentElement;
          if (!container) return;

          // Prefer associated label text if available
          let text = '';
          const forId = checkbox.getAttribute('id');
          if (forId) {
            const label = context.querySelector(`label[for="${forId}"]`);
            if (label) {
              text = (label.textContent || '').trim();
            }
          }

          if (!text) {
            // Look for sibling text
            const labelSibling = checkbox.closest('label') || checkbox.parentElement;
            if (labelSibling) {
              const clone = labelSibling.cloneNode(true);
              clone.querySelectorAll('input, button, svg, [role="checkbox"], [class*="action"], [class*="hover"]').forEach(el => el.remove());
              text = (clone.textContent || '').trim();
            }
          }

          if (!text) {
            const clone = container.cloneNode(true);
            clone.querySelectorAll('input, button, svg, [role="checkbox"], [class*="action"], [class*="hover"]').forEach(el => el.remove());
            text = (clone.textContent || '').trim();
          }

          if (!text) return;

          const key = `${text}-${idx}`;
          if (seen.has(key)) return;
          seen.add(key);

          const isChecked = checkbox.checked || checkbox.getAttribute('aria-checked') === 'true' || checkbox.hasAttribute('checked');

          items.push({
            id: checkbox.getAttribute('data-id') || container.getAttribute('data-id') || `item-${idx + 1}`,
            text: text,
            checked: isChecked,
            checkedBy: null,
            checkedAt: null
          });
        } catch (error) {
          console.warn('Error extracting fallback checkbox item:', error);
        }
      });

      if (items.length > 0) {
        checklists.push({
          id: 1,
          title: 'Checklist',
          progress: null,
          items
        });
      }
    }

    // Process each panel or todo list
    Array.from(checklistPanels).forEach((panelOrList, panelIndex) => {
      try {
        let panel, todoList;

        // Handle both panel objects and DOM elements
        if (panelOrList.todoList) {
          // Virtual panel from todo list
          todoList = panelOrList.todoList;
          panel = todoList.closest('.issue-panel, [class*="panel"], section, div') || todoList.parentElement;
        } else {
          // Regular panel element
          panel = panelOrList;
          todoList = panel.querySelector('.todo-list, ul.item-details, ul[class*="todo-list"], ul[class*="item-details"]');
        }

        // If still no todo list, try to find it in the panel
        if (!todoList && panel) {
          todoList = panel.querySelector('.todo-list, ul.item-details, ul[class*="todo-list"], ul[class*="item-details"]');
        }

        // If we still don't have a todo list, skip
        if (!todoList) return;

        // Get checklist title/name (if available)
        let checklistTitle = null;
        if (panel) {
          checklistTitle = panel.querySelector('h2, h3, header h2, header h3, [class*="title"], [class*="heading"]')?.textContent?.trim();
        }
        if (!checklistTitle) {
          checklistTitle = `Checklist ${panelIndex + 1}`;
        }

        // Get progress info - try multiple locations
        let progressBadge = null;
        if (panel) {
          progressBadge = panel.querySelector('[data-testid="completion-badge"], [data-testid*="completion"], .completion-badge, .bar-progress-badge');
        }
        if (!progressBadge) {
          progressBadge = query('[data-testid="completion-badge"]');
        }

        let progress = null;
        if (progressBadge) {
          const progressText = progressBadge.textContent?.trim() || '';
          const progressMatch = progressText.match(/(\d+)\s*\/\s*(\d+)/);
          if (progressMatch) {
            progress = {
              completed: parseInt(progressMatch[1], 10),
              total: parseInt(progressMatch[2], 10),
              percentage: Math.round((parseInt(progressMatch[1], 10) / parseInt(progressMatch[2], 10)) * 100)
            };
          }
        }

        // Extract todo items - try multiple selectors
        const todoItems = todoList.querySelectorAll('.todo-item, li[class*="todo-item"], li[data-id], li[data-checklist-id]');
        const items = [];

        todoItems.forEach((item, itemIndex) => {
          try {
            const itemId = item.getAttribute('data-id') || item.getAttribute('data-checklist-id') || `item-${itemIndex + 1}`;

            // Get checkbox state - try multiple ways
            const checkbox = item.querySelector('input[type="checkbox"]');
            let isChecked = false;
            if (checkbox) {
              isChecked = checkbox.checked || checkbox.getAttribute('aria-checked') === 'true' || checkbox.hasAttribute('checked');
            }

            // Get item text - try multiple selectors
            let itemText = '';
            const textSelectors = [
              '.item-content',
              '.todo-item-text-container',
              '.todo-item-token-text',
              '[class*="item-content"]',
              '[class*="todo-item-text"]',
              '.item-content span',
              'span[class*="token-text"]'
            ];

            for (const selector of textSelectors) {
              const textElement = item.querySelector(selector);
              if (textElement) {
                itemText = textElement.textContent?.trim();
                if (itemText) break;
              }
            }

            // Fallback: get text from the item itself, removing UI elements
            if (!itemText) {
              const clone = item.cloneNode(true);
              clone.querySelectorAll('input, button, .hover-options, [class*="action"], [class*="hover"], svg, .visible-drag-handler').forEach(el => el.remove());
              itemText = clone.textContent?.trim();
            }

            // Get who checked/unchecked and when (from title attribute)
            const viewElement = item.querySelector('.view, [class*="view"]');
            const titleAttr = viewElement?.getAttribute('title') || item.getAttribute('title') || '';
            let checkedBy = null;
            let checkedAt = null;
            if (titleAttr) {
              const checkedMatch = titleAttr.match(/(Checked|Unchecked)\s+by\s+(.+?)\s+on\s+(.+)/i);
              if (checkedMatch) {
                checkedBy = checkedMatch[2]?.trim();
                checkedAt = checkedMatch[3]?.trim();
              }
            }

            if (itemText && itemText.length > 0) {
              items.push({
                id: itemId,
                text: itemText,
                checked: isChecked,
                checkedBy: checkedBy,
                checkedAt: checkedAt
              });
            }
          } catch (error) {
            console.warn('Error extracting checklist item:', error);
          }
        });

        if (items.length > 0) {
          checklists.push({
            id: panelIndex + 1,
            title: checklistTitle,
            progress: progress,
            items: items
          });
        }
      } catch (error) {
        console.warn('Error extracting checklist:', error);
      }
    });

    return checklists;
  }

  function setupChecklistFrameListener() {
    window.addEventListener('message', async event => {
      if (event.data && event.data.type === 'jira-extractor-request-checklists') {
        try {
          await waitForChecklistElements(5000, document);
          const data = extractChecklistsFromRoot(document);
          event.source?.postMessage({ type: 'jira-extractor-response-checklists', checklists: data }, event.origin);
        } catch (error) {
          console.warn('Failed to respond with checklist data:', error);
        }
      }
    });
  }

  async function requestChecklistsFromFrame(iframe, timeoutMs = 4000, retries = 3) {
    return new Promise(resolve => {
      let settled = false;
      let attempts = 0;
      let timer;

      function handler(event) {
        if (event.source === iframe.contentWindow && event.data && event.data.type === 'jira-extractor-response-checklists') {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            window.removeEventListener('message', handler);
            resolve(event.data.checklists || []);
          }
        }
      }

      window.addEventListener('message', handler);

      try {
        const send = () => {
          attempts += 1;
          if (attempts > retries) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              window.removeEventListener('message', handler);
              resolve([]);
            }
            return;
          }
          iframe.contentWindow?.postMessage({ type: 'jira-extractor-request-checklists' }, '*');
          timer = setTimeout(send, timeoutMs / Math.max(retries, 1));
        };
        send();
      } catch (error) {
        window.removeEventListener('message', handler);
        resolve([]);
      }
    });
  }

  async function extractChecklistsFromIframes() {
    const collected = [];
    const iframeCandidates = Array.from(document.querySelectorAll('iframe[src*="checklist"], iframe[id*="checklist"], iframe[name*="checklist"]'));

    // Wait for iframes to finish loading (best-effort, with timeout)
    await Promise.all(iframeCandidates.map(frame => new Promise(resolve => {
      if (frame.complete || frame.readyState === 'complete') return resolve();
      const timer = setTimeout(resolve, 2000);
      frame.addEventListener('load', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    })));

    // Try to ask the iframe itself for checklist data via postMessage (works even if cross-origin as long as our script runs inside)
    const messageResults = await Promise.all(iframeCandidates.map(frame => requestChecklistsFromFrame(frame)));
    messageResults.forEach(list => {
      if (Array.isArray(list) && list.length > 0) {
        collected.push(...list);
      }
    });
    if (collected.length > 0) {
      return collected;
    }

    // Try to read from same-origin iframe as a secondary fallback (no network fetch to avoid CORS noise)
    for (const frame of iframeCandidates) {
      try {
        if (frame.contentDocument) {
          const nested = extractChecklistsFromRoot(frame.contentDocument);
          if (nested.length > 0) {
            collected.push(...nested);
          }
        }
      } catch (error) {
        // Ignore cross-origin access
      }
    }

    return collected;
  }

  async function extractChecklists() {
    await waitForChecklistElements(6000, document);

    const inPageChecklists = extractChecklistsFromRoot(document);
    const iframeChecklists = await extractChecklistsFromIframes();

    const all = [...inPageChecklists, ...iframeChecklists];
    return all;
  }

  // If we're inside the checklist iframe (or any non-top frame), just expose checklist data and a listener
  if (!isTopFrame) {
    if (isChecklistFrame) {
      setupChecklistFrameListener();
      await waitForChecklistElements(5000, document);
      const frameChecklists = extractChecklistsFromRoot(document);
      return { frameRole: 'checklist-frame', checklists: frameChecklists };
    }
    return { frameRole: 'child-frame', checklists: [] };
  }

  // Wait for JSZip only in the top frame
  let retries = 0;
  while (typeof JSZip === 'undefined' && retries < 10) {
    await new Promise(resolve => setTimeout(resolve, 100));
    retries++;
  }

  if (typeof JSZip === 'undefined') {
    return { error: 'JSZip library not available. Please refresh the page and try again.', frameRole: 'main' };
  }

  // Extract attachments from comments
  function extractAttachmentsFromComments() {
    const attachments = [];
    const seenUrls = new Set();

    // Find all comments
    const commentElements = document.querySelectorAll('[data-testid^="comment-base-item"]');

    commentElements.forEach(commentEl => {
      try {
        // Look for attachment buttons or links in comments
        const attachmentButtons = commentEl.querySelectorAll('button[aria-label*="Download"], button[aria-label*="Open"]');
        const attachmentLinks = commentEl.querySelectorAll('a[href*="attachment"], a[href*="secure/attachment"]');

        // Also look for filmstrip wrappers in comments
        const wrappers = commentEl.querySelectorAll('[data-testid^="issue.views.issue-base.content.attachment.filmstrip-view.attachment-id"]');

        [...Array.from(attachmentButtons), ...Array.from(attachmentLinks), ...Array.from(wrappers)].forEach(el => {
          try {
            let url = null;
            let name = null;

            // If it's a wrapper, extract like we do in main extraction
            if (el.hasAttribute('data-testid') && el.getAttribute('data-testid').includes('attachment-id')) {
              const attachmentIdMatch = el.getAttribute('data-testid')?.match(/attachment-id\.(\d+)/);
              if (attachmentIdMatch) {
                const attachmentId = attachmentIdMatch[1];
                const mediaCard = el.querySelector('[data-test-media-name]');
                name = mediaCard?.getAttribute('data-test-media-name');
                url = `${window.location.origin}/secure/attachment/${attachmentId}/${encodeURIComponent(name || 'file')}`;
              }
            } else if (el.tagName === 'A') {
              // It's a link
              url = el.getAttribute('href');
              name = el.textContent?.trim() || el.getAttribute('title') || el.getAttribute('aria-label');
            } else if (el.tagName === 'BUTTON') {
              // It's a button - try to find associated link or construct URL from aria-label
              const ariaLabel = el.getAttribute('aria-label') || '';
              const match = ariaLabel.match(/(.+?)\s*[—–-]\s*(Download|Open)/i);
              if (match) {
                name = match[1].trim();
              }

              // Look for link in parent
              const link = el.closest('a[href]') || el.parentElement?.querySelector('a[href]');
              if (link) {
                url = link.getAttribute('href');
              }
            }

            if (url && name && !seenUrls.has(url) && !isUnnecessaryFile(url, name)) {
              // Make URL absolute
              if (!url.startsWith('http')) {
                url = new URL(url, window.location.origin).href;
              }

              seenUrls.add(url);
              attachments.push({
                id: attachments.length + 1,
                name: name,
                url: url
              });
            }
          } catch (error) {
            console.warn('Error extracting attachment from comment:', error);
          }
        });
      } catch (error) {
        console.warn('Error processing comment for attachments:', error);
      }
    });

    return attachments;
  }

  // Extract comments
  function extractComments() {
    const comments = [];

    // Find all comment containers using data-testid="comment-base-item-xxx" (primary method)
    const commentElements = Array.from(document.querySelectorAll('[data-testid^="comment-base-item"]'));

    // If no comments found with testid, try fallback selectors
    let fallbackElements = [];
    if (commentElements.length === 0) {
      const fallbackSelectors = [
        '[data-testid^="issue-comment-base"]',
        '.issue-comment',
        '.comment'
      ];

      for (const selector of fallbackSelectors) {
        fallbackElements = Array.from(document.querySelectorAll(selector));
        if (fallbackElements.length > 0) break;
      }
    }

    const allCommentElements = commentElements.length > 0 ? commentElements : fallbackElements;

    allCommentElements.forEach((commentEl, index) => {
      try {
        // Extract comment ID from data-testid if available
        let commentId = index + 1;
        const testId = commentEl.getAttribute('data-testid');
        if (testId) {
          const idMatch = testId.match(/comment-base-item-(\d+)/);
          if (idMatch && idMatch[1]) {
            commentId = parseInt(idMatch[1], 10);
          }
        }

        // Extract author
        const authorSelectors = [
          'h3',
          '[data-testid*="author"]',
          '.comment-author',
          '.author',
          'span[class*="css-12dhjzc"]' // Jira specific author selector
        ];

        let author = 'Unknown';
        for (const selector of authorSelectors) {
          const authorEl = commentEl.querySelector(selector);
          if (authorEl) {
            const authorText = (authorEl.textContent || authorEl.innerText || '').trim();
            // Make sure it's not just whitespace or very short
            if (authorText && authorText.length > 1 && authorText.length < 100) {
              author = authorText;
              break;
            }
          }
        }

        // Extract timestamp
        const timeSelectors = [
          '[data-testid*="timestamp"]',
          '[data-testid="issue-timestamp.relative-time"]',
          'time',
          '.comment-time',
          '[class*="timestamp"]'
        ];

        let timestamp = '';
        for (const selector of timeSelectors) {
          const timeEl = commentEl.querySelector(selector);
          if (timeEl) {
            timestamp = (timeEl.textContent || timeEl.innerText || timeEl.getAttribute('datetime') || '').trim();
            if (timestamp) break;
          }
        }

        // Extract comment body - look for the body section specifically
        const bodySelectors = [
          '[data-testid*="ak-comment"][data-testid*="body"]',
          '.ak-renderer-wrapper.is-comment',
          '.ak-renderer-wrapper',
          '.ak-renderer-document',
          '[data-testid*="comment"][data-testid*="body"]'
        ];

        let body = '';
        for (const selector of bodySelectors) {
          const bodyEl = commentEl.querySelector(selector);
          if (bodyEl) {
            body = extractFromRenderer(bodyEl);
            if (body && body.trim().length > 0) break;
          }
        }

        // If no body found in specific selectors, try to get text from comment body area
        if (!body || body.trim().length === 0) {
          const bodyArea = commentEl.querySelector('[data-testid*="body"], .comment-body, [class*="body"]');
          if (bodyArea) {
            body = extractFromRenderer(bodyArea);
          }
        }

        // Clean up body - remove author name and timestamp if they appear in body
        if (body) {
          body = body.trim();
          // Remove author name from body if it appears at the start
          if (author !== 'Unknown' && body.startsWith(author)) {
            body = body.substring(author.length).trim();
          }
          // Remove timestamp patterns from body
          body = body.replace(/^\d+\s+(days?|hours?|minutes?|weeks?|months?)\s+ago\s*/i, '').trim();
          // Remove patterns like "AuthorName2 days ago"
          body = body.replace(new RegExp(`^${author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+.*ago\\s*`, 'i'), '').trim();
        }

        // Only add comment if it has meaningful content
        // Body should be non-empty and not just the author/timestamp
        const hasValidBody = body && body.trim().length > 0 && body.trim().length > 5;
        const isNotJustMetadata = body !== author && body !== timestamp &&
          !body.match(/^(Staci Jansma|Alexander Spirgel|Unknown)\d+.*ago$/i);

        if (hasValidBody && isNotJustMetadata) {
          comments.push({
            id: commentId,
            author: author,
            timestamp: timestamp,
            body: body
          });
        }
      } catch (error) {
        console.warn('Error extracting comment:', error);
      }
    });

    // Sort comments by ID to maintain order
    comments.sort((a, b) => a.id - b.id);

    return comments;
  }

  // Extract attachments (only meaningful ones, not UI elements)
  function extractAttachments() {
    const attachments = [];
    const seenUrls = new Set();
    const seenNames = new Set();
    const seenAttachmentIds = new Set();

    // First, extract from filmstrip view (new Jira attachment UI)
    // Search for attachment wrappers directly (they can be anywhere in the page)
    const attachmentWrappers = document.querySelectorAll('[data-testid^="issue.views.issue-base.content.attachment.filmstrip-view.attachment-id"]');

    attachmentWrappers.forEach((wrapper) => {
      try {
        // Get attachment ID from data-testid
        const attachmentIdMatch = wrapper.getAttribute('data-testid')?.match(/attachment-id\.(\d+)/);
        if (!attachmentIdMatch) return;

        const attachmentId = attachmentIdMatch[1];

        // Skip if already processed (by attachment ID)
        if (seenAttachmentIds.has(attachmentId)) return;
        seenAttachmentIds.add(attachmentId);

        // Get filename from data-test-media-name
        const mediaCard = wrapper.querySelector('[data-test-media-name]');
        let filename = mediaCard?.getAttribute('data-test-media-name');

        // Also try getting from title box (truncated filename)
        if (!filename) {
          const titleBox = wrapper.querySelector('[data-testid="title-box-header"]');
          if (titleBox) {
            const leftSpan = titleBox.querySelector('[data-testid="truncate-left"]');
            const rightSpan = titleBox.querySelector('[data-testid="truncate-right"]');
            if (leftSpan && rightSpan) {
              filename = (leftSpan.textContent || '').trim() + (rightSpan.textContent || '').trim();
            } else {
              // Try direct text content
              filename = titleBox.textContent?.trim();
            }
          }
        }

        // Try to get from button text in the parent list item
        if (!filename) {
          const listItem = wrapper.closest('[data-testid="media-filmstrip-list-item"]');
          if (listItem) {
            const button = listItem.querySelector('button');
            if (button) {
              const buttonText = button.textContent || button.getAttribute('aria-label') || '';
              filename = buttonText.replace(/^Open\s+/i, '').trim();
            }
          }
        }

        // Try download button aria-label
        if (!filename) {
          const downloadButton = wrapper.querySelector('button[aria-label*="Download"]');
          if (downloadButton) {
            const ariaLabel = downloadButton.getAttribute('aria-label') || '';
            const match = ariaLabel.match(/(.+?)\s*—\s*Download/i);
            if (match && match[1]) {
              filename = match[1].trim();
            }
          }
        }

        if (!filename || filename.length === 0) {
          filename = `attachment-${attachmentId}`;
        }

        // Try to get file ID and blob URL from img element
        let fileId = null;
        let blobUrl = null;
        const img = wrapper.querySelector('img[data-fileid]');
        if (img) {
          fileId = img.getAttribute('data-fileid');
          const src = img.getAttribute('src');
          if (src && src.startsWith('blob:')) {
            blobUrl = src;
          }
        }

        // Construct download URL - try multiple approaches
        let downloadUrl = null;

        // First, try to get URL from download button if it has a link
        const downloadButton = wrapper.querySelector('button[aria-label*="Download"]');
        if (downloadButton) {
          // Check if button has onclick or data attributes with URL
          const onclick = downloadButton.getAttribute('onclick');
          if (onclick) {
            const urlMatch = onclick.match(/['"](https?:\/\/[^'"]+)['"]/);
            if (urlMatch) {
              downloadUrl = urlMatch[1];
            }
          }

          // Check parent for link
          const link = downloadButton.closest('a[href]');
          if (link && !downloadUrl) {
            downloadUrl = link.getAttribute('href');
          }
        }

        // Fallback to standard Jira attachment URL
        if (!downloadUrl) {
          // Try multiple URL patterns
          const baseUrl = window.location.origin;
          const possibleUrls = [
            `${baseUrl}/secure/attachment/${attachmentId}/${encodeURIComponent(filename)}`,
            `${baseUrl}/rest/api/3/attachment/content/${attachmentId}`,
            `${baseUrl}/secure/attachment/${attachmentId}/`
          ];
          downloadUrl = possibleUrls[0]; // Use the first one as default
        }

        // Make URL absolute
        if (!downloadUrl.startsWith('http')) {
          downloadUrl = new URL(downloadUrl, window.location.origin).href;
        }

        // Debug logging
        console.log(`Found attachment: ${filename}, ID: ${attachmentId}, URL: ${downloadUrl}`);

        if (!seenUrls.has(downloadUrl) && !isUnnecessaryFile(downloadUrl, filename)) {
          seenUrls.add(downloadUrl);
          attachments.push({
            id: attachments.length + 1,
            name: filename,
            url: downloadUrl,
            blobUrl: blobUrl, // Store blob URL if available (we can try to extract from it)
            fileId: fileId,
            attachmentId: attachmentId
          });
          console.log(`Added attachment to list: ${filename}`);
        } else {
          if (seenUrls.has(downloadUrl)) {
            console.log(`Skipping duplicate attachment: ${filename}`);
          }
          if (isUnnecessaryFile(downloadUrl, filename)) {
            console.log(`Skipping unnecessary file: ${filename}`);
          }
        }
      } catch (error) {
        console.warn('Error extracting filmstrip attachment:', error);
      }
    });

    // Find the attachment section first
    const attachmentSection = document.querySelector('[data-testid="issue.views.issue-base.content.attachment.heading.section-heading-title"]');
    let attachmentContainer = null;

    if (attachmentSection) {
      // Find the parent container that holds all attachments
      attachmentContainer = attachmentSection.closest('section, div[class*="section"], div[class*="attachment"]');
      if (!attachmentContainer) {
        // Try to find the next sibling or parent that contains attachment links
        let current = attachmentSection.parentElement;
        while (current && current !== document.body) {
          const links = current.querySelectorAll('a[href*="attachment"], a[href*="download"], a[href*="secure/attachment"]');
          if (links.length > 0) {
            attachmentContainer = current;
            break;
          }
          current = current.parentElement;
        }
      }
    }

    // Try multiple selectors for attachment elements
    const attachmentSelectors = [
      '[data-testid*="attachment"]',
      '[data-testid*="issue.views.issue-base.content.attachment"]',
      '.attachment-list',
      '.attachments',
      '[class*="attachment"]',
      'a[href*="/secure/attachment"]',
      'a[href*="/attachment/"]',
      'a[href*="attachmentId="]'
    ];

    let attachmentElements = [];
    for (const selector of attachmentSelectors) {
      const elements = attachmentContainer
        ? Array.from(attachmentContainer.querySelectorAll(selector))
        : Array.from(document.querySelectorAll(selector));

      if (elements.length > 0) {
        attachmentElements = elements;
        break;
      }
    }

    // Extract from attachment elements
    attachmentElements.forEach((el, index) => {
      try {
        const link = el.querySelector('a[href]') || el.closest('a[href]') || (el.tagName === 'A' ? el : null);
        if (link) {
          const href = link.getAttribute('href');
          if (!href) return;

          // Get attachment name from various sources
          let name = link.getAttribute('title') ||
            link.getAttribute('aria-label') ||
            link.textContent ||
            link.querySelector('[data-testid*="name"], [class*="name"]')?.textContent ||
            `attachment-${index + 1}`;
          name = name.trim();

          // Check if it's an attachment URL
          const isAttachmentUrl = href.includes('attachment') ||
            href.includes('download') ||
            href.includes('/secure/attachment') ||
            href.includes('attachmentId=');

          if (isAttachmentUrl) {
            const url = href.startsWith('http') ? href : new URL(href, window.location.origin).href;

            // Skip if already seen
            if (seenUrls.has(url)) return;
            seenUrls.add(url);

            // Skip unnecessary files
            if (!isUnnecessaryFile(url, name)) {
              attachments.push({
                id: attachments.length + 1,
                name: name,
                url: url
              });
            }
          }
        }
      } catch (error) {
        console.warn('Error extracting attachment:', error);
      }
    });

    // Also look for all download/attachment links in the page (broader search)
    const allAttachmentLinks = Array.from(document.querySelectorAll('a[href*="attachment"], a[href*="download"], a[href*="/secure/attachment"]'));

    allAttachmentLinks.forEach((link, index) => {
      try {
        const href = link.getAttribute('href');
        if (!href) return;

        const url = href.startsWith('http') ? href : new URL(href, window.location.origin).href;

        // Skip if already seen
        if (seenUrls.has(url)) return;

        // Skip links that are clearly not attachments (like navigation)
        if (href.includes('#') && !href.includes('attachment')) return;

        const name = link.getAttribute('title') ||
          link.getAttribute('aria-label') ||
          link.textContent ||
          link.querySelector('span, div')?.textContent ||
          `attachment-${attachments.length + index + 1}`;
        const cleanName = name.trim();

        // Skip unnecessary files
        if (!isUnnecessaryFile(url, cleanName)) {
          seenUrls.add(url);
          attachments.push({
            id: attachments.length + 1,
            name: cleanName,
            url: url
          });
        }
      } catch (error) {
        console.warn('Error extracting attachment link:', error);
      }
    });

    // Final fallback: if attachment section exists but no attachments found, 
    // look for any links in the section following the attachment heading
    if (attachmentSection && attachments.length === 0) {
      let current = attachmentSection.parentElement;
      let searchDepth = 0;

      while (current && searchDepth < 5) {
        const links = current.querySelectorAll('a[href]');
        links.forEach(link => {
          try {
            const href = link.getAttribute('href');
            if (!href) return;

            // Look for attachment-like URLs
            if (href.includes('secure/attachment') ||
              href.includes('attachmentId=') ||
              (href.includes('attachment') && !href.includes('#'))) {

              const url = href.startsWith('http') ? href : new URL(href, window.location.origin).href;

              if (seenUrls.has(url)) return;
              seenUrls.add(url);

              const name = link.textContent?.trim() ||
                link.getAttribute('title') ||
                link.getAttribute('aria-label') ||
                `attachment-${attachments.length + 1}`;

              if (!isUnnecessaryFile(url, name)) {
                attachments.push({
                  id: attachments.length + 1,
                  name: name.trim(),
                  url: url
                });
              }
            }
          } catch (error) {
            console.warn('Error in fallback attachment extraction:', error);
          }
        });

        current = current.parentElement;
        searchDepth++;
      }
    }

    return attachments;
  }

  // Check if an image/attachment is unnecessary (UI elements, icons, etc.)
  function isUnnecessaryFile(url, name) {
    const urlLower = url.toLowerCase();
    const nameLower = name.toLowerCase();

    // Skip avatars
    if (urlLower.includes('avatar') || nameLower.includes('avatar')) {
      return true;
    }

    // Skip data URIs
    if (url.startsWith('data:')) {
      return true;
    }

    // Skip Jira UI icons and elements
    const uiPatterns = [
      'jira icon',
      'priority',
      'status',
      'issue type',
      'component',
      'emoji',
      'icon.ico',
      'icon.svg',
      'icon.png',
      'fire', // emoji
      'thumbs up', // emoji
      'thumbs down', // emoji
      'homepage.png' // likely UI screenshot
    ];

    for (const pattern of uiPatterns) {
      if (nameLower.includes(pattern)) {
        return true;
      }
    }

    // Skip emoji URLs (Atlassian emoji service)
    if (urlLower.includes('pf-emoji-service') ||
      urlLower.includes('emoji-service') ||
      urlLower.includes('atlassian.com/emoji') ||
      urlLower.includes('atlassian.net/emoji')) {
      return true;
    }

    // Skip emoji file patterns (like 1f525.png for fire emoji)
    if (urlLower.match(/\/\d+[a-f0-9]+\.(png|svg|jpg|jpeg)$/)) {
      return true;
    }

    // Skip generic numbered images (likely UI elements)
    // Match patterns like "image-36.svg", "image-37.png", etc.
    if (nameLower.match(/^image-\d+\.(svg|png|jpg|jpeg|gif|ico)$/)) {
      return true;
    }

    // Skip Atlassian CDN icons and UI assets
    if (urlLower.includes('atlassian.net') || urlLower.includes('atlassian.com')) {
      // Check if it's a UI asset path
      if (urlLower.includes('/icons/') ||
        urlLower.includes('/images/') ||
        urlLower.includes('/assets/') ||
        urlLower.includes('avatar-management')) {
        return true;
      }
    }

    // Skip very small files (likely icons) - we'll check this during download
    // Skip files with very generic names
    const genericNames = ['icon', 'image', 'img', 'picture', 'photo'];
    if (genericNames.some(g => nameLower === g || nameLower.startsWith(g + '-'))) {
      // But allow if it's a meaningful filename (has more than just generic name)
      if (nameLower.split(/[-_\s]/).length <= 2) {
        return true;
      }
    }

    return false;
  }

  // Extract images from description and comments (only meaningful ones)
  function extractImages() {
    const images = [];
    const imgElements = document.querySelectorAll('img[src]');
    const seenImageUrls = new Set();

    imgElements.forEach((img, index) => {
      const src = img.getAttribute('src');
      if (!src) return;

      // Skip blob URLs - these are display images, not downloadable attachments
      if (src.startsWith('blob:')) {
        return;
      }

      const alt = img.getAttribute('alt') || `image-${index + 1}`;
      const url = src.startsWith('http') ? src : new URL(src, window.location.origin).href;

      // Skip if already seen
      if (seenImageUrls.has(url)) return;
      seenImageUrls.add(url);

      // Skip unnecessary files
      if (isUnnecessaryFile(url, alt)) {
        return;
      }

      images.push({
        id: index + 1,
        name: alt,
        url: url
      });
    });

    return images;
  }

  // Download file - try multiple methods to bypass CORS
  // Uses browser session cookies as primary method, API auth as fallback
  async function downloadFile(url, filename, blobUrl = null, useApiAuth = false, apiAuthHeader = null) {
    try {
      // If we have a blob URL, try to extract the blob from it first
      if (blobUrl && blobUrl.startsWith('blob:')) {
        try {
          const response = await fetch(blobUrl);
          if (response.ok) {
            const blob = await response.blob();
            if (blob.size > 0) {
              return { filename, blob };
            }
          }
        } catch (blobError) {
          console.warn(`Failed to extract from blob URL for ${filename}:`, blobError.message);
        }
      }

      // Skip blob URLs and data URIs if we don't have the blobUrl parameter
      if (url.startsWith('blob:') || url.startsWith('data:')) {
        console.warn(`Skipping blob/data URL: ${filename}`);
        return null;
      }

      // If API auth is enabled, use background script directly to avoid CORS/Header issues in content script
      if (useApiAuth && apiAuthHeader) {
        console.log(`Using background script with API auth for: ${filename}`);
        const bgResult = await downloadFileViaBackgroundBlob(url, filename, apiAuthHeader);
        if (bgResult) return bgResult;
        console.log(`Background API auth failed for ${filename}, falling back to browser session`);
      }

      // For Jira attachments, XHR handles cookies and redirects better than fetch
      // Try XHR first for attachment URLs (they often redirect to media.atlassian.com)
      if (url.includes('/secure/attachment/') || url.includes('/attachment/')) {
        console.log(`Using XHR for attachment: ${filename}`);
        const xhrResult = await downloadFileViaXHR(url, filename);
        if (xhrResult) return xhrResult;
        // If XHR fails, fall through to fetch
        console.log(`XHR failed for ${filename}, trying fetch`);
      }

      // Try with browser session cookies using fetch
      // For Jira attachments that redirect to media.atlassian.com, we need special handling
      let response;
      try {
        // Try same-origin credentials first (only sends cookies for same origin)
        // This avoids CORS issues when URL redirects to different origin
        const fetchOptions = {
          mode: 'cors',
          credentials: 'same-origin', // Only send cookies for same-origin (avoids CORS on redirect)
          redirect: 'follow' // Follow redirects
        };

        // If API auth is provided and URL is an API endpoint, use it
        if (useApiAuth && apiAuthHeader && url.includes('/rest/api/')) {
          fetchOptions.headers = {
            'Authorization': apiAuthHeader,
            'Accept': '*/*'
          };
        }

        response = await fetch(url, fetchOptions);

        // If that fails, try with include credentials (for same-origin requests)
        if (!response || !response.ok) {
          console.log(`Same-origin fetch failed for ${filename}, trying with include credentials`);
          response = await fetch(url, {
            mode: 'cors',
            credentials: 'include',
            redirect: 'follow'
          }).catch(() => null);
        }

        // If still fails or CORS blocked, try background script
        if (!response || response.type === 'opaque') {
          console.log(`CORS blocked for ${filename}, trying background script`);
          const bgResult = await downloadFileViaBackground(url, filename);
          if (bgResult) return bgResult;
          // If background also fails, the file might still download via browser's native handling
          // Return null to continue (file might be in downloads folder)
          console.warn(`All download methods failed for ${filename}, but file may have been downloaded`);
          return null;
        }

        if (!response.ok && response.status === 403 && useApiAuth && apiAuthHeader) {
          // If API auth failed, try again with just browser session
          console.log(`API auth failed for ${filename}, retrying with browser session only`);
          response = await fetch(url, {
            mode: 'cors',
            credentials: 'same-origin',
            redirect: 'follow'
          });
        }
      } catch (corsError) {
        // CORS error - try XHR which handles redirects better
        console.log(`CORS error for ${filename}, trying XHR:`, corsError.message);
        const xhrResult = await downloadFileViaXHR(url, filename);
        if (xhrResult) return xhrResult;
        // If XHR fails, try background script
        return await downloadFileViaBackground(url, filename);
      }

      if (!response) {
        throw new Error('No response from server');
      }

      if (!response.ok) {
        // If we get 403 or CORS issue, try XHR first (has better cookie handling)
        if (response.status === 403 || response.type === 'opaque') {
          console.log(`${response.status} error for ${filename}, trying XHR`);
          const xhrResult = await downloadFileViaXHR(url, filename);
          if (xhrResult) return xhrResult;
          // If XHR fails, try background script
          console.log(`XHR failed for ${filename}, trying background script`);
          return await downloadFileViaBackground(url, filename);
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText || 'Unknown error'}`);
      }

      const blob = await response.blob();

      // Check if blob is empty or very small (might be an error page)
      if (blob.size === 0) {
        console.warn(`Empty blob for ${filename}`);
        return null;
      }

      return { filename, blob };
    } catch (error) {
      // Try background script as fallback
      return await downloadFileViaBackground(url, filename);
    }
  }

  // Download file via background script using blob (supports API auth headers)
  async function downloadFileViaBackgroundBlob(url, filename, apiAuthHeader = null) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'downloadFileAsBlob',
        url: url,
        filename: filename,
        headers: apiAuthHeader ? { 'Authorization': apiAuthHeader, 'Accept': '*/*' } : null
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn(`Background blob download failed for ${filename}:`, chrome.runtime.lastError.message);
          resolve(null);
          return;
        }

        if (response && response.success && response.blob) {
          try {
            // Convert base64 back to Blob
            const byteCharacters = atob(response.blob);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
              byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: response.type });
            resolve({ filename, blob });
          } catch (e) {
            console.error(`Failed to process blob for ${filename}:`, e);
            resolve(null);
          }
        } else {
          console.warn(`Background blob download failed for ${filename}:`, response ? response.error : 'No response');
          resolve(null);
        }
      });
    });
  }

  // Download file using XMLHttpRequest (has better cookie/redirect handling)
  async function downloadFileViaXHR(url, filename) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';
      // Try with credentials first (for same-origin), but it will fail on cross-origin redirect
      // We'll catch the error and try without credentials
      xhr.withCredentials = true;

      xhr.onload = function () {
        if (xhr.status === 200) {
          const blob = xhr.response;
          if (blob && blob.size > 0) {
            resolve({ filename, blob });
          } else {
            console.warn(`Empty blob for ${filename}`);
            resolve(null);
          }
        } else {
          console.warn(`XHR failed for ${filename}: ${xhr.status}`);
          resolve(null);
        }
      };

      xhr.onerror = function () {
        // If error is due to CORS with credentials, try without credentials
        if (xhr.withCredentials) {
          console.log(`XHR with credentials failed for ${filename}, retrying without credentials`);
          const xhr2 = new XMLHttpRequest();
          xhr2.open('GET', url, true);
          xhr2.responseType = 'blob';
          xhr2.withCredentials = false;

          xhr2.onload = function () {
            if (xhr2.status === 200) {
              const blob = xhr2.response;
              if (blob && blob.size > 0) {
                resolve({ filename, blob });
              } else {
                resolve(null);
              }
            } else {
              resolve(null);
            }
          };

          xhr2.onerror = function () {
            console.warn(`XHR error for ${filename} (without credentials)`);
            resolve(null);
          };

          xhr2.ontimeout = function () {
            resolve(null);
          };

          xhr2.timeout = 60000;
          xhr2.send();
        } else {
          console.warn(`XHR error for ${filename}`);
          resolve(null);
        }
      };

      xhr.ontimeout = function () {
        console.warn(`XHR timeout for ${filename}`);
        resolve(null);
      };

      xhr.timeout = 60000; // 60 second timeout
      xhr.send();
    });
  }

  // Download file via background script (bypasses some CORS restrictions)
  async function downloadFileViaBackground(url, filename) {
    return new Promise((resolve) => {
      // Stream data in chunks to avoid exceeding Chrome's message size limit
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const port = chrome.runtime.connect({ name: 'downloadFileStream' });
      const chunks = [];
      let totalLength = 0;
      let contentType = 'application/octet-stream';
      let settled = false;

      const cleanup = () => {
        try {
          port.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
      };

      const finalize = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      // Guard against a hung download
      const timeout = setTimeout(() => {
        console.warn(`Download timed out for ${filename}`);
        finalize(null);
      }, 120000); // 2 minutes

      port.onMessage.addListener((message) => {
        if (message.requestId !== requestId) return;

        if (message.type === 'chunk' && message.chunk) {
          const buffer = message.chunk;
          const view = buffer instanceof ArrayBuffer
            ? new Uint8Array(buffer)
            : new Uint8Array(buffer.buffer || buffer);

          // Ignore empty chunks
          if (view.byteLength === 0) return;

          chunks.push(view);
          totalLength += view.byteLength;
          return;
        }

        if (message.type === 'complete') {
          clearTimeout(timeout);
          contentType = message.contentType || contentType;

          if (totalLength === 0) {
            console.warn(`Background download returned no data for ${filename}`);
            finalize(null);
            return;
          }

          const combined = new Uint8Array(totalLength);
          let offset = 0;
          chunks.forEach(chunk => {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
          });

          const blob = new Blob([combined], { type: contentType });
          finalize(blob.size > 0 ? { filename, blob } : null);
          return;
        }

        if (message.type === 'error') {
          clearTimeout(timeout);
          console.warn(`Background download failed for ${filename}:`, message.error);
          finalize(null);
        }
      });

      port.onDisconnect.addListener(() => {
        clearTimeout(timeout);
        finalize(null);
      });

      port.postMessage({
        action: 'downloadFileStream',
        url,
        requestId
      });
    });
  }

  // Load all comments by clicking "Show more comments" buttons
  async function loadAllComments() {
    let maxIterations = 50; // Safety limit
    let iterations = 0;

    while (iterations < maxIterations) {
      // Find "Show more comments" button using the specific data-testid
      let showMoreButton = document.querySelector(
        'button[data-testid="issue.activity.common.component.load-more-button.loading-button"]'
      );

      // Also try finding by class and text content
      if (!showMoreButton) {
        const buttons = Array.from(document.querySelectorAll('button.css-x4ciwe, button[class*="load-more"]'));
        showMoreButton = buttons.find(btn => {
          const text = (btn.textContent || btn.innerText || '').trim();
          return text.toLowerCase().includes('show more comments') ||
            text.toLowerCase().includes('load more comments');
        });
      }

      // Fallback: search all buttons for the text
      if (!showMoreButton) {
        const allButtons = Array.from(document.querySelectorAll('button'));
        showMoreButton = allButtons.find(btn => {
          const text = (btn.textContent || btn.innerText || '').trim();
          return text.toLowerCase() === 'show more comments' ||
            text.toLowerCase().includes('show more comments');
        });
      }

      if (!showMoreButton) {
        // No more "Show more comments" button found
        break;
      }

      // Check if button is visible and not disabled
      const isVisible = showMoreButton.offsetParent !== null;
      const isDisabled = showMoreButton.disabled ||
        showMoreButton.getAttribute('aria-disabled') === 'true';

      if (!isVisible || isDisabled) {
        break;
      }

      // Scroll button into view
      showMoreButton.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Wait a bit for scroll
      await new Promise(resolve => setTimeout(resolve, 300));

      // Get current comment count before clicking
      const commentCountBefore = document.querySelectorAll('[data-testid^="comment-base-item"]').length;

      // Click the button
      showMoreButton.click();

      // Wait for comments to load - check if new comments appear
      let waitCount = 0;
      let commentsLoaded = false;

      while (waitCount < 20) {
        await new Promise(resolve => setTimeout(resolve, 300));

        const commentCountAfter = document.querySelectorAll('[data-testid^="comment-base-item"]').length;

        // Check if new comments appeared
        if (commentCountAfter > commentCountBefore) {
          commentsLoaded = true;
          // Wait a bit more to ensure all are loaded
          await new Promise(resolve => setTimeout(resolve, 500));
          break;
        }

        // Check if button disappeared (comments finished loading)
        const buttonStillExists = document.contains(showMoreButton);
        if (!buttonStillExists) {
          commentsLoaded = true;
          break;
        }

        waitCount++;
      }

      // If comments didn't load after waiting, break to avoid infinite loop
      if (!commentsLoaded && waitCount >= 20) {
        console.warn('Timeout waiting for comments to load');
        break;
      }

      iterations++;
    }

    // Final wait to ensure all comments are fully rendered
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Try to extract using Jira API first
  async function extractTicketViaAPI() {
    try {
      // Get stored credentials
      const result = await chrome.storage.sync.get(['jiraEmail', 'jiraApiToken']);

      if (!result.jiraEmail || !result.jiraApiToken) {
        return null; // No credentials, fallback to DOM extraction
      }

      // Load Jira API script (only if not already loaded)
      // Check both window and global scope
      const jiraApiLoaded = typeof JiraAPI !== 'undefined' || typeof window.JiraAPI !== 'undefined';

      if (!jiraApiLoaded) {
        try {
          // Check if script is already in DOM
          const existingScript = document.querySelector('script[src*="jira-api.js"]');
          if (existingScript) {
            // Script tag exists, wait for it to load
            let retries = 0;
            while ((typeof JiraAPI === 'undefined' && typeof window.JiraAPI === 'undefined') && retries < 20) {
              await new Promise(resolve => setTimeout(resolve, 100));
              retries++;
            }
          } else {
            // Load the script
            await loadScript('jira-api.js');
            // Wait for JiraAPI to be available
            let retries = 0;
            while ((typeof JiraAPI === 'undefined' && typeof window.JiraAPI === 'undefined') && retries < 20) {
              await new Promise(resolve => setTimeout(resolve, 100));
              retries++;
            }
          }
        } catch (error) {
          console.warn('Failed to load Jira API script, falling back to DOM extraction:', error);
          return null;
        }

        if (typeof JiraAPI === 'undefined' && typeof window.JiraAPI === 'undefined') {
          return null; // API not available, fallback to DOM
        }
      }

      // Use window.JiraAPI if JiraAPI is not in current scope
      const JiraAPIClass = typeof JiraAPI !== 'undefined' ? JiraAPI : window.JiraAPI;

      const baseUrl = JiraAPIClass.extractBaseUrl(window.location.href);
      const issueKey = JiraAPIClass.extractIssueKey(window.location.href);

      if (!baseUrl || !issueKey) {
        console.warn('Could not extract base URL or issue key from page URL');
        return null;
      }

      const api = new JiraAPIClass(result.jiraEmail, result.jiraApiToken, baseUrl);
      const apiData = await api.getFullTicket(issueKey);

      // Convert API data to extractor format
      const ticketData = convertApiDataToExtractorFormat(apiData, baseUrl);

      // Get checklists from DOM (not available in API)
      const checklists = await extractChecklists();
      ticketData.checklists = checklists;

      // Wait for JSZip (if not already loaded)
      let retriesZip = 0;
      while (typeof JSZip === 'undefined' && retriesZip < 10) {
        await new Promise(resolve => setTimeout(resolve, 100));
        retriesZip++;
      }

      if (typeof JSZip === 'undefined') {
        throw new Error('JSZip library not available');
      }

      // Create ZIP structure first
      const zip = new JSZip();
      const ticketFolder = zip.folder(ticketData.ticketKey);
      const rawFolder = ticketFolder.folder('raw');
      const attachmentsFolder = rawFolder.folder('attachments');

      // Download attachments using API URLs (they include proper authentication)
      const allFiles = [...ticketData.attachments];
      const attachmentPaths = [];
      let downloadCount = 0;

      for (const file of allFiles) {
        try {
          if (!file.url) continue;

          // For API attachments, use authenticated fetch
          const credentials = `${result.jiraEmail}:${result.jiraApiToken}`;
          const authHeader = `Basic ${btoa(credentials)}`;

          // Try download with API auth first using the API URL (if available), then fallback to browser session
          let downloadResult = await downloadFile(
            file.apiUrl || file.url,
            file.name,
            file.blobUrl,
            true, // useApiAuth
            authHeader
          );

          // If that failed, try without API auth (browser session only)
          if (!downloadResult) {
            console.log(`Retrying ${file.name} with browser session only`);
            downloadResult = await downloadFile(file.url, file.name, file.blobUrl, false, null);
          }

          if (!downloadResult) continue;

          const result = downloadResult;
          if (result) {
            let filename = file.name.replace(/[<>:"/\\|?*]/g, '_').trim();

            // Ensure unique filename
            let finalFilename = filename;
            let counter = 1;
            while (attachmentPaths.some(a => a.path === `${ticketData.ticketKey}/raw/attachments/${finalFilename}`)) {
              const nameParts = filename.split('.');
              if (nameParts.length > 1) {
                const ext = nameParts.pop();
                finalFilename = nameParts.join('.') + `_${counter}.${ext}`;
              } else {
                finalFilename = `${filename}_${counter}`;
              }
              counter++;
            }

            attachmentsFolder.file(finalFilename, result.blob);
            attachmentPaths.push({
              id: file.id,
              name: file.name,
              path: `${ticketData.ticketKey}/raw/attachments/${finalFilename}`
            });
            downloadCount++;
          }
        } catch (error) {
          console.warn(`Failed to download ${file.name}:`, error);
        }
      }

      ticketData.attachments = attachmentPaths;

      // Add ticket file
      const tktContent = convertToTktFormat(ticketData);
      rawFolder.file('ticket.tkt', tktContent);

      // Generate ZIP
      const zipBlob = await zip.generateAsync({ type: 'blob' });

      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${ticketData.ticketKey}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      return {
        success: true,
        message: `Extracted ticket via API with ${ticketData.comments.length} comments and ${downloadCount} attachments`,
        frameRole: 'main'
      };
    } catch (error) {
      console.warn('API extraction failed, falling back to DOM extraction:', error);
      return null; // Fallback to DOM extraction
    }
  }

  // Main extraction function
  async function extractTicket() {
    try {
      // Try API extraction first (only in top frame)
      if (isTopFrame) {
        const apiResult = await extractTicketViaAPI();
        if (apiResult) {
          return apiResult;
        }
      }

      // Fallback to DOM extraction
      // First, load all comments by clicking "Show more comments" buttons
      await loadAllComments();

      const title = extractTitle();
      const description = extractDescription();
      const customFields = extractRichTextFields();
      const comments = extractComments();
      const checklists = await extractChecklists();
      const attachments = extractAttachments();
      const commentAttachments = extractAttachmentsFromComments();
      const images = extractImages();

      // Combine attachments from main section, comments, and images
      // Remove duplicates by URL
      const allAttachmentsMap = new Map();
      [...attachments, ...commentAttachments, ...images].forEach(file => {
        if (!allAttachmentsMap.has(file.url)) {
          allAttachmentsMap.set(file.url, file);
        }
      });
      const allFiles = Array.from(allAttachmentsMap.values());

      // Extract ticket key first - try multiple methods
      let ticketKey = extractTicketKey();
      const currentUrl = window.location.href;

      // If still UNKNOWN, extract directly from URL
      if (ticketKey === 'UNKNOWN') {
        // Try /browse/ pattern
        const browseMatch = currentUrl.match(/\/browse\/([A-Z]+-\d+)/i);
        if (browseMatch && browseMatch[1]) {
          ticketKey = browseMatch[1];
        } else {
          // Try any ticket key pattern in URL (format: LETTERS-NUMBERS)
          const urlMatch = currentUrl.match(/([A-Z]{2,}\d+-\d+)/i);
          if (urlMatch && urlMatch[1]) {
            ticketKey = urlMatch[1];
          } else {
            // Try pathname last segment
            const pathParts = window.location.pathname.split('/').filter(p => p);
            if (pathParts.length > 0) {
              const lastPart = pathParts[pathParts.length - 1];
              if (lastPart.match(/^[A-Z]+-\d+$/i)) {
                ticketKey = lastPart;
              }
            }
          }
        }
      }

      // Final fallback for ticket key
      if (ticketKey === 'UNKNOWN') {
        ticketKey = extractTicketKeyFromUrl(currentUrl);
      }

      // Ensure we have a valid ticket key for folder structure
      const finalTicketKey = ticketKey !== 'UNKNOWN' ? ticketKey : 'jira-ticket';

      // Create ZIP file
      const zip = new JSZip();

      // Create ticket folder structure: {ticketKey}/raw/
      const ticketFolder = zip.folder(finalTicketKey);
      const rawFolder = ticketFolder.folder('raw');

      // Download and add attachments, track actual filenames
      const attachmentsFolder = rawFolder.folder('attachments');
      const attachmentPaths = [];
      let downloadCount = 0;

      for (const file of allFiles) {
        try {
          // Skip unnecessary files before attempting download
          if (isUnnecessaryFile(file.url, file.name)) {
            console.log(`Skipping unnecessary file: ${file.name}`);
            continue;
          }

          // Use browser session for downloads (most reliable)
          const result = await downloadFile(file.url, file.name, file.blobUrl, false, null);
          if (result) {
            // Get file extension from URL or filename
            let ext = '';
            const urlParts = file.url.split('.');
            if (urlParts.length > 1) {
              ext = urlParts[urlParts.length - 1].split('?')[0].split('#')[0];
            }

            // Determine final filename
            let filename = file.name;

            // Clean filename (remove invalid characters)
            filename = filename.replace(/[<>:"/\\|?*]/g, '_').trim();

            // Add extension if missing
            if (ext && !filename.toLowerCase().endsWith('.' + ext.toLowerCase())) {
              // Check if filename already has an extension
              const hasExt = filename.match(/\.[a-z0-9]+$/i);
              if (!hasExt) {
                filename = filename + '.' + ext;
              }
            }

            // Ensure unique filename
            let finalFilename = filename;
            let counter = 1;
            while (attachmentPaths.some(a => a.path === `${finalTicketKey}/raw/attachments/${finalFilename}`)) {
              const nameParts = filename.split('.');
              if (nameParts.length > 1) {
                const ext = nameParts.pop();
                finalFilename = nameParts.join('.') + `_${counter}.${ext}`;
              } else {
                finalFilename = `${filename}_${counter}`;
              }
              counter++;
            }

            attachmentsFolder.file(finalFilename, result.blob);
            attachmentPaths.push({
              id: file.id,
              name: file.name,
              path: `${finalTicketKey}/raw/attachments/${finalFilename}`
            });
            downloadCount++;
          }
        } catch (error) {
          console.warn(`Failed to download ${file.name}:`, error);
        }
      }

      // Create ticket data structure with local paths
      const ticketData = {
        title: title,
        ticketKey: ticketKey !== 'UNKNOWN' ? ticketKey : extractTicketKeyFromUrl(currentUrl),
        url: currentUrl,
        extractedAt: new Date().toISOString(),
        description: description,
        customFields: customFields,
        comments: comments,
        checklists: checklists,
        attachments: attachmentPaths
      };

      // Ensure ticketKey is set correctly
      if (ticketData.ticketKey === 'UNKNOWN') {
        ticketData.ticketKey = ticketKey !== 'UNKNOWN' ? ticketKey : finalTicketKey;
      }

      // Convert to TKT|v1 format
      const tktContent = convertToTktFormat(ticketData);
      rawFolder.file('ticket.tkt', tktContent);

      // Generate ZIP
      const zipBlob = await zip.generateAsync({ type: 'blob' });

      // Use the ticket key for ZIP naming (ensure it's not UNKNOWN)
      let zipName = ticketData.ticketKey;
      if (zipName === 'UNKNOWN') {
        zipName = finalTicketKey;
      }

      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${zipName}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      return {
        success: true,
        message: `Extracted ticket with ${comments.length} comments and ${downloadCount} attachments`,
        frameRole: 'main'
      };
    } catch (error) {
      return { error: error.message, frameRole: 'main' };
    }
  }

  // Helper function to extract ticket key from URL
  function extractTicketKeyFromUrl(url) {
    if (!url) return 'UNKNOWN';

    // Try /browse/ pattern first
    const browseMatch = url.match(/\/browse\/([A-Z]+-\d+)/i);
    if (browseMatch && browseMatch[1]) {
      return browseMatch[1];
    }

    // Try any ticket key pattern (format: LETTERS-NUMBERS)
    const urlMatch = url.match(/([A-Z]{2,}\d+-\d+)/i);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1];
    }

    // Try simpler pattern
    const simpleMatch = url.match(/([A-Z]+-\d+)/i);
    if (simpleMatch && simpleMatch[1]) {
      return simpleMatch[1];
    }

    return 'UNKNOWN';
  }

  // Convert ticket data to TKT|v1 format
  function convertToTktFormat(ticketData) {
    const lines = [];

    // Header
    lines.push('TKT|v1');

    // Helper function to escape pipes
    function escapePipe(value) {
      if (typeof value !== 'string') return String(value || '');
      return value.replace(/\|/g, '\\|');
    }

    // Helper function to escape newlines in single-line fields
    function escapeNewlines(value) {
      if (typeof value !== 'string') return String(value || '');
      return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\\n');
    }

    // Ticket header: H|{ticketKey}|{title}|{url}|{extractedAt}
    const ticketKey = escapePipe(ticketData.ticketKey || '');
    const ticketTitle = escapePipe(ticketData.title || '');
    const ticketUrl = escapePipe(ticketData.url || '');
    const extractedAt = escapePipe(ticketData.extractedAt || '');
    lines.push(`H|${ticketKey}|${ticketTitle}|${ticketUrl}|${extractedAt}`);

    // Description block (only if description is non-empty)
    if (ticketData.description && ticketData.description.trim()) {
      lines.push('D<<');
      // Normalize newlines - keep as-is in block format
      const desc = ticketData.description.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      lines.push(desc);
      lines.push('>>');
    }

    // Comment records: C|{id}|{author}|{timestamp}|{visibility}|{body}
    if (ticketData.comments && Array.isArray(ticketData.comments)) {
      ticketData.comments.forEach(comment => {
        if (!comment) return;

        const commentId = escapePipe(String(comment.id || ''));
        const commentAuthor = escapePipe(comment.author || '');
        const commentTimestamp = escapePipe(comment.timestamp || '');

        // Determine visibility: "internal" if author/timestamp includes "Internal note" (case-insensitive), otherwise empty
        let visibility = '';
        const authorTimestamp = `${commentAuthor} ${commentTimestamp}`.toLowerCase();
        if (authorTimestamp.includes('internal note')) {
          visibility = 'internal';
        }
        visibility = escapePipe(visibility);

        // Body must be single-line with newlines replaced with \n
        const commentBody = escapeNewlines(comment.body || '');

        lines.push(`C|${commentId}|${commentAuthor}|${commentTimestamp}|${visibility}|${commentBody}`);
      });
    }

    // Attachment records: A|{id}|{name}|{path}
    if (ticketData.attachments && Array.isArray(ticketData.attachments)) {
      ticketData.attachments.forEach(attachment => {
        if (!attachment) return;

        const attachId = escapePipe(String(attachment.id || ''));
        const attachName = escapePipe(attachment.name || '');
        const attachPath = escapePipe(attachment.path || '');

        // Only add if path is not empty (attachments must have a path)
        if (attachPath) {
          lines.push(`A|${attachId}|${attachName}|${attachPath}`);
        }
      });
    }

    return lines.join('\n');
  }

  // Extract ticket key (e.g., CUHC001-614)
  function extractTicketKey() {
    // First, try to find ticket key in URL - check /browse/ path
    const url = window.location.href;
    const pathname = window.location.pathname;

    // Try /browse/ pattern first (most common)
    const browseMatch = url.match(/\/browse\/([A-Z]+-\d+)/i);
    if (browseMatch && browseMatch[1]) {
      return browseMatch[1];
    }

    // Try pathname /browse/ pattern
    const pathBrowseMatch = pathname.match(/\/browse\/([A-Z]+-\d+)/i);
    if (pathBrowseMatch && pathBrowseMatch[1]) {
      return pathBrowseMatch[1];
    }

    // Try general path match (ticket key anywhere in path)
    const pathMatch = pathname.match(/([A-Z]+-\d+)/i);
    if (pathMatch && pathMatch[1]) {
      return pathMatch[1];
    }

    // Try URL match (ticket key anywhere in full URL)
    const urlMatch = url.match(/([A-Z]+-\d+)/i);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1];
    }

    // Try to find in page DOM
    const keySelectors = [
      '[data-testid*="issue.views.issue-base.foundation.breadcrumbs"]',
      '.issue-header-key',
      '[class*="issue-key"]',
      'a[href*="/browse/"]',
      'h1[data-testid*="issue"]'
    ];

    for (const selector of keySelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent || el.innerText || '';
        const match = text.match(/([A-Z]+-\d+)/i);
        if (match && match[1]) {
          return match[1];
        }

        // Also check href attribute
        const href = el.getAttribute('href');
        if (href) {
          const hrefMatch = href.match(/([A-Z]+-\d+)/i);
          if (hrefMatch && hrefMatch[1]) {
            return hrefMatch[1];
          }
        }
      }
    }

    // Last resort: use last path segment
    const pathParts = pathname.split('/').filter(p => p);
    if (pathParts.length > 0) {
      const lastPart = pathParts[pathParts.length - 1];
      if (lastPart.match(/^[A-Z]+-\d+$/i)) {
        return lastPart;
      }
    }

    // Final fallback: extract from full URL as last segment
    const urlParts = url.split('/').filter(p => p);
    if (urlParts.length > 0) {
      const lastUrlPart = urlParts[urlParts.length - 1];
      if (lastUrlPart.match(/^[A-Z]+-\d+$/i)) {
        return lastUrlPart;
      }
    }

    return 'UNKNOWN';
  }

  // Execute extraction
  return await extractTicket();
})();
