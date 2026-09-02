package com.trimachine.padelos;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import androidx.core.app.NotificationCompat;
import java.util.HashMap;
import java.util.Locale;

// Fires the moment a round's time is up — scheduled ahead of time via AlarmManager by
// MatchModeService, so this runs independently of the JS/WebView. This is what makes the
// whistle behave like a native Android timer/alarm: it still fires with the app fully
// closed, unlike the old Web Audio based whistle which needed the app in the foreground.
//
// Plays our own unique whistle sound (res/raw/mm_whistle.wav) instead of the device's
// default alarm/notification tone, so it's unmistakably "this is Matchkeeper, not some
// other alarm" — and, unlike the old approach, we fully control its exact duration.
//
// Also handles the 5-minutes-before warning alarm (type="warning") — a separate, own-line,
// clearly audible notification (spoken voice via Android's built-in TextToSpeech engine,
// no audio file needed), distinct from the persistent Match Mode notification, so it both
// shows up as its own entry (synced to a paired watch) and is actually noticed.
public class MatchModeWhistleReceiver extends BroadcastReceiver {

    private static final long MAX_PLAY_MS = 4000; // safety cap even if playback somehow hangs
    private static final String ALERT_CHANNEL_ID = "matchkeeper_whistle_alert";
    private static final String WARNING_CHANNEL_ID = "matchkeeper_round_warning";
    private static final int ALERT_NOTIF_ID = 4210;
    private static final int WARNING_NOTIF_ID = 4220;

    private static MediaPlayer currentPlayer;
    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static Runnable pendingStop;
    private static PowerManager.WakeLock currentWakeLock;
    private static TextToSpeech tts;

    @Override
    public void onReceive(Context context, Intent intent) {
        int round = intent.getIntExtra("round", -1);
        String eventId = intent.getStringExtra("eventId");
        String type = intent.getStringExtra("type"); // "warning" or "final" (default final)

        if ("warning".equals(type)) {
            android.util.Log.i("MatchModeDiag", "Round warning FIRED round=" + round + " eventId=" + eventId);
            postWarningNotification(context, round);
            speakWarning(context, round);
            return;
        }

        android.util.Log.i("MatchModeDiag", "MatchModeWhistleReceiver FIRED round=" + round + " eventId=" + eventId + " at " + System.currentTimeMillis());

        // Durable record that THIS round's alarm actually rang, independent of whether
        // the JS bridge is reachable right now — the app can ask "which rounds have
        // fired?" at any later point (e.g. when it reopens) and get an honest answer.
        if (round > 0 && eventId != null) {
            context.getSharedPreferences("matchmode_whistles", Context.MODE_PRIVATE)
                    .edit()
                    .putLong("fired_" + eventId + "_" + round, System.currentTimeMillis())
                    .apply();
        }

        // Best-effort: if JS happens to be reachable right now, tell it immediately too
        // (for a live-updating checkmark instead of waiting for the next poll).
        MatchModePlugin plugin = MatchModePlugin.instance;
        if (plugin != null) plugin.emitWhistleFired(round);

        postAlertNotification(context, round);

        stopCurrent();

        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "matchkeeper:whistle");
        wl.acquire(MAX_PLAY_MS + 2000);
        currentWakeLock = wl;

        try {
            // Real bug, confirmed 2026-09-02 via logcat ("trying to set audio attributes
            // called in state 8"): MediaPlayer.create(context, resId) internally calls
            // setDataSource()+prepare() before returning, so by the time this code used to
            // call mp.setAudioAttributes(USAGE_ALARM, ...) the player was already past the
            // state where that's allowed — Android silently rejected it, so the whistle kept
            // playing on whatever default stream create() had already picked instead of the
            // alarm stream. Building the MediaPlayer manually (new MediaPlayer(), attributes
            // set on it while still IDLE, then setDataSource+prepare) is the only order
            // Android accepts audio attributes in, so USAGE_ALARM actually takes effect now
            // — the whistle plays at the phone's alarm volume, not whatever the fallback
            // stream's volume happened to be.
            MediaPlayer mp = new MediaPlayer();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                mp.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
            }
            android.content.res.AssetFileDescriptor afd = context.getResources().openRawResourceFd(R.raw.mm_whistle);
            mp.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            afd.close();
            mp.setVolume(1.0f, 1.0f);
            mp.prepare(); // small bundled WAV — synchronous prepare is effectively instant
            currentPlayer = mp;
            mp.setOnCompletionListener(p -> stopCurrent());
            mp.start();
            pendingStop = MatchModeWhistleReceiver::stopCurrent; // hard safety cap
            handler.postDelayed(pendingStop, MAX_PLAY_MS);
        } catch (Exception e) {
            releaseWakeLock();
        }

        // Three short-long-short bursts — a "whistle" rhythm, not just a generic buzz.
        long[] pattern = {0, 180, 120, 180, 120, 400};
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager vm = (VibratorManager) context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            vm.getDefaultVibrator().vibrate(VibrationEffect.createWaveform(pattern, -1));
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Vibrator v = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
            v.vibrate(VibrationEffect.createWaveform(pattern, -1));
        } else {
            Vibrator v = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
            v.vibrate(pattern, -1);
        }
    }

    // A separate, own-line, high-importance notification (distinct from the ongoing Match
    // Mode notification) — this is what actually rings/heads-up and syncs to a paired
    // watch. Auto-dismisses a few seconds after posting since it's just a momentary alert.
    private void postAlertNotification(Context context, int round) {
        ensureChannel(context, ALERT_CHANNEL_ID, "Match Whistle", NotificationManager.IMPORTANCE_HIGH, false);
        Notification n = new NotificationCompat.Builder(context, ALERT_CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("🔔 Whistle — Round " + round)
                .setContentText("Time's up for this round")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setTimeoutAfter(8000)
                .build();
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(ALERT_NOTIF_ID, n);
    }

    // Own-line heads-up 5 minutes before a round ends. Now HIGH importance (not silent/low
    // like before) — IMPORTANCE_LOW notifications don't heads-up and are very easy to miss
    // entirely, which is exactly what was happening. Paired with a spoken voice alert below.
    private void postWarningNotification(Context context, int round) {
        ensureChannel(context, WARNING_CHANNEL_ID, "Round Ending Soon", NotificationManager.IMPORTANCE_HIGH, false);
        Notification n = new NotificationCompat.Builder(context, WARNING_CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("⏳ Round " + round + " ends in 5 minutes")
                .setContentText("Wrap up soon")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setTimeoutAfter(5 * 60 * 1000)
                .build();
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(WARNING_NOTIF_ID, n);
    }

    // Spoken English voice alert using Android's own built-in TextToSpeech engine — no
    // audio file needed. Initializes fresh each time (a BroadcastReceiver instance is
    // short-lived), speaks once, then shuts itself down once done so it doesn't leak.
    private void speakWarning(Context context, int round) {
        try {
            final Context appContext = context.getApplicationContext();
            tts = new TextToSpeech(appContext, status -> {
                if (status != TextToSpeech.SUCCESS || tts == null) { shutdownTts(); return; }
                tts.setLanguage(Locale.US);
                tts.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build());
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String utteranceId) {}
                    @Override public void onDone(String utteranceId) { handler.post(MatchModeWhistleReceiver::shutdownTts); }
                    @Override public void onError(String utteranceId) { handler.post(MatchModeWhistleReceiver::shutdownTts); }
                });
                HashMap<String, String> params = new HashMap<>();
                params.put(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, "mm_warning_" + round);
                tts.speak("5 minutes remaining for round " + round, TextToSpeech.QUEUE_FLUSH, params);
                // Safety cap in case the utterance callbacks never fire on some OEM builds.
                handler.postDelayed(MatchModeWhistleReceiver::shutdownTts, 10000);
            });
        } catch (Exception ignored) {}
    }

    private static synchronized void shutdownTts() {
        if (tts != null) {
            try { tts.stop(); } catch (Exception ignored) {}
            try { tts.shutdown(); } catch (Exception ignored) {}
            tts = null;
        }
    }

    private void ensureChannel(Context context, String id, String name, int importance, boolean silent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel existing = nm.getNotificationChannel(id);
            // If a previous (e.g. silent) version of this channel already exists, Android
            // won't let us change its importance/sound after the fact — delete and recreate
            // so the new settings actually take effect instead of silently staying as before.
            if (existing != null && existing.getImportance() != importance) {
                nm.deleteNotificationChannel(id);
                existing = null;
            }
            if (existing == null) {
                NotificationChannel channel = new NotificationChannel(id, name, importance);
                if (silent) {
                    channel.setSound(null, null);
                    channel.enableVibration(false);
                }
                nm.createNotificationChannel(channel);
            }
        }
    }

    private static synchronized void stopCurrent() {
        if (pendingStop != null) { handler.removeCallbacks(pendingStop); pendingStop = null; }
        if (currentPlayer != null) {
            try { if (currentPlayer.isPlaying()) currentPlayer.stop(); } catch (Exception ignored) {}
            try { currentPlayer.release(); } catch (Exception ignored) {}
            currentPlayer = null;
        }
        releaseWakeLock();
    }

    private static void releaseWakeLock() {
        if (currentWakeLock != null) {
            try { if (currentWakeLock.isHeld()) currentWakeLock.release(); } catch (Exception ignored) {}
            currentWakeLock = null;
        }
    }
}

