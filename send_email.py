"""
send_email.py — Sends the standup report via Gmail SMTP (SSL, port 465).
Requires GMAIL_ADDRESS and GMAIL_APP_PASSWORD env vars.
"""

import os
import re
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from dotenv import load_dotenv

load_dotenv()


def markdown_to_simple_html(md: str) -> str:
    """Convert the subset of Markdown we use into plain HTML for email clients."""
    lines = md.split("\n")
    html = []
    in_list = False

    for line in lines:
        # Headings
        if line.startswith("# "):
            if in_list:
                html.append("</ul>")
                in_list = False
            html.append(f"<h1>{line[2:].strip()}</h1>")
        elif line.startswith("## "):
            if in_list:
                html.append("</ul>")
                in_list = False
            html.append(f"<h2>{line[3:].strip()}</h2>")
        elif line.startswith("### "):
            if in_list:
                html.append("</ul>")
                in_list = False
            html.append(f"<h3>{line[4:].strip()}</h3>")
        # Bullet list items
        elif re.match(r"^[-*] ", line):
            if not in_list:
                html.append("<ul>")
                in_list = True
            content = line[2:].strip()
            content = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", content)
            content = re.sub(r"\*(.+?)\*", r"<em>\1</em>", content)
            html.append(f"  <li>{content}</li>")
        # Horizontal rule
        elif line.strip().startswith("---"):
            if in_list:
                html.append("</ul>")
                in_list = False
            html.append("<hr>")
        # Blank line
        elif line.strip() == "":
            if in_list:
                html.append("</ul>")
                in_list = False
            html.append("<br>")
        # Normal paragraph
        else:
            if in_list:
                html.append("</ul>")
                in_list = False
            content = line.strip()
            content = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", content)
            content = re.sub(r"\*(.+?)\*", r"<em>\1</em>", content)
            html.append(f"<p>{content}</p>")

    if in_list:
        html.append("</ul>")

    body = "\n".join(html)
    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body  {{ font-family: -apple-system, Arial, sans-serif; max-width: 780px;
           margin: 0 auto; padding: 24px; color: #222; line-height: 1.5; }}
  h1   {{ color: #1a1a2e; border-bottom: 3px solid #3498db; padding-bottom: 8px; }}
  h2   {{ color: #2c3e50; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-top: 28px; }}
  h3   {{ color: #555; margin-top: 16px; }}
  ul   {{ padding-left: 20px; }}
  li   {{ margin: 5px 0; }}
  hr   {{ border: none; border-top: 1px solid #ddd; margin: 20px 0; }}
  p    {{ margin: 6px 0; }}
</style>
</head>
<body>
{body}
</body>
</html>"""


def send_standup_email(subject: str, plain_text: str, html_content: str, to_address: str) -> None:
    gmail_address = os.environ.get("GMAIL_ADDRESS", "")
    app_password = os.environ.get("GMAIL_APP_PASSWORD", "")

    if not gmail_address or not app_password:
        raise ValueError("GMAIL_ADDRESS and GMAIL_APP_PASSWORD must both be set")

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = gmail_address
    msg["To"] = to_address

    # Email clients prefer the last attachment, so HTML goes second
    msg.attach(MIMEText(plain_text, "plain", "utf-8"))
    msg.attach(MIMEText(html_content, "html", "utf-8"))

    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ctx) as server:
        server.login(gmail_address, app_password)
        server.sendmail(gmail_address, to_address, msg.as_string())

    print(f"  ✓ Email sent → {to_address}")
