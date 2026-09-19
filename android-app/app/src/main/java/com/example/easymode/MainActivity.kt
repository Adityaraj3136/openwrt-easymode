package com.example.easymode

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import java.io.IOException

class MainActivity : ComponentActivity() {
    private var server: EasyModeServer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Make status bar transparent so the web content (with its own appbar)
        // can draw behind it using env(safe-area-inset-top) padding in CSS.
        // This prevents the "top not clickable" issue.
        window.statusBarColor = Color.TRANSPARENT
        @Suppress("DEPRECATION")
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
        try {
            server?.start()
        } catch (e: IOException) {
            e.printStackTrace()
        }

        setContent {
            MaterialTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    WebViewScreen()
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        server?.stop()
    }
}

@SuppressLint("SetJavaScriptEnabled")
@androidx.compose.runtime.Composable
fun WebViewScreen() {
    AndroidView(
        factory = { context ->
            val webView = WebView(context)
            webView.settings.javaScriptEnabled = true
            webView.settings.domStorageEnabled = true
            webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            webView.settings.useWideViewPort = true
            webView.settings.loadWithOverviewMode = true
            webView.settings.setSupportZoom(false)
            webView.settings.builtInZoomControls = false
            webView.settings.displayZoomControls = false

            // Enable cookies so the session cookie survives between requests
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

            webView.webViewClient = WebViewClient()
            webView.loadUrl("http://localhost:8080/")
            webView
        },
        update = { _ -> }
    )
}
