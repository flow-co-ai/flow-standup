"""Write the daily pulse markdown to Google Drive as Daily_Pulse_{date}.
Never raises: any failure prints a warning and returns None."""

import io
import json
import os


def upload_daily_pulse(markdown_text: str, date_str: str, folder_id: str):
    if not folder_id:
        print("  Drive pulse: no pulse_archive_folder_id in config, skipping")
        return None
    sa = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
    if not sa:
        print("  Drive pulse: GOOGLE_SERVICE_ACCOUNT_JSON not set, skipping")
        return None
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaIoBaseUpload

        creds = service_account.Credentials.from_service_account_info(
            json.loads(sa), scopes=["https://www.googleapis.com/auth/drive"]
        )
        service = build("drive", "v3", credentials=creds, cache_discovery=False)
        name = f"Daily_Pulse_{date_str}"
        media = MediaIoBaseUpload(
            io.BytesIO(markdown_text.encode("utf-8")), mimetype="text/plain", resumable=False
        )

        existing = service.files().list(
            q=f"'{folder_id}' in parents and name = '{name}' and trashed = false",
            fields="files(id)", pageSize=1,
        ).execute().get("files", [])

        if existing:
            file = service.files().update(
                fileId=existing[0]["id"], media_body=media
            ).execute()
        else:
            file = service.files().create(
                body={"name": name, "parents": [folder_id],
                      "mimeType": "application/vnd.google-apps.document"},
                media_body=media, fields="id",
            ).execute()
        print(f"  Drive pulse: wrote '{name}'")
        return file.get("id")
    except Exception as exc:
        print(f"  Drive pulse warning (non-blocking): {exc}")
        return None
