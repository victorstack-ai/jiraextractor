# Jira Ticket Extractor Chrome Extension

**Install from Chrome Web Store:** https://chromewebstore.google.com/detail/mjdgnpmadepahnoeiahafimajgoajgdp

A Chrome extension that extracts Jira tickets to clean JSON format with all attachments and images. Version 1.0.8, 65.2 KiB, privacy-first (no data collection).

## Features

- Extracts ticket title, description, comments, and attachments
- Converts HTML content to clean text
- Downloads all attachments and images
- Creates a ZIP file containing:
  - `ticket.json` - Clean JSON structure with all ticket data
  - `attachments/` - Folder with all downloaded attachments and images

## Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `jiraextractor` folder

## Usage

1. Navigate to any Jira ticket page (atlassian.net or jira.com)
2. Click the extension icon in the toolbar
3. Click "Extract Ticket"
4. A ZIP file will be downloaded automatically

## Icon Generation

If the icons are missing, you can generate them by:

1. Opening `generate_icons.html` in your browser
2. The icons will be automatically downloaded to your Downloads folder
3. Move them to the `icons/` folder

Alternatively, you can create simple icons using any image editor:
- `icon16.png` - 16x16 pixels
- `icon48.png` - 48x48 pixels  
- `icon128.png` - 128x128 pixels

Recommended color: Jira blue (#0052CC)

## JSON Structure

The extracted JSON follows this structure:

```json
{
  "title": "Ticket Title",
  "ticketKey": "PROJ-123",
  "url": "https://...",
  "extractedAt": "2024-01-01T00:00:00.000Z",
  "description": "Clean text description without HTML",
  "comments": [
    {
      "id": 1,
      "author": "John Doe",
      "timestamp": "3 days ago",
      "body": "Comment text"
    }
  ],
  "attachments": [
    {
      "id": 1,
      "name": "file.pdf",
      "url": "https://..."
    }
  ]
}
```

## Files

- `manifest.json` - Extension configuration
- `popup.html/js` - Extension popup UI
- `content.js` - Content script listener
- `extractor.js` - Main extraction logic
- `jszip.min.js` - JSZip library for creating ZIP files
- `icons/` - Extension icons

## Development

The extension uses:
- Manifest V3
- Content Scripts API
- Chrome Downloads API
- JSZip library for ZIP creation

## Troubleshooting

- If extraction fails, make sure you're on a valid Jira ticket page
- Check browser console for error messages
- Ensure the page has fully loaded before extracting
- Some Jira instances may have different HTML structures - the extractor tries multiple selectors

