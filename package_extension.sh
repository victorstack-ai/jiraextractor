#!/bin/bash

# Name of the output file
OUTPUT_FILE="jiraextractor.zip"

# Build the zip file
# Excludes:
# - .git directory
# - .gitignore
# - venv directory
# - The script itself
# - README/PRIVACY_POLICY (optional, but usually not needed inside the extension package, though good for reference)
# - Any other dev-specific files

echo "Packaging extension into $OUTPUT_FILE..."

# Remove old zip if exists
if [ -f "$OUTPUT_FILE" ]; then
    rm "$OUTPUT_FILE"
fi

zip -r "$OUTPUT_FILE" . \
    -x "*.git*" \
    -x "venv/*" \
    -x "create_icons*" \
    -x "package_extension.sh" \
    -x "*.DS_Store" \
    -x "README.md" \
    -x "CHECKLIST_EXTRACTION_ISSUE.md" \
    -x "node_modules/*"

echo "Done! $OUTPUT_FILE created."
echo "You can now upload $OUTPUT_FILE to the Chrome Web Store Developer Dashboard."
