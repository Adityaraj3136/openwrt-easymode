package com.example.easymode

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import java.io.IOException
import java.io.InputStream
import org.json.JSONObject

class EasyModeServer(private val context: Context, port: Int) : NanoHTTPD(port) {

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        
        // Route API calls to Kotlin logic
        if (uri.startsWith("/api/")) {
            return handleApi(session)
        }
        
        // Serve static frontend files
        var path = uri
        if (path == "/") {
            path = "/index.html"
        }
        
        // Remove leading slash
        if (path.startsWith("/")) {
            path = path.substring(1)
        }
        
        return try {
            val mimeType = getMimeTypeForFile(path)
            val assetStream: InputStream = context.assets.open("frontend/$path")
            newChunkedResponse(Response.Status.OK, mimeType, assetStream)
        } catch (e: IOException) {
            newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "File Not Found")
        }
    }

    private fun handleApi(session: IHTTPSession): Response {
        // Stub for now, will return 401 Unauthorized for status to force login screen
        if (session.uri == "/api/status") {
            val json = JSONObject()
            json.put("error", "Unauthorized")
            return newFixedLengthResponse(Response.Status.UNAUTHORIZED, "application/json", json.toString())
        }
        
        val json = JSONObject()
        json.put("message", "API Endpoint Not Implemented Yet in Native App")
        return newFixedLengthResponse(Response.Status.OK, "application/json", json.toString())
    }
}
