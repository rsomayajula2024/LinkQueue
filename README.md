# LinkQueue

**Free Chrome extension for when your weekly LinkedIn invite limit runs out.**
Queue the people you want to connect with, get a reminder when the limit resets, then send each invite — with your personal note filled in — in one click.

Private (everything stays in your browser), no tracking, open source (MIT).

## Install (2 minutes)
1. Click the green **Code** button above → **Download ZIP**.
2. Unzip it somewhere permanent (e.g. `Documents\LinkQueue-main`). Don't delete this folder later — Chrome runs the extension from it.
3. Open Chrome → go to `chrome://extensions`
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** → select the unzipped folder (the one that contains `manifest.json`).
6. Pin it: puzzle icon in the toolbar → pin **LinkQueue**.
7. Click the **LQ** icon → enter **Your name** → **Save**.

**Updating:** download the ZIP again, replace the files in the same folder, then click ↻ on LinkQueue in `chrome://extensions`. Your queue is kept.

## Daily use
- On any LinkedIn profile, click the blue **＋ LinkQueue** button (bottom right). It turns green = queued.
- Or right-click any person's name or photo anywhere on LinkedIn (feed, comments, search, "People you may know") → **Add to LinkQueue**. No need to open the profile.
- When LinkedIn says your weekly limit is hit, open the dashboard (click the extension icon) → **I hit my limit today**.
  (If you hit it during an invite session, this is recorded automatically.)
- Badge on the icon = number queued. Amber = limit still active, green = ready.
- ~7 days later you get a Chrome notification that the limit has reset.

## Sending the batch
1. Dashboard → tick the people (or **Select all**) → **Start invites for selected**.
2. Each profile opens and LinkQueue automatically opens Connect (including from the ⋯ menu), clicks "Add a note" and fills your note.
3. You click **Send**. That's the only click. The next profile opens after a short random pause.
4. If LinkedIn sends the invite as soon as Connect is clicked (no note popup), LinkQueue marks it sent and shows **Next →**.
5. If LinkedIn shows the weekly-limit message, the invite stays in your queue and the session pauses.
6. **Retry** re-runs the prep if a page loaded slowly; **Skip** keeps someone in the queue; **Stop** ends the session.

> Why one click and not fully automatic? Unattended bulk invites are exactly what LinkedIn's anti-automation systems flag, and accounts get restricted. Keeping your own Send click keeps your account safe.

## No double sends
- Sent people move to the **Sent** tab and never come back into the queue.
- On their profile the button shows **✓ Invite sent · date**.
- If you invited someone outside LinkQueue, it spots the "Pending" button on their profile and marks them sent automatically.

## Notes
- Set "Your name" in the dashboard. The default note uses `{firstName}` and `{myName}`. Per-person notes override it.
- Free LinkedIn accounts get only a few personalised notes per month — if the note box doesn't appear, send without one.
- All data stays in your browser (chrome.storage). Nothing is sent anywhere.
- If LinkedIn changes its page layout and **Retry** stops finding the Connect button, click Connect yourself — the queue, reminders and auto-advance still work. Please open an issue so it can be fixed.

## Disclaimer
LinkQueue is an independent project and is not affiliated with, endorsed by, or sponsored by LinkedIn Corporation. Use it within LinkedIn's User Agreement.
