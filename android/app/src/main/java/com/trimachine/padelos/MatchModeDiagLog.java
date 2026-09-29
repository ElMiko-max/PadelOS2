package com.trimachine.padelos;

import android.content.Context;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

// Persistent, on-device mirror of the existing "MatchModeDiag" logcat tag. Logcat requires a
// laptop plugged in and actively recording DURING the event (see _04 Record Android Log.bat) to
// capture anything — impractical for a live, walk-around Match Mode session, and useless after
// the fact once the buffer rotates. This writes the exact same diagnostic lines to a small file
// in app-internal storage instead, so an intermittent whistle failure can be diagnosed the next
// day from whatever phone actually ran it (admin request, 2026-09-29).
//
// A fresh file is started every time Match Mode is (re)armed (see scheduleAllWhistles). It
// naturally stops growing on its own once the self-healing checkpoint in MatchModeService sees no
// rounds left in the future and stops re-arming itself (verifyAndReschedule) — so there's no
// separate "stop after N hours" timer needed here.
public class MatchModeDiagLog {
    private static final String FILE_NAME = "matchmode_diag.log";
    private static final SimpleDateFormat FMT = new SimpleDateFormat("HH:mm:ss.SSS", Locale.US);

    public static synchronized void write(Context context, String line) {
        try {
            File f = new File(context.getFilesDir(), FILE_NAME);
            FileWriter fw = new FileWriter(f, true);
            fw.write(FMT.format(new Date()) + " " + line + "\n");
            fw.close();
        } catch (Exception ignored) {
            // Diagnostics must never be able to affect real Match Mode behavior.
        }
    }

    public static synchronized void reset(Context context) {
        try {
            File f = new File(context.getFilesDir(), FILE_NAME);
            if (f.exists()) f.delete();
        } catch (Exception ignored) {}
    }

    public static synchronized String readAll(Context context) {
        try {
            File f = new File(context.getFilesDir(), FILE_NAME);
            if (!f.exists()) return "";
            byte[] bytes = new byte[(int) f.length()];
            FileInputStream fis = new FileInputStream(f);
            fis.read(bytes);
            fis.close();
            return new String(bytes, "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }
}
