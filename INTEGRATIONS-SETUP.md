# Comments, Slack and Outlook: setup

Everything here is free. It uses features already in your Supabase plan (database functions, a weekly schedule, one Edge Function) and Slack's free incoming webhooks.

About 20 minutes, once. You need admin access to Supabase and permission to add an app to your Slack workspace.

| Part | What it turns on | Needed for |
|---|---|---|
| 1. Run the SQL | Viewers can comment, @mentions, "Since the last meeting" status changes | Everything below |
| 2. Connect Slack | Instant alerts and the Monday digest | Slack |
| 3. Deploy the calendar function | Calendar links that keep Outlook up to date | Outlook subscriptions |
| 4. Add owner emails | Fills in the To line on email buttons | Email buttons |
| 5. Publish the site | Puts the new app files on the live site | Everyone seeing the changes |

Downloading a calendar file and the email buttons work without parts 1 to 3.

## 1. Run the SQL

1. In Supabase, open **SQL Editor**, then **New query**.
2. Paste all of `supabase-collab-integrations.sql` and click **Run**.
3. The results at the bottom should list 2 triggers, 1 scheduled job (`growth-weekly-digest`) and 8 functions.

It's safe to run again. If anything fails, nothing changes.

## 2. Connect Slack

**Get a webhook link from Slack**
1. Go to api.slack.com/apps and click **Create New App**, then **From scratch**.
2. Name it `Growth Hub`, pick your KIPP workspace, and click **Create App**.
3. In the left menu, click **Incoming Webhooks** and turn it **On**.
4. Click **Add New Webhook to Workspace**, choose the committee channel, and click **Allow**.
   If Slack says an admin must approve the app, ask your Slack admin. It only posts to that one channel.
5. Copy the link. It starts with `https://hooks.slack.com/services/`.

**Paste it in Growth Hub**
1. Open Growth Hub, then **Settings** > **Slack alerts and digest**.
2. Paste the link and click **Connect Slack**.
3. Click **Send a test message** and check the channel.

The link is stored in the database where the website and other users can't read it.

**What posts to Slack**
- A milestone is set to at risk, behind, or blocked (with the blocker)
- A key milestone or greenlight is done
- Someone is @mentioned in a comment (with the comment)
- A school's opening date moves
- Every Monday at 8am Eastern: overdue, due this week, blocked, marked at risk or behind, and check-ins needed by owner

A bulk change, like an import, posts one short summary instead of many messages. Each item links straight to the milestone. Turn alerts or the digest off with the checkboxes in Settings.

Slack @mentions name the person in bold. They don't ping their Slack account, because Growth Hub doesn't know Slack usernames.

## 3. Deploy the calendar function

This lets people subscribe in Outlook so their calendar updates on its own.

1. In Supabase, open **Edge Functions**, then **Deploy a new function** > **Via Editor**.
2. Name it exactly `growth-calendar`.
3. Delete the sample code, paste all of `supabase/functions/growth-calendar/index.ts`, and click **Deploy**.
4. Open the function's **Settings** and turn **off** "Enforce JWT verification." Save.
   Calendar apps can't sign in, so the private code in each person's link does that job.
5. Check it: in Growth Hub, open your name menu > **Add deadlines to Outlook**. You should see "My milestones" and "All milestones" links.

If you use the Supabase command line instead: `supabase functions deploy growth-calendar --no-verify-jwt`

**How people subscribe (share this with the committee)**
1. In Growth Hub, open your name menu > **Add deadlines to Outlook** and click **Copy**.
2. In Outlook, go to Calendar > **Add calendar** > **Subscribe from web**.
3. Paste the link, name it "Growth Hub," and click **Import**.

In classic Outlook for Windows: Home > **Add Calendar** > **From Internet**.

Outlook checks for changes every few hours. Each person's link is private. If one is shared by mistake, **Get a new link** turns the old one off.

## 4. Add owner emails

Settings > **Customize markets, teams, and owners** > Owners. Add each person's KIPP email. The "Email" buttons then fill in the To line. Without emails, the buttons still open a written message with the To line blank.

## 5. Publish the site

The app changes (`app.js`, `styles.css`, `index.html`) are on this computer only. They go live after they're pushed to the GitHub Pages site, the same way as earlier updates. Run part 1 first: until then, comments from viewers and the Settings > Slack section show a "not set up yet" message, and everything else works.

## Turning it off

- **Slack:** Settings > Slack alerts and digest > **Disconnect**. Or uncheck alerts or the digest.
- **Calendar links:** delete the `growth-calendar` Edge Function. Subscribed calendars stop updating.
- **Remove all of it from the database:** run this in the SQL Editor.

```sql
drop trigger if exists slack_milestone_alerts on public.growth_milestones;
drop trigger if exists slack_school_alerts on public.growth_schools;
select cron.unschedule('growth-weekly-digest');
delete from private.growth_integrations where key = 'slack_webhook';
```

To make comments editor-only again, run the `growth_add_note` part of `supabase-team-sync.sql` again.

## Good to know

- **Slack messages include milestone names, owners and comments.** Use a private channel for the committee.
- **Email is not sent automatically.** The buttons open Outlook with the message written, and you press Send. Automatic email needs a mail service set up on a KIPP domain by IT. Slack covers alerts for now.
- **"Since the last meeting"** uses the date set by **Mark meeting held**. Before the first one, it shows the last month.
