import os
import urllib.request
import urllib.parse
import urllib.error
import json
import base64
import sys

# Get credentials from env
BASE_URL = os.environ.get('JIRA_BASE_URL')
EMAIL = os.environ.get('JIRA_EMAIL')
TOKEN = os.environ.get('JIRA_API_TOKEN')

if not all([BASE_URL, EMAIL, TOKEN]):
    print("Missing credentials in environment variables")
    sys.exit(1)

auth_str = f"{EMAIL}:{TOKEN}"
# Python's b64encode adds newlines? No, but let's be safe and replicate specific behavior
b64_auth = base64.b64encode(auth_str.encode("utf-8")).decode("utf-8")
auth_header = f"Basic {b64_auth}"
print(f"Auth Header Prefix: {auth_header[:15]}...") # Print prefix for safety check

headers = {
    "Authorization": auth_header,
    "Accept": "application/json",
    "Content-Type": "application/json"
}

print(f"Testing with Base URL: {BASE_URL}")
print(f"Email: {EMAIL}")

# 0. specific checks
myself_url = f"{BASE_URL}/rest/api/3/myself"
print(f"Checking identity: {myself_url}")
req_me = urllib.request.Request(myself_url, headers=headers)
try:
    with urllib.request.urlopen(req_me) as response:
        data = json.load(response)
        print(f"Authenticated as: {data.get('emailAddress')} ({data.get('displayName')})")
except urllib.error.HTTPError as e:
    print(f"Auth Check Failed: {e.code} {e.reason}")
    sys.exit(1)

# 1. Fetch specific issue
issue_key = "AUCWI-518"
issue_url = f"{BASE_URL}/rest/api/3/issue/{issue_key}"

print(f"Fetching issue: {issue_url}")

req = urllib.request.Request(issue_url, headers=headers)
try:
    with urllib.request.urlopen(req) as response:
        data = json.load(response)
        fields = data.get('fields', {})
        attachments = fields.get('attachment', [])
        
        print(f"Issue found: {issue_key}")
        print(f"Number of attachments found: {len(attachments)}")
        
        if not attachments:
            print("No attachments found in issue fields.")
            # print("Available fields:", list(fields.keys()))
            sys.exit(0)
            
        target_attachment = attachments[0]
        content_url = target_attachment['content']
        filename = target_attachment['filename']
        print(f"Found issue: {issue_key}")
        print(f"Found attachment: {filename}")
        print(f"Content URL: {content_url}")
        
        # 2. Try to download attachment - TEST S3 AUTH REJECTION
        print("\nAttempting download with Authorization header...")
        
        # We want to catch the redirect URL and then FORCE the header on it
        class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
            def http_error_302(self, req, fp, code, msg, headers):
                print("\n--- 302 Redirect Response Headers ---")
                for k, v in headers.items():
                    print(f"{k}: {v}")
                print("-------------------------------------")
                # Return the response object to STOP following the redirect
                return fp
            
            http_error_301 = http_error_302
            http_error_303 = http_error_302
            http_error_307 = http_error_302
        
        opener = urllib.request.build_opener(NoRedirectHandler)
        download_req = urllib.request.Request(content_url, headers=headers)
        
        s3_url = None
        try:
            with opener.open(download_req) as response:
                if response.status in [301, 302, 303, 307]:
                    s3_url = response.headers.get('Location')
                    print(f"Got Redirect URL: {s3_url[:50]}...")
                elif response.status == 200:
                   print("Download succeeded directly (No redirect).")
                   print(f"Final URL: {response.geturl()}")
                   print("\n--- 200 Response Headers ---")
                   for k, v in response.headers.items():
                       print(f"{k}: {v}")
                   print("----------------------------")
        except urllib.error.HTTPError as e:
            if e.code in [301, 302, 303, 307]:
                 print("\n--- 302 Error Response Headers ---")
                 for k, v in e.headers.items():
                     print(f"{k}: {v}")
                 print("----------------------------------")
                 s3_url = e.headers.get('Location')
            else:
                 print(f"Unexpected error: {e}")
                 sys.exit(1)
                
        if s3_url:
            print("\nVerifying download from S3...")
            
            # TEST PREFLIGHT for Authorization header
            print("Testing CORS Preflight (OPTIONS) with Authorization header...")
            s3_options_req = urllib.request.Request(s3_url, method='OPTIONS')
            s3_options_req.add_header("Origin", "chrome-extension://dummy-id")
            s3_options_req.add_header("Access-Control-Request-Method", "GET")
            s3_options_req.add_header("Access-Control-Request-Headers", "authorization")
            
            try:
                with urllib.request.urlopen(s3_options_req) as options_response:
                    print(f"S3 Preflight Status: {options_response.status}")
                    print("S3 Headers for OPTIONS:")
                    for k, v in options_response.headers.items():
                        print(f"{k}: {v}")
            except urllib.error.HTTPError as e:
                print(f"S3 Preflight FAILED: {e.code} {e.reason}")
                print("Headers:")
                print(e.headers)
                print("If this failed, the browser blocked the request due to Preflight check.")

            # We know S3 works without auth (signed URL), so let's check its headers too
            no_auth_req = urllib.request.Request(s3_url) # No headers
            try:
                with urllib.request.urlopen(no_auth_req) as success_response:
                    print(f"S3 Download Status: {success_response.status}")
                    print("\n--- S3 Response Headers ---")
                    for k, v in success_response.headers.items():
                        print(f"{k}: {v}")
                    print("---------------------------")
            except Exception as e:
                print(f"S3 Download Failed: {e}")

except urllib.error.HTTPError as e:
    print(f"Search API Error: {e.code} {e.reason}")
    print(e.read().decode())
except Exception as e:
    print(f"Error: {e}")
