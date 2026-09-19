package com.example.easymode

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Binder
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Foreground service that keeps NanoHTTPD alive even when the app is
 * backgrounded or the screen is off. Android will not kill this process
 * as long as the foreground notification is visible.
 */
class EasyModeService : Service() {

    companion object {
        const val CHANNEL_ID = "easymode_server"
        const val NOTIF_ID = 1
    }

    private var server: EasyModeServer? = null

    inner class LocalBinder : Binder() {
        fun getServer(): EasyModeServer? = server
    }

    private val binder = LocalBinder()

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        } else {
            0
        }

        try {
            ServiceCompat.startForeground(this, NOTIF_ID, buildNotification(), type)
        } catch (e: Exception) {
            startForeground(NOTIF_ID, buildNotification())
        }

        // Start NanoHTTPD server.
        // DefaultAsyncRunner spawns a new thread per request so concurrent
        // dashboard polls + Wi-Fi scans don't queue behind each other.
        server = EasyModeServer(this, 8080)
        try {
            server?.start(5000, false)  // 5s socket timeout, non-daemon threads
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Handle network-change signal from MainActivity's BroadcastReceiver
        if (intent?.getStringExtra("action") == "network_changed") {
            server?.onNetworkChanged()
        }
        // START_STICKY: Android restarts the service if it gets killed
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        super.onDestroy()
        server?.stop()
    }

    // ── Notification ──────────────────────────────────────────
    private fun buildNotification(): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("EasyMode")
            .setContentText("Router management server running")
            .setSmallIcon(android.R.drawable.ic_menu_manage)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "EasyMode Server",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps the EasyMode router management server running in the background"
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
}
