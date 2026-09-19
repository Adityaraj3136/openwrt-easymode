package com.example.easymode

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import java.io.IOException

class MainActivity : ComponentActivity() {
    private var server: EasyModeServer? = null
    private var webViewRef: WebView? = null

    // BroadcastReceiver to detect Wi-Fi network changes
    private val wifiReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == WifiManager.NETWORK_STATE_CHANGED_ACTION ||
                intent.action == WifiManager.WIFI_STATE_CHANGED_ACTION) {
                // Update the server's gateway IP when network changes
                server?.onNetworkChanged()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Transparent status bar — CSS handles spacing via env(safe-area-inset-top)
        window.statusBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            )
        }

        // Start local NanoHTTPD server
        server = EasyModeServer(this, 8080)
        try { server?.start() } catch (e: IOException) { e.printStackTrace() }

        // Register Wi-Fi state change receiver
        val filter = IntentFilter().apply {
            addAction(WifiManager.NETWORK_STATE_CHANGED_ACTION)
            addAction(WifiManager.WIFI_STATE_CHANGED_ACTION)
        }
        registerReceiver(wifiReceiver, filter)

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    WebViewContainer(server = server)
                }
            }
        }

        // Back button: navigate back within the SPA instead of closing the app
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val wv = webViewRef
                if (wv != null && wv.canGoBack()) {
                    wv.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    override fun onDestroy() {
        super.onDestroy()
        try { unregisterReceiver(wifiReceiver) } catch (_: Exception) {}
        server?.stop()
    }

    // Called by WebViewContainer to register the WebView reference for back navigation
    fun registerWebView(wv: WebView) { webViewRef = wv }
}

@SuppressLint("SetJavaScriptEnabled")
@androidx.compose.runtime.Composable
fun WebViewContainer(server: EasyModeServer?) {
    val activity = androidx.compose.ui.platform.LocalContext.current as MainActivity

    AndroidView(
        factory = { context ->
            val webView = WebView(context)
            webView.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                useWideViewPort = true
                loadWithOverviewMode = true
                setSupportZoom(false)
                builtInZoomControls = false
                displayZoomControls = false
                // Allow local storage for session persistence across reloads
                databaseEnabled = true
            }

            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
            // Persist cookies across app restarts
            CookieManager.getInstance().setAcceptCookie(true)

            webView.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    super.onPageFinished(view, url)
                    // Flush cookies to disk so they survive process death
                    CookieManager.getInstance().flush()
                }
            }

            activity.registerWebView(webView)
            webView.loadUrl("http://localhost:8080/")
            webView
        },
        update = { _ -> }
    )
}
