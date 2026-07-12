# Flow Standup

Every Monday at 5 AM Chicago time, this tool automatically:

1. Pulls your 4 Monday.com boards (CRM, Ads, Video, Web + SEO)
2. Pulls the last 7 days of Fireflies meeting transcripts
3. Reads any WhatsApp chat exports you've dropped in
4. Reads your playbooks for context
5. Asks Claude AI to write a structured standup report
6. Saves the report as a Markdown file in `standups/`
7. Emails it to you

---

## Folder structure

```
flow-standup/
├── fetch_monday.py       — pulls Monday.com data
├── fetch_fireflies.py    — pulls Fireflies transcripts
├── fetch_whatsapp.py     — reads WhatsApp exports
├── generate.py           — main script (runs everything)
├── send_email.py         — sends the email
├── config.json           — board IDs, your email address, days_back
├── requirements.txt      — Python libraries needed
├── .env.example          — template for your secret keys
├── playbooks/            — drop .md context files here (optional)
├── inbox/whatsapp/       — drop WhatsApp .txt exports here
└── standups/             — generated reports go here
```

---

## One-time setup (local testing)

### 1. Install Python

If you don't have Python installed, download it from [python.org](https://python.org) — get Python 3.11 or newer.

Open your Terminal (Mac: press `⌘ + Space`, type "Terminal") and check:

```bash
python3 --version
```

### 2. Install the libraries

In Terminal, navigate to this folder, then run:

```bash
cd ~/Projects/flow-standup
pip3 install -r requirements.txt
```

### 3. Create your `.env` file

Copy the example file:

```bash
cp .env.example .env
```

Open `.env` in any text editor (TextEdit works) and fill in your five keys:

| Variable | Where to get it |
|---|---|
| `MONDAY_API_TOKEN` | Monday.com → your avatar → Admin → API → Personal API Token |
| `FIREFLIES_API_KEY` | fireflies.ai → Settings → Integrations → API Key |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `GMAIL_ADDRESS` | Your full Gmail address, e.g. `you@gmail.com` |
| `GMAIL_APP_PASSWORD` | Gmail → Google Account → Security → 2-Step Verification → App passwords (create one called "Flow Standup") |

> **Important:** Never share your `.env` file or commit it. It is already listed in `.gitignore` so it will never accidentally go to GitHub.

### 4. Update your email in config.json

Open `config.json` and replace `EMAIL_HERE` with your real email address.

### 5. Test each data source individually

```bash
# Test Monday.com connection
python3 fetch_monday.py

# Test Fireflies connection
python3 fetch_fireflies.py

# Test WhatsApp parser (needs a file in inbox/whatsapp/ — see below)
python3 fetch_whatsapp.py
```

Each script prints a short summary of what it found, so you can confirm the connection works before running the full generator.

### 6. Run the full generator

```bash
python3 generate.py
```

This will run all fetchers, call Claude, write a file to `standups/YYYY-MM-DD.md`, and send the email.

---

## How to drop in a WhatsApp export

1. Open the WhatsApp chat you want included
2. Tap the chat name at the top → **Export Chat** → **Without Media**
3. Share the `.txt` file to your Mac (AirDrop works)
4. Move it into `inbox/whatsapp/` — the filename becomes the chat label in your report
5. **Do not rename it** to something private — the filename appears in the report

The standup will automatically pick up `.txt` files in that folder. They are excluded from git (your private messages will never be committed).

---

## Adding a playbook

Drop any `.md` file into the `playbooks/` folder. Its contents will be included as context when Claude writes the report. Good examples: a client brief, a campaign overview, your ICP description.

---

## Setting up on GitHub (automated weekly runs)

### Step 1: Create the GitHub repo

After reviewing this project locally, you and your helper will run:

```bash
git remote add origin https://github.com/YOUR_USERNAME/flow-standup.git
git push -u origin main
```

### Step 2: Add your secrets

1. Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret** for each of the five variables:
   - `MONDAY_API_TOKEN`
   - `FIREFLIES_API_KEY`
   - `ANTHROPIC_API_KEY`
   - `GMAIL_ADDRESS`
   - `GMAIL_APP_PASSWORD`

These are encrypted by GitHub and only exposed to the workflow — they are never visible after you save them.

### Step 3: Trigger a manual test run

1. Go to your GitHub repo → **Actions** tab
2. Click **Weekly Standup** in the left sidebar
3. Click **Run workflow** → **Run workflow**

Watch the run — each step should show a green checkmark. The standup file will appear in `standups/` and you'll get the email.

---

## Schedule

The workflow runs automatically every **Monday at 10:00 UTC**, which is:
- 5:00 AM Chicago time (CDT, April–November)
- 4:00 AM Chicago time (CST, November–April)

You can always trigger a manual run any time using the **Run workflow** button.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `MONDAY_API_TOKEN is not set` | Check your `.env` file has the key, and the file is named `.env` (not `.env.txt`) |
| `401 Unauthorized` from Fireflies | Your Fireflies API key may have expired — regenerate it |
| Email not received | Check Gmail's spam folder; make sure you used an **App Password** not your Gmail login password |
| GitHub Action fails | Go to Actions tab → click the failed run → expand the failed step to read the error |
