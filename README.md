# LinkQueue — LinkedIn invite queue

## Install (2 minutes)
1. Unzip this folder somewhere permanent (e.g. Documents\linkqueue).
2. Open Chrome → `chrome://extensions`
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** → select the `linkqueue` folder.
5. Pin the extension (puzzle icon → pin).

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
- If LinkedIn changes its page layout and "Prepare invite" stops finding the Connect button, just click Connect yourself — the queue, reminders and auto-advance still work.
