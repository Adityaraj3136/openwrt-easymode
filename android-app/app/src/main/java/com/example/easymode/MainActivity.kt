package com.example.easymode

import android.annotation.SuppressLint
import android.os.Bundle
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
            WebView(context).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                // Fix for responsive design:
                settings.useWideViewPort = true
                settings.loadWithOverviewMode = true
                settings.setSupportZoom(false)
                settings.builtInZoomControls = false
                settings.displayZoomControls = false

                webViewClient = WebViewClient()
                loadUrl("http://localhost:8080/")
            }
        },
        update = { webView ->
            // Update logic if needed
        }
    )
}
