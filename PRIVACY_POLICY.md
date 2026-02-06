# Privacy Policy for Jira Ticket Extractor

**Last Updated:** February 6, 2026

## 1. Data Collection and Usage
The **Jira Ticket Extractor** extension is designed with privacy as a priority. 

- **No Remote Data Collection**: We do not collect, store, or transmit any of your personal data, ticket data, or browsing activity to our own servers or any third parties.
- **Local Processing**: All data extraction and processing happens locally within your browser.
- **Direct Communication**: The extension communicates directly between your browser and your Jira instance (e.g., `*.atlassian.net` or your self-hosted Jira domain) to fetch ticket details and attachments.

## 2. Permissions
The extension requests the following permissions to function:
- **activeTab**: To identify the current Jira ticket and inject the extraction script.
- **scripting**: To run the logic extracting ticket fields from the page.
- **downloads**: To save the generated `.json` or `.zip` file to your computer.
- **storage**: To save your preferences locally (e.g., API tokens or settings).
- **Host Permissions (<all_urls>)**: This is strictly required to fetch attachments (images, PDFs, log files) included in your Jira tickets. These files are often hosted on various content delivery networks (CDNs) such as AWS S3 or Azure Blob Storage, which have different domains than your Jira instance. The extension downloads these files directly to your machine to include them in the export.

## 3. Data Security
- Your Jira API tokens and credentials (if used) are stored in your browser's local synchronized storage (`chrome.storage.sync`) and are never sent to us.
- Generated exports are saved solely to your local "Downloads" folder.

## 4. Contact
If you have questions about this policy, please contact the developer via the Chrome Web Store support page.
