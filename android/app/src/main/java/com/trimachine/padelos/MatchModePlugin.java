package com.trimachine.padelos;

import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Bridges JS (App.jsx) <-> MatchModeService (foreground service + notification).
// Registered manually in MainActivity.java — local plugins are never auto-discovered,
// only plugins that ship as their own npm package are.
@CapacitorPlugin(name = "MatchMode")
public class MatchModePlugin extends Plugin {

    // Static reference so the Service / BroadcastReceiver can push events back into JS
    // even if the plugin instance was recreated after the Activity restarted. Simple
    // app-wide singleton — fine for a single-activity app like this one.
    public static MatchModePlugin instance;

    @Override
    public void load() {
        super.load();
        instance = this;
    }

    @PluginMethod
    public void start(PluginCall call) {
        sendToService(MatchModeService.ACTION_START, call);
    }

    @PluginMethod
    public void update(PluginCall call) {
        sendToService(MatchModeService.ACTION_UPDATE, call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), MatchModeService.class);
        intent.setAction(MatchModeService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve();
    }

    // Schedules every round's whistle alarm in one shot, right when Match Mode starts —
    // not one at a time as each round gets generated. This is what lets the whistle keep
    // ringing for round 2, 3, 4... on its own, with no dependency on the app re-running
    // this logic when a new round is created or a result comes in.
    //
    // NOTE: uses a plain startService (not startForegroundService) — the service is
    // already in the foreground from the Start call moments earlier, and a *second*
    // startForegroundService call here would need its own prompt startForeground()
    // acknowledgement or Android silently kills the service — which is exactly what was
    // making every whistle go silent.
    @PluginMethod
    public void scheduleWhistles(PluginCall call) {
        Intent intent = new Intent(getContext(), MatchModeService.class);
        intent.setAction(MatchModeService.ACTION_SCHEDULE_ALL);
        intent.putExtra("eventId", readEventIdAsString(call));
        JSArray schedule = call.getArray("schedule");
        intent.putExtra("scheduleJson", schedule != null ? schedule.toString() : "[]");
        getContext().startService(intent);
        call.resolve();
    }

    // eventId can arrive as a JS string or a JS number depending on how the caller built
    // the payload — coerce it to a string reliably either way, since a null here was
    // silently breaking the durable "whistle fired" flag (the alarm itself still fires
    // fine even with a null eventId, since PendingIntents don't need it to work — only
    // the fired-flag bookkeeping depended on it).
    private String readEventIdAsString(PluginCall call) {
        String s = call.getString("eventId");
        if (s != null) return s;
        Integer i = call.getInt("eventId");
        if (i != null) return String.valueOf(i);
        return null;
    }

    private void sendToService(String action, PluginCall call) {
        Intent intent = new Intent(getContext(), MatchModeService.class);
        intent.setAction(action);
        intent.putExtra("eventId", readEventIdAsString(call));
        Integer roundIndex = call.getInt("roundIndex");
        Integer roundNumber = call.getInt("roundNumber");
        intent.putExtra("roundIndex", roundIndex != null ? roundIndex : -1);
        intent.putExtra("roundNumber", roundNumber != null ? roundNumber : 0);
        long whistleAtLong = 0L;
        String whistleAtStr = call.getString("whistleAt");
        if (whistleAtStr != null) {
            try { whistleAtLong = Long.parseLong(whistleAtStr); } catch (NumberFormatException ignored) {}
        }
        intent.putExtra("whistleAt", whistleAtLong);
        intent.putExtra("breakPlayers", call.getString("breakPlayers"));
        Boolean isLastRound = call.getBoolean("isLastRound");
        intent.putExtra("isLastRound", isLastRound != null && isLastRound);
        JSArray courts = call.getArray("courts");
        intent.putExtra("courtsJson", courts != null ? courts.toString() : "[]");
        // Absent (CI, which never sends this field) defaults to true, preserving today's
        // interactive behavior with zero CI-side changes needed.
        Boolean interactive = call.getBoolean("interactive");
        intent.putExtra("interactive", interactive == null || interactive);
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }

    // Called by MatchModeActionReceiver when the organizer taps a win button.
    public void emitCourtWinner(int court, String team) {
        android.util.Log.d("MatchModeDiag", "emitCourtWinner called court=" + court + " team=" + team + " hasListeners(courtWinner)=" + hasListeners("courtWinner"));
        JSObject data = new JSObject();
        data.put("court", court);
        data.put("team", team);
        notifyListeners("courtWinner", data);
    }

    // Called by MatchModeActionReceiver when Generate Next Round is tapped.
    public void emitGenerateNextRound() {
        android.util.Log.d("MatchModeDiag", "emitGenerateNextRound called hasListeners(generateNextRound)=" + hasListeners("generateNextRound"));
        notifyListeners("generateNextRound", new JSObject());
    }

    // Called by MatchModeWhistleReceiver the instant an alarm actually rings — best
    // effort, only reaches JS if it happens to be alive right now. The durable source of
    // truth is getFiredWhistles below, which works regardless of JS's state at fire time.
    public void emitWhistleFired(int round) {
        JSObject data = new JSObject();
        data.put("round", round);
        notifyListeners("whistleFired", data);
    }

    // JS polls this (e.g. every few seconds while Match Mode is on screen) to build the
    // "which rounds have actually rung" checklist — reads a durable flag written by
    // MatchModeWhistleReceiver at the moment each alarm fired, so it's accurate even if
    // the app was fully closed when some of them rang.
    @PluginMethod
    public void getFiredWhistles(PluginCall call) {
        String eventId = call.getString("eventId");
        JSArray fired = new JSArray();
        if (eventId != null) {
            android.content.SharedPreferences prefs = getContext().getSharedPreferences("matchmode_whistles", android.content.Context.MODE_PRIVATE);
            for (int round = 1; round <= 40; round++) {
                if (prefs.contains("fired_" + eventId + "_" + round)) fired.put(round);
            }
        }
        JSObject result = new JSObject();
        result.put("rounds", fired);
        call.resolve(result);
    }

    // Exact alarms (what the whistle relies on for real reliability) can't be granted via
    // a normal runtime permission dialog — Android only allows a direct link to the
    // specific Settings screen for it. This checks current status and, if not granted,
    // opens that screen directly so the person only has to tap "Allow" once, instead of
    // hunting through Settings > Apps > Matchkeeper > Alarms & reminders manually.
    @PluginMethod
    public void ensureExactAlarmPermission(PluginCall call) {
        android.app.AlarmManager am = (android.app.AlarmManager) getContext().getSystemService(android.content.Context.ALARM_SERVICE);
        boolean granted = true;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
            granted = am != null && am.canScheduleExactAlarms();
            if (!granted) {
                try {
                    Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                    intent.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(intent);
                } catch (Exception ignored) {
                    // Some OEM builds don't support the direct-to-toggle intent — nothing
                    // more we can do from code in that case.
                }
            }
        }
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }
}
