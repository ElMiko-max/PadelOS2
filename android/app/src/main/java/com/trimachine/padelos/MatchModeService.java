package com.trimachine.padelos;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import android.view.View;
import android.widget.RemoteViews;
import androidx.core.app.NotificationCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

// Foreground Service that owns the persistent "Match Mode" notification.
// Lives independently of MainActivity — this is what lets the notification stay up
// even if the Activity/WebView has gone to sleep in the background.
//
// IMPORTANT DESIGN NOTE: court-winner / generate button taps are handled RIGHT HERE,
// against an in-memory copy of the current round (currentCourts etc.) — NOT by round-
// tripping through the JS bridge first. This is what makes the notification's own
// checkmarks and "Generate Next Round" button update instantly and reliably, regardless
// of whether the WebView happens to be responsive at that exact moment. We still try to
// forward the tap to JS (best-effort, via MatchModePlugin.instance) so the real Firestore
// data gets updated whenever the JS is alive to process it — but the notification's own
// visual state no longer depends on that succeeding.
public class MatchModeService extends Service {

    public static final String ACTION_START = "com.trimachine.padelos.MM_START";
    public static final String ACTION_UPDATE = "com.trimachine.padelos.MM_UPDATE";
    public static final String ACTION_STOP = "com.trimachine.padelos.MM_STOP";
    public static final String ACTION_SCHEDULE_ALL = "com.trimachine.padelos.MM_SCHEDULE_ALL";
    public static final String ACTION_COURT_WINNER = "com.trimachine.padelos.MM_COURT_WINNER";
    public static final String ACTION_GENERATE = "com.trimachine.padelos.MM_GENERATE";
    public static final String CHANNEL_ID = "matchkeeper_match_mode";
    public static final int NOTIF_ID = 4201;
    public static final int MAX_COURTS = 6;
    public static final int MAX_ROUNDS = 40; // generous ceiling for cancelling stale alarms

    // In-memory snapshot of "what the notification is currently showing" — this is the
    // source of truth for instant local updates on button taps.
    private String currentEventId = "";
    private int currentRoundNumber = 0;
    private long currentWhistleAt = 0L;
    private String currentBreakPlayers = "";
    private boolean currentIsLastRound = false;
    // False only for CT League's display-only payload — courts render as plain info rows
    // with no tap targets there, since result entry stays in-app (score steppers). Absent
    // from the Intent (CI, Ladder) defaults to true via the plugin bridge.
    private boolean currentInteractive = true;
    private final List<CourtInfo> currentCourts = new ArrayList<>();

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_START.equals(action) || ACTION_UPDATE.equals(action)) {
            currentEventId = intent.getStringExtra("eventId");
            if (currentEventId == null) currentEventId = "";
            currentRoundNumber = intent.getIntExtra("roundNumber", 0);
            currentWhistleAt = intent.getLongExtra("whistleAt", 0L);
            currentBreakPlayers = intent.getStringExtra("breakPlayers");
            currentIsLastRound = intent.getBooleanExtra("isLastRound", false);
            currentInteractive = intent.getBooleanExtra("interactive", true);
            String courtsJson = intent.getStringExtra("courtsJson");
            if (courtsJson == null) courtsJson = "[]";
            currentCourts.clear();
            currentCourts.addAll(parseCourts(courtsJson));
            startForeground(NOTIF_ID, buildNotification());
        } else if (ACTION_SCHEDULE_ALL.equals(action)) {
            String eventId = intent.getStringExtra("eventId");
            String scheduleJson = intent.getStringExtra("scheduleJson");
            scheduleAllWhistles(eventId != null ? eventId : "", scheduleJson != null ? scheduleJson : "[]");
        } else if (ACTION_COURT_WINNER.equals(action)) {
            handleCourtWinnerTap(intent);
        } else if (ACTION_GENERATE.equals(action)) {
            handleGenerateTap();
        } else if (ACTION_STOP.equals(action)) {
            cancelAllWhistles();
            stopForeground(true);
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    // Updates our own local notification state immediately — no dependency on the JS
    // bridge being alive — then forwards the tap to JS right away. Capacitor's bridge
    // delivers this to the existing WebView (a message to an already-running app
    // process, not launching a new Activity — Android doesn't block that) even while the
    // app isn't in the foreground, which is what reliably got real results into Firestore
    // before we over-complicated this with a foreground check and a durable queue.
    private void handleCourtWinnerTap(Intent intent) {
        int court = intent.getIntExtra("court", -1);
        String team = intent.getStringExtra("team");
        if (team == null) team = "A";
        for (int i = 0; i < currentCourts.size(); i++) {
            CourtInfo c = currentCourts.get(i);
            if (c.court == court) {
                currentCourts.set(i, new CourtInfo(c.court, c.teamA, c.teamB, team, c.balance, c.group));
                break;
            }
        }
        // Instant visual feedback regardless of JS state — the checkmark shows immediately.
        startForeground(NOTIF_ID, buildNotification());

        MatchModePlugin plugin = MatchModePlugin.instance;
        if (plugin != null) plugin.emitCourtWinner(court, team);
    }

    // "Generate Next Round" genuinely needs the Match Generation Engine, which only
    // exists in JS (break rotation, partner-diversity rules — too complex/risky to
    // duplicate natively). Same direct-forward approach as the winner tap above — the JS
    // side protects itself against incomplete data (nextRoundCI re-checks fresh results
    // before generating, see App.jsx), so this is safe even if the bridge message takes a
    // moment to actually run.
    private void handleGenerateTap() {
        MatchModePlugin plugin = MatchModePlugin.instance;
        if (plugin != null) plugin.emitGenerateNextRound();
    }

    // Schedules every round's whistle alarm in one shot, right when Match Mode starts.
    // This is what lets rounds 2, 3, 4... keep ringing on their own — the whistle no
    // longer depends on the app re-running this logic each time a round is generated.
    //
    // Uses AlarmManager.setAlarmClock() — the exact same high-priority alarm category the
    // phone's own Clock/Alarm app uses. It's specifically designed to be exempt from Doze
    // and most manufacturer battery-saving restrictions, which is what real alarm clocks
    // rely on to ring reliably. The regular "exact and allow while idle" alarms we used
    // before are still subject to some throttling on aggressive devices (like Samsung) —
    // this is a stronger guarantee.
    private void scheduleAllWhistles(String eventId, String scheduleJson) {
        cancelAllWhistles();
        clearFiredFlags(eventId);
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am == null) { android.util.Log.e("MatchModeDiag", "AlarmManager service unavailable"); return; }
        try {
            JSONArray arr = new JSONArray(scheduleJson);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                int round = o.optInt("round", i + 1);
                long whistleAt = 0L;
                try { whistleAt = Long.parseLong(o.optString("whistleAt", "0")); } catch (NumberFormatException ignored) {}
                long now = System.currentTimeMillis();
                if (whistleAt <= 0 || whistleAt <= now) {
                    android.util.Log.w("MatchModeDiag", "skipping round " + round + " — whistleAt=" + whistleAt + " now=" + now + " (already past or invalid)");
                    continue;
                }
                PendingIntent pi = whistlePendingIntent(round, eventId, "final");
                try {
                    AlarmManager.AlarmClockInfo info = new AlarmManager.AlarmClockInfo(whistleAt, contentPendingIntent());
                    am.setAlarmClock(info, pi);
                    android.util.Log.i("MatchModeDiag", "setAlarmClock OK for round " + round + " at " + whistleAt + " (in " + ((whistleAt-now)/1000) + "s)");
                } catch (Exception e) {
                    android.util.Log.e("MatchModeDiag", "setAlarmClock FAILED for round " + round + ": " + e, e);
                    // Extremely rare fallback path, in case setAlarmClock itself is refused.
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, whistleAt, pi);
                        } else {
                            am.setExact(AlarmManager.RTC_WAKEUP, whistleAt, pi);
                        }
                        android.util.Log.i("MatchModeDiag", "fallback setExactAndAllowWhileIdle OK for round " + round);
                    } catch (SecurityException se) {
                        am.set(AlarmManager.RTC_WAKEUP, whistleAt, pi);
                        android.util.Log.w("MatchModeDiag", "fallback plain set() used for round " + round + " (no exact-alarm permission): " + se);
                    }
                }

                // 5-minute-before warning — silent, separate notification. Only scheduled
                // if that moment is still in the future (skip it for an already-compressed
                // round shorter than 5 minutes, or if we're starting late into the round).
                long warnAt = whistleAt - 5*60*1000;
                if (warnAt > now) {
                    PendingIntent warnPi = whistlePendingIntent(round, eventId, "warning");
                    try {
                        AlarmManager.AlarmClockInfo warnInfo = new AlarmManager.AlarmClockInfo(warnAt, contentPendingIntent());
                        am.setAlarmClock(warnInfo, warnPi);
                    } catch (Exception e) {
                        try {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, warnAt, warnPi);
                            } else {
                                am.setExact(AlarmManager.RTC_WAKEUP, warnAt, warnPi);
                            }
                        } catch (SecurityException se) {
                            am.set(AlarmManager.RTC_WAKEUP, warnAt, warnPi);
                        }
                    }
                }
            }
        } catch (Exception e) {
            android.util.Log.e("MatchModeDiag", "scheduleAllWhistles: malformed schedule payload", e);
        }
    }

    private void clearFiredFlags(String eventId) {
        android.content.SharedPreferences prefs = getSharedPreferences("matchmode_whistles", MODE_PRIVATE);
        android.content.SharedPreferences.Editor editor = prefs.edit();
        for (int round = 1; round <= MAX_ROUNDS; round++) editor.remove("fired_" + eventId + "_" + round);
        editor.apply();
    }

    private void cancelAllWhistles() {
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        for (int round = 1; round <= MAX_ROUNDS; round++) {
            am.cancel(whistlePendingIntent(round, currentEventId, "final"));
            am.cancel(whistlePendingIntent(round, currentEventId, "warning"));
        }
    }

    private PendingIntent whistlePendingIntent(int round, String eventId, String type) {
        Intent intent = new Intent(this, MatchModeWhistleReceiver.class);
        intent.putExtra("round", round);
        intent.putExtra("eventId", eventId);
        intent.putExtra("type", type);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        // Distinct request code per round AND per type so each alarm is independent and
        // can coexist with the others instead of overwriting/cancelling one another.
        int base = "warning".equals(type) ? 3500 : 3000;
        return PendingIntent.getBroadcast(this, base + round, intent, flags);
    }

    private List<CourtInfo> parseCourts(String json) {
        List<CourtInfo> list = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                String winner = o.isNull("winner") ? null : o.optString("winner", null);
                list.add(new CourtInfo(
                        o.optInt("court", i + 1),
                        o.optString("teamA", "Team A"),
                        o.optString("teamB", "Team B"),
                        winner,
                        o.optString("balance", ""),
                        o.optString("group", "")
                ));
            }
        } catch (Exception e) {
            // Malformed payload — show an empty notification rather than crash the service.
        }
        return list;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID, "Match Mode", NotificationManager.IMPORTANCE_LOW);
                channel.setDescription("Persistent notification while Match Mode is running");
                channel.setShowBadge(false);
                nm.createNotificationChannel(channel);
            }
        }
    }

    // Buttons now target this Service directly (PendingIntent.getService) instead of a
    // separate BroadcastReceiver — the Service is what holds the in-memory state needed
    // for an instant local update.
    private PendingIntent actionPendingIntent(String action, int court, String team, int requestCode) {
        Intent intent = new Intent(this, MatchModeService.class);
        intent.setAction(action);
        intent.putExtra("court", court);
        intent.putExtra("team", team);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getService(this, requestCode, intent, flags);
    }

    private PendingIntent contentPendingIntent() {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launchIntent == null) launchIntent = new Intent();
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(this, 998, launchIntent, flags);
    }

    // Rebuilds the notification purely from our in-memory state (currentCourts etc.) —
    // no JS/network round-trip needed, which is what makes button taps feel instant.
    private Notification buildNotification() {
        ensureChannel();
        String eventId = currentEventId;
        int roundNumber = currentRoundNumber;
        long whistleAt = currentWhistleAt;
        String breakPlayers = currentBreakPlayers;
        List<CourtInfo> courts = currentCourts;

        boolean allDone = !courts.isEmpty();
        for (CourtInfo c : courts) if (c.winner == null) allDone = false;

        // Chronometer.setBase() takes a time in SystemClock.elapsedRealtime() units, not
        // wall-clock epoch millis — convert the wall-clock whistle time we were given.
        long chronoBase = SystemClock.elapsedRealtime() + (whistleAt - System.currentTimeMillis());
        boolean showCountdown = whistleAt > 0 && !allDone;

        RemoteViews small = new RemoteViews(getPackageName(), R.layout.notification_match_mode_small);
        small.setTextViewText(R.id.mm_small_title, "Match Mode — Round " + roundNumber);
        String clockStr = whistleAt > 0 ? new SimpleDateFormat("h:mm a", Locale.getDefault()).format(new Date(whistleAt)) : null;
        small.setTextViewText(R.id.mm_small_subtitle,
                allDone ? (currentIsLastRound ? "🏁 Last round complete — event finished" : "All courts done — tap to generate next round")
                        : (clockStr != null ? ("Round ends at " + clockStr) : "Tap to expand and declare winners"));
        if (showCountdown) {
            setCountdown(small, R.id.mm_small_countdown, chronoBase);
            small.setViewVisibility(R.id.mm_small_countdown, View.VISIBLE);
        } else {
            small.setViewVisibility(R.id.mm_small_countdown, View.GONE);
        }

        RemoteViews big = new RemoteViews(getPackageName(), R.layout.notification_match_mode);
        big.setTextViewText(R.id.mm_round_title, "Round " + roundNumber);
        big.removeAllViews(R.id.mm_court_container);
        if (showCountdown) {
            setCountdown(big, R.id.mm_countdown, chronoBase);
            big.setViewVisibility(R.id.mm_countdown, View.VISIBLE);
            big.setTextViewText(R.id.mm_whistle_label, "🔔 ends at " + clockStr);
            big.setViewVisibility(R.id.mm_whistle_label, View.VISIBLE);
        } else {
            big.setViewVisibility(R.id.mm_countdown, View.GONE);
            big.setViewVisibility(R.id.mm_whistle_label, View.GONE);
        }

        int idx = 0;
        for (CourtInfo c : courts) {
            if (idx >= MAX_COURTS) break;
            if (!currentInteractive || c.winner == null) {
                // Same row layout for both the normal interactive case (CI/Ladder, tappable)
                // and CT League's display-only case — League just skips wiring the click
                // listeners below, since result entry for it stays in-app.
                RemoteViews row = new RemoteViews(getPackageName(), R.layout.notification_match_court_row);
                String label = "COURT " + c.court + (c.group != null && !c.group.isEmpty() ? " · GROUP " + c.group : "");
                row.setTextViewText(R.id.mm_court_label, label);
                if (c.balance != null && !c.balance.isEmpty()) {
                    row.setTextViewText(R.id.mm_balance_label, c.balance);
                    row.setViewVisibility(R.id.mm_balance_label, View.VISIBLE);
                } else {
                    row.setViewVisibility(R.id.mm_balance_label, View.GONE);
                }
                row.setTextViewText(R.id.mm_team_a_btn, c.teamA);
                row.setTextViewText(R.id.mm_team_b_btn, c.teamB);
                if (currentInteractive) {
                    row.setOnClickPendingIntent(R.id.mm_team_a_btn,
                            actionPendingIntent(ACTION_COURT_WINNER, c.court, "A", 1000 + idx * 2));
                    row.setOnClickPendingIntent(R.id.mm_team_b_btn,
                            actionPendingIntent(ACTION_COURT_WINNER, c.court, "B", 1000 + idx * 2 + 1));
                }
                big.addView(R.id.mm_court_container, row);
            } else {
                RemoteViews done = new RemoteViews(getPackageName(), R.layout.notification_match_court_done);
                done.setTextViewText(R.id.mm_court_label_done, "COURT " + c.court);
                String winnerLabel = "A".equals(c.winner) ? c.teamA : c.teamB;
                done.setTextViewText(R.id.mm_court_done_text, "✅ " + winnerLabel + " won");
                big.addView(R.id.mm_court_container, done);
            }
            idx++;
        }

        big.setViewVisibility(R.id.mm_league_empty_hint,
                (!currentInteractive && courts.isEmpty()) ? View.VISIBLE : View.GONE);

        boolean showGenerate = allDone && !currentIsLastRound;
        big.setViewVisibility(R.id.mm_generate_btn, showGenerate ? View.VISIBLE : View.GONE);
        if (showGenerate) {
            big.setOnClickPendingIntent(R.id.mm_generate_btn,
                    actionPendingIntent(ACTION_GENERATE, 0, null, 999));
        }

        if (breakPlayers != null && !breakPlayers.trim().isEmpty()) {
            big.setTextViewText(R.id.mm_break_names, breakPlayers);
            big.setViewVisibility(R.id.mm_break_row, View.VISIBLE);
        } else {
            big.setViewVisibility(R.id.mm_break_row, View.GONE);
        }

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(contentPendingIntent())
                .setCustomContentView(small)
                .setCustomBigContentView(big)
                .setStyle(new NotificationCompat.DecoratedCustomViewStyle())
                .build();
    }

    // Sets up a native ticking countdown (MM:SS) with no JS/battery cost — Android
    // redraws it every second on its own via the system process, not our app.
    private void setCountdown(RemoteViews views, int viewId, long chronoBase) {
        views.setChronometer(viewId, chronoBase, null, true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            views.setChronometerCountDown(viewId, true);
        }
    }

    private static class CourtInfo {
        final int court;
        final String teamA;
        final String teamB;
        final String winner;
        final String balance;
        final String group; // "A" / "B" / "" — League's group label; unused (empty) for CI/Ladder
        CourtInfo(int court, String teamA, String teamB, String winner, String balance, String group) {
            this.court = court; this.teamA = teamA; this.teamB = teamB; this.winner = winner; this.balance = balance; this.group = group;
        }
    }
}
