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

## Setting up shared checkmarks (Flow Ops dashboard)

The Flow Ops dashboard lets anyone with the passcode mark client rows as "handled." Those checkmarks sync to GitHub and load instantly on any device — phone, laptop, a colleague's browser — without a login.

Here is how it works and how to set it up:

- **Reading** checkmarks is public. The saved state is a plain file on a `state` branch of this repo. Any browser can fetch it without a password.
- **Writing** checkmarks requires a shared passcode. The first time you check a row in the dashboard, a small bar appears at the bottom of the page asking for the passcode. Type it in and it is remembered in your browser. Anyone who needs to check rows off gets the same passcode from you directly (share it over WhatsApp or Slack).

---

### Step 1: Create a GitHub access token for writing

You need to give the dashboard permission to save checkmark files to this repo. You do this by creating a "fine-grained personal access token" — a narrow key that can only touch this one repo.

1. Go to [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta) (you must be logged in as the repo owner, `flow-co-ai`)
2. Click **Generate new token**
3. Fill in:
   - **Token name:** `flow-standup state writer`
   - **Expiration:** 1 year (or No expiration — your choice)
   - **Resource owner:** `flow-co-ai`
   - **Repository access:** select **Only select repositories** → choose `flow-standup`
4. Under **Permissions**, expand **Repository permissions** and find **Contents** — set it to **Read and write**
5. Leave everything else at "No access"
6. Click **Generate token** at the bottom
7. Copy the token — it starts with `github_pat_`. You will not be able to see it again after you leave this page.

This token becomes your `GH_STATE_TOKEN`.

---

### Step 2: Add the two environment variables in Netlify

These two variables go into your **Netlify site settings** — not in GitHub Secrets. The dashboard function runs on Netlify, so that is where it reads them.

1. Go to your Netlify dashboard → open the `flow-standup` site → **Site configuration** → **Environment variables**
2. Click **Add a variable** for each of the following:

| Variable | Value |
|---|---|
| `GH_STATE_TOKEN` | The token you just copied from GitHub (starts with `github_pat_`) |
| `OPS_PASSCODE` | Any password you choose — share this with your team so they can check rows off |

3. Save. No redeploy is needed — the function reads these at runtime.

> **Do not add these to GitHub Secrets.** GitHub Secrets are only for GitHub Actions workflows. These two variables are only needed by the Netlify function.

---

### Step 3: Verify it works

1. Open the Flow Ops dashboard
2. Click the circle next to any client row
3. A bar appears at the bottom — type the `OPS_PASSCODE` you set in Step 2 and press Enter
4. The circle should fill, and a small "saved" message should flash in the footer
5. Open the dashboard in a different browser (or send the link to a colleague) — the checkmark should already be there

If you see "GitHub write failed" in the footer, double-check that:
- `GH_STATE_TOKEN` is entered correctly in Netlify (no extra spaces)
- The token has **Contents: Read and write** permission on the `flow-standup` repo
- The token has not expired

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `MONDAY_API_TOKEN is not set` | Check your `.env` file has the key, and the file is named `.env` (not `.env.txt`) |
| `401 Unauthorized` from Fireflies | Your Fireflies API key may have expired — regenerate it |
| Email not received | Check Gmail's spam folder; make sure you used an **App Password** not your Gmail login password |
| GitHub Action fails | Go to Actions tab → click the failed run → expand the failed step to read the error |
| Checkmarks not saving | See Step 3 above — confirm `GH_STATE_TOKEN` and `OPS_PASSCODE` are set in Netlify site settings |
| "Invalid or missing passcode" in browser console | The passcode stored in your browser does not match `OPS_PASSCODE` in Netlify — clear your browser's localStorage for this site and re-enter the passcode |
